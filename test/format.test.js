import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SMART_MODE_HINT } from '../src/lib/format.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Verbatim from zylos-component-template references/channel-standards.md 11.6.
const STANDARD_SMART_MODE_HINT = "Decide whether to respond. Do NOT reply if: the message is unrelated to you, just casual chat, or doesn't need your input. Only reply when: 1) someone asks a question you can help with, 2) the discussion is on a topic you can substantially help with, 3) someone clearly needs assistance. When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.";

test('SMART_MODE_HINT is the component-template standard text (#110)', () => {
  assert.equal(SMART_MODE_HINT, STANDARD_SMART_MODE_HINT);
});

test('formatMessage puts SMART_MODE_HINT, and no other hint text, in the <smart-mode> block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /import \{ SMART_MODE_HINT \} from '\.\/lib\/format\.js';/);
  const format = src.slice(src.indexOf('function formatMessage('), src.indexOf('function extractPostText('));
  assert.ok(format.includes('if (smartHint) {\n    parts.push(`<smart-mode>\\n${SMART_MODE_HINT}\\n</smart-mode>\\n\\n`);\n  }'));
  assert.ok(!src.includes('Decide whether to respond'), 'no inline hint text left in index.js');
});
