/**
 * Passphrase checks for a cell's gate, off its event loop (HOSTED_DINA §5).
 *
 * A check is a 128 MiB Argon2id run (the wrap's own parameters) followed by an
 * AES-256-GCM open of the wrapped seed: the same work as `unwrapSeed` in
 * `@dina/core`. Run on the gate's only thread it would freeze the gate for a
 * second or two per guess, owner included. Here one worker thread does them,
 * one at a time, while the gate keeps answering; the gate decides the order.
 * The worker answers only "opened" or "did not open", never the seed.
 */

import * as net from 'node:net';
import { Worker } from 'node:worker_threads';

import type { WrappedSeed } from '@dina/core';

// Plain CommonJS, run with `eval: true`: no TypeScript loader is needed in the
// worker, under tsx or under jest alike.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const { argon2id } = require(workerData.hashWasm);
parentPort.on('message', async (job) => {
  let kek;
  try {
    kek = await argon2id({
      password: job.passphrase,
      salt: job.salt,
      iterations: job.params.iterations,
      memorySize: job.params.memory,
      parallelism: job.params.parallelism,
      hashLength: 32,
      outputType: 'binary',
    });
  } catch {
    // No memory, a bad wrap: a fault, never a wrong passphrase.
    parentPort.postMessage({ id: job.id, result: 'fault' });
    return;
  }
  let result = 'opened';
  try {
    const w = job.wrapped;
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, w.subarray(0, 12));
    decipher.setAuthTag(w.subarray(w.length - 16));
    decipher.update(w.subarray(12, w.length - 16));
    decipher.final();
  } catch {
    result = 'wrong';
  }
  parentPort.postMessage({ id: job.id, result });
});
`;

/**
 * `fault`: the check could not run (no memory, a dead or stuck worker), so
 * it says nothing about the passphrase and must not count as a wrong one.
 */
export type CheckResult = 'opened' | 'wrong' | 'fault';

export interface PassphraseChecker {
  check(passphrase: string, wrapped: WrappedSeed, timeoutMs?: number): Promise<CheckResult>;
  close(): Promise<void>;
}

/**
 * A check that has not answered in this long (Argon2 takes a second or two)
 * is a fault and its worker ends. Shorter than the provisioner's hold on a
 * turn (`KDF_HOLD_SECONDS`, 30 s, in `hosting.py`): a turn is never taken
 * back from a check that still runs, so the machine's limit holds.
 */
export const CHECK_TIMEOUT_MS = 20_000;

export function createWorkerChecker(timeoutMs = CHECK_TIMEOUT_MS): PassphraseChecker {
  let worker: Worker | null = null;
  let nextId = 0;
  // Jobs by worker, so a dead worker fails only its own jobs, never a newer one's.
  const waiting = new Map<Worker, Map<number, (result: CheckResult) => void>>();

  const start = (): Worker => {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { hashWasm: require.resolve('hash-wasm') },
    });
    const jobs = new Map<number, (result: CheckResult) => void>();
    waiting.set(w, jobs);
    w.on('message', (msg: { id: number; result: CheckResult }) => {
      const result = msg.result === 'opened' || msg.result === 'wrong' ? msg.result : 'fault';
      jobs.get(msg.id)?.(result);
      jobs.delete(msg.id);
    });
    const fail = (): void => {
      // A dead worker checks nothing; the next check starts a new one.
      for (const resolve of jobs.values()) resolve('fault');
      jobs.clear();
      waiting.delete(w);
      if (worker === w) worker = null;
    };
    w.on('error', fail);
    w.on('exit', fail);
    return w;
  };

  return {
    check(passphrase, wrapped, limitMs = timeoutMs) {
      worker ??= start();
      const w = worker;
      const jobs = waiting.get(w);
      const id = ++nextId;
      return new Promise<CheckResult>((resolve) => {
        if (jobs === undefined) {
          resolve('fault');
          return;
        }
        const timer = setTimeout(() => {
          // Stuck: fail this check and every other on that worker, and end it.
          if (worker === w) worker = null;
          void w.terminate();
        }, limitMs);
        jobs.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        w.postMessage({
          id,
          passphrase,
          salt: wrapped.salt,
          wrapped: wrapped.wrapped,
          params: wrapped.params,
        });
      });
    },
    async close() {
      const all = [...waiting.keys()];
      worker = null;
      await Promise.all(all.map((w) => w.terminate()));
    },
  };
}

/**
 * Wait for a turn among all cells; resolves with the function that gives it
 * back. `fresh`: the client has no recent failure (the owner, most likely),
 * and the provisioner serves such turns first across the whole machine.
 */
export type KdfSlot = (fresh: boolean) => Promise<() => void>;

/** How long a check waits for a turn: a repeat guesser gives up sooner. */
export const FRESH_TURN_WAIT_MS = 20_000;
export const REPEAT_TURN_WAIT_MS = 5_000;

/**
 * The machine-wide limit on passphrase checks, asked of the provisioner over
 * the gate's own socket pair (`DINA_CELL_KDF_FD`; `hosting.py` `KdfSlots`).
 * One line each way: `want fresh` or `want repeat`, then `go` when a slot
 * frees, then `done`. Only turns cross the socket, never a passphrase. A turn
 * that does not come in time fails the check as busy; if it comes later it
 * goes to the next check waiting, or straight back. The gate asks for one turn
 * at a time; when a check of the other kind takes over a waiting ask, the gate
 * sends that kind's `want` and the provisioner moves the ask to its queue.
 */
export function createSlotClient(
  fd: number,
  waits: { fresh: number; repeat: number } = {
    fresh: FRESH_TURN_WAIT_MS,
    repeat: REPEAT_TURN_WAIT_MS,
  },
): KdfSlot {
  const sock = new net.Socket({ fd, readable: true, writable: true });
  let asked: 'fresh' | 'repeat' | null = null; // a `want` is out, its `go` not come
  let waiter: (() => void) | null = null;
  let closed = false;
  let buffered = '';
  const failWaiter = (): void => {
    closed = true;
    waiter = null;
  };
  sock.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line !== 'go' || asked === null) continue;
      asked = null;
      const w = waiter;
      waiter = null;
      if (w !== null) w();
      else sock.write('done\n'); // nobody is waiting any more
    }
  });
  sock.on('error', failWaiter);
  sock.on('close', failWaiter);
  // The provisioner may be gone; this socket must not keep the gate alive.
  sock.unref();

  return (fresh) =>
    new Promise<() => void>((resolve, reject) => {
      if (closed) {
        reject(new Error('no slot service'));
        return;
      }
      const timer = setTimeout(
        () => {
          waiter = null;
          reject(new Error('no slot in time'));
        },
        fresh ? waits.fresh : waits.repeat,
      );
      waiter = () => {
        clearTimeout(timer);
        let given = false;
        resolve(() => {
          if (given) return;
          given = true;
          if (!closed) sock.write('done\n');
        });
      };
      const kind = fresh ? 'fresh' : 'repeat';
      if (asked !== kind) {
        asked = kind;
        sock.write(`want ${kind}\n`);
      }
    });
}
