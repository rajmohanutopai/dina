/**
 * Guardian workflow-event consumer (BRAIN-P2-W03).
 *
 * Polls Core's `listWorkflowEvents(needs_delivery=true)`, picks out the
 * `service_query` completions, formats them via `formatServiceQueryResult`,
 * delivers the text through an injected `deliver` callback, then ACKs the
 * event so Core retires it from the delivery queue.
 *
 * Design mirrors `DelegationRunner`:
 *   - Injectable clock + scheduler (production `setInterval`, tests a fake).
 *   - Default cadence 1 second so requester-side replies feel snappy.
 *   - Per-event error isolation — one bad event never breaks the tick.
 *   - Events that do not match our filter are still acknowledged: we are
 *     the single Bus Driver consumer, so leaving them unacked would stall
 *     the delivery scheduler. Other event streams (approval lifecycle
 *     audit, etc.) are write-only from Core's perspective; the ack is
 *     a no-op from their side because nothing else consumes them.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md BRAIN-P2-W03 / MOBILE-009.
 */

import type { CoreClient, WorkflowEvent, WorkflowTask } from '@dina/core';
import { formatServiceQueryResult, type ServiceQueryEventDetails } from './result_formatter';
import type { ServiceResponseBody } from '@dina/protocol';

/**
 * How the formatted response reaches the surface (chat thread, Telegram,
 * test spy). The consumer hands over the ready-to-render text plus the
 * underlying event so callers can route by capability / correlation_id.
 */
export type WorkflowEventDeliverer = (args: {
  text: string;
  event: WorkflowEvent;
  task: WorkflowTask;
  details: ServiceQueryEventDetails;
}) => void | Promise<void>;

/**
 * Payload of a `service_query_execution` delegation, embedded on every
 * approval task. The `approved`-event dispatcher needs the same shape
 * that `ServiceHandler.executeAndRespond` already accepts.
 */
export interface ApprovedExecutionPayload {
  from_did: string;
  query_id: string;
  capability: string;
  params: unknown;
  ttl_seconds?: number;
  schema_hash?: string;
  service_name?: string;
}

/**
 * Fired when a workflow task transitions `pending_approval → queued`.
 * Callers typically forward to `ServiceHandler.executeAndRespond` to
 * spawn the delegation task that actually runs the capability. Hook
 * errors behave like `deliver` errors: the event is NOT acked, so Core
 * re-drives it on the next tick.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md BRAIN-P4-P01.
 */
export type ApprovalEventDispatcher = (args: {
  event: WorkflowEvent;
  task: WorkflowTask;
  payload: ApprovedExecutionPayload;
}) => void | Promise<void>;

/**
 * The 4-method slice of `CoreClient` the consumer actually uses. Kept
 * as a `Pick<CoreClient, ...>` so a future `CoreClient` method addition
 * doesn't widen the consumer's contract (callers can still pass the
 * full `InProcessTransport` / `HttpCoreTransport`, TS narrows at assign).
 */
export type WorkflowEventConsumerCoreClient = Pick<
  CoreClient,
  | 'listWorkflowEvents'
  | 'acknowledgeWorkflowEvent'
  | 'getWorkflowTask'
  | 'failWorkflowEventDelivery'
>;

export interface WorkflowEventConsumerOptions {
  coreClient: WorkflowEventConsumerCoreClient;
  deliver: WorkflowEventDeliverer;
  /**
   * Optional dispatcher for `approved` events on approval tasks. When
   * installed, the consumer parses the approval task's payload and hands
   * it to the dispatcher (typically `ServiceHandler.executeAndRespond`).
   * When absent, the event is acked as skipped — matching the prior
   * "chat-approve handler owns execution" posture.
   */
  onApproved?: ApprovalEventDispatcher;
  /** Poll cadence in ms. Defaults to 1_000 (snappy chat delivery). */
  intervalMs?: number;
  /** Max events per tick. Defaults to 50 — events are light. */
  batchSize?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  onTaskOutcome?: (event: WorkflowEvent, outcome: 'delivered' | 'skipped' | 'failed') => void;
  onError?: (err: unknown) => void;
  logger?: (entry: Record<string, unknown>) => void;
}

export interface WorkflowEventTickResult {
  discovered: number;
  delivered: number;
  skipped: number;
  failed: number;
  errors: Error[];
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 50;

export class WorkflowEventConsumer {
  private readonly core: WorkflowEventConsumerCoreClient;
  private readonly deliver: WorkflowEventDeliverer;
  private readonly onApproved: ApprovalEventDispatcher | null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (h: unknown) => void;
  private readonly onTaskOutcome:
    | ((event: WorkflowEvent, outcome: 'delivered' | 'skipped' | 'failed') => void)
    | null;
  private readonly onError: ((err: unknown) => void) | null;
  private readonly log: (entry: Record<string, unknown>) => void;

  private handle: unknown = null;
  private inFlight: Promise<WorkflowEventTickResult> | null = null;

  constructor(options: WorkflowEventConsumerOptions) {
    if (!options.coreClient) {
      throw new Error('WorkflowEventConsumer: coreClient is required');
    }
    if (!options.deliver) {
      throw new Error('WorkflowEventConsumer: deliver is required');
    }
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (intervalMs <= 0) {
      throw new Error('WorkflowEventConsumer: intervalMs must be positive');
    }
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (batchSize <= 0) {
      throw new Error('WorkflowEventConsumer: batchSize must be positive');
    }
    this.core = options.coreClient;
    this.deliver = options.deliver;
    this.onApproved = options.onApproved ?? null;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.setIntervalFn =
      options.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms) as unknown);
    this.clearIntervalFn =
      options.clearInterval ??
      ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>));
    this.onTaskOutcome = options.onTaskOutcome ?? null;
    this.onError = options.onError ?? null;
    this.log =
      options.logger ??
      (() => {
        /* no-op */
      });
  }

  start(): void {
    if (this.handle !== null) return;
    this.runTick().catch(() => {
      /* errors routed via onError already */
    });
    this.handle = this.setIntervalFn(() => {
      this.runTick().catch(() => {
        /* per-event errors isolated */
      });
    }, this.intervalMs);
    const h = this.handle as { unref?: () => void };
    if (h !== null && typeof h.unref === 'function') h.unref();
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  async flush(): Promise<void> {
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch {
        /* already reported */
      }
    }
  }

  async runTick(): Promise<WorkflowEventTickResult> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.runTickInner();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runTickInner(): Promise<WorkflowEventTickResult> {
    const result: WorkflowEventTickResult = {
      discovered: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    let events: WorkflowEvent[];
    try {
      events = await this.core.listWorkflowEvents({
        needsDeliveryOnly: true,
        limit: this.batchSize,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result.errors.push(err);
      if (this.onError !== null) {
        try {
          this.onError(err);
        } catch {
          /* swallow */
        }
      }
      this.log({ event: 'workflow_event.list_failed', error: err.message });
      return result;
    }

    result.discovered = events.length;
    for (const ev of events) {
      await this.processEvent(ev, result);
    }
    return result;
  }

  private async processEvent(event: WorkflowEvent, result: WorkflowEventTickResult): Promise<void> {
    // Event kinds this consumer routes:
    //   - completed  → successful service_query delivery
    //   - failed     → TTL expiry / provider rejection (issue #11)
    //   - cancelled  → operator deny / task cancel (issue #11)
    //   - approved   → approval-queue kickoff (→ onApproved dispatcher)
    //
    // Review #4: unknown event kinds used to be ACKed-and-dropped,
    // which was only safe while the workflow-events queue was
    // service-query-only. Once another feature (e.g. delegation,
    // reminders, outbox) shares the queue, this consumer would
    // silently retire their events. We now mark the event as
    // delivery-failed instead: Core's delivery scheduler backs off
    // so no one hot-loops on it, but the event stays available for
    // a future consumer that knows how to handle its kind.
    const DELIVERABLE_KINDS = new Set(['completed', 'failed', 'cancelled', 'approved']);
    if (!DELIVERABLE_KINDS.has(event.event_kind)) {
      this.log({
        event: 'workflow_event.unknown_kind',
        event_id: event.event_id,
        event_kind: event.event_kind,
      });
      await this.markDeliveryFailed(event, new Error(`unknown event kind: ${event.event_kind}`));
      return;
    }
    // `approved` events are only meaningful when an onApproved dispatcher
    // is installed. Without one, the chat-approve handler owns execution
    // and we should still retire the event so it doesn't redrive.
    if (event.event_kind === 'approved' && this.onApproved === null) {
      await this.ackAndTrack(event, 'skipped', result);
      return;
    }

    let task: WorkflowTask | null;
    try {
      task = await this.core.getWorkflowTask(event.task_id);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result.failed++;
      result.errors.push(err);
      if (this.onError !== null) {
        try {
          this.onError(err);
        } catch {
          /* swallow */
        }
      }
      if (this.onTaskOutcome !== null) {
        try {
          this.onTaskOutcome(event, 'failed');
        } catch {
          /* swallow */
        }
      }
      this.log({
        event: 'workflow_event.fetch_task_failed',
        task_id: event.task_id,
        error: err.message,
      });
      // Review #2: negative-ack so Core pushes next_delivery_at out
      // instead of hot-looping on a Core that's flaking on
      // getWorkflowTask (e.g. transient 5xx). Previously the branch
      // returned without marking, so every subsequent tick re-fetched
      // the same event.
      await this.markDeliveryFailed(event, err);
      return;
    }

    if (task === null) {
      // Task archived before we got here — nothing to dispatch.
      await this.ackAndTrack(event, 'skipped', result);
      return;
    }

    if (event.event_kind === 'approved') {
      if (task.kind !== 'approval') {
        await this.ackAndTrack(event, 'skipped', result);
        return;
      }
      // Review #4: re-read the task's CURRENT state before dispatching.
      // A redriven `approved` event can arrive after the task has
      // already been failed / cancelled by the expiry reconciler or
      // a manual `/service_deny` — dispatching in those cases would
      // spawn execution on a task that's no longer live. We only
      // dispatch when the task is in the narrow set of states that
      // still represent "operator said yes and nothing terminal has
      // happened yet": queued + running (claimed by a previous event)
      // + pending_approval (race against reconciler).
      const DISPATCHABLE: ReadonlySet<string> = new Set(['queued', 'running', 'pending_approval']);
      if (!DISPATCHABLE.has(task.status)) {
        this.log({
          event: 'workflow_event.approved_skipped_terminal',
          task_id: task.id,
          task_state: task.status,
        });
        await this.ackAndTrack(event, 'skipped', result);
        return;
      }
      await this.dispatchApproved(event, task, result);
      return;
    }

    // event_kind in ('completed', 'failed', 'cancelled')
    if (task.kind !== 'service_query') {
      await this.ackAndTrack(event, 'skipped', result);
      return;
    }

    const details = this.composeDetails(event, task);
    const text = formatServiceQueryResult(details);

    try {
      await this.deliver({ text, event, task, details });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result.failed++;
      result.errors.push(err);
      if (this.onError !== null) {
        try {
          this.onError(err);
        } catch {
          /* swallow */
        }
      }
      if (this.onTaskOutcome !== null) {
        try {
          this.onTaskOutcome(event, 'failed');
        } catch {
          /* swallow */
        }
      }
      this.log({
        event: 'workflow_event.deliver_failed',
        event_id: event.event_id,
        error: err.message,
      });
      // Negative-ack with exponential-ish backoff: let Core push
      // `next_delivery_at` out so subsequent `needs_delivery=true`
      // sweeps don't immediately re-surface this event. Previously
      // a failing deliverer caused a hot loop at every tick (review
      // #6). The consumer tolerates the mark-fail call itself
      // failing — we simply don't ack and let Core retry.
      await this.markDeliveryFailed(event, err);
      return;
    }

    await this.ackAndTrack(event, 'delivered', result);
  }

  /**
   * Record a delivery/dispatch failure with Core so the event's
   * `next_delivery_at` backs off. Failures to record are swallowed —
   * the sweeper's own retry is still in effect, so we never want a
   * negative-ack hiccup to cascade into a thrown exception inside
   * the consumer's error path.
   */
  private async markDeliveryFailed(event: WorkflowEvent, err: Error): Promise<void> {
    // Exponential-ish backoff floor: 1s for the first failure, doubling
    // every attempt, capped at 5 minutes. The `(delivery_attempts + 1)`
    // reflects THIS attempt being the one we're about to record.
    const attempt = event.delivery_attempts + 1;
    const backoffMs = Math.min(1_000 * Math.pow(2, Math.min(attempt, 10)), 5 * 60_000);
    try {
      await this.core.failWorkflowEventDelivery(event.event_id, {
        nextDeliveryAt: Date.now() + backoffMs,
        error: err.message,
      });
    } catch (markErr) {
      this.log({
        event: 'workflow_event.mark_fail_failed',
        event_id: event.event_id,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
  }

  /**
   * Parse the approval task's payload and hand it to the installed
   * dispatcher. Payload must include `from_did / query_id / capability /
   * params` for the downstream execution call; anything else surfaces as
   * a failed dispatch (the event is NOT acked — a redriven event with a
   * corrected payload can still land).
   */
  private async dispatchApproved(
    event: WorkflowEvent,
    task: WorkflowTask,
    result: WorkflowEventTickResult,
  ): Promise<void> {
    const dispatcher = this.onApproved;
    if (dispatcher === null) return;

    // Approval tasks can carry a payload other than the bus-driver
    // service_query_execution envelope — e.g. intent_validation
    // approvals raised by POST v1/intent/validate. Those approvals
    // settle when the agent polls v1/intent/:id/status; there's no
    // service.query requester waiting on a D2D response, so the
    // event-consumer's job is just to skip them cleanly. Without
    // this the malformed-payload branch below would mark the event
    // failed + back off, leaving a noisy redrive loop on every
    // intent approval.
    const payloadType = peekPayloadType(task.payload);
    if (payloadType !== '' && payloadType !== 'service_query_execution') {
      this.log({
        event: 'workflow_event.approved_skipped_other_payload',
        task_id: task.id,
        payload_type: payloadType,
      });
      await this.ackAndTrack(event, 'skipped', result);
      return;
    }

    const payload = parseApprovedPayload(task.payload);
    if (payload === null) {
      result.failed++;
      const err = new Error(`workflow_event.approved_payload_invalid: task ${task.id}`);
      result.errors.push(err);
      if (this.onError !== null) {
        try {
          this.onError(err);
        } catch {
          /* swallow */
        }
      }
      if (this.onTaskOutcome !== null) {
        try {
          this.onTaskOutcome(event, 'failed');
        } catch {
          /* swallow */
        }
      }
      this.log({
        event: 'workflow_event.approved_payload_invalid',
        task_id: task.id,
      });
      // Review #3: malformed payload is not going to fix itself on
      // retry — but the consumer has no authority to archive events,
      // so mark it failed with a long backoff. Core's delivery
      // scheduler will stop hot-looping; an operator can inspect the
      // event + task via diagnostics and cancel the task manually.
      // Previously this branch returned without marking, so every
      // tick resurrected the same bad event.
      await this.markDeliveryFailed(event, err);
      return;
    }

    try {
      await dispatcher({ event, task, payload });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result.failed++;
      result.errors.push(err);
      if (this.onError !== null) {
        try {
          this.onError(err);
        } catch {
          /* swallow */
        }
      }
      if (this.onTaskOutcome !== null) {
        try {
          this.onTaskOutcome(event, 'failed');
        } catch {
          /* swallow */
        }
      }
      this.log({
        event: 'workflow_event.approved_dispatch_failed',
        event_id: event.event_id,
        error: err.message,
      });
      // Negative-ack (review #6) — same reasoning as the deliver
      // path: let Core back off instead of re-surfacing on every tick.
      await this.markDeliveryFailed(event, err);
      return;
    }

    await this.ackAndTrack(event, 'delivered', result);
  }

  /**
   * Merge `event.details` with the task's stored `result` (the full D2D
   * `service.response` body) + the task's `payload` (capability + service
   * name) so the formatter sees everything it needs regardless of which
   * event kind triggered delivery (completed / failed / cancelled).
   */
  private composeDetails(event: WorkflowEvent, task: WorkflowTask): ServiceQueryEventDetails {
    let details: ServiceQueryEventDetails = {};
    try {
      const parsed = JSON.parse(event.details) as ServiceQueryEventDetails;
      if (parsed !== null && typeof parsed === 'object') details = parsed;
    } catch {
      /* malformed details — fall through with an empty object */
    }

    // Backfill capability + service_name from the task payload when the
    // event details didn't carry them (most non-completed events don't).
    if (!details.capability || !details.service_name) {
      try {
        const payload = JSON.parse(task.payload) as {
          capability?: unknown;
          service_name?: unknown;
        };
        if (!details.capability && typeof payload.capability === 'string') {
          details.capability = payload.capability;
        }
        if (!details.service_name && typeof payload.service_name === 'string') {
          details.service_name = payload.service_name;
        }
      } catch {
        /* malformed payload — formatter shows generic "Service" */
      }
    }

    // Map event_kind → response_status when details didn't specify one.
    // `failed` events from expiry fan-out already set response_status=
    // 'expired'; `cancelled` events from /service_deny just carry
    // {reason} so we synthesise `response_status='unavailable'` and
    // promote the reason into the `error` slot.
    if (details.response_status === undefined || details.response_status === '') {
      if (event.event_kind === 'cancelled') {
        details.response_status = 'unavailable';
        if (!details.error) {
          try {
            const c = JSON.parse(event.details) as { reason?: unknown };
            if (typeof c.reason === 'string' && c.reason !== '') details.error = c.reason;
          } catch {
            /* malformed */
          }
        }
      } else if (event.event_kind === 'failed') {
        details.response_status = 'error';
      }
    }

    if (typeof task.result === 'string' && task.result !== '') {
      try {
        const body = JSON.parse(task.result) as Partial<ServiceResponseBody>;
        if (details.result === undefined && body.result !== undefined) {
          details.result = body.result;
        }
        if (
          (details.response_status === undefined || details.response_status === '') &&
          typeof body.status === 'string'
        ) {
          details.response_status = body.status;
        }
      } catch {
        /* malformed body — formatter falls back on details alone */
      }
    }
    return details;
  }

  private async ackAndTrack(
    event: WorkflowEvent,
    outcome: 'delivered' | 'skipped',
    result: WorkflowEventTickResult,
  ): Promise<void> {
    try {
      await this.core.acknowledgeWorkflowEvent(event.event_id);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result.errors.push(err);
      if (this.onError !== null) {
        try {
          this.onError(err);
        } catch {
          /* swallow */
        }
      }
      this.log({
        event: 'workflow_event.ack_failed',
        event_id: event.event_id,
        error: err.message,
      });
      return;
    }
    if (outcome === 'delivered') result.delivered++;
    else result.skipped++;
    if (this.onTaskOutcome !== null) {
      try {
        this.onTaskOutcome(event, outcome);
      } catch {
        /* swallow */
      }
    }
    this.log({ event: `workflow_event.${outcome}`, event_id: event.event_id });
  }
}

/**
 * Read the `type` field from an approval task's JSON payload without
 * validating the rest of the envelope. Returns `''` for malformed JSON
 * or a missing/non-string `type`. Used to discriminate
 * `service_query_execution` (bus-driver flow) from other approval
 * payload kinds (e.g. `intent_validation`) that should be skipped by
 * this consumer.
 */
function peekPayloadType(raw: string): string {
  try {
    const p = JSON.parse(raw);
    if (p === null || typeof p !== 'object') return '';
    const t = (p as Record<string, unknown>).type;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

/**
 * Extract the `service_query_execution` envelope from an approval task's
 * payload. Returns `null` when the payload is malformed or missing any
 * required field — the consumer treats that as a dispatch-failure so
 * Core can redrive after an operator re-issues the task.
 */
function parseApprovedPayload(raw: string): ApprovedExecutionPayload | null {
  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(raw);
    if (p === null || typeof p !== 'object') return null;
    parsed = p as Record<string, unknown>;
  } catch {
    return null;
  }
  const from_did = parsed.from_did;
  const query_id = parsed.query_id;
  const capability = parsed.capability;
  if (
    typeof from_did !== 'string' ||
    from_did === '' ||
    typeof query_id !== 'string' ||
    query_id === '' ||
    typeof capability !== 'string' ||
    capability === ''
  ) {
    return null;
  }
  return {
    from_did,
    query_id,
    capability,
    params: parsed.params,
    ttl_seconds: typeof parsed.ttl_seconds === 'number' ? parsed.ttl_seconds : undefined,
    // Treat empty-string schema_hash / service_name as absent — the handler
    // writes them as '' when no value is available, and downstream consumers
    // expect a missing field in that case.
    schema_hash:
      typeof parsed.schema_hash === 'string' && parsed.schema_hash !== ''
        ? parsed.schema_hash
        : undefined,
    service_name:
      typeof parsed.service_name === 'string' && parsed.service_name !== ''
        ? parsed.service_name
        : undefined,
  };
}
