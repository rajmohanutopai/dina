/**
 * Poll-mode watch payload (PUSH_SERVICES_ARCHITECTURE.md §3.2 / Phase 0, and the
 * DINA_WORKFLOW_CONTROL_PLANE §6 Watch blueprint).
 *
 * A watch is the long-lived, subscriber-owned anchor of a standing subscription.
 * In POLL mode (the only Phase-0 fulfilment) Dina drives it: when the watch's
 * `next_run_at` fires on the scheduler, Dina sends an ordinary `service.query`
 * to the provider, who answers with `service.response` through the existing
 * requester lane. There is NO inbound push surface in poll mode.
 *
 * This payload is the LOCAL shape stored in `workflow_tasks.payload` for a
 * `kind='watch'` row — it is not itself a wire message (the issued
 * `service.query` is the wire part, already specified), so it lives in Core, not
 * in `@dina/protocol`.
 */

import { classifyWatchFilter, parseWatchFilter, type WatchFilter } from './filter';

/** Poll-mode watch payload — stored in `workflow_tasks.payload` (JSON). */
export interface WatchPollPayload {
  /** Discriminates the payload family in the shared `workflow_tasks.payload`. */
  type: 'watch_poll';
  /** Subscriber-generated stable id (also the idempotency anchor). */
  subscription_id: string;
  /** The persona the watched topic belongs to. */
  persona: string;
  /** The service being polled (AT-URI of the provider's service record). */
  service_uri: string;
  /** The provider's DID (the `service.query` recipient). */
  provider_did: string;
  /** The capability the query invokes. */
  capability: string;
  /** The `service.query` parameters (opaque to the driver). */
  query: Record<string, unknown>;
  /** Poll cadence in SECONDS (matches the `workflow_tasks.next_run_at` unit). */
  poll_interval_sec: number;
  /** Optional human-readable condition ("BA117 delayed > 30m"). Display only. */
  condition?: string;
  /** R2-04 — the executable WAKE FILTER: only surface a poll result when it
   *  matches (else the watch stays silent — Silence First). Absent → fire always. */
  filter?: WatchFilter;
}

/** The floor poll cadence (§6 "conservative poll intervals"; a hard guard
 *  against a runaway tight loop). 60s — callers set the real, larger interval. */
export const MIN_POLL_INTERVAL_SEC = 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a stored watch payload. Returns null on any shape mismatch (a
 *  malformed/foreign payload is never treated as a pollable watch). */
export function parseWatchPollPayload(raw: string | undefined | null): WatchPollPayload | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== 'watch_poll') return null;
  const subscription_id = parsed.subscription_id;
  const persona = parsed.persona;
  const service_uri = parsed.service_uri;
  const provider_did = parsed.provider_did;
  const capability = parsed.capability;
  const poll_interval_sec = parsed.poll_interval_sec;
  if (
    typeof subscription_id !== 'string' || subscription_id === '' ||
    typeof persona !== 'string' || persona === '' ||
    typeof service_uri !== 'string' || service_uri === '' ||
    typeof provider_did !== 'string' || provider_did === '' ||
    typeof capability !== 'string' || capability === '' ||
    typeof poll_interval_sec !== 'number' || !Number.isFinite(poll_interval_sec) || poll_interval_sec <= 0
  ) {
    return null;
  }
  // R5-07 — a PRESENT-but-invalid filter fails the WHOLE parse (treated as a
  // malformed payload), so a corrupt wake condition can never be silently
  // reinterpreted as "fire always". The sweeper pauses a malformed row (R5-06)
  // and `deliveryPolicyFor` reports it inactive — fail closed, per Silence First.
  if (classifyWatchFilter(parsed.filter) === 'invalid') return null;
  return {
    type: 'watch_poll',
    subscription_id,
    persona,
    service_uri,
    provider_did,
    capability,
    query: isRecord(parsed.query) ? parsed.query : {},
    poll_interval_sec,
    ...(typeof parsed.condition === 'string' ? { condition: parsed.condition } : {}),
    ...((): { filter?: WatchFilter } => {
      const f = parseWatchFilter(parsed.filter);
      return f !== undefined ? { filter: f } : {};
    })(),
  };
}

/** Serialize a watch payload for storage. */
export function serializeWatchPollPayload(p: WatchPollPayload): string {
  return JSON.stringify(p);
}
