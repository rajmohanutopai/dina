/**
 * The search projection (UCP plan §3.16): the text Brain wants to send to
 * merchants, checked by Core before anything leaves.
 *
 *  - PII: the query is cleaned (`cleanForProvenance`, A2A's rule) and run
 *    through the same detector A2A's scrub uses. Dina does not send a
 *    placeholder query to a merchant; a query the detector would change is
 *    held for the owner instead.
 *  - Persona taint: a query from a conversation in which Brain read a
 *    restricted persona (the release log for a day, `conversation_taint` for
 *    the conversation's life), or from a conversation whose record is not
 *    known to be whole (uncovered), is held for the owner.
 *  - Provenance is recorded, never required: `quoted` when the query is,
 *    whole, a message the owner sent in this conversation (the release log's
 *    digests); otherwise `derived`.
 *
 * A held query is not sent: Brain gets the reasons. If the owner wants it
 * sent anyway, Core raises ONE `ucp_search_review` card (Core-minted: Brain
 * can neither create nor decide it) showing the exact query and every
 * merchant it goes to. The card is bound to the conversation, the hash of
 * the query and the sorted set of merchant origins; the search that names
 * an approved card must match all three, and uses the card up. A changed
 * query, or another merchant, needs a new card.
 */

import { parseStrictJson } from '@dina/a2a';

import { canonicalDigest } from '../../a2a/digest';
import { OWNER_TURN_LIVE_MS } from '../../a2a/proposal';
import { cleanForProvenance, utteranceDigest } from '../../a2a/provenance_text';
import { isMirrorableDetail, isMirrorableTitle } from '../../approval/mirror_text';
import { detectPII } from '../../pii/patterns';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../../workflow/domain';

import { merchantOrigin } from './discovery';

import type { A2AReleaseLog } from '../../a2a/release_log';
import type { ConversationTaint } from '../../chat/taint';
import type { WorkflowTask } from '../../workflow/domain';
import type { WorkflowService } from '../../workflow/service';

export const UCP_SEARCH_REVIEW_TYPE = 'ucp_search_review';
/** Workflow task ids and keys under this prefix are Core's alone (§3.18). */
export const UCP_TASK_NAMESPACE = 'ucp-';
export const isUcpTaskNamespace = (value: string | undefined): boolean =>
  value !== undefined && value.startsWith(UCP_TASK_NAMESPACE);

/** A search query's bound (characters); a merchant's catalogue search is short text. */
export const QUERY_MAX_LENGTH = 500;
/** Merchants one search may go to. */
export const SEARCH_MAX_MERCHANTS = 10;
/**
 * How long a review card lives: for the owner to decide it, and once
 * approved, for the search to use it. A copy mirrored to the paired phone
 * gets the phone's shorter window (the sync caps it); a copy that lapses
 * there unanswered is cancelled as a lapse, not a refusal.
 */
export const SEARCH_REVIEW_TTL_MS = 60 * 60_000;

/** Cards waiting on the owner at once in one conversation; more is Brain asking past an answer. */
export const MAX_PENDING_REVIEWS = 3;

/** The review cards Core keeps a note of per conversation: those of the last day. */
const REVIEW_LOOKBACK_MS = 24 * 60 * 60_000;

/** Where a session's review cards are noted (Core's UCP store). */
export interface ReviewLedger {
  recordReview(sessionId: string, reviewId: string, now: number): void;
  reviewsSince(sessionId: string, since: number): string[];
}

export type ReviewReason = 'personal_data' | 'restricted_read' | 'uncovered_conversation';

export interface SearchRequest {
  /** The conversation (release session) the search serves. */
  sessionId: string;
  query: string;
  /** Merchant origins (`https://host`), as Brain names them. */
  merchants: readonly string[];
}

export interface ProjectedSearch {
  query: string;
  /** Sorted, de-duplicated origins. */
  merchants: string[];
  provenance: 'quoted' | 'derived';
  /** The card's binding: a digest of conversation, query and merchants. */
  binding: string;
}

export type SearchCheck =
  | { ok: true; search: ProjectedSearch }
  | { ok: false; reason: 'needs_review'; why: ReviewReason[]; search: ProjectedSearch }
  /** No owner turn in the session in the last half hour; `search` is what a card for it would bind. */
  | { ok: false; reason: 'no_owner_turn'; search: ProjectedSearch }
  | { ok: false; reason: 'bad_query' | 'bad_merchants' };

export interface SearchCheckDeps {
  log: A2AReleaseLog;
  taint: (sessionId: string) => ConversationTaint;
  nowMs: () => number;
}

/** Core's check of a search; nothing is sent from here. */
export function checkSearch(req: SearchRequest, deps: SearchCheckDeps): SearchCheck {
  const query = cleanForProvenance(req.query).trim();
  if (query === '' || query.length > QUERY_MAX_LENGTH) return { ok: false, reason: 'bad_query' };
  if (req.merchants.length === 0 || req.merchants.length > SEARCH_MAX_MERCHANTS)
    return { ok: false, reason: 'bad_merchants' };
  const origins: string[] = [];
  for (const m of req.merchants) {
    const origin = merchantOrigin(m);
    if (origin === null) return { ok: false, reason: 'bad_merchants' };
    origins.push(origin);
  }
  const merchants = [...new Set(origins)].sort();
  const owner = new Set(deps.log.utterances(req.sessionId).map((u) => u.digest));
  const provenance = owner.has(utteranceDigest(query)) ? 'quoted' : 'derived';
  const search: ProjectedSearch = {
    query,
    merchants,
    provenance,
    binding: canonicalDigest({ session: req.sessionId, query, merchants }),
  };
  // A search serves a conversation the owner is in now, as an A2A proposal does: Core
  // recorded the owner's words in this session within the last half hour. A session
  // Brain names but Core holds no turn for searches nothing.
  const turn = deps.log.latestUtterance(req.sessionId);
  if (turn === null || deps.nowMs() - turn.recorded_at > OWNER_TURN_LIVE_MS)
    return { ok: false, reason: 'no_owner_turn', search };

  const why: ReviewReason[] = [];
  if (detectPII(query).length > 0) why.push('personal_data');
  const taint = deps.taint(req.sessionId);
  if (taint.restrictedPersonas.length > 0) why.push('restricted_read');
  if (!taint.covered) why.push('uncovered_conversation');
  return why.length === 0
    ? { ok: true, search }
    : { ok: false, reason: 'needs_review', why, search };
}

/** The card as it is stored and shown: the exact query and every merchant. */
export interface SearchReviewCard {
  type: typeof UCP_SEARCH_REVIEW_TYPE;
  session_id: string;
  binding: string;
  query: string;
  merchants: string[];
  why: ReviewReason[];
}

export type RaiseReview =
  | { ok: true; reviewId: string; expiresAtMs: number }
  | {
      ok: false;
      reason:
        | 'not_needed'
        | 'bad_query'
        | 'bad_merchants'
        | 'no_owner_turn'
        | 'review_declined'
        | 'too_many_reviews';
    };

/** The card's text where no renderer knows the type: the whole query and every merchant. */
export function searchReviewDescription(
  card: Pick<SearchReviewCard, 'query' | 'merchants'>,
): string {
  return `Search ${card.merchants.join(', ')} for: ${card.query}`;
}

/**
 * Raise the owner's card for a held search. Core checks the search again
 * itself: a card is raised only for a search that needs one. One live card
 * per search: raising it again returns the card already waiting (or
 * approved and not yet used); a new one is made only after it ends.
 */
export function raiseSearchReview(
  req: SearchRequest,
  deps: SearchCheckDeps & {
    workflow: WorkflowService;
    reviews: ReviewLedger;
    newId: () => string;
    nowMs: () => number;
  },
): RaiseReview {
  const check = checkSearch(req, deps);
  if (check.ok) return { ok: false, reason: 'not_needed' };
  if (check.reason !== 'needs_review') return { ok: false, reason: check.reason };
  const { search } = check;
  const idempotencyKey = `${UCP_TASK_NAMESPACE}search-review:${search.binding}`;
  const now = deps.nowMs();
  // The conversation's cards, whatever search each held. Once the owner declined one,
  // Dina asks again (for that search or a reworded one) only after they have spoken
  // since; and only a few may wait on them at once. This holds the model to the owner's
  // answer. On a server Brain itself records the owner's turns (as for every A2A
  // proposal), so it does not hold against compromised Brain code; the card it raises
  // is still the owner's to decide.
  const turn = deps.log.latestUtterance(req.sessionId);
  let waiting = 0;
  for (const id of deps.reviews.reviewsSince(req.sessionId, now - REVIEW_LOOKBACK_MS)) {
    const task = deps.workflow.store().getById(id);
    if (task === null) continue;
    if (ownerDeclined(task) && (turn === null || turn.recorded_at <= task.updated_at))
      return { ok: false, reason: 'review_declined' };
    if (
      task.status === WorkflowTaskState.PendingApproval &&
      task.idempotency_key !== idempotencyKey &&
      (task.expires_at ?? 0) * 1000 > now
    )
      waiting += 1;
  }
  const card: SearchReviewCard = {
    type: UCP_SEARCH_REVIEW_TYPE,
    session_id: req.sessionId,
    binding: search.binding,
    query: search.query,
    merchants: search.merchants,
    why: check.why,
  };
  const live = deps.workflow.store().getActiveByIdempotencyKey(idempotencyKey);
  if (live !== null) {
    const expiresAtMs = (live.expires_at ?? 0) * 1000;
    if (expiresAtMs > now) return { ok: true, reviewId: live.id, expiresAtMs };
    // Past its time but not yet swept: expire it as the sweeper would (a lapse, not the
    // owner's refusal), so the owner is shown a card that can still be used.
    deps.workflow.expireTasks(Math.floor(now / 1000), now);
  }
  if (waiting >= MAX_PENDING_REVIEWS) return { ok: false, reason: 'too_many_reviews' };
  const reviewId = `${UCP_TASK_NAMESPACE}search-review-${deps.newId()}`;
  const expiresAtMs = now + SEARCH_REVIEW_TTL_MS;
  deps.workflow.create({
    id: reviewId,
    kind: WorkflowTaskKind.Approval,
    description: searchReviewDescription(card),
    idempotencyKey,
    payload: JSON.stringify(card),
    expiresAtSec: Math.floor(expiresAtMs / 1000),
    correlationId: UCP_SEARCH_REVIEW_TYPE,
    priority: WorkflowTaskPriority.UserBlocking,
    origin: 'system',
    initialState: WorkflowTaskState.PendingApproval,
  });
  deps.reviews.recordReview(req.sessionId, reviewId, now);
  return { ok: true, reviewId, expiresAtMs };
}

/**
 * A cancelled card is the owner's no: only the owner's decision cancels a
 * review card (one past its time fails, and a phone copy that lapses leaves
 * the card alone).
 */
function ownerDeclined(task: WorkflowTask): boolean {
  return task.status === WorkflowTaskState.Cancelled;
}

export type UseReview =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'pending' | 'declined' | 'used' | 'expired' | 'mismatch' };

/**
 * Use an approved card for exactly the search it was raised for, once. The
 * card's state is the owner's decision: `queued` is approved and unused;
 * using it completes it.
 */
export function useSearchReview(
  reviewId: string,
  search: ProjectedSearch,
  sessionId: string,
  deps: { workflow: WorkflowService; nowMs: () => number },
): UseReview {
  if (!isUcpTaskNamespace(reviewId)) return { ok: false, reason: 'not_found' };
  const task = deps.workflow.store().getById(reviewId);
  if (task === null) return { ok: false, reason: 'not_found' };
  const card = readSearchReviewCard(task.payload);
  if (card === null) return { ok: false, reason: 'not_found' };
  if (card.session_id !== sessionId || card.binding !== search.binding)
    return { ok: false, reason: 'mismatch' };
  if (task.status === WorkflowTaskState.PendingApproval) return { ok: false, reason: 'pending' };
  if (task.status === WorkflowTaskState.Completed) return { ok: false, reason: 'used' };
  if (task.status !== WorkflowTaskState.Queued) return { ok: false, reason: 'declined' };
  if (
    task.expires_at !== undefined &&
    task.expires_at !== null &&
    task.expires_at * 1000 <= deps.nowMs()
  )
    return { ok: false, reason: 'expired' };
  // Run to its end, as an approved A2A card is: queued → running (compare-and-set,
  // so of two searches racing for one card only one wins) → completed.
  if (
    !deps.workflow
      .store()
      .transition(reviewId, WorkflowTaskState.Queued, WorkflowTaskState.Running, deps.nowMs())
  ) {
    return { ok: false, reason: 'used' };
  }
  deps.workflow.complete(reviewId, JSON.stringify({ used: true }), 'search sent');
  return { ok: true };
}

/** Why a search was held, in the words every surface shows the owner. */
export const REVIEW_REASON_WORDS: Record<ReviewReason, string> = {
  personal_data: 'It may carry personal details (a name, number or address).',
  restricted_read: 'It follows a read of one of your private vaults in this conversation.',
  uncovered_conversation: 'Dina cannot tell everything this conversation read before.',
};

/**
 * The card as the paired phone shows it (a server's card, decided on the
 * phone), or null when it cannot be shown there whole: the phone must show
 * every merchant and every byte of the query.
 */
export function searchReviewMirror(
  card: SearchReviewCard,
): { title: string; detail: string } | null {
  const title =
    card.merchants.length === 1
      ? `Search ${new URL(card.merchants[0] as string).host}?`
      : `Search ${card.merchants.length} shops?`;
  const detail = [
    'Dina held this search before it left:',
    ...card.why.map((w) => REVIEW_REASON_WORDS[w]),
    'It goes to:',
    ...card.merchants,
    'Exactly what will be sent:',
    card.query,
  ].join('\n');
  return isMirrorableTitle(title) && isMirrorableDetail(detail) ? { title, detail } : null;
}

/** A stored review card, checked field by field; null when the payload is not one. */
export function readSearchReviewCard(payload: string): SearchReviewCard | null {
  const parsed = parseStrictJson(payload);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.type !== UCP_SEARCH_REVIEW_TYPE) return null;
  if (
    typeof v.session_id !== 'string' ||
    typeof v.binding !== 'string' ||
    typeof v.query !== 'string'
  )
    return null;
  if (!Array.isArray(v.merchants) || !v.merchants.every((m) => typeof m === 'string')) return null;
  if (
    !Array.isArray(v.why) ||
    !v.why.every(
      (w) => w === 'personal_data' || w === 'restricted_read' || w === 'uncovered_conversation',
    )
  )
    return null;
  return {
    type: UCP_SEARCH_REVIEW_TYPE,
    session_id: v.session_id,
    binding: v.binding,
    query: v.query,
    merchants: v.merchants as string[],
    why: v.why as ReviewReason[],
  };
}
