/**
 * Subject card display data layer (TN-MOB-020).
 *
 * The Trust tab's search-result card per plan §8.3:
 *
 *     ┌──────────────────────────────────────────┐
 *     │  Aeron chair · Office furniture          │   ← title + subtitle
 *     │                                          │
 *     │  82  HIGH                14 reviews      │   ← score + count
 *     │  ★ 2 friends · 12 strangers              │   ← friends pill
 *     │                                          │
 *     │  "Worth every penny for the back"        │   ← top reviewer
 *     │  — Sancho · contact · trust HIGH         │
 *     └──────────────────────────────────────────┘
 *
 * This module owns the *derivation* — pure data → render-ready bundle.
 * The screen layer wraps it with theme tokens, layout, and tap
 * handlers. Two rules that matter:
 *
 *   1. **Score format follows plan §8.3.1.** Numeric (e.g. "82")
 *      only when `n ≥ 3` reviews — at lower N the noise dominates
 *      and the band-only label ("HIGH", "—") is more honest. The
 *      threshold lives here, not at the call site, so it can't
 *      drift between cards on the search screen and cards on the
 *      reviewer-profile screen.
 *
 *   2. **Friends pill semantics.** Always shown when ≥ 1 contact
 *      reviewed (per plan). Hidden when zero contacts reviewed —
 *      a "0 friends · 12 strangers" badge actively misleads ("oh
 *      this product is unpopular with my friends" when actually
 *      no friends have weighed in either way).
 *
 * Pure function, zero state. Tested under plain Jest. No dependency
 * on `@dina/core` or anything React.
 */

import { type TrustDisplay, trustDisplayFor } from './score_helpers';

import type { TrustBand } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * One reviewer entry on a subject. Modelled minimally — the screen
 * has the full review record from AppView; the card data layer only
 * needs the fields that influence what's displayed in the card-sized
 * surface (i.e. the top-reviewer line and the friends/strangers
 * count, not headline body or per-dimension ratings).
 */
export interface SubjectReview {
  /** Reviewer's network position relative to the viewer. */
  readonly ring: 'self' | 'contact' | 'fof' | 'stranger';
  /**
   * Reviewer's DID (e.g. `did:plc:zaxxz2vts2umzfk2r5fpzes4`). Drives
   * the drill-down deep link from a tapped reviewer row to the
   * reviewer profile screen. `null` only for `ring === 'self'` rows
   * — those don't drill anywhere (the user is looking at their own
   * profile they got to faster a different way).
   *
   * Required because earlier the row only carried `reviewerName`
   * (display string), and the screen-side tap handler ended up
   * pushing `params: { did: reviewerName }`. The reviewer screen's
   * runner short-circuits on `!did.startsWith('did:')`, so the
   * profile sat on the loading spinner forever instead of fetching.
   */
  readonly reviewerDid: string | null;
  /** Reviewer trust score on the AppView [0, 1] scale, or null. */
  readonly reviewerTrustScore: number | null;
  /** Reviewer display name — the card uses it in the top-reviewer line. */
  readonly reviewerName: string;
  /** Headline (≤ 140 chars per plan §8.5). */
  readonly headline: string;
  /** Recency timestamp (ms since epoch) for tie-breaking. */
  readonly createdAtMs: number;
}

/**
 * One subject as it lands on a search result card. Modelled minimally.
 */
export interface SubjectCardInput {
  /** Display title — `subject.name` from the AppView search hit. */
  readonly title: string;
  /**
   * `subject.category` from AppView — slash-delimited path the
   * enricher writes (e.g. `'office_furniture/chair'`). The card
   * shows the second segment as the human-readable subtitle per
   * plan §8.3 ("Office furniture"). Omit / null → no subtitle.
   */
  readonly category?: string | null;
  /** Subject-level aggregate trust score on [0, 1], or null. */
  readonly subjectTrustScore: number | null;
  /** Total review count surfaced on the card ("14 reviews"). */
  readonly reviewCount: number;
  /** All reviewers in scope (the card picks one for the spotlight line). */
  readonly reviews: readonly SubjectReview[];
}

export interface FriendsPill {
  readonly friendsCount: number;
  readonly strangersCount: number;
}

export interface TopReviewerLine {
  readonly headline: string;
  readonly reviewerName: string;
  readonly ring: SubjectReview['ring'];
  readonly band: TrustBand;
}

export interface SubjectCardDisplay {
  readonly title: string;
  /** Subtitle string ("Office furniture"), or `null` when no category. */
  readonly subtitle: string | null;
  /** Score + band display bundle, or `null` only when subject is fully unrated. */
  readonly score: TrustDisplay;
  /**
   * `true` when the card surface should show "82" (numeric).
   * `false` when it should show "HIGH" / "—" (band only). Threshold
   * is `MIN_REVIEWS_FOR_NUMERIC` (`3` per plan §8.3.1).
   */
  readonly showNumericScore: boolean;
  readonly reviewCount: number;
  /** Friends-pill counts, or `null` when no contacts reviewed. */
  readonly friendsPill: FriendsPill | null;
  /** Highlighted reviewer line, or `null` when there are no reviews. */
  readonly topReviewer: TopReviewerLine | null;
}

/**
 * Per plan §8.3.1: "Numeric score only when n ≥ 3". Below this N,
 * cards display the band ("HIGH") instead of a digit.
 */
export const MIN_REVIEWS_FOR_NUMERIC = 3;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Derive a render-ready bundle for one subject card.
 *
 * Pure: same input always produces the same output. The screen calls
 * this once per subject in its result list — no expensive precompute
 * needed; the function does one pass over `reviews` plus a constant-
 * time set of decisions.
 */
export function deriveSubjectCard(input: SubjectCardInput): SubjectCardDisplay {
  const reviewCount = clampNonNegative(input.reviewCount);
  const score = trustDisplayFor(input.subjectTrustScore);

  let friends = 0;
  let strangers = 0;
  let top: SubjectReview | null = null;

  for (const r of input.reviews) {
    // Friend pill: contact-or-self counts as a friend; everyone else
    // is a stranger. fof (friend-of-friend) is "stranger" for this
    // pill — the plan's mock copy is "★ 2 friends · 12 strangers"
    // (binary). The subject-detail screen breaks fofs out separately;
    // the card stays the binary view to fit the line budget.
    if (r.ring === 'self' || r.ring === 'contact') friends += 1;
    else strangers += 1;

    if (top === null || beats(r, top)) top = r;
  }

  return {
    title: input.title,
    subtitle: deriveSubtitle(input.category),
    score,
    showNumericScore: reviewCount >= MIN_REVIEWS_FOR_NUMERIC && score.score !== null,
    reviewCount,
    friendsPill: friends > 0 ? { friendsCount: friends, strangersCount: strangers } : null,
    topReviewer: top === null ? null : toTopReviewerLine(top),
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

/**
 * Strict ordering for "which reviewer to spotlight":
 *
 *   1. Closer ring wins (`self` > `contact` > `fof` > `stranger`).
 *      Spotlighting a stranger over a contact would inverted-promote
 *      strangers' opinions on the very surface that's supposed to
 *      privilege the user's network.
 *   2. Higher reviewer trust score wins. `null` (unrated) is treated
 *      as `-Infinity` so an unrated reviewer never displaces a rated
 *      one — pinned by test.
 *   3. More recent wins.
 *   4. Stable tiebreak by `reviewerName` ascending so order doesn't
 *      reshuffle between renders.
 */
function beats(a: SubjectReview, b: SubjectReview): boolean {
  const ar = ringRank(a.ring);
  const br = ringRank(b.ring);
  if (ar !== br) return ar > br;

  const at = a.reviewerTrustScore ?? Number.NEGATIVE_INFINITY;
  const bt = b.reviewerTrustScore ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return at > bt;

  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs > b.createdAtMs;

  return a.reviewerName < b.reviewerName;
}

function ringRank(ring: SubjectReview['ring']): number {
  switch (ring) {
    case 'self':
      return 3;
    case 'contact':
      return 2;
    case 'fof':
      return 1;
    case 'stranger':
      return 0;
  }
}

function toTopReviewerLine(r: SubjectReview): TopReviewerLine {
  return {
    headline: r.headline,
    reviewerName: r.reviewerName,
    ring: r.ring,
    band: trustDisplayFor(r.reviewerTrustScore).band,
  };
}

/**
 * Plan §8.3 + §3.6.1 — `subject.category` is a slash-delimited path
 * like `office_furniture/chair`. The card subtitle takes the SECOND
 * segment (the leaf "what kind of subject"), humanises underscores,
 * and title-cases. When there's only one segment we still humanise +
 * capitalise it; cards with no category at all return null.
 *
 * `subtitle: string | null` is a hard contract — `null` means
 * "no subtitle, hide the slot". An all-underscore category like
 * `'__/chair'` humanises to the empty string; we collapse that to
 * `null` so a downstream `value ?? fallback` treats it as absence.
 * The screen's truthy `&&` already hides it either way, but
 * surfacing `''` from a `string | null` is contract drift.
 */
function deriveSubtitle(category: string | null | undefined): string | null {
  if (category === null || category === undefined) return null;
  const trimmed = category.trim();
  if (trimmed.length === 0) return null;

  const [first] = trimmed.split('/').filter((s) => s.length > 0);
  if (first === undefined) return null;

  // Plan §8.3: "Office furniture" appears as the subtitle for an
  // Aeron chair, which has category `office_furniture/chair`.
  // That's the FIRST segment humanised — the leaf segment ("chair")
  // is too narrow to use as the at-a-glance "what kind of subject"
  // subtitle.
  const result = humanise(first);
  return result.length === 0 ? null : result;
}

function humanise(segment: string): string {
  // Replace underscores with spaces, collapse runs of whitespace,
  // and capitalise the first character. Using `charAt(0)` rather
  // than `Array.from(string)[0]` is fine because category segments
  // are ASCII per the AppView enricher contract.
  const spaced = segment.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (spaced.length === 0) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function clampNonNegative(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
