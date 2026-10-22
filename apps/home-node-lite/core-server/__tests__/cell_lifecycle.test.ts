/**
 * HOSTED_DINA §5, §7 — a hosted cell's Core lives only as long as its gate, and
 * never starts beside a Core that still answers on its socket.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { socketAnswers, watchParent } from '../src/server/cell_lifecycle';

describe('a cell Core and its gate', () => {
  it('closes and exits when the gate that holds the pipe goes away', async () => {
    // This test is the gate; the child is a Core that watches fd 3. Closing
    // our end, as a dying gate's OS does, must make the child close and exit.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    const script = path.join(dir, 'core.ts');
    fs.writeFileSync(
      script,
      `import { watchParent } from ${JSON.stringify(path.resolve(__dirname, '../src/server/cell_lifecycle'))};\n` +
        `watchParent({ env: { DINA_PARENT_WATCH_FD: '3' }, logger: { warn: () => undefined },\n` +
        `  close: async () => { process.stdout.write('closed\\n'); }, exit: (c) => process.exit(c) });\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    try {
      const core = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'inherit', 'pipe'],
      });
      let out = '';
      core.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      await new Promise((r) => setTimeout(r, 1500));
      (core.stdio[3] as net.Socket).destroy();
      const code = await new Promise<number | null>((resolve) => core.on('exit', resolve));
      expect(code).toBe(0);
      expect(out).toContain('closed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('exits on a deadline when the graceful close never settles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    const script = path.join(dir, 'core.ts');
    fs.writeFileSync(
      script,
      `import { watchParent } from ${JSON.stringify(path.resolve(__dirname, '../src/server/cell_lifecycle'))};\n` +
        `watchParent({ env: { DINA_PARENT_WATCH_FD: '3' }, logger: { warn: () => undefined },\n` +
        `  close: () => new Promise(() => undefined), graceMs: 300, exit: (c) => process.exit(c) });\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    try {
      const core = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: path.resolve(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
      });
      await new Promise((r) => setTimeout(r, 1500));
      const t0 = Date.now();
      (core.stdio[3] as net.Socket).destroy();
      const code = await new Promise<number | null>((resolve) => core.on('exit', resolve));
      expect(code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does nothing without the variable, and refuses the standard streams', () => {
    const close = jest.fn(async () => undefined);
    watchParent({ env: {}, logger: { warn: () => undefined }, close });
    expect(close).not.toHaveBeenCalled();
    expect(() =>
      watchParent({ env: { DINA_PARENT_WATCH_FD: '1' }, logger: { warn: () => undefined }, close }),
    ).toThrow(/3 or above/);
  });

  it('tells a live socket from a stale file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
    const sock = path.join(dir, 's.sock');
    try {
      expect(await socketAnswers(sock)).toBe(false);
      const server = net.createServer();
      await new Promise<void>((r) => server.listen(sock, () => r()));
      expect(await socketAnswers(sock)).toBe(true);
      await new Promise<void>((r) => server.close(() => r()));
      fs.writeFileSync(sock, '');
      expect(await socketAnswers(sock)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
