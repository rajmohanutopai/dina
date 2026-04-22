/**
 * Task 6.14 — `com.dina.contact.resolve` xRPC client.
 *
 * Brain uses `contact.resolve` to turn a human-readable handle
 * (`alice.bsky.social`) or display name into a canonical DID with
 * trust metadata. The typical use:
 *
 *   - User types "Alice" at the nudge composer.
 *   - Brain's ContactMatcher (5.35) + PersonResolver (5.36) look
 *     local first.
 *   - For unknown names, Brain calls `contact.resolve(query)` and
 *     the AppView returns candidate DIDs ranked by trust.
 *   - Brain renders the candidates; user picks one.
 *
 * **Response shape** (mirrors the plan doc + AppView):
 *
 *   {
 *     "contacts": [{
 *       "did": "did:plc:abc123...",
 *       "handle": "alice.bsky.social",
 *       "displayName": "Alice",
 *       "trustScore": 0.75,
 *       "ring": 2,
 *       "lastSeenMs": 1234567890000
 *     }],
 *     "total": 1
 *   }
 *
 * **Query hygiene**: the query string is trimmed + length-capped
 * at 128 chars. Queries with control chars or NULs rejected.
 *
 * **Error taxonomy** matches the other AppView clients (6.11-6.13):
 * `invalid_input`, `network_error`, `rejected_by_appview`,
 * `malformed_response`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6d task 6.14.
 */

import type { XrpcFetchResult } from './trust_resolve_client';

export interface ContactResolveRequest {
  /** Free-text handle / display-name to resolve. Required. */
  query: string;
  /** Max results — clamped to [1, 20]. Default 10. */
  limit?: number;
  /** Filter by minimum ring. */
  minRing?: 1 | 2 | 3;
}

export interface ContactMatch {
  did: string;
  handle: string;
  /** Human-readable name the user chose (from profile record). */
  displayName: string;
  /** 0..1 trust score, null when unknown. */
  trustScore: number | null;
  /** Ring distance 1/2/3, null when unknown. */
  ring: 1 | 2 | 3 | null;
  /** UTC ms of last seen activity — null when unknown. */
  lastSeenMs: number | null;
}

export interface ContactResolveResponse {
  contacts: ContactMatch[];
  /** Total matches AppView knows about (may be > contacts.length due to limit). */
  total: number;
}

export type ContactResolveRejectionReason =
  | 'invalid_input'
  | 'network_error'
  | 'rejected_by_appview'
  | 'malformed_response';

export type ContactResolveOutcome =
  | { ok: true; response: ContactResolveResponse }
  | { ok: false; reason: 'invalid_input'; detail: string }
  | { ok: false; reason: 'network_error'; error: string }
  | { ok: false; reason: 'rejected_by_appview'; status: number; error: string }
  | { ok: false; reason: 'malformed_response'; detail: string };

export type ContactResolveFetchFn = (
  input: ContactResolveRequest,
) => Promise<XrpcFetchResult>;

export interface ContactResolveClientOptions {
  fetchFn: ContactResolveFetchFn;
  onEvent?: (event: ContactResolveEvent) => void;
}

export type ContactResolveEvent =
  | { kind: 'resolved'; query: string; contactCount: number }
  | { kind: 'rejected'; query: string; reason: ContactResolveRejectionReason };

export const MAX_CONTACT_QUERY_LEN = 128;
export const MAX_CONTACT_LIMIT = 20;
export const DEFAULT_CONTACT_LIMIT = 10;

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:-]+)$/;
/** Matches ASCII control chars (0x00–0x08, 0x0B–0x0C, 0x0E–0x1F). Excludes tab, newline, CR. */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/**
 * Create the `contact.resolve` xRPC client. Returns a function that
 * takes `{query, limit?, minRing?}` and resolves to a typed outcome.
 */
export function createContactResolveClient(
  opts: ContactResolveClientOptions,
): (input: ContactResolveRequest) => Promise<ContactResolveOutcome> {
  if (typeof opts?.fetchFn !== 'function') {
    throw new TypeError('createContactResolveClient: fetchFn is required');
  }
  const fetchFn = opts.fetchFn;
  const onEvent = opts.onEvent;

  return async function resolve(
    input: ContactResolveRequest,
  ): Promise<ContactResolveOutcome> {
    const validation = validateInput(input);
    if (validation !== null) {
      onEvent?.({
        kind: 'rejected',
        query: String(input?.query ?? ''),
        reason: 'invalid_input',
      });
      return { ok: false, reason: 'invalid_input', detail: validation };
    }
    const normalised = normaliseInput(input);

    let result: XrpcFetchResult;
    try {
      result = await fetchFn(normalised);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({
        kind: 'rejected',
        query: normalised.query,
        reason: 'network_error',
      });
      return { ok: false, reason: 'network_error', error: msg };
    }

    if (result.status < 200 || result.status >= 300) {
      const msg = typeof (result.body as { error?: unknown })?.error === 'string'
        ? ((result.body as { error: string }).error)
        : `status ${result.status}`;
      onEvent?.({
        kind: 'rejected',
        query: normalised.query,
        reason: 'rejected_by_appview',
      });
      return {
        ok: false,
        reason: 'rejected_by_appview',
        status: result.status,
        error: msg,
      };
    }

    if (result.body === null) {
      onEvent?.({
        kind: 'resolved',
        query: normalised.query,
        contactCount: 0,
      });
      return { ok: true, response: { contacts: [], total: 0 } };
    }

    const parsed = parseResponse(result.body);
    if (!parsed.ok) {
      onEvent?.({
        kind: 'rejected',
        query: normalised.query,
        reason: 'malformed_response',
      });
      return parsed;
    }
    onEvent?.({
      kind: 'resolved',
      query: normalised.query,
      contactCount: parsed.response.contacts.length,
    });
    return parsed;
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateInput(input: ContactResolveRequest | null | undefined): string | null {
  if (input === null || input === undefined || typeof input !== 'object') {
    return 'request must be an object';
  }
  if (typeof input.query !== 'string') {
    return 'query must be a string';
  }
  const trimmed = input.query.trim();
  if (trimmed === '') return 'query must be non-empty';
  if (trimmed.length > MAX_CONTACT_QUERY_LEN) {
    return `query must be <= ${MAX_CONTACT_QUERY_LEN} chars`;
  }
  if (CONTROL_RE.test(trimmed)) {
    return 'query contains control characters';
  }
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_CONTACT_LIMIT
    ) {
      return `limit must be integer in [1, ${MAX_CONTACT_LIMIT}]`;
    }
  }
  if (input.minRing !== undefined) {
    if (input.minRing !== 1 && input.minRing !== 2 && input.minRing !== 3) {
      return 'minRing must be 1, 2, or 3';
    }
  }
  return null;
}

function normaliseInput(input: ContactResolveRequest): ContactResolveRequest {
  return {
    ...input,
    query: input.query.trim(),
    limit: input.limit ?? DEFAULT_CONTACT_LIMIT,
  };
}

type ParseOk = { ok: true; response: ContactResolveResponse };
type ParseFail = { ok: false; reason: 'malformed_response'; detail: string };

function parseResponse(body: Record<string, unknown>): ParseOk | ParseFail {
  if (!Array.isArray(body.contacts)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'body.contacts must be an array',
    };
  }
  const contacts: ContactMatch[] = [];
  for (const entry of body.contacts) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.did !== 'string' || !DID_RE.test(e.did)) continue;
    if (typeof e.handle !== 'string' || e.handle === '') continue;
    if (typeof e.displayName !== 'string') continue;
    contacts.push({
      did: e.did,
      handle: e.handle,
      displayName: e.displayName,
      trustScore:
        typeof e.trustScore === 'number' && Number.isFinite(e.trustScore)
          ? e.trustScore
          : null,
      ring: e.ring === 1 || e.ring === 2 || e.ring === 3 ? (e.ring as 1 | 2 | 3) : null,
      lastSeenMs:
        typeof e.lastSeenMs === 'number' &&
        Number.isInteger(e.lastSeenMs) &&
        e.lastSeenMs >= 0
          ? e.lastSeenMs
          : null,
    });
  }
  const total =
    typeof body.total === 'number' && Number.isInteger(body.total) && body.total >= 0
      ? body.total
      : contacts.length;
  return { ok: true, response: { contacts, total } };
}
