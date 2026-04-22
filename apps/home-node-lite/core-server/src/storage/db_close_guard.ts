/**
 * Task 4.87 — signal-safe DB close.
 *
 * SIGINT / SIGTERM trigger the graceful-shutdown coordinator (task
 * 4.9, `src/shutdown.ts`). This module is the DB-close step that
 * plugs into that coordinator — it formalises the checkpoint-then-
 * close ordering that keeps the vault consistent even if the process
 * is subsequently SIGKILL'd.
 *
 * **Invariant** (SQLite WAL-mode semantics, mirrored here):
 *   1. `checkpoint()` flushes the WAL into the main DB file.
 *   2. `close()` releases the file descriptor + the WAL lock.
 *   3. Each step has its own timeout budget — a hung checkpoint
 *      can't block the close, and a hung close can't deadlock the
 *      shutdown coordinator past its overall budget.
 *
 * **Under SIGKILL**: no hook runs. The DB's durability story then
 * depends on:
 *   - WAL mode (writes survive a kill because they've been fsync'd
 *     to the WAL before the commit returned).
 *   - Idempotent handlers (workflow task 4.82 guarantees safe replay).
 * This module's job is to make SIGINT / SIGTERM paths as clean as
 * possible; SIGKILL survivability comes from the storage layer.
 *
 * **DB-handle agnostic**: the `DatabaseHandle` interface is just
 * `checkpoint()` + `close()` — any SQLCipher / op-sqlite / wasm
 * backend satisfies it. Tests pass mocks.
 *
 * **Event stream** surfaces every phase so `shutdown.ts` can log the
 * transition sequence even when checkpoint or close times out.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4l task 4.87.
 */

export interface DatabaseHandle {
  /**
   * Flush WAL → main file. SQLite's
   * `PRAGMA wal_checkpoint(TRUNCATE)` is the reference. Must be
   * async and MUST NOT throw on already-truncated WAL — idempotent.
   */
  checkpoint(): Promise<void>;
  /**
   * Release file descriptors + drop locks. Safe to call even after
   * a failed checkpoint (the WAL still preserves durability; the
   * next open will re-run recovery).
   */
  close(): Promise<void>;
}

export type DbCloseStage = 'checkpoint' | 'close';

export type DbCloseEvent =
  | { kind: 'stage_start'; stage: DbCloseStage }
  | {
      kind: 'stage_ok';
      stage: DbCloseStage;
      durationMs: number;
    }
  | {
      kind: 'stage_failed';
      stage: DbCloseStage;
      durationMs: number;
      error: string;
    }
  | {
      kind: 'stage_timeout';
      stage: DbCloseStage;
      timeoutMs: number;
    };

export interface SafeDbCloseOptions {
  /** The DB handle to close. Required. */
  handle: DatabaseHandle;
  /**
   * Timeout for the checkpoint step. Default 5s — enough for a
   * several-MB WAL even on slow disks.
   */
  checkpointTimeoutMs?: number;
  /**
   * Timeout for the close step. Default 2s — close is fast by design;
   * a hung close usually means a file-lock contention that no amount
   * of waiting will resolve.
   */
  closeTimeoutMs?: number;
  /**
   * When true, attempts the close step even if checkpoint failed.
   * Default true — a failed checkpoint still leaves the DB consistent
   * (WAL is durable), and we should still release file handles.
   */
  closeOnCheckpointFail?: boolean;
  /** Injectable clock. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Injectable timer functions — tests pass deterministic variants. */
  setTimerFn?: (fn: () => void, ms: number) => unknown;
  clearTimerFn?: (handle: unknown) => void;
  /** Diagnostic hook. */
  onEvent?: (event: DbCloseEvent) => void;
}

export const DEFAULT_CHECKPOINT_TIMEOUT_MS = 5_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export interface SafeDbCloseResult {
  checkpointOk: boolean;
  closeOk: boolean;
  /** Reason strings if any stage failed; keyed by stage. */
  errors: Partial<Record<DbCloseStage, string>>;
}

/**
 * Run the checkpoint-then-close sequence with per-stage timeouts.
 * Never throws — returns structured result so the coordinator can
 * log the outcome + decide whether to proceed with the next
 * shutdown step.
 */
export async function safeDbClose(
  opts: SafeDbCloseOptions,
): Promise<SafeDbCloseResult> {
  const { handle } = opts;
  if (!handle) {
    throw new Error('safeDbClose: handle is required');
  }
  const checkpointTimeoutMs =
    opts.checkpointTimeoutMs ?? DEFAULT_CHECKPOINT_TIMEOUT_MS;
  const closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const closeOnCheckpointFail = opts.closeOnCheckpointFail ?? true;
  const nowMsFn = opts.nowMsFn ?? Date.now;
  const setTimerFn =
    opts.setTimerFn ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimerFn =
    opts.clearTimerFn ??
    ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));

  const onEvent = opts.onEvent;
  const errors: Partial<Record<DbCloseStage, string>> = {};

  // ── Phase 1: checkpoint ───────────────────────────────────────────────
  onEvent?.({ kind: 'stage_start', stage: 'checkpoint' });
  const cpStart = nowMsFn();
  let checkpointOk = false;
  try {
    await runWithTimeout(
      () => handle.checkpoint(),
      checkpointTimeoutMs,
      'checkpoint',
      setTimerFn,
      clearTimerFn,
    );
    checkpointOk = true;
    onEvent?.({
      kind: 'stage_ok',
      stage: 'checkpoint',
      durationMs: nowMsFn() - cpStart,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'timeout:checkpoint') {
      onEvent?.({
        kind: 'stage_timeout',
        stage: 'checkpoint',
        timeoutMs: checkpointTimeoutMs,
      });
      errors.checkpoint = `timeout after ${checkpointTimeoutMs}ms`;
    } else {
      onEvent?.({
        kind: 'stage_failed',
        stage: 'checkpoint',
        durationMs: nowMsFn() - cpStart,
        error: msg,
      });
      errors.checkpoint = msg;
    }
  }

  // ── Phase 2: close ────────────────────────────────────────────────────
  if (!checkpointOk && !closeOnCheckpointFail) {
    return { checkpointOk, closeOk: false, errors };
  }

  onEvent?.({ kind: 'stage_start', stage: 'close' });
  const clStart = nowMsFn();
  let closeOk = false;
  try {
    await runWithTimeout(
      () => handle.close(),
      closeTimeoutMs,
      'close',
      setTimerFn,
      clearTimerFn,
    );
    closeOk = true;
    onEvent?.({
      kind: 'stage_ok',
      stage: 'close',
      durationMs: nowMsFn() - clStart,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'timeout:close') {
      onEvent?.({
        kind: 'stage_timeout',
        stage: 'close',
        timeoutMs: closeTimeoutMs,
      });
      errors.close = `timeout after ${closeTimeoutMs}ms`;
    } else {
      onEvent?.({
        kind: 'stage_failed',
        stage: 'close',
        durationMs: nowMsFn() - clStart,
        error: msg,
      });
      errors.close = msg;
    }
  }

  return { checkpointOk, closeOk, errors };
}

/**
 * Wrap a promise in a timeout. Throws `Error("timeout:<label>")` on
 * expiry so the caller can discriminate timeouts from operation
 * errors via the message prefix.
 */
async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
  setTimerFn: (fn: () => void, ms: number) => unknown,
  clearTimerFn: (handle: unknown) => void,
): Promise<T> {
  let timer: unknown = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimerFn(() => {
        reject(new Error(`timeout:${label}`));
      }, timeoutMs);
      fn().then(
        (v) => {
          if (timer !== null) clearTimerFn(timer);
          resolve(v);
        },
        (err) => {
          if (timer !== null) clearTimerFn(timer);
          reject(err);
        },
      );
    });
  } finally {
    if (timer !== null) clearTimerFn(timer);
  }
}
