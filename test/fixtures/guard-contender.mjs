/**
 * Child process for test/restart-guard-lock.test.js (not a test file).
 * Builds a restart guard on a shared state file, reports 'ready', blocks on a
 * barrier (GO_FILE appearing), then calls tryAcquire() and prints the verdict.
 * Env: STATE_FILE, GO_FILE, LOCK_MODE ('full' | 'none' | 'write-only', the
 * latter two are test-only mutants), WIDEN_MS (delay between read and write
 * inside the transaction, widening the race window identically for all modes).
 */
import fs from 'node:fs';
import { createRestartGuard } from '../../src/lib/transport/restart-guard.js';

const { STATE_FILE, GO_FILE, LOCK_MODE = 'full', WIDEN_MS = '0' } = process.env;
const widen = Number(WIDEN_MS);
const guard = createRestartGuard({
  file: STATE_FILE,
  _lockMode: LOCK_MODE,
  _afterRead: widen > 0 ? () => new Promise((r) => setTimeout(r, widen)) : null,
});

process.stdout.write('ready\n');
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(GO_FILE)) Atomics.wait(cell, 0, 0, 1);

const verdict = await guard.tryAcquire('pong-timeout');
process.stdout.write(`${JSON.stringify({ pid: process.pid, verdict })}\n`);
