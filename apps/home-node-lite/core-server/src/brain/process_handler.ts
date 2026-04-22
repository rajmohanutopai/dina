/**
 * Task 5.16 — `POST /api/v1/process`.
 *
 * Synchronous event-processing endpoint. Clients POST an inbound
 * event (captured email, calendar item, D2D nudge payload); Brain
 * runs the classification → delivery pipeline + returns a
 * structured disposition so the caller knows what happened.
 *
 * **Pipeline**:
 *
 *   1. **Validate** input (non-empty content + persona + stable id).
 *   2. **Classify** via `DomainClassifier` (task 5.32) → sensitivity
 *      + domain. Informs downstream routing (cloud LLM vs. local,
 *      scrubbing intensity).
 *   3. **Prioritise** via the caller-supplied `prioritiseFn`. The
 *      prioritiser reads the event + classification + any content
 *      heuristics (promises, deadlines, urgent phrasing) and returns
 *      one of the three Silence-First tiers from task 5.48.
 *   4. **Deliver** via `notifyFn` — routes the event to the actual
 *      downstream (NotifyDispatcher, buffer for briefing, …).
 *   5. **Respond** with `{event_id, disposition, priority,
 *      classification, elapsed_ms}`.
 *
 * **Never throws** — every failure path funnels into a structured
 * `failed` disposition. The caller gets a shape it can switch on.
 *
 * **Trace correlation** (task 5.58): the inbound `X-Request-Id`
 * header is honoured + surfaces in every downstream log line via
 * `withTrace`. Events inherit the same trace id so an admin UI
 * timeline can render the full request → notification chain.
 *
 * **Idempotency**: the handler does NOT enforce dedupe itself —
 * the caller (NotifyDispatcher / IdempotencyCache 4.83) owns that
 * concern. A duplicate submission yields a duplicate disposition;
 * the prioritiser can inspect `eventId` to skip work if needed.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5c task 5.16.
 */

import type { Classification, DomainClassifier } from './domain_classifier';
import type { NotifyPriority } from './priority';
import {
  inboundRequestId,
  newRequestId,
  withTrace,
  type TraceContext,
} from './trace_correlation';

export type ProcessDisposition =
  | 'notified' // NotifyFn accepted + user will see the notification
  | 'buffered' // Event queued for the next briefing flush
  | 'skipped'; // Classifier / prioritiser decided to drop

export interface ProcessRequest {
  /** Stable event id (caller supplies — typically the source item id). */
  eventId: string;
  /** The payload to classify + route. Email body, D2D payload text, etc. */
  content: string;
  /** Active persona when the event was captured. */
  persona: string;
  /** Free-form kind tag (gmail / d2d / calendar / manual). */
  kind?: string;
  /** Optional sender DID — only for audit, not classification. */
  senderDid?: string;
  /** Inbound X-Request-Id. Validated + promoted to trace if present. */
  requestIdHeader?: string | null;
}

/**
 * Caller-supplied prioritiser. Receives the full classification +
 * original request, returns the priority tier AND whether to
 * actually deliver. Returning `{kind: 'skip'}` drops the event; the
 * handler reports `disposition: 'skipped'`.
 */
export type PrioritiseFn = (input: {
  req: ProcessRequest;
  classification: Classification;
}) => Promise<PrioritiseOutcome>;

export type PrioritiseOutcome =
  | { kind: 'deliver'; priority: NotifyPriority }
  | { kind: 'skip'; reason: string };

/**
 * Delivery function. Called when the prioritiser returns `deliver`.
 * Returns the actual disposition (notified vs buffered) so the
 * handler reports it verbatim — some priorities buffer even when the
 * caller says "deliver" (engagement events buffer by design).
 */
export type NotifyFn = (input: {
  req: ProcessRequest;
  classification: Classification;
  priority: NotifyPriority;
}) => Promise<Extract<ProcessDisposition, 'notified' | 'buffered'>>;

export interface ProcessSuccessBody {
  request_id: string;
  event_id: string;
  disposition: ProcessDisposition;
  priority: NotifyPriority | null;
  classification: {
    sensitivity: Classification['sensitivity'];
    domain: Classification['domain'];
    confidence: number;
    reason: string;
    layer: Classification['layer'];
  };
  /** Skip reason — present when `disposition === 'skipped'`. */
  skip_reason?: string;
  elapsed_ms: number;
}

export interface ProcessFailureBody {
  request_id: string;
  event_id: string;
  error: {
    kind: 'invalid_input' | 'classify_failed' | 'prioritise_failed' | 'notify_failed';
    message: string;
  };
  elapsed_ms: number;
}

export type ProcessResult =
  | { status: 200; body: ProcessSuccessBody }
  | { status: 400; body: ProcessFailureBody }
  | { status: 500; body: ProcessFailureBody };

export interface ProcessHandlerOptions {
  domainClassifier: Pick<DomainClassifier, 'classify'>;
  prioritiseFn: PrioritiseFn;
  notifyFn: NotifyFn;
  /** Clock. Defaults to `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. */
  onEvent?: (event: ProcessHandlerEvent) => void;
}

export type ProcessHandlerEvent =
  | { kind: 'invalid_input'; eventId: string; reason: string }
  | {
      kind: 'classified';
      eventId: string;
      sensitivity: Classification['sensitivity'];
      domain: Classification['domain'];
    }
  | { kind: 'skipped'; eventId: string; reason: string }
  | { kind: 'delivered'; eventId: string; priority: NotifyPriority; disposition: 'notified' | 'buffered' }
  | { kind: 'classify_failed'; eventId: string; error: string }
  | { kind: 'prioritise_failed'; eventId: string; error: string }
  | { kind: 'notify_failed'; eventId: string; error: string };

/**
 * Factory for the process handler. Framework-free —
 * `(req) => ProcessResult`.
 */
export function createProcessHandler(
  opts: ProcessHandlerOptions,
): (req: ProcessRequest) => Promise<ProcessResult> {
  if (!opts?.domainClassifier || typeof opts.domainClassifier.classify !== 'function') {
    throw new TypeError('createProcessHandler: domainClassifier is required');
  }
  if (typeof opts.prioritiseFn !== 'function') {
    throw new TypeError('createProcessHandler: prioritiseFn is required');
  }
  if (typeof opts.notifyFn !== 'function') {
    throw new TypeError('createProcessHandler: notifyFn is required');
  }
  const classifier = opts.domainClassifier;
  const prioritiseFn = opts.prioritiseFn;
  const notifyFn = opts.notifyFn;
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const onEvent = opts.onEvent;

  return async function handleProcess(req: ProcessRequest): Promise<ProcessResult> {
    const start = nowMsFn();
    const eventId = req?.eventId ?? '';
    // Input validation — return 400 with structured detail.
    const validation = validate(req);
    if (validation !== null) {
      onEvent?.({ kind: 'invalid_input', eventId, reason: validation });
      const requestId =
        inboundRequestId(req?.requestIdHeader ?? null) ?? newRequestId();
      return {
        status: 400,
        body: {
          request_id: requestId,
          event_id: eventId,
          error: { kind: 'invalid_input', message: validation },
          elapsed_ms: nowMsFn() - start,
        },
      };
    }

    const requestId =
      inboundRequestId(req.requestIdHeader ?? null) ?? newRequestId();
    const trace: TraceContext = Object.freeze({
      requestId,
      parentId: null,
      startedAtMs: start,
    });

    return withTrace(trace, async () => {
      // 1. Classify.
      let classification: Classification;
      try {
        classification = await classifier.classify({
          text: req.content,
          persona: req.persona,
        });
        onEvent?.({
          kind: 'classified',
          eventId,
          sensitivity: classification.sensitivity,
          domain: classification.domain,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ kind: 'classify_failed', eventId, error: msg });
        return {
          status: 500,
          body: {
            request_id: requestId,
            event_id: eventId,
            error: { kind: 'classify_failed', message: msg },
            elapsed_ms: nowMsFn() - start,
          },
        };
      }

      // 2. Prioritise.
      let outcome: PrioritiseOutcome;
      try {
        outcome = await prioritiseFn({ req, classification });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ kind: 'prioritise_failed', eventId, error: msg });
        return {
          status: 500,
          body: {
            request_id: requestId,
            event_id: eventId,
            error: { kind: 'prioritise_failed', message: msg },
            elapsed_ms: nowMsFn() - start,
          },
        };
      }

      if (outcome.kind === 'skip') {
        onEvent?.({ kind: 'skipped', eventId, reason: outcome.reason });
        return {
          status: 200,
          body: {
            request_id: requestId,
            event_id: eventId,
            disposition: 'skipped',
            priority: null,
            classification: classificationView(classification),
            skip_reason: outcome.reason,
            elapsed_ms: nowMsFn() - start,
          },
        };
      }

      // 3. Deliver.
      const priority = outcome.priority;
      let disposition: 'notified' | 'buffered';
      try {
        disposition = await notifyFn({ req, classification, priority });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ kind: 'notify_failed', eventId, error: msg });
        return {
          status: 500,
          body: {
            request_id: requestId,
            event_id: eventId,
            error: { kind: 'notify_failed', message: msg },
            elapsed_ms: nowMsFn() - start,
          },
        };
      }

      onEvent?.({ kind: 'delivered', eventId, priority, disposition });
      return {
        status: 200,
        body: {
          request_id: requestId,
          event_id: eventId,
          disposition,
          priority,
          classification: classificationView(classification),
          elapsed_ms: nowMsFn() - start,
        },
      };
    });
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(req: ProcessRequest | undefined | null): string | null {
  if (!req || typeof req !== 'object') return 'request body is required';
  if (typeof req.eventId !== 'string' || req.eventId.trim() === '') {
    return 'eventId must be a non-empty string';
  }
  if (typeof req.content !== 'string' || req.content.trim() === '') {
    return 'content must be a non-empty string';
  }
  if (typeof req.persona !== 'string' || req.persona.trim() === '') {
    return 'persona must be a non-empty string';
  }
  return null;
}

function classificationView(c: Classification): ProcessSuccessBody['classification'] {
  return {
    sensitivity: c.sensitivity,
    domain: c.domain,
    confidence: c.confidence,
    reason: c.reason,
    layer: c.layer,
  };
}
