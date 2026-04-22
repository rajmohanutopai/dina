/**
 * Task 6.15 — `com.dina.review.list` xRPC client.
 *
 * Reviews are signed claims in the Trust Network — one actor
 * attesting to another actor's reliability, behaviour, or
 * capability. Brain fetches them when:
 *
 *   - Rendering the admin UI "trust" panel (show reviews about me).
 *   - Surfacing Verified-Actioned signals for `decideTrust` (task
 *     6.23) — a positive review from a ring-1 contact carries more
 *     weight than an anonymous one.
 *   - Populating the "review this service after you used it"
 *     prompt (the counterpart list: reviews I've left).
 *
 * **Response shape** (`com.dina.review.list`):
 *
 *   {
 *     "reviews": [{
 *       "id": "at://…/com.dina.review/<rkey>",
 *       "subject": "did:plc:…",
 *       "author": "did:plc:…",
 *       "rating": 5,
 *       "summary": "…",
 *       "createdAtMs": 1234567890000,
 *       "verifiedActioned": true,   // user actually transacted
 *       "context": "…"              // optional free-form (gasoline, dentist, …)
 *     }],
 *     "total": 1,
 *     "cursor": "opaque-string"       // present when more results exist
 *   }
 *
 * **Input**: either `subject` (reviews ABOUT someone) or `author`
 * (reviews BY someone) must be provided — not both at once. The
 * AppView query-planner uses the filter to pick its index.
 *
 * **Error taxonomy** aligned with 6.11-6.14: `invalid_input`,
 * `network_error`, `rejected_by_appview`, `malformed_response`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6d task 6.15.
 */

import type { XrpcFetchResult } from './trust_resolve_client';

export interface ReviewListRequest {
  /** DID of the person/service being reviewed. */
  subject?: string;
  /** DID of the author. */
  author?: string;
  /** Max results. Clamped to [1, 100]. Default 20. */
  limit?: number;
  /** Opaque cursor from a previous response for pagination. */
  cursor?: string;
  /**
   * Filter to verified-actioned reviews (the subject actually
   * did the thing the reviewer is reviewing). Defaults to false
   * (include all).
   */
  verifiedActionedOnly?: boolean;
}

export interface Review {
  /** Full AT URI of the review record. */
  id: string;
  subject: string;
  author: string;
  /** 1..5 star rating. */
  rating: number;
  /** Free-form text, up to ~500 chars. */
  summary: string;
  /** UTC ms when the review was published. */
  createdAtMs: number;
  /** True when the author transacted with the subject (stronger signal). */
  verifiedActioned: boolean;
  /** Optional category label ("transit", "restaurant", …). */
  context: string | null;
}

export interface ReviewListResponse {
  reviews: Review[];
  total: number;
  /** Opaque cursor for next page — null when no more results. */
  cursor: string | null;
}

export type ReviewListRejectionReason =
  | 'invalid_input'
  | 'network_error'
  | 'rejected_by_appview'
  | 'malformed_response';

export type ReviewListOutcome =
  | { ok: true; response: ReviewListResponse }
  | { ok: false; reason: 'invalid_input'; detail: string }
  | { ok: false; reason: 'network_error'; error: string }
  | { ok: false; reason: 'rejected_by_appview'; status: number; error: string }
  | { ok: false; reason: 'malformed_response'; detail: string };

export type ReviewListFetchFn = (
  input: ReviewListRequest,
) => Promise<XrpcFetchResult>;

export interface ReviewListClientOptions {
  fetchFn: ReviewListFetchFn;
  onEvent?: (event: ReviewListEvent) => void;
}

export type ReviewListEvent =
  | { kind: 'listed'; subject: string | null; author: string | null; count: number; hasMore: boolean }
  | { kind: 'rejected'; reason: ReviewListRejectionReason };

export const MAX_REVIEW_LIMIT = 100;
export const DEFAULT_REVIEW_LIMIT = 20;

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.:-]+)$/;

/**
 * Create the `review.list` xRPC client. Returns a function
 * `(input) => Promise<ReviewListOutcome>`.
 */
export function createReviewListClient(
  opts: ReviewListClientOptions,
): (input: ReviewListRequest) => Promise<ReviewListOutcome> {
  if (typeof opts?.fetchFn !== 'function') {
    throw new TypeError('createReviewListClient: fetchFn is required');
  }
  const fetchFn = opts.fetchFn;
  const onEvent = opts.onEvent;

  return async function list(
    input: ReviewListRequest,
  ): Promise<ReviewListOutcome> {
    const validation = validateInput(input);
    if (validation !== null) {
      onEvent?.({ kind: 'rejected', reason: 'invalid_input' });
      return { ok: false, reason: 'invalid_input', detail: validation };
    }
    const normalised = normaliseInput(input);

    let result: XrpcFetchResult;
    try {
      result = await fetchFn(normalised);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({ kind: 'rejected', reason: 'network_error' });
      return { ok: false, reason: 'network_error', error: msg };
    }

    if (result.status < 200 || result.status >= 300) {
      const msg = typeof (result.body as { error?: unknown })?.error === 'string'
        ? ((result.body as { error: string }).error)
        : `status ${result.status}`;
      onEvent?.({ kind: 'rejected', reason: 'rejected_by_appview' });
      return {
        ok: false,
        reason: 'rejected_by_appview',
        status: result.status,
        error: msg,
      };
    }

    if (result.body === null) {
      onEvent?.({
        kind: 'listed',
        subject: normalised.subject ?? null,
        author: normalised.author ?? null,
        count: 0,
        hasMore: false,
      });
      return {
        ok: true,
        response: { reviews: [], total: 0, cursor: null },
      };
    }

    const parsed = parseResponse(result.body);
    if (!parsed.ok) {
      onEvent?.({ kind: 'rejected', reason: 'malformed_response' });
      return parsed;
    }
    onEvent?.({
      kind: 'listed',
      subject: normalised.subject ?? null,
      author: normalised.author ?? null,
      count: parsed.response.reviews.length,
      hasMore: parsed.response.cursor !== null,
    });
    return parsed;
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateInput(input: ReviewListRequest | null | undefined): string | null {
  if (input === null || input === undefined || typeof input !== 'object') {
    return 'request must be an object';
  }
  const hasSubject = typeof input.subject === 'string' && input.subject !== '';
  const hasAuthor = typeof input.author === 'string' && input.author !== '';
  if (!hasSubject && !hasAuthor) {
    return 'subject or author is required';
  }
  if (hasSubject && hasAuthor) {
    return 'provide either subject or author, not both';
  }
  if (hasSubject && !DID_RE.test(input.subject!)) {
    return 'subject must be a valid DID';
  }
  if (hasAuthor && !DID_RE.test(input.author!)) {
    return 'author must be a valid DID';
  }
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_REVIEW_LIMIT
    ) {
      return `limit must be integer in [1, ${MAX_REVIEW_LIMIT}]`;
    }
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 512) {
      return 'cursor must be a string ≤ 512 chars';
    }
  }
  if (input.verifiedActionedOnly !== undefined && typeof input.verifiedActionedOnly !== 'boolean') {
    return 'verifiedActionedOnly must be a boolean';
  }
  return null;
}

function normaliseInput(input: ReviewListRequest): ReviewListRequest {
  return {
    ...input,
    limit: input.limit ?? DEFAULT_REVIEW_LIMIT,
  };
}

type ParseOk = { ok: true; response: ReviewListResponse };
type ParseFail = { ok: false; reason: 'malformed_response'; detail: string };

function parseResponse(body: Record<string, unknown>): ParseOk | ParseFail {
  if (!Array.isArray(body.reviews)) {
    return {
      ok: false,
      reason: 'malformed_response',
      detail: 'body.reviews must be an array',
    };
  }
  const reviews: Review[] = [];
  for (const entry of body.reviews) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id.startsWith('at://')) continue;
    if (typeof e.subject !== 'string' || !DID_RE.test(e.subject)) continue;
    if (typeof e.author !== 'string' || !DID_RE.test(e.author)) continue;
    if (
      typeof e.rating !== 'number' ||
      !Number.isInteger(e.rating) ||
      e.rating < 1 ||
      e.rating > 5
    ) {
      continue;
    }
    if (typeof e.summary !== 'string') continue;
    if (
      typeof e.createdAtMs !== 'number' ||
      !Number.isInteger(e.createdAtMs) ||
      e.createdAtMs < 0
    ) {
      continue;
    }
    reviews.push({
      id: e.id,
      subject: e.subject,
      author: e.author,
      rating: e.rating,
      summary: e.summary,
      createdAtMs: e.createdAtMs,
      verifiedActioned: e.verifiedActioned === true,
      context: typeof e.context === 'string' ? e.context : null,
    });
  }
  const total =
    typeof body.total === 'number' && Number.isInteger(body.total) && body.total >= 0
      ? body.total
      : reviews.length;
  const cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : null;
  return { ok: true, response: { reviews, total, cursor } };
}
