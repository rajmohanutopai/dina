/**
 * Display data layer for the reviewer profile screen (TN-MOB-015 / Plan §8.5).
 *
 * Derives display-ready fields from the raw `TrustProfile` (the
 * AppView `com.dina.trust.getProfile` response shape, owned by
 * `@dina/core`'s `TrustQueryClient`). The screen layer
 * (`app/trust/reviewer/[did].tsx`) renders these values directly;
 * keeping the derivation here means both the screen AND the
 * subject-detail "top reviewer" surface that drills into the
 * profile share the same formatting rules.
 *
 * Pure data, no React, no I/O. Tested with plain Jest. The runner
 * that actually CALLS the xRPC + handles loading/error states lives
 * in the screen's wrapper.
 *
 * **Why a separate module rather than inlining**: the same projection
 * is used by:
 *   - The reviewer profile screen header (this file's primary client).
 *   - The subject-detail "top reviewer" mini-card (plan §8.3).
 *   - The cosig accept-flow's "who's asking" drill-down (plan §10).
 *
 * One function for all three; otherwise the band thresholds, the
 * helpful-ratio formatting, and the "active in N domains" copy drift.
 */

import {
  trustBandFor,
  trustScoreDisplay,
  trustScoreLabel,
  type TrustBand,
} from './score_helpers';

import type { TrustProfile } from '@dina/core';

/**
 * Display-ready projection of a `TrustProfile`. The screen binds
 * these fields directly to RN primitives without further computation.
 */
export interface ReviewerProfileDisplay {
  /** Reviewer DID (`did:plc:xxxx`). */
  readonly did: string;
  /**
   * Resolved handle from PLC `alsoKnownAs[0]` (e.g.
   * `alice.pds.dinakernel.com`) when the AppView has backfilled it,
   * `null` otherwise. The header renders this prominently with the
   * DID as a smaller subtitle so reviewers are recognisable at a
   * glance — DID is for receipts, handle is for humans.
   */
  readonly handle: string | null;
  /**
   * `[0, 100]` integer for the score badge. `null` when the profile
   * has no score yet (DID known but unscored — render an em-dash).
   */
  readonly scoreDisplay: number | null;
  /** "82" or "—" — ready for `<Text>` insertion. */
  readonly scoreLabel: string;
  /** Trust band for badge colour. `'unrated'` for null scores. */
  readonly band: TrustBand;
  /**
   * Total attestations RECEIVED by this DID (reviews ABOUT them).
   * Used for the per-sentiment breakdown chips.
   */
  readonly totalAttestations: number;
  /**
   * Total attestations AUTHORED by this DID (reviews BY them).
   * Surfaced as the headline "Reviews written" count — that's the
   * meaningful signal for a reviewer profile (vs. attestationSummary
   * which is what others said about THIS DID).
   */
  readonly reviewsWritten: number;
  /**
   * Per-sentiment counts. Renders as e.g. "12 positive · 3 neutral ·
   * 1 negative" on the screen.
   */
  readonly positiveCount: number;
  readonly neutralCount: number;
  readonly negativeCount: number;
  /** Vouches received from other DIDs. Surfaced as a count badge. */
  readonly vouchCount: number;
  /** Endorsements received. Distinct from vouches (Plan §3.2). */
  readonly endorsementCount: number;
  /**
   * Domains the reviewer is most active in (e.g. `['github.com',
   * 'amazon.com']`). Rendered as a chip-row; deferring to AppView's
   * curated `activeDomains` list — no aggregation done here.
   */
  readonly activeDomains: readonly string[];
  /**
   * Helpful-ratio of reactions on this reviewer's attestations as a
   * `[0, 100]` integer. `null` when not yet computed (e.g., reviewer
   * has < 3 attestations — the helpful-rate signal is too noisy).
   */
  readonly helpfulRatioDisplay: number | null;
  /**
   * Corroboration-rate of this reviewer's attestations as a `[0, 100]`
   * integer. `null` when below the consistency-min threshold (Plan
   * §4.1's `N_CONSISTENCY_MIN`, default 3).
   */
  readonly corroborationRateDisplay: number | null;
  /**
   * Last-active ms timestamp (or null when never active). The screen
   * formats relative to "now" — e.g. "3d ago", "2 weeks ago" — so the
   * raw timestamp is what the data layer surfaces.
   */
  readonly lastActiveMs: number | null;
  /**
   * Whether the profile carries enough data to display a numeric
   * score. Threshold: at least 3 attestations (Plan §8.3.1 — score
   * is only honest at N≥3). Below that, the band-only display
   * ("HIGH" / "—") is what the screen should render.
   */
  readonly hasNumericScore: boolean;
}

const NUMERIC_SCORE_MIN_ATTESTATIONS = 3;

/**
 * Derive the display-ready projection. Pure function, no I/O.
 *
 * Edge cases:
 *   - `profile.overallTrustScore === null` → `band = 'unrated'`,
 *     `scoreLabel = '—'`, `hasNumericScore = false`.
 *   - `profile.attestationSummary.total < 3` → score still computed
 *     (band + display number derived from the score), but
 *     `hasNumericScore = false` so the screen renders the band label
 *     only ("HIGH" / "MODERATE") rather than the numeric.
 *   - Helpful-ratio / corroboration-rate display values clamped to
 *     `[0, 100]` and rounded.
 *   - Negative or out-of-range raw values fall back to `null` rather
 *     than rendering as nonsense.
 */
export function deriveReviewerProfileDisplay(
  profile: TrustProfile,
): ReviewerProfileDisplay {
  const total = profile.attestationSummary.total;
  return {
    did: profile.did,
    handle: profile.handle ?? null,
    scoreDisplay: trustScoreDisplay(profile.overallTrustScore),
    scoreLabel: trustScoreLabel(profile.overallTrustScore),
    band: trustBandFor(profile.overallTrustScore),
    totalAttestations: total,
    reviewsWritten: profile.reviewerStats.totalAttestationsBy,
    positiveCount: profile.attestationSummary.positive,
    neutralCount: profile.attestationSummary.neutral,
    negativeCount: profile.attestationSummary.negative,
    vouchCount: profile.vouchCount,
    endorsementCount: profile.endorsementCount,
    activeDomains: profile.activeDomains,
    helpfulRatioDisplay: percentDisplay(profile.reviewerStats.helpfulRatio),
    corroborationRateDisplay: percentDisplay(profile.reviewerStats.corroborationRate),
    lastActiveMs: profile.lastActive,
    hasNumericScore:
      profile.overallTrustScore !== null && total >= NUMERIC_SCORE_MIN_ATTESTATIONS,
  };
}

/**
 * Convert a `[0, 1]` rate to a `[0, 100]` integer for display.
 * `null` for non-finite or out-of-range inputs so the screen renders
 * "—" rather than "NaN" or "—42%".
 */
function percentDisplay(rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  const clamped = Math.max(0, Math.min(1, rate));
  return Math.round(clamped * 100);
}

/**
 * Format `lastActiveMs` against a reference `nowMs` as a short
 * relative string. Pure — `nowMs` is injectable so tests can pin
 * exact outputs without `Date.now()` mocking.
 *
 * Buckets (matches plan §8.5's "last active" copy):
 *   - `null` or future timestamp → "never"
 *   - < 1 minute → "just now"
 *   - < 1 hour → "Nm ago"
 *   - < 1 day → "Nh ago"
 *   - < 7 days → "Nd ago"
 *   - < 4 weeks → "Nw ago"
 *   - else → "N months ago"
 */
export function formatLastActive(
  lastActiveMs: number | null,
  nowMs: number,
): string {
  if (lastActiveMs === null || lastActiveMs > nowMs) return 'never';
  const diffMs = nowMs - lastActiveMs;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}
