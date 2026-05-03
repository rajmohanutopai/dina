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

import { trustBandFor, trustDisplayFor, type TrustBand, type TrustDisplay } from './score_helpers';
import {
  MIN_REVIEWS_FOR_NUMERIC,
  deriveCardSubtitle,
  deriveRecencyBadge,
  deriveRegionPill,
  normaliseHostChip,
  normaliseLanguageChip,
  normalisePlaceLocation,
  normalisePriceTier,
  type SubjectReview,
} from './subject_card';

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
  /**
   * **TN-V2-P1-004.** Display-ready host string (lowercased + trimmed)
   * mirroring the card. Same chip rendered larger on the detail screen
   * so the actionability signal carries through the drill-down.
   */
  readonly host: string | null;
  /**
   * **TN-V2-P1-004.** Display-ready BCP-47 language tag, uppercased.
   * Mirrors the card chip semantics; presentation only.
   */
  readonly language: string | null;
  /**
   * **TN-V2-P1-004.** Display-ready place location string (e.g.
   * `'37.77°N, 122.42°W'`) — non-null only when the subject is a
   * `place` and coords are valid. Mirrors `SubjectCardDisplay.location`.
   */
  readonly location: string | null;
  /**
   * **TN-V2-RANK-013.** Display-ready price tier (`'$'` / `'$$'` /
   * `'$$$'`), or `null` when the subject has no price data. Mirrors
   * `SubjectCardDisplay.priceTier` — same chip semantics, rendered
   * at slightly larger type on the detail header.
   */
  readonly priceTier: '$' | '$$' | '$$$' | null;
  /**
   * **TN-V2-RANK-011.** Display-ready recency badge string (e.g.
   * `'3 years old'`), or `null` when the subject is fresh per the
   * category half-life. Mirrors `SubjectCardDisplay.recency` —
   * threshold + formatting are owned by the data layer in
   * `subject_card.ts`.
   */
  readonly recency: string | null;
  /**
   * **TN-V2-RANK-012.** Display-ready region-availability pill
   * (e.g. `'📍 UK only'`), or `null` when subject is available to
   * the viewer OR when availability is unknown. Mirrors
   * `SubjectCardDisplay.regionPill`.
   */
  readonly regionPill: string | null;
  /**
   * **TN-V2-RANK-015.** Negative-space warning surface — non-null
   * when 1+ contacts in the viewer's network have flagged a related
   * subject (same brand / category, depending on `scope`). Renders
   * as a banner ABOVE the chip row since it's the load-bearing
   * exclusion signal. The banner-or-nothing posture (no rendering
   * for 0 flags) is intentional: a "0 contacts flagged this" line
   * would be reassurance theatre, not signal.
   */
  readonly flagWarning: FlagWarning | null;
}

/**
 * **TN-V2-RANK-015.** Display projection for the flag-warning banner.
 * `count` is for tests / consumers that want the raw number; `text`
 * is the rendered copy ("2 of your contacts flagged this brand").
 */
export interface FlagWarning {
  readonly count: number;
  /**
   * Whether the flag is on the subject itself, the brand, or the
   * category. Drives noun choice in the rendered text.
   */
  readonly scope: 'subject' | 'brand' | 'category';
  readonly text: string;
}

export interface SubjectDetailDisplay {
  readonly header: SubjectDetailHeader;
  /** Reviews from self + direct contacts, sorted by the spotlight comparator. */
  readonly friendsReviews: readonly SubjectReview[];
  /** Reviews from friends-of-friends, sorted likewise. */
  readonly fofReviews: readonly SubjectReview[];
  /** Reviews from everyone else, sorted likewise. */
  readonly strangerReviews: readonly SubjectReview[];
  /**
   * **TN-V2-RANK-014.** "3 trusted alternatives" strip below the
   * review list — top-N other subjects in the same category sorted
   * by the viewer's trust signal. Always exactly the count requested
   * (or fewer if the network is sparse); empty array when the
   * RANK-009 xRPC returns no candidates. Source data is server-
   * computed; the data layer here only normalises + caps + filters
   * out the current subject.
   */
  readonly alternatives: readonly SubjectAlternative[];
}

/**
 * **TN-V2-RANK-014.** Display-ready alternative subject. Mirrors the
 * minimal subset of `SubjectCardDisplay` the strip needs — title,
 * subjectId, optional category for the strip's "tap → category
 * search" deep link, optional trust band for the colour chip.
 *
 * Kept lean (NOT full SubjectCardDisplay) because the strip renders
 * compact rows, not full cards. If the strip ever needs friends
 * pill / top-reviewer / etc., extend this — or switch to rendering
 * full SubjectCardDisplay.
 */
export interface SubjectAlternative {
  readonly subjectId: string;
  readonly title: string;
  readonly category: string | null;
  /** Trust band for the colour chip — `'unrated'` when subject has no score. */
  readonly band: TrustBand;
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
   * and can't reconstruct the SubjectRef the inject path needs. Also
   * gates the location chip per TN-V2-P1-004 (only `place` subjects
   * surface a coords chip). Optional for backwards compatibility;
   * tests passing synthetic `SubjectDetailInput` may omit it.
   */
  readonly subjectKind?: string;
  /** Identifier (ASIN, ISBN, etc.) when the subject ref carries one. */
  readonly subjectIdentifier?: string;
  /** DID when the subject ref is a `did:` reference. */
  readonly subjectDid?: string;
  /** URI when the subject ref is a `content` / `dataset` reference. */
  readonly subjectUri?: string;
  /**
   * **TN-V2-P1-004.** Source `subjects.metadata.host` for the chip,
   * mirroring `SubjectCardInput.host`. Optional + nullable.
   */
  readonly host?: string | null;
  /**
   * **TN-V2-P1-004.** Source `subjects.language` for the chip, mirroring
   * `SubjectCardInput.language`. Optional + nullable.
   */
  readonly language?: string | null;
  /**
   * **TN-V2-P1-004.** Coordinates for `place` subjects from
   * `subjects.metadata.{lat,lng}`. Mirrors `SubjectCardInput.coordinates`.
   * Gated by `subjectKind === 'place'` in the derivation.
   */
  readonly coordinates?: { readonly lat: number; readonly lng: number } | null;
  /**
   * **TN-V2-RANK-013.** Server-derived price tier. Mirrors
   * `SubjectCardInput.priceTier`. Optional + nullable.
   */
  readonly priceTier?: '$' | '$$' | '$$$' | null;
  /**
   * **TN-V2-RANK-011.** META-011 source — the most recent
   * attestation timestamp. Drives the recency-badge gate. Mirrors
   * `SubjectCardInput.lastActiveMs`.
   */
  readonly lastActiveMs?: number | null;
  /**
   * **TN-V2-RANK-012.** META-001 source — ISO 3166-1 alpha-2 country
   * codes for the regions where this subject is available. Mirrors
   * `SubjectCardInput.availabilityRegions`.
   */
  readonly availabilityRegions?: readonly string[] | null;
  /**
   * **TN-V2-RANK-015.** Source for the flag-warning banner: how many
   * 1-hop contacts have flagged a related subject and at what scope
   * (the subject itself, its brand, or its category). Optional +
   * nullable: subjects with no contact-network flags simply omit
   * this and the banner stays silent. Sourced from `getNegativeSpace`
   * xRPC (RANK-010) at the screen runner; the data layer doesn't do
   * its own AppView round-trip.
   */
  readonly flagSummary?: FlagSummary | null;
  /**
   * **TN-V2-RANK-014.** Pre-fetched alternative subjects from the
   * RANK-009 `getAlternatives(subjectId, count, viewerCtx?)` xRPC.
   * The screen runner calls the xRPC; the data layer here normalises,
   * caps to {@link MAX_ALTERNATIVES}, and filters out the current
   * subject (defensive — server should never return self, but a
   * wire-format violation shouldn't render "this product" as a
   * suggested alternative). Optional + nullable: pre-V2 callers and
   * tests skip the strip entirely.
   */
  readonly alternatives?: readonly AlternativeInput[] | null;
}

/**
 * **TN-V2-RANK-014.** Wire-side shape for an alternative subject.
 * Looser than `SubjectAlternative` (the display shape) — accepts
 * the raw fields the xRPC returns; the data layer narrows the band
 * + filters bad entries.
 */
export interface AlternativeInput {
  readonly subjectId: string;
  readonly title: string;
  readonly category?: string | null;
  /** Subject-level trust score in [0, 1] for band derivation, or null. */
  readonly subjectTrustScore?: number | null;
}

/**
 * **TN-V2-RANK-014.** Cap on alternatives surfaced in the strip.
 * Three is the plan §6.3 number — fits one row on a phone, gives
 * the user real choice without overwhelming the screen, and the
 * RANK-009 xRPC already ranks server-side so 3 is "the top 3
 * trusted alternatives". Exposed so callers can rely on the cap
 * being enforced by the data layer.
 */
export const MAX_ALTERNATIVES = 3;

/**
 * **TN-V2-RANK-015.** Wire-side shape for the negative-space lookup.
 * Captures only what the banner needs — count + scope. Reviewer DIDs
 * are intentionally omitted from the screen-level input: revealing
 * which specific contacts flagged a brand on a non-related subject's
 * detail page leaks more relationship data than the chip's purpose
 * warrants. If the future surface "tap the banner to see who flagged"
 * lands, that would be a separate xRPC + a separate input field.
 */
export interface FlagSummary {
  /** Distinct 1-hop contacts who flagged a related subject. */
  readonly contactsFlaggedCount: number;
  /**
   * What the contacts flagged. `'subject'` = the same subject as
   * displayed; `'brand'` = a same-brand subject; `'category'` = a
   * same-category subject. The detail screen uses scope to choose
   * between "this product" / "this brand" / "this category" copy.
   */
  readonly scope: 'subject' | 'brand' | 'category';
}

/**
 * **TN-V2-RANK-011 + RANK-012.** Per-render context for viewer-state
 * the chip derivations need. Mirrors `SubjectCardContext`. Optional —
 * omitting it means the viewer-aware chips silently render as null,
 * matching the card's behaviour.
 */
export interface SubjectDetailContext {
  /** Viewer's region preference for the region pill. */
  readonly viewerRegion?: string | null;
  /** Current time for the recency badge; defaults to `Date.now()`. */
  readonly nowMs?: number;
  /**
   * Viewer's own DID. Same belt-and-braces guard as
   * `SubjectCardContext.viewerDid`: any review whose `reviewerDid`
   * matches this is reclassified as `ring='self'` regardless of the
   * wire's bucketing. Without this, AppView's `subjectGet` has been
   * observed putting self-authored reviews into the `strangers`
   * bucket, which then renders the user's own band ("VERY LOW")
   * against their own name + drops them out of the friends count.
   */
  readonly viewerDid?: string | null;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Derive the full subject-detail bundle from the screen's raw input.
 *
 * Pure: same input + same context always produces the same output.
 * The screen calls this once per render — O(N log N) where N is the
 * number of reviews (one pass to bucket + a sort per group).
 *
 * `context` is optional: omitting it skips the viewer-aware chips
 * (recency, regionPill). Pre-V2 callers stay source-compatible.
 */
export function deriveSubjectDetail(
  input: SubjectDetailInput,
  context?: SubjectDetailContext,
): SubjectDetailDisplay {
  const reviewCount = clampNonNegative(input.reviewCount);
  const score = trustDisplayFor(input.subjectTrustScore);

  // Bucket reviews into three groups in a single pass. Ring=self
  // collapses with contacts under "friends" — same posture as the
  // card's friends-pill (self counts as a friend in the binary
  // view since the user trusts themselves).
  const friends: SubjectReview[] = [];
  const fof: SubjectReview[] = [];
  const strangers: SubjectReview[] = [];

  // Override the wire `ring` to `'self'` for self-authored rows when
  // the viewer's DID is known. Mirrors the same guard in
  // `deriveSubjectCard` so the friends-vs-strangers split agrees
  // across surfaces.
  const viewerDid =
    typeof context?.viewerDid === 'string' && context.viewerDid.length > 0
      ? context.viewerDid
      : null;
  const reclassify = (r: SubjectReview): SubjectReview =>
    viewerDid !== null && r.reviewerDid === viewerDid && r.ring !== 'self'
      ? { ...r, ring: 'self' }
      : r;

  for (const raw of input.reviews) {
    const r = reclassify(raw);
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

  const nowMs = context?.nowMs ?? Date.now();

  return {
    header: {
      title: input.title,
      subtitle: deriveCardSubtitle(input.category),
      score,
      reviewCount,
      showNumericScore: reviewCount >= MIN_REVIEWS_FOR_NUMERIC && score.score !== null,
      ringCounts: {
        friends: friends.length,
        fof: fof.length,
        strangers: strangers.length,
      },
      // TN-V2-P1-004 + RANK-011/012/013: chips mirror the card
      // surface — same normalisation helpers, same gating. Imported
      // from `subject_card.ts` so the chip contract is single-source:
      // a wire-format change propagates to both surfaces in one edit.
      host: normaliseHostChip(input.host),
      language: normaliseLanguageChip(input.language),
      location: normalisePlaceLocation(input.subjectKind, input.coordinates),
      priceTier: normalisePriceTier(input.priceTier),
      recency: deriveRecencyBadge(input.category, input.lastActiveMs, nowMs),
      regionPill: deriveRegionPill(input.availabilityRegions, context?.viewerRegion),
      flagWarning: deriveFlagWarning(input.flagSummary),
    },
    friendsReviews: friends,
    fofReviews: fof,
    strangerReviews: strangers,
    alternatives: deriveAlternatives(input.alternatives, currentSubjectId(input)),
  };
}

/**
 * Resolve the "current" subject's ID for filtering it out of the
 * alternatives list. The subject-detail input doesn't carry an
 * explicit `subjectId` field today (the screen passes it as a
 * prop alongside the data); we compose a best-effort identifier
 * from `subjectDid` / `subjectIdentifier` / `subjectUri` so the
 * filter works even when the field happens to overlap. Returns
 * empty string when none — that means the filter is a no-op
 * (which is fine; the server side should not return self anyway).
 */
function currentSubjectId(input: SubjectDetailInput): string {
  return input.subjectDid ?? input.subjectIdentifier ?? input.subjectUri ?? '';
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

function clampNonNegative(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// ─── TN-V2-RANK-015: flag-warning banner ──────────────────────────────────

/**
 * Map flag scope → noun used in the banner text.
 *
 * `'subject'` → "this subject" reads slightly weak ("subject" is a
 * noun the user shouldn't have to know about). We use "this product"
 * as the catchall — most subjects are products in practice. If
 * `subjectKind`-aware noun choice ever matters, callers can pass the
 * `scope: 'subject'` and the screen layer can override the noun.
 *
 * Plural form ("contacts" vs "contact") is handled separately in
 * `deriveFlagWarning` since it depends on count, not scope.
 */
const FLAG_SCOPE_NOUN: Readonly<Record<FlagSummary['scope'], string>> = {
  subject: 'product',
  brand: 'brand',
  category: 'category',
};

/**
 * Derive the flag-warning banner per TN-V2-RANK-015.
 *
 * Returns `null` when:
 *   - `summary` is missing / null (no signal — no banner)
 *   - `summary.contactsFlaggedCount` is non-finite, zero, or negative
 *     (defensive — a "0 contacts flagged this" banner is reassurance
 *     theatre, not signal)
 *   - `summary.contactsFlaggedCount` exceeds a defensive ceiling
 *     (1e6) — also a wire-format violation guard
 *
 * Otherwise composes the rendered text:
 *   - 1 contact: `"1 of your contacts flagged this brand"`
 *   - N>1: `"N of your contacts flagged this brand"`
 *
 * Pure helper — exported for tests + reuse if a card-side surface
 * eventually wants the same banner.
 */
export function deriveFlagWarning(
  summary: FlagSummary | null | undefined,
): FlagWarning | null {
  if (summary === null || summary === undefined) return null;
  const count = summary.contactsFlaggedCount;
  if (!Number.isFinite(count)) return null;
  if (count <= 0) return null;
  // Defensive ceiling — a count above this is a wire-format violation
  // (the user's network can't realistically have 1M+ flaggers on one
  // brand). Render a clipped value rather than a runaway banner.
  const SAFE_CEILING = 1_000_000;
  const safeCount = Math.min(Math.floor(count), SAFE_CEILING);
  const noun = FLAG_SCOPE_NOUN[summary.scope] ?? 'subject';
  // Always plural for the prepositional phrase: "1 of your contacts"
  // reads correctly because "of your contacts" is "out of the set of
  // your contacts" — the count of the subset doesn't affect the
  // plurality of the larger set name. "1 of your contact" would be
  // ungrammatical.
  return {
    count: safeCount,
    scope: summary.scope,
    text: `${safeCount} of your contacts flagged this ${noun}`,
  };
}

// ─── TN-V2-RANK-014: alternatives strip ───────────────────────────────────

/**
 * Derive the alternatives strip from the wire-side list per
 * TN-V2-RANK-014.
 *
 * Pipeline:
 *   1. Drop entries with empty `subjectId` or empty `title` (a chip
 *      with no identity / no label can't render usefully).
 *   2. Drop the current subject if the server happened to include it
 *      (defensive — RANK-009 spec excludes self, but a wire-format
 *      violation shouldn't render "Worth every penny" as a
 *      suggestion to itself).
 *   3. De-duplicate by `subjectId` (defensive — same wire violation
 *      class).
 *   4. Cap at {@link MAX_ALTERNATIVES} (the strip is sized for 3).
 *   5. Project each survivor to `SubjectAlternative` (band derived
 *      from `subjectTrustScore`).
 *
 * Returns an empty readonly array (never `null`) — the strip's
 * "show / hide" decision is owned by the screen layer based on
 * length: empty array → hide the whole strip; non-empty → show
 * with the surviving entries.
 */
export function deriveAlternatives(
  raw: readonly AlternativeInput[] | null | undefined,
  currentId: string,
): readonly SubjectAlternative[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SubjectAlternative[] = [];
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry.subjectId !== 'string' || entry.subjectId.length === 0) continue;
    if (typeof entry.title !== 'string' || entry.title.length === 0) continue;
    if (entry.subjectId === currentId) continue; // never suggest self
    if (seen.has(entry.subjectId)) continue;
    seen.add(entry.subjectId);
    out.push({
      subjectId: entry.subjectId,
      title: entry.title,
      category: entry.category ?? null,
      band: bandForScore(entry.subjectTrustScore),
    });
    if (out.length >= MAX_ALTERNATIVES) break;
  }
  return out;
}

/**
 * Map a [0, 1] trust score to its band token via the shared
 * `trustBandFor` so the alternatives strip can't drift from the
 * card's banding. Defensive null/non-finite handling lives here so
 * the helper itself stays honest about its accepted inputs.
 */
function bandForScore(
  score: number | null | undefined,
): TrustBand {
  if (score === null || score === undefined) return 'unrated';
  if (!Number.isFinite(score)) return 'unrated';
  return trustBandFor(score);
}
