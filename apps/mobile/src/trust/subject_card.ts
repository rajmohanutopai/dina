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
  /**
   * **TN-V2-P1-001 (V2 actionability layer).** `subjects.metadata.host`
   * extracted by the AppView enricher (e.g. `'amazon.co.uk'`,
   * `'jumia.ug'`). Already in the schema — V2 just surfaces it on
   * the card so a viewer can SEE the regional/source signal at a
   * glance. Optional: omitted on subjects with no URL ancestry
   * (DID-typed subjects, freeform claims). Empty / whitespace-only
   * coerces to "no host" rather than rendering a blank chip — see
   * `normaliseChip` in the derivation.
   */
  readonly host?: string | null;
  /**
   * **TN-V2-P1-002 (V2 actionability layer).** `subjects.language`
   * auto-detected by `franc-min` over name + searchable text. BCP-47
   * tag (e.g. `'en'`, `'pt-BR'`). Surfaced as a chip so a viewer
   * can spot non-locale subjects before tapping in. Optional:
   * legacy rows where detection failed have null. The data layer
   * uppercases for display; the wire shape stays as-stored.
   */
  readonly language?: string | null;
  /**
   * **TN-V2-P1-003 (V2 actionability layer).** Subject-ref kind from
   * the wire (`'product'` / `'place'` / `'organization'` / etc.). The
   * card uses this to gate the location chip — coords on non-place
   * subjects are dropped (would be a wire bug; defensive). Optional:
   * pre-V2 callers don't carry it.
   */
  readonly subjectKind?: string | null;
  /**
   * **TN-V2-P1-003 (V2 actionability layer).** Coordinates for `place`
   * subjects, sourced from `subjects.metadata.{lat,lng}`. The card
   * shows these as a small chip ("37.77°N, 122.42°W") so a viewer
   * can see the geographic anchor at a glance. Reverse-geocoding to
   * a city/region label is a Cluster B follow-on; for V2.P1 we
   * surface the truncated coords directly. Out-of-range / non-finite
   * values are coerced to `null` in the derivation.
   */
  readonly coordinates?: { readonly lat: number; readonly lng: number } | null;
  /**
   * **TN-V2-RANK-013 (V2 actionability layer).** Tier bucket for the
   * subject's price range — `$` / `$$` / `$$$`. The server-side
   * scorer derives this from `subjects.metadata.price.{low_e7,
   * high_e7}` against the per-category reference price (Cluster B
   * + RANK work). The mobile client renders what arrives; tier
   * bucketing logic does NOT live here because it depends on
   * category-specific reference prices the client doesn't know.
   * Optional + nullable: subjects without price data (services,
   * non-commercial subjects, claims) have `null`.
   */
  readonly priceTier?: '$' | '$$' | '$$$' | null;
  /**
   * **TN-V2-RANK-011 (V2 actionability layer).** Server-derived
   * `subjects.lastActiveMs` (META-011) — the most recent attestation
   * touching this subject. Used as a freshness floor: when the gap
   * between `nowMs` and this exceeds the per-category half-life
   * threshold, the card surfaces a "stale" badge so the viewer can
   * weigh that signal alongside trust. Optional + nullable: legacy
   * subjects without the field, or freshly-created subjects with
   * lastActiveMs missing, simply skip the badge.
   */
  readonly lastActiveMs?: number | null;
  /**
   * **TN-V2-RANK-012 (V2 actionability layer).** ISO 3166-1 alpha-2
   * country codes from `subjects.metadata.availability.regions`
   * (META-001). When the viewer's region is NOT in this list, the
   * card renders a "📍 UK only" pill so the viewer knows the subject
   * isn't sold in their region BEFORE tapping in. Optional + nullable:
   * subjects without availability data carry `null` — no pill,
   * preserves the "missing field = pass" V2 contract (we don't
   * surface availability warnings against unknown availability).
   */
  readonly availabilityRegions?: readonly string[] | null;
}

/**
 * **TN-V2-RANK-011 + RANK-012.** Per-render context passed into
 * `deriveSubjectCard`. Holds viewer-state (region, current time)
 * that the chip derivations need. Kept out of `SubjectCardInput` so
 * that the input stays pure subject-state — the same subject row
 * produces the same input regardless of which viewer sees it. The
 * context is what's per-viewer, per-render. Optional: omitting the
 * context simply skips the viewer-aware chips (recency, regionPill)
 * — pre-V2 callers and tests that don't care about those chips can
 * call `deriveSubjectCard(input)` and get null on both.
 */
export interface SubjectCardContext {
  /**
   * The viewer's region preference (ISO 3166-1 alpha-2, e.g. `'GB'`,
   * `'US'`). Sourced from `useViewerPreferences().profile.region`.
   * Required for the region pill — without it, we can't determine
   * whether the subject's availability includes the viewer.
   */
  readonly viewerRegion?: string | null;
  /**
   * Current time in milliseconds since epoch. Required for the
   * recency badge so the function stays pure (same input + same
   * `nowMs` → same output, always). The screen layer passes
   * `Date.now()` at render time. Defaults to `Date.now()` when
   * omitted, so production callers don't have to wire it explicitly,
   * but tests should always pin a value.
   */
  readonly nowMs?: number;
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
  /**
   * **TN-V2-P1-001.** Display-ready host string — lowercased,
   * trimmed, empty coerces to `null`. The view renders this as a
   * small chip (e.g. `'amazon.co.uk'`); the derivation owns
   * normalisation so the view stays a pure renderer.
   */
  readonly host: string | null;
  /**
   * **TN-V2-P1-002.** Display-ready language tag — uppercased
   * (BCP-47 conventions: language subtag lowercase, region subtag
   * uppercase, but the chip is small + glance-readable so we
   * uppercase the whole thing — `'EN'`, `'PT-BR'`). Trimmed; empty
   * coerces to `null`. Wire shape (lowercase) stays as-stored at
   * the AppView; this is presentation only.
   */
  readonly language: string | null;
  /**
   * **TN-V2-P1-003.** Display-ready place location string — formatted
   * truncated lat/lng with cardinal letters (e.g. `'37.77°N, 122.42°W'`).
   * `null` when the subject is not a `place`, when coords are absent,
   * or when coords are out-of-range / non-finite. The view renders this
   * as a small chip alongside host + language; the gating + formatting
   * are owned here so the view stays a pure renderer.
   */
  readonly location: string | null;
  /**
   * **TN-V2-RANK-013.** Display-ready price tier for the chip
   * (`'$'` / `'$$'` / `'$$$'`), or `null` when the subject has no
   * price data. The data layer narrows the wire-side enum to
   * exactly the three valid tier strings — invalid input coerces
   * to `null` rather than rendering a malformed chip.
   */
  readonly priceTier: '$' | '$$' | '$$$' | null;
  /**
   * **TN-V2-RANK-011.** Display-ready recency badge text (e.g.
   * `'3 years old'`, `'8 months old'`), or `null` when the subject
   * is fresh per its category-tuned half-life threshold. Renders as
   * a subdued chip — the badge's purpose is a *gentle* "this might
   * be stale" cue, not a hard signal that overrides trust. The
   * threshold + age calculation are owned by the data layer so the
   * view stays a pure renderer.
   */
  readonly recency: string | null;
  /**
   * **TN-V2-RANK-012.** Display-ready region-availability pill
   * (e.g. `'📍 UK only'`, `'📍 US, CA only'`), or `null` when the
   * subject is available in the viewer's region OR when availability
   * data is missing entirely (we don't penalise unknown — preserves
   * the "missing field = pass" V2 contract). Pure data-layer derivation
   * so the view stays a renderer.
   */
  readonly regionPill: string | null;
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
 * Pure: same input + same context always produces the same output.
 * The screen calls this once per subject in its result list — no
 * expensive precompute needed; the function does one pass over
 * `reviews` plus a constant-time set of decisions.
 *
 * `context` is optional: omitting it skips the two viewer-aware
 * chips (`recency`, `regionPill`). Pre-V2 callers stay
 * source-compatible.
 */
export function deriveSubjectCard(
  input: SubjectCardInput,
  context?: SubjectCardContext,
): SubjectCardDisplay {
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

  // Default `nowMs` to call-time `Date.now()` so production callers
  // can omit context entirely. Tests pin an explicit `nowMs` to keep
  // the function pure under their lens.
  const nowMs = context?.nowMs ?? Date.now();

  return {
    title: input.title,
    subtitle: deriveCardSubtitle(input.category),
    score,
    showNumericScore: reviewCount >= MIN_REVIEWS_FOR_NUMERIC && score.score !== null,
    reviewCount,
    friendsPill: friends > 0 ? { friendsCount: friends, strangersCount: strangers } : null,
    topReviewer: top === null ? null : toTopReviewerLine(top),
    host: normaliseHostChip(input.host),
    language: normaliseLanguageChip(input.language),
    location: normalisePlaceLocation(input.subjectKind, input.coordinates),
    priceTier: normalisePriceTier(input.priceTier),
    recency: deriveRecencyBadge(input.category, input.lastActiveMs, nowMs),
    regionPill: deriveRegionPill(input.availabilityRegions, context?.viewerRegion),
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
 * like `office_furniture/chair`. The card subtitle takes the FIRST
 * segment (the at-a-glance "what kind of subject"), humanises
 * underscores, and capitalises. When there's only one segment we
 * still humanise + capitalise it; cards with no category at all
 * return null.
 *
 * `subtitle: string | null` is a hard contract — `null` means
 * "no subtitle, hide the slot". An all-underscore category like
 * `'__/chair'` humanises to the empty string; we collapse that to
 * `null` so a downstream `value ?? fallback` treats it as absence.
 * The screen's truthy `&&` already hides it either way, but
 * surfacing `''` from a `string | null` is contract drift.
 *
 * Exported so `subject_detail_data.ts` can produce the same subtitle
 * — single source of truth across card + detail surfaces. (Earlier
 * the function was duplicated with a "deferred until rule of three"
 * comment; the V2 chip work centralised the chip normalisers here, so
 * extending the same single-source pattern to the subtitle removes
 * the inconsistency.)
 */
export function deriveCardSubtitle(category: string | null | undefined): string | null {
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

/**
 * Normalise the host chip per TN-V2-P1-001.
 *
 * Hosts arrive from `subjects.metadata.host` already lowercased by
 * the AppView enricher's `normalizeHost` (DNS is case-insensitive),
 * but we re-lowercase here so this module has a self-contained
 * contract — a future caller threading host from a non-enricher
 * source can't accidentally render `Amazon.CO.UK`. Trim defends
 * against accidental whitespace from JSON parsing edge cases.
 *
 * Returns `null` for null/undefined/empty/whitespace-only input —
 * the contract is `host: string | null` with `null` = absent. The
 * view's truthy `&&` already hides the chip either way, but
 * surfacing `''` from a `string | null` is contract drift (same
 * reasoning as `deriveSubtitle`'s null-vs-empty discipline).
 *
 * Exported so `subject_detail_data.ts` can apply the same
 * normalisation to its header chips — single source of truth for
 * the host-chip contract across card + detail surfaces.
 */
export function normaliseHostChip(host: string | null | undefined): string | null {
  if (host === null || host === undefined) return null;
  const trimmed = host.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalise the language chip per TN-V2-P1-002.
 *
 * BCP-47 tags arrive lowercase from `franc-min` (e.g. `'en'`,
 * `'pt-br'`). The chip is glance-readable — a 2-3 character pill
 * — so we uppercase for visual punch (`'EN'`, `'PT-BR'`). The
 * underlying wire shape stays lowercase at the AppView; this is
 * presentation-only. Same null-vs-empty discipline as
 * `normaliseHostChip`. Exported for reuse on the detail surface.
 */
export function normaliseLanguageChip(language: string | null | undefined): string | null {
  if (language === null || language === undefined) return null;
  const trimmed = language.trim().toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalise the place-location chip per TN-V2-P1-003.
 *
 * Two-stage gate:
 *
 *   1. **Subject kind must be `place`.** Coords on non-place subjects
 *      are dropped — that's a wire-format invariant violation (the
 *      enricher only writes `lat`/`lng` into `subjects.metadata` for
 *      `place` rows), so the right behaviour is to ignore them rather
 *      than surface a misleading "this product is at 37°N" chip.
 *   2. **Coords must be in range and finite.** `lat ∈ [-90, 90]`,
 *      `lng ∈ [-180, 180]`. NaN / Infinity / out-of-range coerce to
 *      `null` — defensive against malformed wire data.
 *
 * Format: `"37.77°N, 122.42°W"` — 2 decimal places (≈ 1.1km accuracy,
 * city-block precision, enough to identify a city without being
 * alarmingly precise about a private place). Cardinal letters carry
 * the sign so `Math.abs()` cleans up `-0` rendering and matches the
 * conventional human-readable format you'd see on a map app.
 *
 * Reverse-geocoding to a city/region label ("San Francisco, CA") is
 * a Cluster B follow-on; this is the V2.P1 truncated-coords version.
 *
 * Exported for reuse on the detail surface (TN-V2-P1-004).
 */
export function formatPlaceLocation(
  coords: { readonly lat: number; readonly lng: number } | null | undefined,
): string | null {
  if (coords === null || coords === undefined) return null;
  const { lat, lng } = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lng).toFixed(2)}°${ew}`;
}

/**
 * Normalise the price-tier chip per TN-V2-RANK-013.
 *
 * The wire delivers `'$'` / `'$$'` / `'$$$'` as the bucketed tier.
 * The mobile data layer's only job here is type-narrowing: anything
 * that's not exactly one of the three valid tier strings coerces
 * to `null` so a downstream renderer never sees malformed data.
 *
 * Exported for `subject_detail_data.ts` so the chip semantics
 * stay single-source across card + detail surfaces.
 */
export function normalisePriceTier(
  tier: string | null | undefined,
): '$' | '$$' | '$$$' | null {
  if (tier === '$' || tier === '$$' || tier === '$$$') return tier;
  return null;
}

/**
 * Combined gate: location chip is non-null only when subject is a
 * `place` AND coords are valid. Centralised here so both card +
 * detail derivations apply the same gating — a future change to
 * "we also surface coords for `organization` subjects with a HQ
 * location" lands in one place.
 *
 * Exported for `subject_detail_data.ts` to reuse the same gate.
 */
export function normalisePlaceLocation(
  subjectKind: string | null | undefined,
  coords: { readonly lat: number; readonly lng: number } | null | undefined,
): string | null {
  if (subjectKind !== 'place') return null;
  return formatPlaceLocation(coords);
}

// ─── TN-V2-RANK-011: recency badge ────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // approximate — for badge UX, not banking
const MS_PER_YEAR = 365 * MS_PER_DAY;

/**
 * Per-category badge thresholds — how old before we surface the
 * "stale" hint. Keyed by the FIRST segment of the slash-delimited
 * category path (`'tech/laptops'` → `'tech'`). Categories not in the
 * map fall back to `DEFAULT_RECENCY_THRESHOLD_MS`.
 *
 * Tuned for the *signal-to-noise* of the badge, not for trust-score
 * decay (which is RANK-006, scorer-side, separate concern). A badge
 * that fires on every tech review older than 6 months is too chatty;
 * one that never fires on book reviews older than a decade is
 * useless. The values below are honest defaults — refine with real
 * data once the lastActiveMs pipeline is feeding the AppView.
 *
 * **Drift risk**: RANK-006 ships its own per-category half-life
 * table (server-side, in `appview/src/scorer/algorithms/`) for the
 * trust-score decay. These two tables answer DIFFERENT questions
 * ("when does the score start decaying?" vs "when is the badge
 * worth showing the user?") so they legitimately diverge — but if
 * future maintainers want them coupled, the right move is to serve
 * the values from `appview_config` and read here at boot.
 *
 * Exported as a constant (not `Map`) so it stays inspectable +
 * stable across renders. Read-only.
 */
export const RECENCY_THRESHOLDS_MS: Readonly<Record<string, number>> = {
  // Tech moves fast — phones, laptops, software all turn over in
  // months. A 1-year-old phone review is borderline-stale; 2 years
  // is firmly stale.
  tech: 1 * MS_PER_YEAR,
  technology: 1 * MS_PER_YEAR,
  electronics: 1 * MS_PER_YEAR,
  software: 1 * MS_PER_YEAR,
  // Books / classics — a 10-year-old novel review is still relevant.
  // Threshold high so the badge only fires on genuinely-ancient
  // reviews of evolving non-fiction.
  book: 5 * MS_PER_YEAR,
  books: 5 * MS_PER_YEAR,
  // Restaurants change ownership, chefs, menus — yearly threshold.
  restaurant: 1 * MS_PER_YEAR,
  food: 1 * MS_PER_YEAR,
  // Office furniture, home goods — long-lived. Low signal-to-noise
  // before 3 years.
  office_furniture: 3 * MS_PER_YEAR,
  furniture: 3 * MS_PER_YEAR,
};

/**
 * Default recency threshold for categories not in the table —
 * 2 years. Generic "still meaningful" floor.
 */
export const DEFAULT_RECENCY_THRESHOLD_MS = 2 * MS_PER_YEAR;

/**
 * Derive the recency-badge string per TN-V2-RANK-011.
 *
 * Returns `null` when:
 *   - `lastActiveMs` is missing / non-finite (no signal — no badge)
 *   - subject is fresh per its category threshold (badge purpose
 *     is "this might be stale", silent on fresh subjects)
 *   - `lastActiveMs > nowMs` (future-dated wire data — defensive,
 *     no badge rather than "0 months old")
 *
 * Otherwise returns a coarse human-readable age:
 *   - ≥ 1 year: `"3 years old"` (or `"1 year old"` singular)
 *   - 1-11 months: `"8 months old"` (or `"1 month old"`)
 *   - < 1 month (post-threshold edge case): `"recent"` — only
 *     reachable if a category's threshold ever drops below 30 days,
 *     which today's table does not. Defensive.
 *
 * Exported for `subject_detail_data.ts` reuse.
 */
export function deriveRecencyBadge(
  category: string | null | undefined,
  lastActiveMs: number | null | undefined,
  nowMs: number,
): string | null {
  if (lastActiveMs === null || lastActiveMs === undefined) return null;
  if (!Number.isFinite(lastActiveMs)) return null;
  if (!Number.isFinite(nowMs)) return null;

  const ageMs = nowMs - lastActiveMs;
  if (ageMs < 0) return null;

  const threshold = recencyThresholdForCategory(category);
  if (ageMs <= threshold) return null;

  return formatAge(ageMs);
}

function recencyThresholdForCategory(
  category: string | null | undefined,
): number {
  if (typeof category !== 'string' || category.trim().length === 0) {
    return DEFAULT_RECENCY_THRESHOLD_MS;
  }
  const head = category.trim().split('/')[0]?.toLowerCase() ?? '';
  return RECENCY_THRESHOLDS_MS[head] ?? DEFAULT_RECENCY_THRESHOLD_MS;
}

function formatAge(ageMs: number): string {
  if (ageMs >= MS_PER_YEAR) {
    const years = Math.floor(ageMs / MS_PER_YEAR);
    return `${years} ${years === 1 ? 'year' : 'years'} old`;
  }
  if (ageMs >= MS_PER_MONTH) {
    const months = Math.floor(ageMs / MS_PER_MONTH);
    return `${months} ${months === 1 ? 'month' : 'months'} old`;
  }
  return 'recent';
}

// ─── TN-V2-RANK-012: region pill ──────────────────────────────────────────

/**
 * Derive the "📍 X only" pill per TN-V2-RANK-012.
 *
 * Returns `null` when:
 *   - `availabilityRegions` is missing / empty (no signal — preserves
 *     "missing field = pass" V2 contract; we don't surface
 *     availability warnings against unknown availability)
 *   - `viewerRegion` is missing (without it we can't decide
 *     "is the viewer in scope?")
 *   - `viewerRegion` IS in `availabilityRegions` (subject IS
 *     available — no warning needed)
 *
 * Otherwise renders a pill listing the regions the subject IS
 * available in:
 *   - 1 region: `"📍 GB only"`
 *   - 2-3 regions: `"📍 US, CA, GB only"`
 *   - 4+ regions: `"📍 US, CA, GB +N only"` (compact form to fit
 *     the chip-row's line budget)
 *
 * Region codes are uppercased ISO 3166-1 alpha-2. Display-name
 * lookup is intentionally not done here — codes are universally
 * recognised, the chip is small, and reverse-lookup adds Intl
 * dependency for a marginal UX gain. Detail surfaces can render
 * full names if a follow-on calls for it.
 *
 * Exported for `subject_detail_data.ts` reuse.
 */
export function deriveRegionPill(
  availabilityRegions: readonly string[] | null | undefined,
  viewerRegion: string | null | undefined,
): string | null {
  if (!Array.isArray(availabilityRegions)) return null;
  if (availabilityRegions.length === 0) return null;

  const normalisedRegions = availabilityRegions
    .map((r) => (typeof r === 'string' ? r.trim().toUpperCase() : ''))
    .filter((r) => r.length > 0);
  if (normalisedRegions.length === 0) return null;

  if (typeof viewerRegion !== 'string') return null;
  const viewer = viewerRegion.trim().toUpperCase();
  if (viewer.length === 0) return null;

  if (normalisedRegions.includes(viewer)) return null;

  return formatRegionList(normalisedRegions);
}

function formatRegionList(regions: readonly string[]): string {
  // Cap the listed regions at 3 to keep the pill chip-sized; spill
  // anything beyond into a "+N" suffix. Stable order as provided —
  // the wire-side enricher (META-001) is responsible for any
  // canonical ordering decisions.
  const MAX_LISTED = 3;
  if (regions.length <= MAX_LISTED) {
    return `📍 ${regions.join(', ')} only`;
  }
  const head = regions.slice(0, MAX_LISTED).join(', ');
  const overflow = regions.length - MAX_LISTED;
  return `📍 ${head} +${overflow} only`;
}
