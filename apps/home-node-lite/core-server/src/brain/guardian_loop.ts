/**
 * Task 5.30 — Guardian event loop (supervisor primitive).
 *
 * The Guardian is Dina's central event processor. Every inbound
 * event (staged vault item, incoming D2D message, classification
 * trigger) passes through a four-step pipeline:
 *
 *   1. **Classify** — decide the event's priority
 *      (`fiduciary` | `solicited` | `engagement`). Ambiguous events
 *      default to `engagement` (Silence First: never interrupt
 *      unless silence would cause harm).
 *   2. **Process** — run the priority-specific handler (notify the
 *      user, buffer for briefing, or take a fiduciary action).
 *   3. **Checkpoint** — multi-step handlers write progress to the
 *      Scratchpad (task 5.42) so crash-recovery can resume without
 *      repeating work already grounded in the vault.
 *   4. **Emit events** — every decision fires a diagnostic event so
 *      the admin UI can render "Guardian: X events in the last
 *      minute, N silenced, M fiduciary".
 *
 * **Why a primitive?**  The full Python Guardian is 5k+ lines of
 * orchestration. This TS version owns ONLY the supervisory loop —
 * the event plumbing + classification + error isolation + shutdown
 * coordination. The actual handler for each priority is injected by
 * the caller. This keeps the primitive tight + testable without
 * requiring the full LLM / vault / notify stack.
 *
 * **Security + safety invariants** (pinned by tests):
 *   - Per-event errors are isolated — one handler throwing does NOT
 *     kill the loop. The error is emitted + the next event is
 *     processed.
 *   - `stop()` is graceful: drains in-flight events, waits for the
 *     loop to exit, returns a promise that resolves after the final
 *     event settles.
 *   - Silence First: when `classifyFn` throws or returns `null`,
 *     the event is classified as `engagement` (buffered — not
 *     emitted to the user).
 *   - Per-event timeout: a handler that takes too long is
 *     abandoned (the loop doesn't stall). The abandoned event
 *     fires `event_timeout` for ops visibility.
 *
 * **Lifecycle**:
 *   - `new GuardianLoop(opts)` → configured but idle.
 *   - `start()` → begins consuming events from `eventSourceFn`.
 *   - `stop()` → signals shutdown; resolves after drain.
 *   - `isRunning()` → true between `start()` and full drain.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.30.
 */

import type { NotifyPriority } from './priority';

/**
 * Guardian priorities unify with `NotifyPriority` (task 5.48) — the
 * Guardian classifies events into the same three tiers the notify
 * dispatcher routes. Alias kept for legibility at call-sites that
 * read better as `GuardianPriority` in context.
 */
export type GuardianPriority = NotifyPriority;

export interface GuardianEvent {
  /** Stable id — used for dedup + checkpoint correlation. */
  id: string;
  /** Arbitrary payload the handler interprets. */
  payload: unknown;
  /** Source tag (gmail, d2d, manual) — passed through to events + logs. */
  source?: string;
}

/**
 * Classify an event into a priority. Returning `null` signals
 * "unable to classify" and the loop treats the event as `engagement`
 * (Silence First default).
 */
export type GuardianClassifyFn = (
  event: GuardianEvent,
) => Promise<GuardianPriority | null>;

/** Handler for a single priority-tagged event. */
export type GuardianProcessFn = (
  event: GuardianEvent,
  priority: GuardianPriority,
) => Promise<void>;

/**
 * Event source — `next()` resolves to the next event or `null` when
 * the source is exhausted. The loop drains until it sees null.
 * Production wires this to a queue fed from Core; tests pass an
 * array-backed source.
 */
export type GuardianEventSourceFn = () => Promise<GuardianEvent | null>;

export interface GuardianLoopOptions {
  eventSourceFn: GuardianEventSourceFn;
  classifyFn: GuardianClassifyFn;
  processFn: GuardianProcessFn;
  /**
   * Per-event handler timeout in ms. When exceeded, the event is
   * considered abandoned + the loop moves on. 0 / undefined disables
   * timeouts. Defaults to 30s.
   */
  eventTimeoutMs?: number;
  /** Injectable clock — tests use a mock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: GuardianLoopEvent) => void;
}

export type GuardianLoopEvent =
  | { kind: 'event_received'; eventId: string; source: string }
  | {
      kind: 'classified';
      eventId: string;
      priority: GuardianPriority;
      classifierFailed: boolean;
    }
  | { kind: 'processed'; eventId: string; priority: GuardianPriority; durationMs: number }
  | { kind: 'process_failed'; eventId: string; priority: GuardianPriority; error: string }
  | { kind: 'event_timeout'; eventId: string; priority: GuardianPriority; timeoutMs: number }
  | { kind: 'loop_stopped'; processed: number; failed: number; timedOut: number };

export const DEFAULT_EVENT_TIMEOUT_MS = 30_000;

/**
 * Counters exposed via `stats()` for admin UI and tests. Snapshotted
 * on every read so the caller can compute deltas without aliasing.
 */
export interface GuardianStats {
  processed: number;
  failed: number;
  timedOut: number;
  silenced: number;
  running: boolean;
}

export class GuardianLoop {
  private readonly eventSourceFn: GuardianEventSourceFn;
  private readonly classifyFn: GuardianClassifyFn;
  private readonly processFn: GuardianProcessFn;
  private readonly eventTimeoutMs: number;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: GuardianLoopEvent) => void;

  private running = false;
  private stopRequested = false;
  private drainPromise: Promise<void> | null = null;
  private counters: GuardianStats = {
    processed: 0,
    failed: 0,
    timedOut: 0,
    silenced: 0,
    running: false,
  };

  constructor(opts: GuardianLoopOptions) {
    for (const [k, fn] of [
      ['eventSourceFn', opts.eventSourceFn],
      ['classifyFn', opts.classifyFn],
      ['processFn', opts.processFn],
    ] as const) {
      if (typeof fn !== 'function') {
        throw new TypeError(`GuardianLoop: ${k} is required`);
      }
    }
    this.eventSourceFn = opts.eventSourceFn;
    this.classifyFn = opts.classifyFn;
    this.processFn = opts.processFn;
    this.eventTimeoutMs = opts.eventTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /**
   * Start draining the event source. Returns immediately; the
   * returned promise resolves when the source yields `null` (or
   * `stop()` is called and the drain completes).
   *
   * Calling `start()` while already running returns the same drain
   * promise — idempotent.
   */
  start(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.running = true;
    this.counters.running = true;
    this.stopRequested = false;
    this.drainPromise = this.drain();
    return this.drainPromise;
  }

  /**
   * Signal the loop to stop after draining the currently in-flight
   * event (if any). Returns a promise that resolves when the loop
   * has exited.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  stats(): GuardianStats {
    return { ...this.counters };
  }

  // ── Core loop ────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    try {
      while (!this.stopRequested) {
        const event = await this.eventSourceFn();
        if (event === null) break;
        await this.processOne(event);
      }
    } finally {
      this.running = false;
      this.counters.running = false;
      this.onEvent?.({
        kind: 'loop_stopped',
        processed: this.counters.processed,
        failed: this.counters.failed,
        timedOut: this.counters.timedOut,
      });
      this.drainPromise = null;
    }
  }

  private async processOne(event: GuardianEvent): Promise<void> {
    this.onEvent?.({
      kind: 'event_received',
      eventId: event.id,
      source: event.source ?? '',
    });

    // ── Classify (Silence First default on failure / null) ──────────
    let priority: GuardianPriority = 'engagement';
    let classifierFailed = false;
    try {
      const result = await this.classifyFn(event);
      if (result === null) {
        classifierFailed = true;
      } else {
        priority = result;
      }
    } catch {
      classifierFailed = true;
    }
    this.onEvent?.({
      kind: 'classified',
      eventId: event.id,
      priority,
      classifierFailed,
    });
    if (classifierFailed && priority === 'engagement') {
      // Silence First: classifier ambiguous → buffer, do not surface.
      this.counters.silenced++;
    }

    // ── Process with per-event timeout ──────────────────────────────
    const start = this.nowMsFn();
    try {
      if (this.eventTimeoutMs > 0) {
        await this.withTimeout(
          this.processFn(event, priority),
          this.eventTimeoutMs,
        );
      } else {
        await this.processFn(event, priority);
      }
      this.counters.processed++;
      this.onEvent?.({
        kind: 'processed',
        eventId: event.id,
        priority,
        durationMs: this.nowMsFn() - start,
      });
    } catch (err) {
      if (err instanceof GuardianTimeoutError) {
        this.counters.timedOut++;
        this.onEvent?.({
          kind: 'event_timeout',
          eventId: event.id,
          priority,
          timeoutMs: this.eventTimeoutMs,
        });
      } else {
        this.counters.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.onEvent?.({
          kind: 'process_failed',
          eventId: event.id,
          priority,
          error: msg,
        });
      }
      // Per-event error isolation — loop continues.
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new GuardianTimeoutError(ms));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

class GuardianTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`guardian event timeout after ${timeoutMs}ms`);
  }
}
