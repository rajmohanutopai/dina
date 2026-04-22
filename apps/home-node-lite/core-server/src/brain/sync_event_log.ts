/**
 * Sync event log (GAP.md row #24 closure-start — M4 foundation).
 *
 * Paired devices (mobile, web, laptop CLI) keep local state in sync
 * with the home node via an event-log protocol:
 *
 *   Home node appends events → clients stream events from a cursor
 *   → clients apply events to local state → clients send their
 *   cursor back for anchoring. Missed events (client offline for a
 *   week) replay from wherever the server still has.
 *
 * This primitive is the event-log core: `append`, `since(cursor)`,
 * `tail`, `snapshotCursor`, `compact(beforeCursor)`. In-memory; real
 * wiring (SQLite-backed persistence + WebSocket fan-out) composes
 * on top of this.
 *
 * **Monotonic sequence** — every `append` gets the next integer.
 * Sequence starts at 1. Clients hold a cursor; `since(cursor)`
 * returns every event strictly after it.
 *
 * **Retention**: in-memory ring capped at `maxRetained` events.
 * Overflow drops oldest. Consumers past the drop horizon get
 * `{ ok: false, reason: 'cursor_behind_retention' }` and must
 * bootstrap from a full snapshot.
 *
 * **Compaction**: `compact(beforeCursor)` drops events with
 * sequence ≤ cursor. Used when every connected client has ack'd
 * past a cursor — the events are no longer useful for replay.
 *
 * **Topics**: events carry an opaque `topic` string (e.g. `persona`,
 * `contact`, `vault_item`). Clients filter by topic on read. Keeps
 * the log a single ordered stream while letting consumers focus.
 *
 * **Deterministic tests**: inject `nowMsFn` for timestamps. No other
 * clock reads.
 *
 * Source: GAP.md (task 5.46 follow-up) — M4 client-sync foundation.
 */

export interface SyncEvent<TPayload = unknown> {
  /** Monotonic sequence number. First event = 1. */
  seq: number;
  /** Free-form topic the event belongs to. */
  topic: string;
  /** Short event-kind label (e.g. "created", "updated", "deleted"). */
  kind: string;
  /** Unix ms when the event was appended. */
  ts: number;
  /** Arbitrary payload — consumers parse by `topic`+`kind`. */
  payload: TPayload;
}

export interface SyncEventLogOptions {
  /** Ring capacity. Default 10_000. Older events drop first. */
  maxRetained?: number;
  /** Injectable clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
}

export type SinceResult<TPayload = unknown> =
  | { ok: true; events: SyncEvent<TPayload>[]; tailSeq: number }
  | {
      ok: false;
      reason: 'cursor_behind_retention';
      /** Earliest sequence still retained — client bootstraps from a snapshot then resumes here. */
      earliestRetainedSeq: number;
      tailSeq: number;
    };

export interface AppendInput<TPayload = unknown> {
  topic: string;
  kind: string;
  payload: TPayload;
  /** Override timestamp — tests + replay use this. Defaults to `nowMsFn()`. */
  ts?: number;
}

export const DEFAULT_MAX_RETAINED = 10_000;

/**
 * In-memory ordered event log. Single-threaded; callers own
 * concurrency via surrounding locks if needed.
 */
export class SyncEventLog<TPayload = unknown> {
  private readonly events: SyncEvent<TPayload>[] = [];
  private readonly maxRetained: number;
  private readonly nowMsFn: () => number;
  private nextSeq = 1;

  constructor(opts: SyncEventLogOptions = {}) {
    const max = opts.maxRetained ?? DEFAULT_MAX_RETAINED;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError('maxRetained must be a positive integer');
    }
    this.maxRetained = max;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
  }

  /** Count of events currently retained. */
  size(): number {
    return this.events.length;
  }

  /** Sequence of the most recently appended event, or 0 if empty. */
  tailSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * Earliest sequence still retained. 0 when the log is empty.
   * Clients with cursors older than this need a fresh snapshot.
   */
  earliestRetainedSeq(): number {
    return this.events.length === 0 ? 0 : this.events[0]!.seq;
  }

  /**
   * Append an event. Returns the assigned sequence. Validation
   * throws — callers should treat that as a programmer bug, not
   * a runtime failure.
   */
  append(input: AppendInput<TPayload>): number {
    if (!input || typeof input !== 'object') {
      throw new TypeError('append: input is required');
    }
    if (typeof input.topic !== 'string' || input.topic === '') {
      throw new TypeError('append: topic must be a non-empty string');
    }
    if (typeof input.kind !== 'string' || input.kind === '') {
      throw new TypeError('append: kind must be a non-empty string');
    }
    const ts = input.ts ?? this.nowMsFn();
    if (!Number.isFinite(ts)) {
      throw new TypeError('append: ts must be finite');
    }
    const seq = this.nextSeq++;
    this.events.push({ seq, topic: input.topic, kind: input.kind, ts, payload: input.payload });
    this.enforceRetention();
    return seq;
  }

  /**
   * Return every event with sequence > `cursor`. `cursor = 0`
   * returns all retained events. When the cursor is behind the
   * retention horizon, returns `cursor_behind_retention` so the
   * client bootstraps from scratch.
   *
   * Optional `topic` filter matches a single topic; pass `undefined`
   * for all topics.
   */
  since(cursor: number, topic?: string): SinceResult<TPayload> {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RangeError('cursor must be a non-negative integer');
    }
    if (this.events.length === 0) {
      return { ok: true, events: [], tailSeq: this.tailSeq() };
    }
    const earliest = this.events[0]!.seq;
    // Cursor older than what we still retain — tell caller to resync.
    // Exception: cursor = tailSeq means "all caught up" and should be OK.
    if (cursor < earliest - 1 && cursor < this.tailSeq()) {
      return {
        ok: false,
        reason: 'cursor_behind_retention',
        earliestRetainedSeq: earliest,
        tailSeq: this.tailSeq(),
      };
    }
    const out: SyncEvent<TPayload>[] = [];
    for (const ev of this.events) {
      if (ev.seq <= cursor) continue;
      if (topic !== undefined && ev.topic !== topic) continue;
      out.push(ev);
    }
    return { ok: true, events: out, tailSeq: this.tailSeq() };
  }

  /**
   * Return the `limit` most recent events, optionally filtered by
   * topic. Useful for operator debugging ("what did we just do?").
   */
  tail(limit = 20, topic?: string): SyncEvent<TPayload>[] {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError('limit must be a non-negative integer');
    }
    const filtered =
      topic === undefined
        ? this.events
        : this.events.filter((e) => e.topic === topic);
    if (limit === 0) return [];
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  /**
   * Drop every event with sequence ≤ `beforeCursor`. Caller
   * guarantees all connected clients have acked past `beforeCursor`.
   * Returns the number of events dropped.
   */
  compact(beforeCursor: number): number {
    if (!Number.isInteger(beforeCursor) || beforeCursor < 0) {
      throw new RangeError('beforeCursor must be a non-negative integer');
    }
    const before = this.events.length;
    let dropIndex = 0;
    while (
      dropIndex < this.events.length &&
      this.events[dropIndex]!.seq <= beforeCursor
    ) {
      dropIndex += 1;
    }
    if (dropIndex > 0) this.events.splice(0, dropIndex);
    return before - this.events.length;
  }

  /** Drop every event + reset the sequence. Tests + persona wipes. */
  reset(): void {
    this.events.length = 0;
    this.nextSeq = 1;
  }

  /**
   * Cursor snapshot for a client — pair this with `since()` next
   * time around. Just an alias for tailSeq with a friendlier name.
   */
  snapshotCursor(): number {
    return this.tailSeq();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private enforceRetention(): void {
    const overflow = this.events.length - this.maxRetained;
    if (overflow > 0) this.events.splice(0, overflow);
  }
}
