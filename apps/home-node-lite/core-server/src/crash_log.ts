/**
 * Task 4.11 — crash-log writer.
 *
 * Top-level traps for `uncaughtException` + `unhandledRejection`. On
 * each, writes a structured crash entry via the injected sink (in
 * prod: the `crash_log` SQLCipher table; today: a pluggable writer
 * interface, since storage-node is pending). After writing, logs the
 * crash to stderr and exits with code 2.
 *
 * **Why a dedicated writer, not just the logger?** The `crash_log`
 * table is a durable, queryable record that survives logger flush
 * loss. It's the first thing ops looks at on a restart — "what did we
 * miss?" — and it's schema'd to carry the process-start time, the
 * stack, and the trap kind without relying on free-text log parsing.
 *
 * **Fail-safe exit.** Even if the writer itself throws, we still exit.
 * A crashed process that refuses to die is worse than one that does.
 *
 * **Flush before exit.** The logger may have buffered entries — give
 * it a short synchronous window to flush before process.exit().
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a task 4.11.
 */

import type { Logger } from './logger';

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

export interface CrashEntry {
  /** RFC3339 timestamp when the trap fired. */
  at: string;
  /** Which Node top-level trap fired. */
  kind: CrashKind;
  /** Error message (or the rejected value's `.message` / JSON shape). */
  message: string;
  /** Stack trace when available. */
  stack?: string;
  /** `err.code` when present (e.g. `ENOTFOUND`, `ECONNREFUSED`). */
  code?: string;
  /** Process-start epoch-ms for correlation across restarts. */
  processStartMs: number;
}

/**
 * Abstract writer — `storage-node`'s `crash_log` table implements
 * this. Tests inject in-memory recorders. Must be synchronous-safe
 * when possible (use `.then()` to drain before exit).
 */
export interface CrashLogWriter {
  write(entry: CrashEntry): void | Promise<void>;
}

/** In-memory writer — tests + early development use this. */
export class InMemoryCrashLogWriter implements CrashLogWriter {
  readonly entries: CrashEntry[] = [];
  write(entry: CrashEntry): void {
    this.entries.push(entry);
  }
}

export interface InstallCrashLogOptions {
  logger: Logger;
  writer: CrashLogWriter;
  /** Process exit hook — injected for tests. Default: `process.exit`. */
  exit?: (code: number) => void;
  /** Max wait for logger flush before forcing exit. Default: 100ms. */
  flushTimeoutMs?: number;
}

/**
 * Wire `uncaughtException` + `unhandledRejection` → crash log + exit.
 * Returns a deregister function.
 *
 * **Call once.** Registering twice doubles the traps — the second
 * call's deregister removes only its own handlers.
 */
export function installCrashLogHandlers(opts: InstallCrashLogOptions): () => void {
  const { logger, writer } = opts;
  const exit = opts.exit ?? ((code) => process.exit(code));
  const flushMs = opts.flushTimeoutMs ?? 100;
  const processStartMs = Date.now();

  const handle = async (kind: CrashKind, err: unknown): Promise<void> => {
    const entry: CrashEntry = {
      at: new Date().toISOString(),
      kind,
      ...extractErrorFields(err),
      processStartMs,
    };

    // Best-effort write. If the writer throws, log + continue.
    try {
      await writer.write(entry);
    } catch (writeErr) {
      logger.error(
        { writeErr: (writeErr as Error).message, originalKind: kind },
        'crash-log writer failed — still exiting',
      );
    }

    // Log the crash to the standard stream too so ops sees it without
    // needing to query the crash_log table.
    logger.fatal(
      { kind, message: entry.message, stack: entry.stack, code: entry.code },
      'process crashed',
    );

    // Give pino a short sync-ish window to flush. Without this, the
    // "process crashed" log line may be lost on exit.
    setTimeout(() => exit(2), flushMs).unref();
  };

  const onUncaught = (err: Error): void => void handle('uncaughtException', err);
  const onRejection = (reason: unknown): void => void handle('unhandledRejection', reason);

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractErrorFields(err: unknown): {
  message: string;
  stack?: string;
  code?: string;
} {
  if (err instanceof Error) {
    const withCode = err as Error & { code?: unknown };
    return {
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
      ...(typeof withCode.code === 'string' ? { code: withCode.code } : {}),
    };
  }
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}
