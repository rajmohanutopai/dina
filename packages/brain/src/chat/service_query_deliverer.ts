/**
 * Shared `service_query` chat deliverer — the requester-side bridge from a
 * `WorkflowEventConsumer` event to a chat-thread lifecycle card.
 *
 * Both surfaces use THIS, so the "one card per query" reconciliation lives in
 * exactly one place:
 *   - mobile (`apps/mobile/src/services/bootstrap.ts`) — in-process consumer.
 *   - home-node-lite brain-server — out-of-process consumer polling Core.
 *
 * Behaviour (lifted verbatim from the mobile bootstrap that shipped it):
 *   - The orchestrator / ask-coordinator bridge posts a `'dina'` message
 *     tagged `metadata.lifecycle.kind === 'service_query'` (status `pending`)
 *     when the query is dispatched. When the response lands we PATCH that
 *     message in place (`updateMessageLifecycle`) keyed by `task.id` — so a
 *     resolved answer and any later terminal event collapse onto the SAME
 *     card instead of stacking a second bubble.
 *   - If the event lands before any pending card exists (peer answered before
 *     the LLM finished dispatching), we post a fresh lifecycle message already
 *     in its terminal state — still exactly one card.
 *   - Non-`service_query` workflow events fall back to a plain dina bubble.
 *
 * The only surface-specific input is the optional `threadResolver` (mobile
 * maps a query's `origin_channel` to a per-channel thread); lite passes a
 * fixed `threadId` (`'main'`).
 */

import { validateCardSpec, type CardSpec } from '@dina/protocol';

import { buildResultCardSpec } from '../service/result_card_mapper';
import type { WorkflowEventDeliverer } from '../service/workflow_event_consumer';

import {
  addDinaResponse,
  addLifecycleMessage,
  findMessageByTaskId,
  hydrateThread,
  readLifecycle,
  updateMessageLifecycle,
  type ServiceQueryLifecycle,
  type ServiceQueryStatus,
} from './thread';

export interface ServiceQueryDelivererOptions {
  /** Fallback thread the card lands in when no resolver is supplied or it
   *  returns empty. Lite uses the chat default (`'main'`). */
  threadId: string;
  /**
   * Optional per-event thread resolver. Mobile maps the query's
   * `origin_channel` (stamped on the task payload) to a per-channel thread;
   * omit to always use `threadId`.
   */
  threadResolver?: (ctx: {
    originChannel: string;
    eventKind: string;
    task: { id: string; kind: string };
  }) => string | null;
}

/**
 * Build a `WorkflowEventDeliverer` that reconciles service-query workflow
 * events into chat-thread lifecycle cards. See module docstring.
 */
export function createServiceQueryDeliverer(
  options: ServiceQueryDelivererOptions,
): WorkflowEventDeliverer {
  const { threadId, threadResolver } = options;
  return async ({ text, event, task, details }) => {
    const sources: string[] = [];
    if (event.task_id !== '') sources.push(event.task_id);
    if (details.capability !== undefined && details.capability !== '') {
      sources.push(details.capability);
    }
    let target = threadId;
    let diverted = false;
    if (threadResolver !== undefined) {
      const originChannel = extractOriginChannel(task.payload);
      const resolved = threadResolver({
        originChannel,
        eventKind: event.event_kind,
        task: { id: task.id, kind: task.kind },
      });
      if (resolved !== null && resolved !== '') {
        target = resolved;
        diverted = true;
      }
    }

    // Hydration race fix (P2-3): peer Talk threads hydrate LAZILY (on first
    // open), so a `service.response` that arrives before the peer chat is
    // opened would scan an EMPTY in-memory thread, miss the persisted pending
    // card, and post a DUPLICATE terminal card. Hydrate the diverted (peer)
    // thread from the repo first so the patch finds the persisted card. The
    // default thread ('main') is already hydrated at boot, so only hydrate
    // when the resolver diverted us to another thread. `hydrateThread` is a
    // no-op when no repo is wired and a merge otherwise (never clobbers live
    // entries), so it's safe even when the thread is already in memory.
    if (diverted) {
      try {
        await hydrateThread(target);
      } catch {
        /* hydration is best-effort — fall through to the in-memory scan */
      }
    }

    // Lifecycle pattern — patch the pending card in place instead of
    // appending a new message. The two-messages-for-one-query race is gone.
    const existing = findMessageByTaskId(target, task.id);
    const lc = existing !== null ? readLifecycle(existing) : null;

    // Only `service_query` workflow tasks become lifecycle cards — other
    // task kinds (delegation, etc.) keep using the plain dina path.
    if (task.kind === 'service_query') {
      const status = mapResponseStatusToCardStatus(details.response_status);
      const resultBody = parseEventResult(details.result);
      const serviceName =
        details.service_name !== undefined && details.service_name !== ''
          ? details.service_name
          : lc?.kind === 'service_query'
            ? lc.serviceName
            : 'service';
      const capability =
        details.capability !== undefined && details.capability !== ''
          ? details.capability
          : extractCapabilityFromPayload(task.payload);

      // On a resolved success, PREFER a provider-authored card — re-validated
      // as UNTRUSTED first (drops provider trust badges, https-only links,
      // strips unknown blocks). Fall back to the deterministic mapper over
      // `result` when the provider sent no card or it failed validation.
      const cardSpec: CardSpec | null =
        status === 'resolved'
          ? (validateCardSpec(details.card, { trusted: false }) ??
            (resultBody !== null
              ? buildResultCardSpec({ capability, serviceName, result: resultBody })
              : null))
          : null;

      if (lc !== null && lc.kind === 'service_query') {
        const patch: Partial<{
          status: ServiceQueryStatus;
          result: Record<string, unknown>;
          cardSpec: NonNullable<typeof cardSpec>;
          error: string;
          serviceName: string;
          resolvedAt: number;
        }> = { status, serviceName, resolvedAt: Date.now() };
        if (resultBody !== null) patch.result = resultBody;
        if (cardSpec !== null) patch.cardSpec = cardSpec;
        if (typeof details.error === 'string' && details.error !== '') {
          patch.error = details.error;
        }
        updateMessageLifecycle(target, task.id, patch, text);
        return;
      }

      // Workflow event landed before any chat artifact existed (e.g. peer
      // answered before the LLM completed). Post a fresh lifecycle message in
      // terminal state so the user still sees one card. `queryId` isn't on the
      // event details — recover it from the task payload (stamped at dispatch).
      const lifecycle: ServiceQueryLifecycle = {
        kind: 'service_query',
        status,
        taskId: task.id,
        queryId: extractQueryIdFromPayload(task.payload),
        capability,
        serviceName,
      };
      if (resultBody !== null) lifecycle.result = resultBody;
      if (cardSpec !== null) lifecycle.cardSpec = cardSpec;
      if (typeof details.error === 'string' && details.error !== '') {
        lifecycle.error = details.error;
      }
      addLifecycleMessage(target, text, lifecycle);
      return;
    }

    // Non-service_query workflow events keep the normal dina-bubble path.
    addDinaResponse(target, text, sources.length > 0 ? sources : undefined);
  };
}

/** Map a D2D `service.response` status onto a card lifecycle status. */
export function mapResponseStatusToCardStatus(status: string | undefined): ServiceQueryStatus {
  switch (status) {
    case 'success':
      return 'resolved';
    case 'expired':
      return 'expired';
    case 'unavailable':
    case 'error':
    default:
      return 'failed';
  }
}

/**
 * The workflow event's `details.result` arrives as either a parsed JSON object
 * or its string form (Core's mixed delivery). Coerce to a plain object so the
 * card renderer can read fields without re-parsing. `null` when missing/unparseable.
 */
export function parseEventResult(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* swallow — the formatter already produced a text fallback */
    }
  }
  return null;
}

/** Pull `query_id` from a `service_query` task's JSON payload. '' on failure. */
export function extractQueryIdFromPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { query_id?: unknown };
    return typeof parsed.query_id === 'string' ? parsed.query_id : '';
  } catch {
    return '';
  }
}

/** Recover the capability stamped into the task payload at dispatch. '' on failure. */
export function extractCapabilityFromPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { capability?: unknown };
    return typeof parsed.capability === 'string' ? parsed.capability : '';
  } catch {
    return '';
  }
}

/** Best-effort extract of `origin_channel` from a task payload. '' on failure. */
export function extractOriginChannel(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { origin_channel?: unknown };
    return typeof parsed.origin_channel === 'string' ? parsed.origin_channel : '';
  } catch {
    return '';
  }
}
