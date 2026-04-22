/**
 * Sync transport (GAP.md row #24 follow-up — closes sync_engine weakness).
 *
 * `sync_event_log.ts` holds the ordered stream. This primitive is
 * the **fan-out layer**: paired devices subscribe with a cursor +
 * optional topic filter; every `append()` to the log pushes to every
 * matching subscriber. Clients `ack(cursor)` when they've applied an
 * event locally; the transport uses the min-ack across subscribers
 * to compact the log.
 *
 * **What it does** (all synchronous from the log's perspective):
 *
 *   1. `subscribe({send, since, topic?, id?})` — register a client.
 *      Immediately replays everything `since < seq <= tailSeq`, then
 *      the client is caught up.
 *   2. `publishFromLog(event)` — wire-bridge: called by the log every
 *      time a new event is appended. Pushes to every matching client.
 *   3. `ack(subscriptionId, cursor)` — client reports it has applied
 *      up to `cursor`. Transport remembers min-ack across clients.
 *   4. `minAckedCursor()` — exposes the floor for log compaction.
 *   5. `unsubscribe(id)` / `close()` — cleanup.
 *
 * **Why inject `send`**: production wires a WebSocket `send(frame)`
 * per client; tests pass an in-memory collector. The transport is
 * agnostic about the wire.
 *
 * **Error isolation**: a slow / broken client's `send` rejecting
 * doesn't propagate — the transport logs via `onEvent` + keeps
 * fanning out. Repeated failures mark the subscription as `broken`
 * (future `minAckedCursor` skips it).
 *
 * **Replay-on-subscribe**: the log's `since(cursor)` returns the
 * replay set. If the cursor is behind retention, the transport
 * reports `cursor_behind_retention` back to the caller — the caller
 * tells the client to re-bootstrap.
 *
 * Source: GAP.md — M4 client sync protocol.
 */

import type { SyncEvent, SyncEventLog } from './sync_event_log';

export interface Subscription<TPayload = unknown> {
  id: string;
  send: (event: SyncEvent<TPayload>) => Promise<void> | void;
  /** Optional topic filter; undefined = all topics. */
  topic?: string;
  /** Cursor the client has ack'd. */
  ackedCursor: number;
  /** Sticky flag when `send` repeatedly fails. */
  broken: boolean;
  /** Count of consecutive send failures — reset on success. */
  consecutiveFailures: number;
}

export interface SubscribeInput<TPayload = unknown> {
  /** Client-supplied id or generated internally. */
  id?: string;
  /** Wire write callback. */
  send: (event: SyncEvent<TPayload>) => Promise<void> | void;
  /** Replay all events with seq > this value. Default 0 (everything). */
  since?: number;
  /** Optional topic filter. */
  topic?: string;
}

export type SubscribeOutcome<TPayload = unknown> =
  | { ok: true; subscription: Subscription<TPayload>; replayedCount: number }
  | {
      ok: false;
      reason: 'cursor_behind_retention';
      earliestRetainedSeq: number;
      tailSeq: number;
    };

export type TransportEvent =
  | { kind: 'subscribed'; id: string; since: number }
  | { kind: 'unsubscribed'; id: string }
  | { kind: 'pushed'; id: string; seq: number }
  | { kind: 'send_failed'; id: string; seq: number; error: string }
  | { kind: 'marked_broken'; id: string; failures: number }
  | { kind: 'acked'; id: string; cursor: number };

export interface SyncTransportOptions {
  /** Max consecutive failures before a subscription is flagged broken. Default 5. */
  maxConsecutiveFailures?: number;
  /** Diagnostic hook. */
  onEvent?: (event: TransportEvent) => void;
  /** Id generator. Defaults to `sub-<counter>`. */
  makeIdFn?: () => string;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Fan-out transport over a SyncEventLog.
 */
export class SyncTransport<TPayload = unknown> {
  private readonly subscriptions = new Map<string, Subscription<TPayload>>();
  private readonly log: SyncEventLog<TPayload>;
  private readonly maxConsecutiveFailures: number;
  private readonly onEvent?: (event: TransportEvent) => void;
  private readonly makeId: () => string;
  private counter = 0;
  private closed = false;

  constructor(log: SyncEventLog<TPayload>, opts: SyncTransportOptions = {}) {
    if (!log) throw new TypeError('SyncTransport: log required');
    this.log = log;
    this.maxConsecutiveFailures =
      opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    if (!Number.isInteger(this.maxConsecutiveFailures) || this.maxConsecutiveFailures < 1) {
      throw new RangeError('maxConsecutiveFailures must be a positive integer');
    }
    this.onEvent = opts.onEvent;
    this.makeId = opts.makeIdFn ?? (() => `sub-${++this.counter}`);
  }

  size(): number {
    return this.subscriptions.size;
  }

  /**
   * Register a subscription. The transport replays every event with
   * `seq > since` synchronously — if any send throws during the
   * replay burst, the whole subscription is rejected.
   */
  async subscribe(
    input: SubscribeInput<TPayload>,
  ): Promise<SubscribeOutcome<TPayload>> {
    if (this.closed) {
      throw new Error('SyncTransport: cannot subscribe after close');
    }
    if (typeof input?.send !== 'function') {
      throw new TypeError('subscribe: send function required');
    }
    const since = input.since ?? 0;
    const historical = this.log.since(since, input.topic);
    if (!historical.ok) {
      return {
        ok: false,
        reason: historical.reason,
        earliestRetainedSeq: historical.earliestRetainedSeq,
        tailSeq: historical.tailSeq,
      };
    }
    const id = input.id ?? this.makeId();
    const subscription: Subscription<TPayload> = {
      id,
      send: input.send,
      ackedCursor: since,
      broken: false,
      consecutiveFailures: 0,
    };
    if (input.topic !== undefined) subscription.topic = input.topic;
    // Replay historical events. If a send fails during replay, we
    // surface the error rather than silently onboarding a broken sub.
    for (const ev of historical.events) {
      await subscription.send(ev);
    }
    this.subscriptions.set(id, subscription);
    this.onEvent?.({ kind: 'subscribed', id, since });
    return {
      ok: true,
      subscription,
      replayedCount: historical.events.length,
    };
  }

  /**
   * Push one event to every matching subscription. Call this whenever
   * a new event is appended to the log (the caller wires this up as
   * an after-append hook).
   */
  async publishFromLog(event: SyncEvent<TPayload>): Promise<void> {
    if (this.closed) return;
    for (const sub of this.subscriptions.values()) {
      if (sub.broken) continue;
      if (sub.topic !== undefined && sub.topic !== event.topic) continue;
      try {
        await sub.send(event);
        sub.consecutiveFailures = 0;
        this.onEvent?.({ kind: 'pushed', id: sub.id, seq: event.seq });
      } catch (err) {
        sub.consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.onEvent?.({
          kind: 'send_failed',
          id: sub.id,
          seq: event.seq,
          error: msg,
        });
        if (sub.consecutiveFailures >= this.maxConsecutiveFailures) {
          sub.broken = true;
          this.onEvent?.({
            kind: 'marked_broken',
            id: sub.id,
            failures: sub.consecutiveFailures,
          });
        }
      }
    }
  }

  /** Record a client ack. Non-existent id is a no-op. */
  ack(id: string, cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new RangeError('ack: cursor must be a non-negative integer');
    }
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    // Monotonic — never let a client retreat.
    if (cursor > sub.ackedCursor) {
      sub.ackedCursor = cursor;
      this.onEvent?.({ kind: 'acked', id, cursor });
    }
  }

  /**
   * Floor of healthy-subscription ack cursors. Used for log
   * compaction — the log can drop events with seq ≤ this value.
   * Returns `Infinity` when no healthy subscriptions are connected
   * (so the caller knows to skip compaction rather than drop
   * everything).
   */
  minAckedCursor(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const sub of this.subscriptions.values()) {
      if (sub.broken) continue;
      if (sub.ackedCursor < min) min = sub.ackedCursor;
    }
    return min;
  }

  unsubscribe(id: string): boolean {
    const existed = this.subscriptions.delete(id);
    if (existed) this.onEvent?.({ kind: 'unsubscribed', id });
    return existed;
  }

  /** Drop every subscription + reject future subscribe calls. */
  close(): void {
    for (const id of Array.from(this.subscriptions.keys())) {
      this.unsubscribe(id);
    }
    this.closed = true;
  }

  /** Read-only snapshot of subscriptions — useful for admin + tests. */
  list(): Array<Pick<Subscription<TPayload>, 'id' | 'topic' | 'ackedCursor' | 'broken'>> {
    return Array.from(this.subscriptions.values()).map((s) => {
      const out: Pick<Subscription<TPayload>, 'id' | 'topic' | 'ackedCursor' | 'broken'> = {
        id: s.id,
        ackedCursor: s.ackedCursor,
        broken: s.broken,
      };
      if (s.topic !== undefined) out.topic = s.topic;
      return out;
    });
  }
}
