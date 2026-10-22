/**
 * Two rules that keep a hosted cell's Core single (HOSTED_DINA §5, §7).
 *
 * - A Core that finds its socket answered by someone refuses to start: two
 *   Cores on one vault would be two writers and two nodes signing as one DID.
 * - A Core started by a cell's gate lives only as long as the gate. The gate
 *   holds the write end of a pipe and Core watches the read end
 *   (`DINA_PARENT_WATCH_FD`); when the gate dies for any reason the pipe
 *   ends, and Core closes and exits, taking its keys with it.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';

/** True when something accepts a connection on this Unix socket. */
export function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

export interface WatchParentOptions {
  env?: NodeJS.ProcessEnv;
  logger: { warn: (o: object, m: string) => void };
  close: () => Promise<unknown>;
  exit?: (code: number) => void;
  /** How long a graceful close may take before the process exits anyway (default 5 s). */
  graceMs?: number;
}

/** Close and exit when the watched pipe ends. A no-op without `DINA_PARENT_WATCH_FD`. */
export function watchParent(opts: WatchParentOptions): void {
  const raw = ((opts.env ?? process.env).DINA_PARENT_WATCH_FD ?? '').trim();
  if (raw === '') return;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 3) throw new Error('DINA_PARENT_WATCH_FD must be 3 or above');
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const watch = fs.createReadStream('', { fd, autoClose: true });
  let gone = false;
  const leave = (): void => {
    if (gone) return;
    gone = true;
    opts.logger.warn({}, 'the gate that started this Core is gone; closing');
    // A close that never settles (an open request, a stuck hook) must not
    // keep the keys in memory: the deadline exits whatever is still open.
    const deadline = setTimeout(() => exit(0), opts.graceMs ?? 5_000);
    void Promise.resolve()
      .then(() => opts.close())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(deadline);
        exit(0);
      });
  };
  watch.on('data', () => undefined);
  watch.on('end', leave);
  watch.on('close', leave);
  watch.on('error', leave);
}
