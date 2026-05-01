/**
 * Subject detail screen data layer (TN-MOB-012 / Plan §8.5).
 *
 * Plan §8.5 specifies the subject detail screen as the drill-down
 * from a search-result card. It shows:
 *
 *   1. Header: title, subtitle, aggregate trust score, total review
 *      count, friends-pill summary.
 *   2. Reviews grouped by ring:
 *      - Friends (self + contacts) — most-trusted voices, top section
 *      - Friend-of-friend (fof) — second-tier
 *      - Strangers (everyone else) — informational, bottom section
 *
 * The grouping itself is the screen's signature — Plan §8.5 calls for
 * "header / friends / fof / strangers" specifically. The within-group
 * ordering reuses the same comparator the card spotlight uses (closer
 * ring first, higher score next, more recent next, name asc) so the
 * top reviewer of each section is the most-trusted-then-most-recent.
 *
 * Pure data, no React, no I/O. Plan-§8.5-aligned, tested under plain
 * Jest.
 *
 * **Why a separate module rather than inlining in the screen**: the
 * same grouping feeds the subject-detail screen + the
 * `selectAuthoritativeReviewer` helper that the cosig accept flow
 * uses to decide whether to surface "your contact already cosigned
 * this". One source of truth keeps the ring semantics consistent
 * across both surfaces.
 */

import { trustDisplayFor, type TrustDisplay } from './score_helpers';
import { MIN_REVIEWS_FOR_NUMERIC, type SubjectReview } from './subject_card';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Display-ready header for the subject detail screen — same fields
 * as the card header but with the binary friends pill expanded to
 * the three-ring (friends / fof / strangers) breakdown the detail
 * screen surfaces.
 */
export interface SubjectDetailHeader {
  readonly title: string;
  readonly subtitle: string | null;
  readonly score: TrustDisplay;
  readonly reviewCount: number;
  /**
   * `true` when the score has enough signal to surface as a number
   * (Plan §8.3.1: N≥3 attestations). `false` → the screen renders
   * the band label ("HIGH", "—") instead.
   */
  readonly showNumericScore: boolean;
  /** Three-way ring breakdown for the header summary line. */
  readonly ringCounts: {
    readonly friends: number; // self + contacts
    readonly fof: number;
    readonly strangers: number;
  };
}

export interface SubjectDetailDisplay {
  readonly header: SubjectDetailHeader;
  /** Reviews from self + direct contacts, sorted by the spotlight comparator. */
  readonly friendsReviews: readonly SubjectReview[];
  /** Reviews from friends-of-friends, sorted likewise. */
  readonly fofReviews: readonly SubjectReview[];
  /** Reviews from everyone else, sorted likewise. */
  readonly strangerReviews: readonly SubjectReview[];
}

export interface SubjectDetailInput {
  readonly title: string;
  readonly category?: string | null;
  readonly subjectTrustScore: number | null;
  readonly reviewCount: number;
  readonly reviews: readonly SubjectReview[];
  /**
   * Subject-ref kind ("product" / "place" / etc.). Carried so the
   * "Write a review" CTA can deep-link into the write screen with full
   * subject context — without it the write screen has only `subjectId`
   * and can't reconstruct the SubjectRef the inject path needs.
   * Optional for backwards compatibility; tests passing synthetic
   * `SubjectDetailInput` may omit it.
   */
  readonly subjectKind?: string;
  /** Identifier (ASIN, ISBN, etc.) when the subject ref carries one. */
  readonly subjectIdentifier?: string;
  /** DID when the subject ref is a `did:` reference. */
  readonly subjectDid?: string;
  /** URI when the subject ref is a `content` / `dataset` reference. */
  readonly subjectUri?: string;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Derive the full subject-detail bundle from the screen's raw input.
 *
 * Pure: same input always produces the same output. The screen calls
 * this once per render — O(N log N) where N is the number of reviews
 * (one pass to bucket + a sort per group).
 */
export function deriveSubjectDetail(input: SubjectDetailInput): SubjectDetailDisplay {
  const reviewCount = clampNonNegative(input.reviewCount);
  const score = trustDisplayFor(input.subjectTrustScore);

  // Bucket reviews into three groups in a single pass. Ring=self
  // collapses with contacts under "friends" — same posture as the
  // card's friends-pill (self counts as a friend in the binary
  // view since the user trusts themselves).
  const friends: SubjectReview[] = [];
  const fof: SubjectReview[] = [];
  const strangers: SubjectReview[] = [];

  for (const r of input.reviews) {
    if (r.ring === 'self' || r.ring === 'contact') friends.push(r);
    else if (r.ring === 'fof') fof.push(r);
    else strangers.push(r);
  }

  // Sort each group by the spotlight comparator (closer ring first
  // already partitioned us into groups, so within-group we order by
  // trust score desc, recency desc, name asc).
  friends.sort(byDetailOrder);
  fof.sort(byDetailOrder);
  strangers.sort(byDetailOrder);

  return {
    header: {
      title: input.title,
      subtitle: deriveSubtitle(input.category),
      score,
      reviewCount,
      showNumericScore: reviewCount >= MIN_REVIEWS_FOR_NUMERIC && score.score !== null,
      ringCounts: {
        friends: friends.length,
        fof: fof.length,
        strangers: strangers.length,
      },
    },
    friendsReviews: friends,
    fofReviews: fof,
    strangerReviews: strangers,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

/**
 * Within-group ordering: highest trust score first, most recent next,
 * stable tiebreak on reviewerName ascending. `null` trust score is
 * treated as `-Infinity` (unrated reviewers don't displace rated
 * ones) — same convention as `subject_card.ts:beats`.
 */
function byDetailOrder(a: SubjectReview, b: SubjectReview): number {
  const at = a.reviewerTrustScore ?? Number.NEGATIVE_INFINITY;
  const bt = b.reviewerTrustScore ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  if (a.reviewerName < b.reviewerName) return -1;
  if (a.reviewerName > b.reviewerName) return 1;
  return 0;
}

/**
 * Same subtitle derivation as `subject_card.ts` — the detail header
 * shows the same "Office furniture" string the card surfaces. Could
 * be DRY'd into a shared util; deferred until a third call site
 * needs it (rule of three).
 */
function deriveSubtitle(category: string | null | undefined): string | null {
  if (category === null || category === undefined) return null;
  const trimmed = category.trim();
  if (trimmed.length === 0) return null;
  const [first] = trimmed.split('/').filter((s) => s.length > 0);
  if (first === undefined) return null;
  const spaced = first.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced.length === 0) return null;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function clampNonNegative(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
