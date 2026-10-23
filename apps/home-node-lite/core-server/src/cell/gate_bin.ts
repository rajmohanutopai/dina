/**
 * Entry point for a hosted cell's gate (HOSTED_DINA §3.1). The provisioner
 * starts it as the cell's OS user:
 *
 *   DINA_CELL_VAULT_DIR    Core's vault folder
 *   DINA_CELL_CORE_SOCKET  the Unix socket Core listens on
 *   DINA_CELL_LISTEN       where the gate listens: `unix:/path` (behind the
 *                          cell's TLS front) or `tcp:127.0.0.1:port` (local test)
 *   DINA_CELL_CORE_COMMAND JSON array: how to run Core (e.g. tsx + src/bin.ts)
 *   DINA_CELL_CORE_CWD     Core's working folder
 *   DINA_CELL_CORE_LOG     file Core's output goes to (metadata-only logs)
 *   DINA_CELL_EVENTS_FD    inherited fd the gate reports events on, one JSON line each
 *   DINA_CELL_KDF_FD       inherited socket the gate asks the provisioner on for a
 *                          turn before each passphrase check (all cells share them)
 *   DINA_CELL_FRONT_DOOR   the front door's origin, the one place sign-up returns to
 *
 * Every other variable passes through to Core (PDS, MsgBox, AppView, handle).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { createGate, type CoreHandle, type GateEvent } from './gate';
import { createSlotClient, type KdfSlot } from './kdf_worker';

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value === '') throw new Error(`${name} is required`);
  return value;
}

function eventSink(): (event: GateEvent) => void {
  const raw = (process.env.DINA_CELL_EVENTS_FD ?? '').trim();
  if (raw === '') return () => undefined;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 3) throw new Error('DINA_CELL_EVENTS_FD must be 3 or above');
  const stream = fs.createWriteStream('', { fd, autoClose: true });
  return (event) => {
    stream.write(`${JSON.stringify(event)}\n`);
  };
}

function kdfSlot(): KdfSlot | undefined {
  const raw = (process.env.DINA_CELL_KDF_FD ?? '').trim();
  if (raw === '') return undefined;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 3) throw new Error('DINA_CELL_KDF_FD must be 3 or above');
  return createSlotClient(fd);
}

function coreEnv(vaultDir: string, socket: string, gateKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DINA_CELL_') || k === 'DINA_UNLOCK_PASSPHRASE') continue;
    env[k] = v;
  }
  return {
    ...env,
    DINA_VAULT_DIR: vaultDir,
    DINA_CORE_SOCKET: socket,
    DINA_UNLOCK_PASSPHRASE_FD: '3',
    DINA_BOOTSTRAP_HANDOFF_FD: '4',
    DINA_BOOTSTRAP_SCOPE: 'dot',
    // Readable only by the cell's own user (/proc/<pid>/environ).
    DINA_GATE_KEY: gateKey,
    // Core exits when this pipe ends, which is when the gate dies.
    DINA_PARENT_WATCH_FD: '5',
    DINA_CORE_OWNER_CONSOLE: '1',
  };
}

function spawner(
  vaultDir: string,
  socket: string,
): (passphrase: string, gateKey: string) => CoreHandle {
  const command = JSON.parse(required('DINA_CELL_CORE_COMMAND')) as unknown;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((c) => typeof c !== 'string')
  ) {
    throw new Error('DINA_CELL_CORE_COMMAND must be a JSON array of strings');
  }
  const [bin = '', ...args] = command as string[];
  const cwd = (process.env.DINA_CELL_CORE_CWD ?? '').trim() || process.cwd();
  const logPath = (process.env.DINA_CELL_CORE_LOG ?? '').trim();
  return (passphrase, gateKey) => {
    const log = logPath === '' ? 'ignore' : fs.openSync(logPath, 'a', 0o600);
    const child = spawn(bin, args, {
      cwd,
      env: coreEnv(vaultDir, socket, gateKey),
      stdio: ['ignore', log, log, 'pipe', 'pipe', 'pipe'],
    });
    if (typeof log === 'number') fs.closeSync(log);
    // The passphrase goes down the pipe and is not kept here.
    (child.stdio[3] as NodeJS.WritableStream).end(passphrase);
    const bootstrap = new Promise<{ code: string; expiresAt: number } | null>((resolve) => {
      let text = '';
      const handoff = child.stdio[4] as NodeJS.ReadableStream;
      handoff.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      handoff.on('end', () => {
        try {
          const parsed = JSON.parse(text.trim()) as { code?: unknown; expiresAt?: unknown };
          resolve(
            typeof parsed.code === 'string' && typeof parsed.expiresAt === 'number'
              ? { code: parsed.code, expiresAt: parsed.expiresAt }
              : null,
          );
        } catch {
          resolve(null);
        }
      });
      handoff.on('error', () => resolve(null));
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code)),
    );
    return {
      bootstrap,
      exited,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(timer);
      },
    };
  };
}

async function main(): Promise<void> {
  const vaultDir = required('DINA_CELL_VAULT_DIR');
  const socket = required('DINA_CELL_CORE_SOCKET');
  const listen = required('DINA_CELL_LISTEN');
  // sun_path holds 104 bytes on macOS and 108 on Linux; a longer path fails at
  // connect time with EINVAL, so refuse it while the cause is still plain.
  for (const p of [socket, listen.startsWith('unix:') ? listen.slice(5) : '']) {
    if (Buffer.byteLength(p) > 100) throw new Error(`socket path too long: ${p}`);
  }
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  const slot = kdfSlot();
  const gate = createGate({
    vaultDir,
    coreSocket: socket,
    spawnCore: spawner(vaultDir, socket),
    emit: eventSink(),
    frontDoorOrigin: (process.env.DINA_CELL_FRONT_DOOR ?? '').trim(),
    // On a socket only the cell's Caddy can open, its forwarded address is the client.
    trustForwardedFor: listen.startsWith('unix:'),
    ...(slot !== undefined ? { kdfSlot: slot } : {}),
  });
  if (listen.startsWith('unix:')) {
    const p = listen.slice('unix:'.length);
    fs.rmSync(p, { force: true });
    await gate.app.listen({ path: p });
    // Only the cell's own user (its TLS front runs as it) may connect.
    fs.chmodSync(p, 0o600);
  } else if (listen.startsWith('tcp:')) {
    const [host, port] = listen.slice('tcp:'.length).split(/:(?=[0-9]+$)/);
    await gate.app.listen({ host: host ?? '127.0.0.1', port: Number(port) });
  } else {
    throw new Error('DINA_CELL_LISTEN must be unix:/path or tcp:host:port');
  }
  const shutdown = (): void => {
    void gate.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `cell gate failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
