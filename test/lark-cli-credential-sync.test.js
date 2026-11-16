import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  syncCredentialsToLarkCli,
  normalizeLarkLang,
  getLarkCliConfigPath,
} from '../hooks/post-install-shared.js';

// Tests for issue #112: `lark-cli config init` must not wipe users that were
// logged in via `lark-cli auth login`.

const APP_ID = 'cli_test_app_1';
const SECRET = 'test-secret-value-0123456789abcdef';
const USER = { userOpenId: 'ou_alice', userName: 'Alice' };

let tmp;
let configPath;
let stateFile;
let calls;
let logs;
let origLog;
let origWarn;

/**
 * Fake `lark-cli config init` reproducing lark-cli v1.0.81 non-profile
 * behaviour (saveInitConfig → saveAsOnlyApp): config.json is replaced by a
 * single app with `users: []`; lang is normalised; all other fields dropped.
 */
function fakeLarkCli(file, args, options) {
  calls.push({ file, args, input: options.input });
  const get = (flag) => args[args.indexOf(flag) + 1];
  let prior;
  try { prior = JSON.parse(fs.readFileSync(configPath, 'utf-8')).apps?.[0]?.lang; } catch { /* none */ }
  const cfg = {
    apps: [{
      appId: get('--app-id'),
      appSecret: { source: 'keychain', id: `appsecret:${get('--app-id')}` },
      brand: get('--brand'),
      lang: normalizeLarkLang(get('--lang')) || prior,
      users: [],
    }],
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

function failingLarkCli() {
  calls.push({ failed: true });
  throw new Error('lark-cli config init exited with status 1');
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function appEntry(overrides = {}) {
  return {
    appId: APP_ID,
    appSecret: { source: 'keychain', id: `appsecret:${APP_ID}` },
    brand: 'lark',
    lang: 'zh_cn',
    users: [USER],
    ...overrides,
  };
}

function sync(overrides = {}) {
  return syncCredentialsToLarkCli({
    appId: APP_ID,
    appSecret: SECRET,
    lang: 'zh',
    envFile: path.join(tmp, 'no-such.env'),
    execFile: fakeLarkCli,
    configPath,
    stateFile,
    ...overrides,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-cli-sync-'));
  configPath = path.join(tmp, '.lark-cli', 'config.json');
  stateFile = path.join(tmp, 'components', 'lark', 'lark-cli-sync.json');
  calls = [];
  logs = [];
  origLog = console.log;
  origWarn = console.warn;
  console.log = (...a) => logs.push({ level: 'log', msg: a.join(' ') });
  console.warn = (...a) => logs.push({ level: 'warn', msg: a.join(' ') });
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const warnings = () => logs.filter((l) => l.level === 'warn').map((l) => l.msg);

describe('lark-cli credential sync: preserve users across config init (#112)', () => {
  it('fresh install (no config.json): runs init, writes 0600 state without the plain secret', () => {
    const res = sync();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      'config', 'init', '--app-id', APP_ID, '--app-secret-stdin', '--brand', 'lark', '--lang', 'zh',
    ]);
    assert.equal(calls[0].input, SECRET + '\n');
    assert.equal(res.initSkipped, false);
    assert.deepEqual(res.lostUsers, []);

    const stateRaw = fs.readFileSync(stateFile, 'utf-8');
    assert.ok(!stateRaw.includes(SECRET), 'state file must not contain the secret');
    const state = JSON.parse(stateRaw);
    assert.equal(state.appId, APP_ID);
    assert.match(state.salt, /^[0-9a-f]{32}$/);
    assert.match(state.secretHmac, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  });

  it('upgrade from a version without state: runs init and restores same-appId users', () => {
    writeConfig({ apps: [appEntry({ defaultAs: 'user', strictMode: 'off' })], riskControl: false });
    const res = sync();
    assert.equal(calls.length, 1);
    assert.equal(res.restoredUsers, 1);
    assert.deepEqual(res.lostUsers, []);
    const cfg = readConfig();
    assert.deepEqual(cfg.apps[0].users, [USER]);
    assert.equal(cfg.apps[0].defaultAs, 'user');
    assert.equal(cfg.apps[0].strictMode, 'off');
    assert.equal(cfg.riskControl, false);
    assert.deepEqual(warnings(), []);
  });

  it('second run with nothing changed: skips config init and leaves config.json untouched', () => {
    writeConfig({ apps: [appEntry()] });
    sync();
    const before = fs.readFileSync(configPath, 'utf-8');
    const mtimeBefore = fs.statSync(configPath).mtimeMs;
    calls = [];
    const res = sync();
    assert.equal(calls.length, 0, 'config init must not run');
    assert.equal(res.initSkipped, true);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
    assert.equal(fs.statSync(configPath).mtimeMs, mtimeBefore);
  });

  it('accepts short and canonical lang forms as equal ("zh" vs stored "zh_cn")', () => {
    writeConfig({ apps: [appEntry()] });
    sync({ lang: 'zh' });
    calls = [];
    assert.equal(sync({ lang: 'zh_cn' }).initSkipped, true);
    assert.equal(calls.length, 0);
  });

  it('secret rotated in .env: re-runs init, keeps users, updates state', () => {
    writeConfig({ apps: [appEntry()] });
    sync();
    const oldState = fs.readFileSync(stateFile, 'utf-8');
    calls = [];
    const res = sync({ appSecret: 'rotated-secret-zzzzzzzzzzzzzzzzzz' });
    assert.equal(calls.length, 1);
    assert.equal(res.initSkipped, false);
    assert.deepEqual(readConfig().apps[0].users, [USER]);
    assert.notEqual(fs.readFileSync(stateFile, 'utf-8'), oldState);
    // and the new secret is now considered in sync
    calls = [];
    assert.equal(sync({ appSecret: 'rotated-secret-zzzzzzzzzzzzzzzzzz' }).initSkipped, true);
  });

  for (const [label, mutate, opts] of [
    ['lang changed', () => {}, { lang: 'en' }],
    ['brand differs', (c) => { c.apps[0].brand = 'feishu'; }, {}],
    ['secret stored inline instead of keychain', (c) => { c.apps[0].appSecret = 'plain'; }, {}],
    ['currentApp points elsewhere', (c) => { c.currentApp = 'cli_other'; }, {}],
  ]) {
    it(`${label}: re-runs init and preserves users`, () => {
      writeConfig({ apps: [appEntry()] });
      sync();
      const cfg = readConfig();
      mutate(cfg);
      writeConfig(cfg);
      calls = [];
      const res = sync(opts);
      assert.equal(calls.length, 1);
      assert.equal(res.initSkipped, false);
      assert.deepEqual(readConfig().apps[0].users, [USER]);
      assert.deepEqual(res.lostUsers, []);
    });
  }

  it('appId changed: never carries users over and warns about the lost identity', () => {
    writeConfig({ apps: [appEntry({ appId: 'cli_old_app', appSecret: { source: 'keychain', id: 'appsecret:cli_old_app' } })] });
    const res = sync();
    assert.equal(calls.length, 1);
    assert.equal(res.restoredUsers, 0);
    assert.deepEqual(readConfig().apps[0].users, []);
    assert.equal(res.lostUsers.length, 1);
    assert.equal(res.lostUsers[0].userOpenId, 'ou_alice');
    const w = warnings();
    assert.equal(w.length, 1);
    assert.match(w[0], /ou_alice/);
    assert.match(w[0], /different app \(cli_old_app\)/);
  });

  it('restores only the same-appId profile users when several apps existed', () => {
    writeConfig({
      apps: [
        appEntry({ appId: 'cli_other', appSecret: { source: 'keychain', id: 'appsecret:cli_other' }, users: [{ userOpenId: 'ou_bob', userName: 'Bob' }] }),
        appEntry({ name: 'mine' }),
      ],
    });
    const res = sync();
    const cfg = readConfig();
    assert.equal(cfg.apps.length, 1);
    assert.deepEqual(cfg.apps[0].users, [USER]);
    assert.deepEqual(res.lostUsers.map((u) => u.userOpenId), ['ou_bob']);
  });

  it('warns when a same-appId user still disappears (restore impossible)', () => {
    writeConfig({ apps: [appEntry()] });
    // lark-cli drops the app entirely (simulated schema surprise)
    const weird = (file, args, options) => {
      calls.push({ args, input: options.input });
      writeConfig({ apps: [] });
    };
    const res = sync({ execFile: weird });
    assert.equal(res.lostUsers.length, 1);
    assert.ok(warnings().some((m) => /could not be restored/.test(m)));
  });

  it('corrupt config.json: runs init without throwing', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{not json');
    const res = sync();
    assert.equal(calls.length, 1);
    assert.equal(res.initSkipped, false);
    assert.deepEqual(res.lostUsers, []);
  });

  it('config init failure: throws and does not record state', () => {
    writeConfig({ apps: [appEntry()] });
    assert.throws(() => sync({ execFile: failingLarkCli }), /exited with status 1/);
    assert.equal(fs.existsSync(stateFile), false);
    assert.deepEqual(readConfig().apps[0].users, [USER], 'config left as lark-cli left it');
  });

  it('restored config.json is written atomically and keeps mode 0600', () => {
    writeConfig({ apps: [appEntry()] });
    sync();
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    const leftovers = fs.readdirSync(path.dirname(configPath)).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
  });

  it('tampered state (wrong secret hash) forces a re-init', () => {
    writeConfig({ apps: [appEntry()] });
    sync();
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    state.secretHmac = '0'.repeat(64);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    calls = [];
    sync();
    assert.equal(calls.length, 1);
    assert.deepEqual(readConfig().apps[0].users, [USER]);
  });

  it('never logs the secret', () => {
    writeConfig({ apps: [appEntry({ appId: 'cli_old_app' })] });
    sync();
    sync();
    for (const l of logs) assert.ok(!l.msg.includes(SECRET), `secret leaked in: ${l.msg}`);
  });

  it('missing credentials: unchanged behaviour (skipped, no init)', () => {
    const saved = { id: process.env.LARK_APP_ID, secret: process.env.LARK_APP_SECRET };
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    try {
      const res = sync({ appId: undefined, appSecret: undefined });
      assert.deepEqual(res, { skipped: true, reason: 'credentials_missing' });
      assert.equal(calls.length, 0);
    } finally {
      if (saved.id !== undefined) process.env.LARK_APP_ID = saved.id;
      if (saved.secret !== undefined) process.env.LARK_APP_SECRET = saved.secret;
    }
  });
});

describe('lark-cli helpers', () => {
  it('normalizeLarkLang maps short codes, keeps canonical locales, rejects unknown', () => {
    assert.equal(normalizeLarkLang('zh'), 'zh_cn');
    assert.equal(normalizeLarkLang('en'), 'en_us');
    assert.equal(normalizeLarkLang('ja_jp'), 'ja_jp');
    assert.equal(normalizeLarkLang('xx'), null);
    assert.equal(normalizeLarkLang(''), null);
    assert.equal(normalizeLarkLang('constructor'), null);
  });

  it('getLarkCliConfigPath honours LARKSUITE_CLI_CONFIG_DIR', () => {
    assert.equal(getLarkCliConfigPath({ HOME: '/h' }), '/h/.lark-cli/config.json');
    assert.equal(
      getLarkCliConfigPath({ HOME: '/h', LARKSUITE_CLI_CONFIG_DIR: '/x' }),
      '/x/config.json'
    );
  });
});
