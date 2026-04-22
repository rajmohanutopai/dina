/**
 * Tasks 5.47 + 5.49 — notify dispatcher with priority-routed batching.
 *
 * Three Silence-First tiers (CLAUDE.md §Silence First, §35.1 in
 * ARCHITECTURE.md) get distinct delivery semantics:
 *
 *   **fiduciary** — interrupt immediately; silence would cause harm.
 *     Sends directly to Core bypassing any batch window. Task 5.49's
 *     "urgent-path" requirement: a fiduciary notification must reach
 *     the user even if a batching window is in the middle of its
 *     cycle.
 *   **solicited** — notify; the user asked for this. Sends
 *     immediately; the caller is responsible for DND policy
 *     (defer vs send) via a `solicitedPolicy` hook.
 *   **engagement** — save for briefing. Buffered until `flush()`
 *     (periodic cadence OR demand from the daily-briefing pipeline).
 *
 * **Why one module for both tasks**: 5.47 asks for ergonomic
 * priority-specific methods (`notifyFiduciary`, `notifyEngagement`)
 * and 5.49 asks for fiduciary-bypass semantics. Both surface the
 * same underlying `notify(priority, payload)` primitive with
 * different paths — splitting them would force the caller to wire
 * two classes that share the same sender reference.
 *
 * **Pluggable sender**: `notifyFn(priority, payload) → Promise<void>`
 * is injected. Production wires the signed-HTTP client's
 * `POST /v1/notify` call (task 5.9 / 5.10); tests pass a scripted
 * capture function.
 *
 * **Solicited DND policy**: `solicitedPolicy()` returns
 * `'send' | 'defer'`. When `'defer'`, the notification lands in
 * the deferred buffer + flushes with engagement on the next cycle.
 * When `'send'`, it routes direct.
 *
 * **Engagement ordering** preserved on flush — delivery order matches
 * buffering order (useful for briefing narratives).
 *
 * **Graceful shutdown**: `flushPending()` is called from the
 * shutdown coordinator (task 4.9) so no engagement notifications
 * are dropped on SIGTERM.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5f tasks 5.47 + 5.49.
 */

import { NOTIFY_PRIORITY_FIDUCIARY, NOTIFY_PRIORITY_SOLICITED, NOTIFY_PRIORITY_ENGAGEMENT, type NotifyPriority } from '@dina/protocol';

/**
 * Low-level send surface. Production wires to the signed-HTTP
 * CoreClient.notify; tests pass a scripted recorder.
 */
export type NotifyFn = (
  priority: NotifyPriority,
  payload: NotifyPayload,
) => Promise<void>;

/** Structured notification payload — matches Go `notifyRequest`. */
export interface NotifyPayload {
  message: string;
  /** Optional structured metadata the CLI / admin UI can render. */
  meta?: Record<string, unknown>;
}

/**
 * Solicited DND hook — returns whether to send-now or defer the
 * solicited notification. Caller (Brain) computes from calendar +
 * user settings; this module just respects the verdict.
 */
export type SolicitedPolicyFn = () => 'send' | 'defer';

export interface NotifyDispatcherOptions {
  notifyFn: NotifyFn;
  /** Defaults to `() => 'send'` (no DND, always immediate). */
  solicitedPolicy?: SolicitedPolicyFn;
  /** Diagnostic hook. */
  onEvent?: (event: NotifyEvent) => void;
}

export type NotifyEvent =
  | { kind: 'sent'; priority: NotifyPriority; latencyMs: number }
  | { kind: 'buffered'; priority: 'solicited' | 'engagement'; pendingCount: number }
  | { kind: 'flushed'; count: number; durationMs: number }
  | {
      kind: 'send_failed';
      priority: NotifyPriority;
      error: string;
      willRetry: boolean;
    };

export const FIDUCIARY_PRIORITY = NOTIFY_PRIORITY_FIDUCIARY;
export const SOLICITED_PRIORITY = NOTIFY_PRIORITY_SOLICITED;
export const ENGAGEMENT_PRIORITY = NOTIFY_PRIORITY_ENGAGEMENT;

interface BufferEntry {
  priority: 'solicited' | 'engagement';
  payload: NotifyPayload;
  bufferedAtMs: number;
}

export class NotifyDispatcher {
  private readonly notifyFn: NotifyFn;
  private readonly solicitedPolicy: SolicitedPolicyFn;
  private readonly onEvent?: (event: NotifyEvent) => void;
  private readonly buffer: BufferEntry[] = [];

  constructor(opts: NotifyDispatcherOptions) {
    if (typeof opts.notifyFn !== 'function') {
      throw new Error('NotifyDispatcher: notifyFn is required');
    }
    this.notifyFn = opts.notifyFn;
    this.solicitedPolicy = opts.solicitedPolicy ?? (() => 'send');
    this.onEvent = opts.onEvent;
  }

  /**
   * Fiduciary: interrupt-now. Bypasses every batching gate — task
   * 5.49. The caller awaits the underlying send so safety-critical
   * notifications surface synchronously from the handler that
   * raised them.
   */
  async notifyFiduciary(payload: NotifyPayload): Promise<void> {
    return this.directSend(FIDUCIARY_PRIORITY, payload);
  }

  /**
   * Solicited: user asked for it. Honours `solicitedPolicy` — when
   * DND policy says `'defer'`, the notification joins the buffer
   * (flushed alongside engagement items on next `flush()`).
   */
  async notifySolicited(payload: NotifyPayload): Promise<void> {
    if (this.solicitedPolicy() === 'defer') {
      this.buffer.push({
        priority: 'solicited',
        payload,
        bufferedAtMs: Date.now(),
      });
      this.onEvent?.({
        kind: 'buffered',
        priority: 'solicited',
        pendingCount: this.buffer.length,
      });
      return;
    }
    return this.directSend(SOLICITED_PRIORITY, payload);
  }

  /**
   * Engagement: save for briefing. ALWAYS buffered — never emitted
   * outside a `flush()` cycle. The caller owns the flush cadence
   * (typically wired into a `SupervisedLoop` from 4.90 on the
   * briefing schedule, OR manual via admin UI "send briefing now").
   */
  async notifyEngagement(payload: NotifyPayload): Promise<void> {
    this.buffer.push({
      priority: 'engagement',
      payload,
      bufferedAtMs: Date.now(),
    });
    this.onEvent?.({
      kind: 'buffered',
      priority: 'engagement',
      pendingCount: this.buffer.length,
    });
  }

  /**
   * Generic escape hatch — caller supplies the priority explicitly.
   * Routes to the priority-specific method. Matches the Go
   * `notify(priority, payload)` signature for when the caller
   * already has the priority as a variable.
   */
  async notify(priority: NotifyPriority, payload: NotifyPayload): Promise<void> {
    if (priority === FIDUCIARY_PRIORITY) return this.notifyFiduciary(payload);
    if (priority === SOLICITED_PRIORITY) return this.notifySolicited(payload);
    if (priority === ENGAGEMENT_PRIORITY) return this.notifyEngagement(payload);
    throw new Error(
      `NotifyDispatcher.notify: unknown priority ${JSON.stringify(priority)}`,
    );
  }

  /**
   * Flush every buffered notification (solicited-deferred +
   * engagement). Preserves insertion order so the briefing renders
   * events in the order they were buffered. Returns count sent.
   *
   * If `notifyFn` throws mid-flush, remaining items stay in the
   * buffer — the next flush retries them. Per-item failures fire
   * `send_failed` with `willRetry: true`.
   */
  async flush(): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const start = Date.now();
    const drain = this.buffer.slice();
    this.buffer.length = 0;
    let sent = 0;
    const carryOver: BufferEntry[] = [];
    for (const entry of drain) {
      try {
        await this.notifyFn(
          entry.priority === 'solicited'
            ? SOLICITED_PRIORITY
            : ENGAGEMENT_PRIORITY,
          entry.payload,
        );
        sent++;
      } catch (err) {
        this.onEvent?.({
          kind: 'send_failed',
          priority: entry.priority === 'solicited' ? SOLICITED_PRIORITY : ENGAGEMENT_PRIORITY,
          error: err instanceof Error ? err.message : String(err),
          willRetry: true,
        });
        carryOver.push(entry);
      }
    }
    // Re-queue failures at the HEAD so next flush retries them first.
    this.buffer.unshift(...carryOver);
    this.onEvent?.({
      kind: 'flushed',
      count: sent,
      durationMs: Date.now() - start,
    });
    return sent;
  }

  /**
   * Shutdown-safe flush. Synonym for `flush()` but named for the
   * shutdown-coordinator call site (task 4.9's step list will wire
   * `{name: 'notify-flush', close: () => dispatcher.flushPending()}`).
   */
  async flushPending(): Promise<number> {
    return this.flush();
  }

  /** Count of buffered notifications awaiting flush. */
  pending(): number {
    return this.buffer.length;
  }

  /**
   * Clear the buffer WITHOUT sending. Intended for test teardown +
   * the "discard drafts" admin operation. Returns the count
   * discarded.
   */
  discardPending(): number {
    const n = this.buffer.length;
    this.buffer.length = 0;
    return n;
  }

  /**
   * Snapshot the buffered items (copy). Useful for admin UI ("here's
   * what would go in the next briefing") without mutation risk.
   */
  peekBuffered(): Array<{
    priority: 'solicited' | 'engagement';
    payload: NotifyPayload;
    bufferedAtMs: number;
  }> {
    // Deep clone so callers can mutate freely without corrupting the
    // live buffer — meta is `Record<string, unknown>` and may contain
    // nested structures that a shallow copy would leave shared.
    return this.buffer.map((e) => ({
      priority: e.priority,
      payload: structuredClone(e.payload),
      bufferedAtMs: e.bufferedAtMs,
    }));
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async directSend(
    priority: NotifyPriority,
    payload: NotifyPayload,
  ): Promise<void> {
    const start = Date.now();
    try {
      await this.notifyFn(priority, payload);
      this.onEvent?.({
        kind: 'sent',
        priority,
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      this.onEvent?.({
        kind: 'send_failed',
        priority,
        error: err instanceof Error ? err.message : String(err),
        willRetry: false,
      });
      throw err;
    }
  }
}
