/**
 * Task 5.42 — cognitive checkpoint scratchpad.
 *
 * Multi-step reasoning (guardian loop, nudge assembly, reminder
 * planning) must survive crash + restart so Brain can resume from the
 * last successful step instead of re-doing work that's already
 * grounded in the vault. This module is the thin primitive that
 * captures "where am I in a multi-step plan + what have I learned so
 * far".
 *
 * **Invariants** (mirrored from the Python reference in
 * `brain/src/service/scratchpad.py`):
 *
 *   1. **One checkpoint per `task_id`.**  Writes upsert — the latest
 *      step overwrites earlier ones for the same task. A step counter
 *      lets the reader know how far the task had progressed.
 *   2. **Accumulated context.**  The `context` dict is the *full*
 *      accumulated reasoning state (relationship data, extracted
 *      entities, partial LLM outputs), NOT just the delta from the
 *      last step. A resumed task skips every completed step.
 *   3. **Monotonic step.**  Out-of-order writes (e.g. step 2 then
 *      step 1) are rejected as `bad_step_order` — they indicate a
 *      bug in the caller's step ordering.
 *   4. **Clear after completion.**  Successful tasks call `clear()`
 *      so the backend can free storage immediately rather than
 *      waiting for the 24-hour sweeper.
 *   5. **Backend-agnostic.**  `ScratchpadBackend` is a 3-method port
 *      (write / read / clear). Production wires to Core's vault via
 *      the signed-HTTP client; tests pass `InMemoryScratchpadBackend`.
 *
 * **Why not just "call Core directly"?**  Three reasons:
 *   - Step-ordering validation is the planner's concern, not Core's
 *     — Core is a vault, not a workflow engine.
 *   - Context-size limits are Brain's concern (Core's upstream policy
 *     can't distinguish "this context is too big because the caller
 *     forgot to compact" from "this context is legitimately large").
 *   - The service layer wants an event stream for observability
 *     (admin UI shows "tasks in flight + last checkpoint step").
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.42.
 */

export type ScratchpadContext = Record<string, unknown>;

/** Persistence port. In production, the CoreClient adapter. */
export interface ScratchpadBackend {
  /**
   * Upsert the checkpoint for `taskId`. MUST be idempotent — callers
   * may retry on transient failure.
   */
  write(
    taskId: string,
    step: number,
    context: ScratchpadContext,
  ): Promise<void>;
  /** Return the latest checkpoint for `taskId`, or `null` if absent. */
  read(
    taskId: string,
  ): Promise<{ step: number; context: ScratchpadContext } | null>;
  /** Delete the checkpoint. Idempotent — missing task is not an error. */
  clear(taskId: string): Promise<void>;
}

export type ScratchpadEvent =
  | { kind: 'checkpoint_written'; taskId: string; step: number; keys: string[] }
  | { kind: 'resume_hit'; taskId: string; step: number }
  | { kind: 'resume_miss'; taskId: string }
  | { kind: 'cleared'; taskId: string }
  | { kind: 'rejected'; taskId: string; reason: ScratchpadRejectionReason };

export type ScratchpadRejectionReason =
  | 'empty_task_id'
  | 'non_positive_step'
  | 'bad_step_order'
  | 'context_too_large';

export interface ScratchpadOptions {
  backend: ScratchpadBackend;
  /**
   * Maximum serialised context byte size. Default 64KB — well under
   * typical vault payload limits but large enough for rich reasoning
   * context.
   */
  maxContextBytes?: number;
  /** Diagnostic hook. */
  onEvent?: (event: ScratchpadEvent) => void;
}

export const DEFAULT_MAX_CONTEXT_BYTES = 64 * 1024;

export type CheckpointResult =
  | { ok: true; step: number }
  | { ok: false; reason: ScratchpadRejectionReason; detail?: string };

/**
 * Ephemeral brain scratchpad for resumable multi-step reasoning.
 * Not a data vault — treat checkpoints as "probably less than 24
 * hours old" state.
 */
export class Scratchpad {
  private readonly backend: ScratchpadBackend;
  private readonly maxContextBytes: number;
  private readonly onEvent?: (event: ScratchpadEvent) => void;
  /**
   * Cache of the last step written for each task id — lets us reject
   * out-of-order writes without an extra read round-trip. The backend
   * is still the source of truth (cache is best-effort; a crash
   * between write + in-memory update is fine because the next write
   * sees the stale cache + is still valid for step > cached-step).
   */
  private readonly lastStepByTask: Map<string, number> = new Map();

  constructor(opts: ScratchpadOptions) {
    if (!opts.backend) {
      throw new Error('Scratchpad: backend is required');
    }
    this.backend = opts.backend;
    this.maxContextBytes = opts.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    this.onEvent = opts.onEvent;
  }

  /**
   * Persist a checkpoint. Returns a structured result instead of
   * throwing so the caller (a supervised loop) can log + continue
   * rather than aborting the whole task.
   *
   * `context` must be JSON-serialisable — we refuse empty task ids,
   * non-positive steps, steps that go backward, and oversized
   * payloads.
   */
  async checkpoint(
    taskId: string,
    step: number,
    context: ScratchpadContext,
  ): Promise<CheckpointResult> {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      this.emit({ kind: 'rejected', taskId, reason: 'empty_task_id' });
      return { ok: false, reason: 'empty_task_id' };
    }
    if (!Number.isInteger(step) || step <= 0) {
      this.emit({ kind: 'rejected', taskId, reason: 'non_positive_step' });
      return { ok: false, reason: 'non_positive_step' };
    }
    const lastStep = this.lastStepByTask.get(taskId);
    if (lastStep !== undefined && step <= lastStep) {
      this.emit({ kind: 'rejected', taskId, reason: 'bad_step_order' });
      return {
        ok: false,
        reason: 'bad_step_order',
        detail: `step ${step} <= last recorded step ${lastStep}`,
      };
    }
    // Serialise once here so we (a) catch non-JSON payloads before the
    // round-trip, (b) enforce size cheaply, (c) feed the event keys.
    let serialised: string;
    try {
      serialised = JSON.stringify(context ?? {});
    } catch (err) {
      return {
        ok: false,
        reason: 'context_too_large',
        detail: `context is not JSON-serialisable: ${(err as Error).message}`,
      };
    }
    const byteLength = Buffer.byteLength(serialised, 'utf8');
    if (byteLength > this.maxContextBytes) {
      this.emit({ kind: 'rejected', taskId, reason: 'context_too_large' });
      return {
        ok: false,
        reason: 'context_too_large',
        detail: `context ${byteLength}B exceeds max ${this.maxContextBytes}B`,
      };
    }

    await this.backend.write(taskId, step, context);
    this.lastStepByTask.set(taskId, step);
    this.emit({
      kind: 'checkpoint_written',
      taskId,
      step,
      keys: Object.keys(context ?? {}),
    });
    return { ok: true, step };
  }

  /**
   * Load the latest checkpoint. Returns `null` on a fresh task (no
   * prior checkpoint or the backend swept it). Primes the last-step
   * cache so subsequent `checkpoint()` calls on the same task can
   * enforce step ordering without re-reading.
   */
  async resume(
    taskId: string,
  ): Promise<{ step: number; context: ScratchpadContext } | null> {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      this.emit({
        kind: 'rejected',
        taskId: String(taskId ?? ''),
        reason: 'empty_task_id',
      });
      return null;
    }
    const result = await this.backend.read(taskId);
    if (result === null) {
      this.emit({ kind: 'resume_miss', taskId });
      return null;
    }
    this.lastStepByTask.set(taskId, result.step);
    this.emit({ kind: 'resume_hit', taskId, step: result.step });
    return result;
  }

  /**
   * Delete the checkpoint immediately. Idempotent — clearing an
   * unknown task emits `cleared` and returns without error (the
   * post-condition "no checkpoint exists for this task" holds
   * either way).
   */
  async clear(taskId: string): Promise<void> {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      this.emit({
        kind: 'rejected',
        taskId: String(taskId ?? ''),
        reason: 'empty_task_id',
      });
      return;
    }
    await this.backend.clear(taskId);
    this.lastStepByTask.delete(taskId);
    this.emit({ kind: 'cleared', taskId });
  }

  /**
   * Count tasks with a step-cache entry. Primarily for tests + admin
   * UI ("tasks in flight"). Since the cache is best-effort, this may
   * undercount tasks the backend knows about but this process hasn't
   * touched since startup.
   */
  tasksInFlight(): number {
    return this.lastStepByTask.size;
  }

  private emit(event: ScratchpadEvent): void {
    this.onEvent?.(event);
  }
}

/**
 * Reference backend for tests + local dev. Keeps checkpoints in a
 * plain Map so nothing survives process restart — production wires
 * the Core vault adapter.
 */
export class InMemoryScratchpadBackend implements ScratchpadBackend {
  private readonly store: Map<
    string,
    { step: number; context: ScratchpadContext }
  > = new Map();

  async write(
    taskId: string,
    step: number,
    context: ScratchpadContext,
  ): Promise<void> {
    // Structured-clone so callers can mutate the source context after
    // the write without corrupting the stored snapshot.
    this.store.set(taskId, {
      step,
      context: structuredClone(context),
    });
  }

  async read(
    taskId: string,
  ): Promise<{ step: number; context: ScratchpadContext } | null> {
    const entry = this.store.get(taskId);
    if (entry === undefined) return null;
    return {
      step: entry.step,
      context: structuredClone(entry.context),
    };
  }

  async clear(taskId: string): Promise<void> {
    this.store.delete(taskId);
  }

  /** Test-only: inspect live entries without triggering read. */
  size(): number {
    return this.store.size;
  }
}
