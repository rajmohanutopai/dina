/**
 * Brain-side dispatcher: when an ask transitions to `pending_approval`,
 * emit a structured `NotificationFrame` so the operator's client (CLI,
 * mobile app, admin UI) sees an actionable prompt instead of silently
 * stalling on `GET /api/v1/ask/:id/status`.
 *
 * **Why this exists**: `AskRegistry.markPendingApproval` updates state
 * but doesn't push anywhere. `AskApprovalGateway.approve` accepts the
 * operator's decision but never tells them about the ask in the first
 * place. Without a producer subscribed to the `pending_approval`
 * event, the only way an operator finds out a request is waiting is
 * by polling `listOpenApprovals`. That's fine for the admin UI, but
 * fiduciary asks shouldn't wait for someone to refresh a page.
 *
 * **Where this fits**: the dispatcher is a thin event-handler
 * composed into `AskRegistry.onEvent`. It does not own the WebSocket
 * — the sink (`notify`) is injected. In production the sink is the
 * client WebSocket broadcaster (task 4.36); in tests it's a recording
 * spy.
 *
 * **Why `solicited` priority**: the user asked the question (it's not
 * fiduciary "silence-causes-harm"), but they're now actively waiting
 * (it's not engagement "queue for briefing"). `solicited` is the
 * Silence-First tier that means "normal push; defer during DND".
 *
 * **Single responsibility**: this module turns one registry event
 * into one notification frame. It does not:
 *   - build approval-action UX (the frame's `id` lets the client
 *     correlate; routing is the consumer's job)
 *   - resolve approval metadata from `ApprovalManager` (an enricher
 *     callback is injectable; default is just the question excerpt)
 *   - re-execute the ask after approval (that's `AskApprovalResumer`)
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b — closes the missing
 * "operator visibility on pending_approval" seam flagged in the
 * AskApprovalGateway design notes.
 */

import { buildNotificationFrame, type NotificationFrame } from '../notify/notification_frame';
import type { AskEvent, AskRecord, AskRegistry } from './ask_registry';

/**
 * Sink the dispatcher pushes built frames into. Returns void or a
 * Promise — production wires the WS broadcaster; tests inject a spy.
 * Throwing is permitted; the dispatcher catches and emits a diagnostic
 * event so a flaky sink doesn't fail-loud through the registry.
 */
export type NotificationSink = (frame: NotificationFrame) => void | Promise<void>;

/**
 * Optional enricher for the message text. Receives the registry's
 * `AskRecord` (which has id + question + requesterDid + approvalId)
 * and returns a string. Default: `Approval needed for: <truncated
 * question>`.
 *
 * **PII WARNING**: the default builder embeds the raw user question
 * in the notification frame. For sensitive-vault asks this can leak
 * the very PII the approval gate is meant to protect (e.g. "what's
 * my SSN" arrives in the WS payload before the operator's decision).
 * Production wiring **must** override this builder to either (a) hide
 * the question entirely ("Approval needed: financial vault"), (b)
 * route through PII scrubbing, or (c) replace with a stable summary
 * keyed off `ApprovalManager.requestApproval(...).reason` /
 * `preview` (which are caller-controlled and already scrubbed
 * upstream of the gateway). The dispatcher stays decoupled from
 * `ApprovalManager` so it can be tested without one — the ergonomic
 * default is for development; the secure default is the caller's
 * `buildMessage`.
 */
export type AskNotificationMessageBuilder = (record: AskRecord) => string;

export type AskNotificationDispatcherEvent =
  | { kind: 'dispatched'; askId: string; frameId: string }
  | { kind: 'record_missing'; askId: string }
  | { kind: 'sink_failed'; askId: string; detail: string };

export interface AskNotificationDispatcherOptions {
  registry: AskRegistry;
  notify: NotificationSink;
  /** Override the message builder. Defaults to a question excerpt. */
  buildMessage?: AskNotificationMessageBuilder;
  /** Override the frame id. Defaults to `notif-ask-{askId}`. */
  buildFrameId?: (record: AskRecord) => string;
  /** Injectable clock (ms since epoch). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook — fires on every dispatcher decision. */
  onEvent?: (event: AskNotificationDispatcherEvent) => void;
}

/** Hard cap on the question excerpt — keeps push payloads small. */
export const ASK_NOTIFICATION_PREVIEW_CHARS = 160;

export class AskNotificationDispatcher {
  private readonly registry: AskRegistry;
  private readonly notify: NotificationSink;
  private readonly buildMessage: AskNotificationMessageBuilder;
  private readonly buildFrameId: (record: AskRecord) => string;
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: AskNotificationDispatcherEvent) => void;

  constructor(opts: AskNotificationDispatcherOptions) {
    if (!opts?.registry) {
      throw new TypeError('AskNotificationDispatcher: registry is required');
    }
    if (typeof opts.notify !== 'function') {
      throw new TypeError('AskNotificationDispatcher: notify must be a function');
    }
    this.registry = opts.registry;
    this.notify = opts.notify;
    this.buildMessage = opts.buildMessage ?? defaultBuildMessage;
    this.buildFrameId = opts.buildFrameId ?? defaultBuildFrameId;
    this.nowMsFn = opts.nowMsFn ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /**
   * Event handler — wire into `AskRegistry.onEvent`. Ignores every
   * event kind except `pending_approval`. Returns a promise so tests
   * can await dispatch deterministically; the registry's onEvent
   * contract treats the return value as `void` and does not await,
   * which means production stays fire-and-forget while tests stay
   * race-free.
   */
  readonly handle = async (event: AskEvent): Promise<void> => {
    if (event.kind !== 'pending_approval') return;
    await this.dispatchPendingApproval(event.id);
  };

  private async dispatchPendingApproval(askId: string): Promise<void> {
    const record = await this.registry.get(askId);
    if (record === null) {
      // Race: registry was wiped between event emission and our
      // lookup. Nothing to dispatch.
      this.onEvent?.({ kind: 'record_missing', askId });
      return;
    }
    let frame: NotificationFrame;
    try {
      frame = buildNotificationFrame({
        priority: 'solicited',
        message: this.buildMessage(record),
        id: this.buildFrameId(record),
        ts: this.nowMsFn(),
      });
    } catch (err) {
      // `buildMessage` / `buildFrameId` returned an invalid value, OR
      // `nowMsFn` produced something `buildNotificationFrame` rejects.
      // Surface as sink_failed so the operator visibility path doesn't
      // silently swallow producer bugs.
      this.onEvent?.({
        kind: 'sink_failed',
        askId,
        detail: `frame_build_failed: ${stringifyError(err)}`,
      });
      return;
    }
    try {
      await this.notify(frame);
    } catch (err) {
      this.onEvent?.({
        kind: 'sink_failed',
        askId,
        detail: stringifyError(err),
      });
      return;
    }
    this.onEvent?.({ kind: 'dispatched', askId, frameId: frame.id });
  }
}

function defaultBuildMessage(record: AskRecord): string {
  const trimmed = record.question.trim();
  const excerpt =
    trimmed.length > ASK_NOTIFICATION_PREVIEW_CHARS
      ? `${trimmed.slice(0, ASK_NOTIFICATION_PREVIEW_CHARS - 1)}…` // ellipsis
      : trimmed;
  return `Approval needed for: ${excerpt}`;
}

function defaultBuildFrameId(record: AskRecord): string {
  // Include `approvalId` so a re-approval cycle (same ask, second
  // approval needed) emits a distinct notification id. Without this,
  // a resumer-driven re-trigger would share the id with the first
  // notification — clients deduping on id would drop the second
  // prompt and the operator would never see it. Both fields are
  // present in the AskRecord at pending_approval time (the registry
  // sets approvalId in `markPendingApproval` before emitting the
  // event we're handling).
  return `notif-ask-${record.id}-${record.approvalId ?? 'unknown'}`;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
