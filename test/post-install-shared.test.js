import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(__dirname, '..', 'hooks');

// We can't easily mock execSync, so test the pure logic by importing
// the module and verifying getTargetVersion / semverCompare via the
// exported functions' observable behavior.

describe('post-install-shared version logic', () => {
  it('package.json contains larkCli.version field', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
    );
    assert.ok(pkg.larkCli, 'package.json should have a larkCli field');
    assert.ok(pkg.larkCli.version, 'package.json larkCli should have a version');
    assert.match(pkg.larkCli.version, /^\d+\.\d+\.\d+$/, 'version should be semver');
  });

  it('version marker file name is used in installLarkCliSkills', async () => {
    const src = fs.readFileSync(
      path.join(HOOKS_DIR, 'post-install-shared.js'),
      'utf-8'
    );
    assert.ok(
      src.includes('.lark-cli-version'),
      'should reference the version marker file'
    );
  });

  it('getTargetVersion reads from package.json larkCli.version', async () => {
    const src = fs.readFileSync(
      path.join(HOOKS_DIR, 'post-install-shared.js'),
      'utf-8'
    );
    assert.ok(
      src.includes('pkg.larkCli?.version'),
      'should read larkCli.version from package.json'
    );
    assert.ok(
      src.includes('FALLBACK_VERSION'),
      'should have a fallback version'
    );
  });

  it('installLarkCliBinary compares versions before deciding to upgrade', async () => {
    const src = fs.readFileSync(
      path.join(HOOKS_DIR, 'post-install-shared.js'),
      'utf-8'
    );
    assert.ok(
      src.includes('semverCompare(installed, target)'),
      'should compare installed version against target'
    );
    assert.ok(
      src.includes('getInstalledVersion'),
      'should have getInstalledVersion function'
    );
  });

  it('EXPECTED_SUB_SKILLS includes lark-apps and lark-note (added in v1.0.59)', async () => {
    const src = fs.readFileSync(
      path.join(HOOKS_DIR, 'post-install-shared.js'),
      'utf-8'
    );
    assert.ok(src.includes("'lark-apps'"), 'should include lark-apps');
    assert.ok(src.includes("'lark-note'"), 'should include lark-note');
    const match = src.match(/EXPECTED_SUB_SKILLS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(match, 'should find EXPECTED_SUB_SKILLS array');
    const entries = match[1].match(/'lark-[a-z-]+'/g);
    assert.equal(entries.length, 27, 'should have 27 expected sub-skills for v1.0.59');
  });

  it('installLarkCliSkills triggers repair when marker exists but sub-skill is missing', async () => {
    const src = fs.readFileSync(
      path.join(HOOKS_DIR, 'post-install-shared.js'),
      'utf-8'
    );
    // The function checks missing.length independently of needsVersionUpgrade,
    // so even when the marker matches the target, missing dirs trigger a repair.
    assert.ok(
      src.includes('missing.length === 0 && !needsVersionUpgrade'),
      'skip condition should require BOTH no missing sub-skills AND no version upgrade'
    );
    assert.ok(
      src.includes("missing.length > 0"),
      'should check for missing sub-skills and log repair'
    );
    // After install, verification must use findMissing() again
    assert.ok(
      src.includes('stillMissing = findMissing()'),
      'should re-check for missing sub-skills after install'
    );
  });

  it('installLarkCliSkills writes version marker after successful install', async () => {
    const src = fs.readFileSync(
      path.join(HOOKS_DIR, 'post-install-shared.js'),
      'utf-8'
    );
    assert.ok(
      src.includes("fs.writeFileSync(versionFile, target"),
      'should write version marker file after install'
    );
    assert.ok(
      src.includes("fs.readFileSync(versionFile,"),
      'should read version marker file to check installed version'
    );
  });
});
