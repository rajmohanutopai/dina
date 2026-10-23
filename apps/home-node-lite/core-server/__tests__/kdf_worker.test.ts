/**
 * HOSTED_DINA §5 — the gate's passphrase check runs on a worker thread and
 * gives the same answer as `unwrapSeed`, without the event loop stalling.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateMnemonic, mnemonicToEntropy, unwrapSeed, wrapSeed } from '@dina/core';

import { CHECK_TIMEOUT_MS, createWorkerChecker } from '../src/cell/kdf_worker';

import type * as net from 'node:net';

describe('the gate’s off-thread passphrase check', () => {
  it('opens with the right passphrase only, matching unwrapSeed, and leaves the event loop free', async () => {
    const seed = mnemonicToEntropy(generateMnemonic());
    const wrapped = await wrapSeed('the right passphrase', seed);
    await expect(unwrapSeed('the right passphrase', wrapped)).resolves.toBeDefined();
    const checker = createWorkerChecker();
    try {
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 20);
      const result = await checker.check('the right passphrase', wrapped);
      clearInterval(timer);
      expect(result).toBe('opened');
      // The main thread kept running while Argon2 worked elsewhere.
      expect(ticks).toBeGreaterThan(3);
      expect(await checker.check('a wrong passphrase', wrapped)).toBe('wrong');
    } finally {
      await checker.close();
    }
  }, 60_000);
});

describe('the gate’s turn among all cells', () => {
  it('asks once, waits for go, gives the turn back, and returns a turn nobody waits for', async () => {
    // The child is a gate using fd 3; this test plays the provisioner on the other end.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
    const script = path.join(dir, 'gate.ts');
    fs.writeFileSync(
      script,
      `import { createSlotClient } from ${JSON.stringify(path.resolve(__dirname, '../src/cell/kdf_worker'))};\n` +
        `const slot = createSlotClient(3, { fresh: 400, repeat: 400 });\n` +
        `const keep = setInterval(() => {}, 1000);\n` +
        `(async () => {\n` +
        `  const give = await slot(true);\n` +
        `  process.stdout.write('got\\n');\n` +
        `  give(); give();\n` +
        `  await slot(false).then(() => process.stdout.write('unexpected\\n'), () => process.stdout.write('timed out\\n'));\n` +
        `  setTimeout(() => { clearInterval(keep); }, 600);\n` +
        `})();\n`,
    );
    try {
      const gate = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
      });
      const prov = gate.stdio[3] as net.Socket;
      let fromGate = '';
      let out = '';
      prov.on('data', (d: Buffer) => (fromGate += d.toString()));
      gate.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      const until = async (ok: () => boolean): Promise<void> => {
        for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      };
      await until(() => fromGate === 'want fresh\n');
      expect(out).toBe(''); // no turn yet
      prov.write('go\n');
      await until(() => out.includes('got'));
      await until(() => fromGate.split('\n').length >= 4);
      // One `done` for two calls to give back; then a repeat guess asks.
      expect(fromGate).toBe('want fresh\ndone\nwant repeat\n');
      await until(() => out.includes('timed out'));
      prov.write('go\n'); // late: nobody waits, so it goes straight back
      await until(() => fromGate.endsWith('done\n'));
      expect(fromGate).toBe('want fresh\ndone\nwant repeat\ndone\n');
      expect(out).not.toContain('unexpected');
      gate.kill();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('a waiting ask taken over by a check of the other kind', () => {
  it('is relabelled on the wire, so an owner never rides a guesser’s repeat ask', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
    const script = path.join(dir, 'gate.ts');
    fs.writeFileSync(
      script,
      `import { createSlotClient } from ${JSON.stringify(path.resolve(__dirname, '../src/cell/kdf_worker'))};\n` +
        `const slot = createSlotClient(3, { fresh: 400, repeat: 400 });\n` +
        `const keep = setInterval(() => {}, 1000);\n` +
        `const say = (s: string) => process.stdout.write(s + '\\n');\n` +
        `(async () => {\n` +
        `  await slot(false).then(() => say('unexpected'), () => say('guess timed out'));\n` +
        `  const give = await slot(true);\n` +
        `  say('owner got');\n` +
        `  give();\n` +
        `  await slot(true).then(() => say('unexpected'), () => say('owner timed out'));\n` +
        `  await slot(false).then(() => say('unexpected'), () => say('guess timed out again'));\n` +
        `  setTimeout(() => { clearInterval(keep); }, 300);\n` +
        `})();\n`,
    );
    try {
      const gate = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
      });
      const prov = gate.stdio[3] as net.Socket;
      let fromGate = '';
      let out = '';
      prov.on('data', (d: Buffer) => (fromGate += d.toString()));
      gate.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      const until = async (ok: () => boolean): Promise<void> => {
        for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
      };
      // A guess times out; the owner's check takes over its ask and moves it
      // to the fresh queue.
      await until(() => fromGate === 'want repeat\nwant fresh\n');
      expect(fromGate).toBe('want repeat\nwant fresh\n');
      expect(out).toBe('guess timed out\n');
      prov.write('go\n');
      await until(() => out.includes('owner got'));
      // Then an owner's ask times out and a guess takes it over: back to repeat.
      await until(() => out.includes('guess timed out again'));
      expect(fromGate).toBe('want repeat\nwant fresh\ndone\nwant fresh\nwant repeat\n');
      expect(out).not.toContain('unexpected');
      gate.kill();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('a stuck or dead check', () => {
  it('is a fault, and the same checker runs the next check on a fresh worker', async () => {
    const seed = mnemonicToEntropy(generateMnemonic());
    const wrapped = await wrapSeed('the right passphrase', seed);
    const checker = createWorkerChecker();
    try {
      // Far less than one Argon2 run: the worker is ended mid-check.
      expect(await checker.check('the right passphrase', wrapped, 5)).toBe('fault');
      // At once, on the same checker: the old worker's late exit must not
      // touch this job, which runs on a new worker.
      expect(await checker.check('the right passphrase', wrapped)).toBe('opened');
      expect(await checker.check('a wrong passphrase', wrapped)).toBe('wrong');
    } finally {
      await checker.close();
    }
  }, 60_000);

  it('a turn is never taken back from a check that still runs', () => {
    const hosting = fs.readFileSync(
      path.resolve(__dirname, '../../../../cli/src/dina_cli/hosting.py'),
      'utf8',
    );
    const hold = Number(/^KDF_HOLD_SECONDS = ([0-9.]+)/m.exec(hosting)?.[1]);
    expect(hold).toBeGreaterThan(0);
    expect(CHECK_TIMEOUT_MS).toBeLessThan(hold * 1000);
  });
});
