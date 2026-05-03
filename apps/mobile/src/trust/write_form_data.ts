/**
 * Compose-flow form-state derivation (TN-MOB-013 / Plan §8.6).
 *
 * The compose screen captures four fields:
 *   - sentiment (positive / neutral / negative — required)
 *   - headline (≤ 140 chars per Plan §8.5 — required)
 *   - body (≤ 4000 chars — optional)
 *   - confidence (certain / high / moderate / speculative — required)
 *
 * The validation logic (which combinations are publishable, what the
 * disabled state of the Publish button is, what error message to
 * surface inline) is non-trivial enough to deserve its own pure
 * module — saves the screen from interleaving form rules with
 * RN-specific rendering.
 *
 * Headline length: Plan §8.5 sets 140 chars as the cap. Body
 * length: 4000 chars is the conservative AppView Zod schema bound.
 * Both checks are bytes-of-UTF-16 (JS string `.length`) — same as
 * AppView's Zod `max(140)` interprets them, so the mobile preflight
 * + the AppView server-side check agree.
 *
 * Pure function. No state. Tested under plain Jest.
 */

import type { Sentiment, Confidence } from '@dina/protocol';

// ─── Public constants ─────────────────────────────────────────────────────

export const HEADLINE_MAX_LENGTH = 140;
export const BODY_MAX_LENGTH = 4000;
export const SUBJECT_NAME_MAX_LENGTH = 200;
export const SUBJECT_IDENTIFIER_MAX_LENGTH = 256;

/** Closed enum of the sentiment selector buttons. Order = display order. */
export const SENTIMENT_OPTIONS: readonly Sentiment[] = ['positive', 'neutral', 'negative'];

/** Closed enum of the confidence selector buttons. Order = display order. */
export const CONFIDENCE_OPTIONS: readonly Confidence[] = [
  'certain',
  'high',
  'moderate',
  'speculative',
];

/**
 * AppView's `subject.type` taxonomy (mirror of
 * `appview/src/shared/types/lexicon-types.ts:SubjectRef.type`). Order
 * matches the order the picker renders.
 */
export type SubjectKind =
  | 'product'
  | 'place'
  | 'organization'
  | 'content'
  | 'did'
  | 'dataset'
  | 'claim';

export const SUBJECT_KIND_OPTIONS: readonly SubjectKind[] = [
  'product',
  'place',
  'organization',
  'content',
  'did',
  'dataset',
  'claim',
];

/**
 * Per-kind hint copy. Surfaced under the picker so the user knows
 * what kind of identifier each option expects. Keep these short — they
 * fit on one line under the chip row.
 */
export const SUBJECT_KIND_HINT: Record<SubjectKind, string> = {
  product: 'A reviewable product (e.g. Aeron Chair, ASIN, ISBN).',
  place: 'A location — restaurant, venue, address.',
  organization: 'A company, publisher, or service provider.',
  content: 'An article, video, podcast, or web page (URL).',
  did: 'A person or AT-protocol identity (did:plc / did:web).',
  dataset: 'A published dataset with a stable URI.',
  claim: 'A factual claim that can be sourced or contested.',
};

// ─── Public types ─────────────────────────────────────────────────────────

/** Form state — all fields, exactly the shape the screen renders. */
export interface WriteFormState {
  readonly sentiment: Sentiment | null;
  readonly headline: string;
  readonly body: string;
  readonly confidence: Confidence | null;
  /**
   * Subject describe-fields (TN-MOB-021). When the screen receives a
   * `subjectId` URL param, `subject` is `null` — the subject already
   * exists in AppView and the form publishes against the existing row.
   * When the user reaches the form via "Add to trust network" (no
   * existing subject), the screen prompts them to fill these fields,
   * and the publish payload carries them as `record.subject`.
   */
  readonly subject: WriteSubjectState | null;
  /**
   * **TN-V2-REV-002.** Self-declared expertise with the subject's
   * category. Closed enum so RANK-008's expert-weighted ranking can
   * tier reviewers without string-matching free-form values. `null` =
   * the reviewer hasn't claimed an experience tier — the wire record
   * omits the field.
   */
  readonly reviewerExperience: ReviewerExperience | null;
  /**
   * **TN-V2-META-002.** Reviewer-declared price block as text the
   * user typed — kept as display strings (not e7) so the input is
   * round-trippable while typing. Resolution to the wire shape
   * (`{ low_e7, high_e7, currency, lastSeenMs }`) happens at publish
   * time via {@link priceFromForm}.
   *
   * When `low` is empty, the whole price block is unset — `high` and
   * `currency` are silently ignored on publish. When `low` is set
   * but `high` is empty, it's a point price (`low_e7 == high_e7`).
   */
  readonly priceLow: string;
  readonly priceHigh: string;
  readonly priceCurrency: string;
  /**
   * **TN-V2-META-005.** Reviewer-declared compliance tags from
   * {@link COMPLIANCE_VOCABULARY}. Closed-vocab discipline at the
   * form layer; AppView indexes opaque tags. Cap
   * {@link MAX_COMPLIANCE} = 10 (additive — one product can be halal
   * AND vegan AND gluten-free simultaneously). Empty array = wire
   * record omits the field.
   */
  readonly compliance: readonly string[];
  /**
   * **TN-V2-META-006.** Reviewer-declared accessibility tags from
   * {@link ACCESSIBILITY_VOCABULARY}. Same shape + cap
   * ({@link MAX_ACCESSIBILITY} = 10) rationale as `compliance` —
   * accessibility is additive (wheelchair AND captions AND
   * audio-described on the same venue is normal).
   */
  readonly accessibility: readonly string[];
  /**
   * **TN-V2-META-003.** Reviewer-declared compatibility tags from
   * {@link COMPAT_VOCABULARY}. Cap {@link MAX_COMPAT} = 15 (vs 10
   * for compliance/accessibility) — devices legitimately check many
   * compatibility boxes (a laptop: macos + thunderbolt-4 + usb-c +
   * bluetooth-5 + wifi-6e + … hits double digits before any
   * per-platform expansion).
   */
  readonly compat: readonly string[];
  /**
   * **TN-V2-REV-004.** Use-case endorsements / warnings from the
   * same vocabulary as {@link useCases} (per-category). `recommendFor`
   * flags use-cases the reviewer endorses; `notRecommendFor` flags
   * use-cases they explicitly warn against. Cap each at
   * {@link MAX_RECOMMEND_FOR} = 5 — larger lists become noise on the
   * detail surface that renders them.
   */
  readonly recommendFor: readonly string[];
  readonly notRecommendFor: readonly string[];
  // **Dropped from review form (subject-attribute, not opinion):**
  // availabilityRegions, availabilityShipsTo, availabilitySoldAt,
  // scheduleLeadDays, scheduleSeasonal. A reviewer in the UK can't
  // authoritatively enumerate which 50 countries a product ships to,
  // and "lead time" / "seasonal months" are facts about the venue, not
  // the reviewer's experience. These belong on a future "Add subject"
  // surface (subject-owner / curator declares; reviewer attests). The
  // wire record continues to accept them — older clients publishing
  // them stay valid, the AppView keeps indexing — but the mobile form
  // no longer prompts for them.
  /**
   * **TN-V2-REV-006.** Optional self-declared use-case tags from a
   * per-category vocabulary (see {@link USE_CASE_BY_CATEGORY}). Up
   * to {@link MAX_USE_CASES} = 3 tags. Powers RANK-008's use-case-
   * aware reviewer weighting ("rank reviews from people who used the
   * subject for the same purpose I'm considering it for"). Empty
   * array = user didn't pick any → wire record omits the field.
   *
   * The form layer enforces the cap; the screen mutator uses
   * tap-to-toggle. The vocabulary is **closed**: only tags from the
   * category's list are accepted (free-form input is silently
   * dropped — see `setUseCases`).
   */
  readonly useCases: readonly string[];
  /**
   * **TN-V2-REV-008.** Optional list of "other things I tried" the
   * reviewer also considered. Powers the "the reviewer also looked
   * at X, Y" surface (Plan §6.3 conflict_chooser dovetails here).
   * Up to {@link MAX_REVIEW_ALTERNATIVES} = 5 entries — enough to
   * be useful, capped to keep the publish payload bounded.
   *
   * Entries are added via the search picker (REV-008 UI) or by
   * synthesis (free-form name); the form layer doesn't gate on
   * "subjectId resolved" — alternatives without a known subjectId
   * still ship to the wire as a SubjectRef shape (the AppView's
   * subject-resolver mints/finds the id at ingest time).
   */
  readonly alternatives: readonly ReviewAlternative[];
  /**
   * **TN-V2-REV-007.** Optional self-declared "when did I last
   * interact with this subject?" — distinct from `createdAt` (the
   * review's write timestamp). A reviewer who tried something a
   * year ago but is writing the review today gets to flag that
   * staleness honestly.
   *
   * Captured as a coarse BUCKET (not a free-form date) for two
   * reasons: (1) "today / past week / past month / past 6 months /
   * past year / over a year" answers the freshness question users
   * actually have without demanding date-precision they don't
   * remember; (2) the bucket avoids a native date-picker dependency
   * on the mobile side. The publish path resolves the bucket → ms
   * via {@link lastUsedMsForBucket} when serialising the wire
   * record.
   *
   * `null` (the default) = user didn't pick a bucket → the wire
   * record omits `lastUsedMs` entirely. NOT defaulted to "today" at
   * form-state level — defaulting unobserved would be a wire-side
   * lie.
   */
  readonly lastUsedBucket: LastUsedBucket | null;
}

// ─── TN-V2-REV-002: reviewer experience ───────────────────────────────────

/**
 * **TN-V2-REV-002.** Self-declared expertise tier for the subject's
 * category. Closed enum so RANK-008 can weight reviewers by tier
 * without string-matching free-form values. Self-declared because
 * external verification doesn't scale; the social cost of
 * misrepresenting yourself within your trust network is the gate.
 */
export type ReviewerExperience = 'novice' | 'intermediate' | 'expert';

export const REVIEWER_EXPERIENCE_OPTIONS: readonly ReviewerExperience[] = [
  'novice',
  'intermediate',
  'expert',
];

export const REVIEWER_EXPERIENCE_LABEL: Readonly<Record<ReviewerExperience, string>> = {
  novice: 'Novice',
  intermediate: 'Intermediate',
  expert: 'Expert',
};

export const REVIEWER_EXPERIENCE_HINT: Readonly<Record<ReviewerExperience, string>> = {
  novice: 'Just starting out with this category.',
  intermediate: 'Regular use, comfortable with the basics.',
  expert: 'Deep familiarity — domain professional or long-term user.',
};

// ─── TN-V2-META-002: price ────────────────────────────────────────────────

/**
 * **TN-V2-META-002.** E7 scaling factor — the wire format stores
 * prices as integer hundred-millionths (`round(price * 1e7)`) per
 * the AT Protocol no-floats-in-CBOR rule. Mirrors AppView's
 * `record-validator.ts` price schema.
 */
export const PRICE_E7 = 10_000_000;

/**
 * Closed wire-format error variants for price input. Keeps the
 * screen exhaustive-switch over each kind of price problem; combined
 * with {@link WriteFormError} to stay in the same closed-enum space.
 */
export type PriceFormError =
  | 'price_low_invalid'
  | 'price_high_invalid'
  | 'price_high_below_low'
  | 'price_currency_invalid';

/**
 * Parse a user-typed decimal-string into an e7 integer. Returns
 * `null` for invalid input (non-numeric, negative, out-of-safe-int).
 *
 * Mirrors the OpenGraph price parser's helper (`parse_open_graph_price.ts`)
 * to keep mobile-side preflight semantics aligned with server-side
 * extraction:
 *   - `'29.99'` → `299_900_000`
 *   - `'1000'`  → `10_000_000_000`
 *   - `'29,99'` (European decimal comma) → `299_900_000`
 *   - `''`, `'$29.99'`, `'-1'` → `null`
 *
 * Pure helper — exported for the screen's submit-time resolution.
 */
export function priceDisplayToE7(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Accept European decimal comma — many .de / .fr inputs use it.
  const normalised = trimmed.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalised)) return null;
  const n = Number(normalised);
  if (!Number.isFinite(n) || n < 0) return null;
  // Math.round guards `29.99 * 1e7 = 299899999.99...` → 299_900_000.
  const e7 = Math.round(n * PRICE_E7);
  if (!Number.isSafeInteger(e7)) return null;
  return e7;
}

/**
 * Render an e7 price as a display string (truncates trailing zeros
 * after the decimal point: `299_900_000` → `'29.99'`,
 * `10_000_000_000` → `'1000'`). Used by edit-mode seeding when the
 * form is re-opened on an existing record.
 */
export function priceE7ToDisplay(e7: number): string {
  if (!Number.isFinite(e7) || e7 < 0) return '';
  const dollars = e7 / PRICE_E7;
  // toFixed(2) keeps precision for currency display, then strip
  // trailing zeros so '29.99' stays '29.99' and '1000.00' becomes '1000'.
  const fixed = dollars.toFixed(2);
  return fixed.replace(/\.?0+$/, '');
}

/**
 * Normalise a user-typed currency input (`'usd'`, `'  EUR  '`, `'eur'`)
 * to the wire format (`'USD'` / `'EUR'`). Returns `null` for inputs
 * that don't match ISO 4217 alpha-3 shape after normalisation.
 */
export function normaliseCurrency(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) return null;
  return upper;
}

/**
 * Resolve the form's price-input fields into the wire-shape price
 * block, OR an error variant explaining why the input is unusable,
 * OR `null` when the user hasn't entered any price (the field is
 * optional — empty `priceLow` means "unset" and should omit the
 * whole `price` field from the wire record).
 *
 * Validation rules (mirrors the AppView Zod refines):
 *   - `priceLow` empty → return `null` (field unset, currency/high
 *     ignored).
 *   - `priceLow` non-empty but unparseable → `price_low_invalid`.
 *   - `priceCurrency` not ISO 4217 alpha-3 → `price_currency_invalid`.
 *   - `priceHigh` non-empty but unparseable → `price_high_invalid`.
 *   - `priceHigh` < `priceLow` → `price_high_below_low`.
 *   - `priceHigh` empty → point price (`high_e7 = low_e7`).
 *
 * `now` is injectable so tests can pin `lastSeenMs`. The default
 * (`Date.now()`) matches the publish-path call shape.
 */
export interface PriceFormBlock {
  readonly priceLow: string;
  readonly priceHigh: string;
  readonly priceCurrency: string;
}

export function priceFromForm(
  form: PriceFormBlock,
  now: () => number = Date.now,
):
  | { kind: 'unset' }
  | { kind: 'invalid'; error: PriceFormError }
  | {
      kind: 'ok';
      price: { low_e7: number; high_e7: number; currency: string; lastSeenMs: number };
    } {
  const lowRaw = form.priceLow.trim();
  if (lowRaw.length === 0) return { kind: 'unset' };
  const low_e7 = priceDisplayToE7(lowRaw);
  if (low_e7 === null) return { kind: 'invalid', error: 'price_low_invalid' };
  const currency = normaliseCurrency(form.priceCurrency);
  if (currency === null) return { kind: 'invalid', error: 'price_currency_invalid' };
  const highRaw = form.priceHigh.trim();
  let high_e7 = low_e7;
  if (highRaw.length > 0) {
    const parsed = priceDisplayToE7(highRaw);
    if (parsed === null) return { kind: 'invalid', error: 'price_high_invalid' };
    if (parsed < low_e7) return { kind: 'invalid', error: 'price_high_below_low' };
    high_e7 = parsed;
  }
  return {
    kind: 'ok',
    price: { low_e7, high_e7, currency, lastSeenMs: now() },
  };
}

// ─── TN-V2-META-005/006/003: closed-vocab tag fields ──────────────────────

/**
 * **TN-V2-META-005.** Closed compliance vocabulary. Tags surfaced as
 * filter chips and detail-page badges. Order = display order in the
 * picker. Deliberately small — additive labels for
 * regulator/dietary/age compliance; expand by deliberate enrichment
 * (no free-form input) so the filter chips stay scannable.
 */
export const COMPLIANCE_VOCABULARY: readonly string[] = [
  'halal',
  'kosher',
  'vegan',
  'vegetarian',
  'gluten_free',
  'dairy_free',
  'organic',
  'fair_trade',
  'fda_approved',
  'ce_marked',
  'rohs_compliant',
  'age_18_plus',
];

export const COMPLIANCE_LABEL: Readonly<Record<string, string>> = {
  halal: 'Halal',
  kosher: 'Kosher',
  vegan: 'Vegan',
  vegetarian: 'Vegetarian',
  gluten_free: 'Gluten-free',
  dairy_free: 'Dairy-free',
  organic: 'Organic',
  fair_trade: 'Fair trade',
  fda_approved: 'FDA approved',
  ce_marked: 'CE marked',
  rohs_compliant: 'RoHS',
  age_18_plus: '18+',
};

export const MAX_COMPLIANCE = 10;

/**
 * **TN-V2-META-006.** Closed accessibility vocabulary. Additive
 * (wheelchair AND captions AND audio-described on the same venue is
 * normal); the picker greys out unselected entries when the cap is
 * hit so the reviewer can't quietly drop a tag they care about.
 */
export const ACCESSIBILITY_VOCABULARY: readonly string[] = [
  'wheelchair',
  'step_free',
  'captions',
  'audio_described',
  'screen_reader',
  'sign_language',
  'large_print',
  'color_blind_safe',
  'quiet_hours',
  'service_animals',
  'reduced_lighting',
  'sensory_friendly',
];

export const ACCESSIBILITY_LABEL: Readonly<Record<string, string>> = {
  wheelchair: 'Wheelchair',
  step_free: 'Step-free',
  captions: 'Captions',
  audio_described: 'Audio described',
  screen_reader: 'Screen reader',
  sign_language: 'Sign language',
  large_print: 'Large print',
  color_blind_safe: 'Colour-blind safe',
  quiet_hours: 'Quiet hours',
  service_animals: 'Service animals',
  reduced_lighting: 'Reduced lighting',
  sensory_friendly: 'Sensory-friendly',
};

export const MAX_ACCESSIBILITY = 10;

/**
 * **TN-V2-META-003.** Closed compatibility vocabulary. Larger than
 * compliance/accessibility because devices stack many compat
 * surfaces (a laptop: macos + windows + thunderbolt-4 + usb-c +
 * bluetooth-5 + wifi-6e + … hits double digits before any
 * per-platform expansion).
 */
export const COMPAT_VOCABULARY: readonly string[] = [
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'web',
  'usb_c',
  'lightning',
  'thunderbolt_4',
  'bluetooth_5',
  'wifi_6',
  'wifi_6e',
  '110v',
  '240v',
  'apple_watch',
  'android_wear',
  'matter',
  'homekit',
  'google_home',
  'alexa',
];

export const COMPAT_LABEL: Readonly<Record<string, string>> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  web: 'Web',
  usb_c: 'USB-C',
  lightning: 'Lightning',
  thunderbolt_4: 'Thunderbolt 4',
  bluetooth_5: 'Bluetooth 5',
  wifi_6: 'Wi-Fi 6',
  wifi_6e: 'Wi-Fi 6E',
  '110v': '110V',
  '240v': '240V',
  apple_watch: 'Apple Watch',
  android_wear: 'Wear OS',
  matter: 'Matter',
  homekit: 'HomeKit',
  google_home: 'Google Home',
  alexa: 'Alexa',
};

export const MAX_COMPAT = 15;

/**
 * Generic toggle-tag-in-vocabulary helper used by compliance,
 * accessibility, compat, recommendFor, and notRecommendFor.
 * Mirrors {@link toggleUseCase} but with a per-call cap (each field
 * has its own limit). Tags not in `vocabulary` are silently dropped
 * to preserve the closed-vocab contract.
 *
 * Behaviour:
 *   - Tag present → remove.
 *   - Tag absent + under cap → add.
 *   - Tag absent + at cap → no-op (screen surfaces the cap visually
 *     by greying out unselected tags).
 *   - Tag not in vocabulary → no-op.
 */
export function toggleTagInVocabulary(
  current: readonly string[],
  tag: string,
  vocabulary: readonly string[],
  max: number,
): readonly string[] {
  if (!vocabulary.includes(tag)) return current;
  const idx = current.indexOf(tag);
  if (idx >= 0) {
    return [...current.slice(0, idx), ...current.slice(idx + 1)];
  }
  if (current.length >= max) return current;
  return [...current, tag];
}

// ─── TN-V2-REV-004: recommendFor / notRecommendFor ────────────────────────

/**
 * **TN-V2-REV-004.** Cap on each of `recommendFor` /
 * `notRecommendFor`. Five matches the AppView Zod bound — larger
 * lists become noise on the detail surface that renders them.
 */
export const MAX_RECOMMEND_FOR = 5;

// ─── TN-V2-META-001: availability ─────────────────────────────────────────

export const MAX_AVAILABILITY_REGIONS = 30;
export const MAX_AVAILABILITY_SOLD_AT = 20;

/**
 * Validate an ISO 3166-1 alpha-2 country code. Mirrors the AppView
 * Zod regex — the form rejects malformed codes at preflight so the
 * user sees the error inline instead of waiting for a server 400.
 *
 * Closed-vocab discipline lives on the writer; AppView treats the
 * code as opaque. We don't enforce the *closed list* of ~250 valid
 * codes here (would need a static table that drifts as
 * countries change) — only the *shape*.
 */
export function isPlausibleCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value.trim().toUpperCase());
}

/**
 * Add an ISO alpha-2 country code to a list (regions / shipsTo).
 * Trims + uppercases on the way in. Drops malformed codes and dups.
 * No-op when the cap is hit. Returns the input unchanged when
 * nothing changes.
 */
export function addCountryCode(
  current: readonly string[],
  raw: string,
  max: number = MAX_AVAILABILITY_REGIONS,
): readonly string[] {
  const upper = raw.trim().toUpperCase();
  if (!isPlausibleCountryCode(upper)) return current;
  if (current.includes(upper)) return current;
  if (current.length >= max) return current;
  return [...current, upper];
}

export function removeAtIndex<T>(current: readonly T[], index: number): readonly T[] {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    return current;
  }
  return [...current.slice(0, index), ...current.slice(index + 1)];
}

/**
 * Validate a hostname (RFC 1035 — labels of 1-63 chars, total ≤ 253,
 * letters / digits / hyphen, no leading/trailing hyphen per label).
 * Rejects URLs (`https://amazon.com` → false) — the soldAt list is
 * hostnames, not URLs, so the detail page can build links lazily.
 */
export function isPlausibleHostname(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0 || v.length > 253) return false;
  if (v.includes('://') || v.includes('/') || v.includes(' ')) return false;
  // Must contain at least one dot (top-level hostnames like 'localhost'
  // aren't useful retailer entries).
  if (!v.includes('.')) return false;
  const labels = v.split('.');
  return labels.every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

export function addHostname(
  current: readonly string[],
  raw: string,
  max: number = MAX_AVAILABILITY_SOLD_AT,
): readonly string[] {
  const lower = raw.trim().toLowerCase();
  if (!isPlausibleHostname(lower)) return current;
  if (current.includes(lower)) return current;
  if (current.length >= max) return current;
  return [...current, lower];
}

// ─── TN-V2-META-004: schedule ─────────────────────────────────────────────

/**
 * **TN-V2-META-004.** Lead-days bounds — mirrors the AppView Zod
 * range (`int().min(0).max(365)`). The form input is a string while
 * the user types; resolution to int happens at publish time. Empty
 * string = unset.
 */
export const SCHEDULE_LEAD_DAYS_MAX = 365;

/**
 * Parse a user-typed lead-days string. Returns `null` for non-integer
 * or out-of-range input. Empty string → `null` (the publish path
 * treats `null` as "unset" and omits the field).
 */
export function parseLeadDays(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > SCHEDULE_LEAD_DAYS_MAX) return null;
  return n;
}

/**
 * Toggle a month (1-12) in the seasonal-months list. Out-of-range
 * months are no-ops.
 */
export function toggleSeasonalMonth(
  current: readonly number[],
  month: number,
): readonly number[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) return current;
  const idx = current.indexOf(month);
  if (idx >= 0) {
    return [...current.slice(0, idx), ...current.slice(idx + 1)];
  }
  // Keep months sorted so the chip row renders in calendar order
  // regardless of selection sequence.
  return [...current, month].sort((a, b) => a - b);
}

export const SEASONAL_MONTH_LABEL: readonly string[] = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ─── TN-V2-REV-008: alternatives selector ─────────────────────────────────

/**
 * **TN-V2-REV-008.** A "the reviewer also tried" entry on a
 * Write-form draft. Mirrors the wire's `SubjectRef` shape, plus
 * an optional pre-resolved `subjectId` for picker-flow entries
 * (where the search xRPC returned a known subject). Entries
 * without `subjectId` go through the AppView subject-resolver at
 * publish time.
 *
 * Equality (used for de-duplication) is defined as: same
 * `subjectId` if both have one; otherwise same `kind` + same
 * normalised `name`. Free-form duplicates (two entries typed with
 * the same name) collapse to one.
 */
export interface ReviewAlternative {
  readonly kind: SubjectKind;
  readonly name: string;
  readonly subjectId?: string;
  readonly did?: string;
  readonly uri?: string;
  readonly identifier?: string;
}

/**
 * **TN-V2-REV-008.** Cap on alternatives a single review can carry.
 * Five fits comfortably in the publish payload + the Advanced
 * section's chip list, while leaving room for a meaningful "I tried
 * X, Y, Z, A, B before deciding on this one" comparison.
 */
export const MAX_REVIEW_ALTERNATIVES = 5;

/**
 * Add an alternative to the list. Pure helper:
 *   - Trims `name` (`'  Aeron  '` → `'Aeron'`).
 *   - Drops whitespace-only names (no anonymous chip).
 *   - De-duplicates: same `subjectId` (when both present), or same
 *     `kind` + case-insensitive `name`.
 *   - Caps at {@link MAX_REVIEW_ALTERNATIVES}; over-cap → no-op.
 *
 * Returns the input unchanged when nothing changes (drop, dup,
 * cap).
 */
export function addReviewAlternative(
  current: readonly ReviewAlternative[],
  entry: ReviewAlternative,
): readonly ReviewAlternative[] {
  const trimmedName = entry.name.trim();
  if (trimmedName.length === 0) return current;
  if (current.length >= MAX_REVIEW_ALTERNATIVES) return current;
  const normalised: ReviewAlternative = { ...entry, name: trimmedName };
  // Dup check.
  const key = alternativeKey(normalised);
  for (const existing of current) {
    if (alternativeKey(existing) === key) return current;
  }
  return [...current, normalised];
}

/**
 * Remove an alternative at the given index. Out-of-range indices
 * are no-ops.
 */
export function removeReviewAlternative(
  current: readonly ReviewAlternative[],
  index: number,
): readonly ReviewAlternative[] {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    return current;
  }
  return [...current.slice(0, index), ...current.slice(index + 1)];
}

/**
 * De-duplication key for a ReviewAlternative.
 * - With `subjectId`: that's the canonical id, use it.
 * - Without: case-insensitive `kind`+`name` so "Aeron Chair" and
 *   "AERON CHAIR" of the same kind collapse.
 *
 * Unexported — internal to the dedup logic.
 */
function alternativeKey(a: ReviewAlternative): string {
  if (typeof a.subjectId === 'string' && a.subjectId.length > 0) {
    return `id:${a.subjectId}`;
  }
  return `kn:${a.kind}:${a.name.trim().toLowerCase()}`;
}

// ─── TN-V2-REV-006: use-case picker ───────────────────────────────────────

/**
 * **TN-V2-REV-006.** Per-category use-case vocabulary. Keyed by the
 * FIRST segment of the slash-delimited category (`'tech/laptop'` →
 * `'tech'`); categories not in the map fall back to
 * {@link USE_CASES_DEFAULT}. Each list is intentionally short
 * (5-7 tags) so the chip row stays scannable.
 *
 * The vocabulary is **closed by category** for ranking discipline:
 * RANK-008's use-case-aware ranking depends on a stable tag set
 * server-side. A reviewer who types a freeform tag (`'great-for-cats'`)
 * gets ignored at scoring time. Free-form alternatives belong in
 * {@link recommendFor}/{@link notRecommendFor} (REV-004).
 *
 * Why per-category instead of one global list: "fiction" makes no
 * sense for laptops; "gaming" makes no sense for restaurants. Forcing
 * one menu would either flood every category or starve some of them.
 *
 * Keys are normalised lowercase; the lookup helper handles the case
 * conversion + slash-segmenting.
 */
export const USE_CASE_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  // Tech / electronics / software — work-vs-play axes.
  tech: ['everyday', 'professional', 'travel', 'gaming', 'creative'],
  technology: ['everyday', 'professional', 'travel', 'gaming', 'creative'],
  electronics: ['everyday', 'professional', 'travel', 'gaming', 'creative'],
  software: ['everyday', 'professional', 'creative', 'gaming'],
  // Books — what you read it for.
  book: ['fiction', 'nonfiction', 'reference', 'kids', 'travel'],
  books: ['fiction', 'nonfiction', 'reference', 'kids', 'travel'],
  // Restaurants / food — occasion + audience.
  restaurant: ['date_night', 'family', 'business', 'casual', 'late_night'],
  food: ['everyday', 'special_occasion', 'family', 'kids'],
  // Furniture — venue + endurance.
  office_furniture: ['home_office', 'office', 'long_hours'],
  furniture: ['everyday', 'kids', 'travel'],
};

/**
 * Fallback use-case list for categories not in
 * {@link USE_CASE_BY_CATEGORY}. Generic enough to apply to most
 * subject kinds without forcing freeform input — keeps the
 * closed-vocabulary contract intact.
 */
export const USE_CASES_DEFAULT: readonly string[] = [
  'everyday',
  'professional',
  'travel',
  'family',
  'kids',
];

/**
 * **TN-V2-REV-006.** Cap on simultaneously-selected use-case tags.
 * Three is the plan number — fits the chip row, prevents the user
 * from indiscriminately ticking every box (which would make the
 * tags useless as a ranking signal).
 */
export const MAX_USE_CASES = 3;

/**
 * Resolve the use-case vocabulary for a given category. Picks the
 * first slash-delimited segment, lowercases, and looks up the
 * table; falls back to {@link USE_CASES_DEFAULT} when the segment
 * isn't recognised. Empty / null categories also fall back.
 *
 * Pure helper, exported for the screen + tests.
 */
export function useCasesForCategory(
  category: string | null | undefined,
): readonly string[] {
  if (typeof category !== 'string' || category.trim().length === 0) {
    return USE_CASES_DEFAULT;
  }
  const head = category.trim().split('/')[0]?.toLowerCase() ?? '';
  return USE_CASE_BY_CATEGORY[head] ?? USE_CASES_DEFAULT;
}

/**
 * Toggle a tag in the use-cases list. If already present → remove;
 * if absent and under the cap → add; if absent and at the cap →
 * return the input unchanged (the screen surfaces the cap visually
 * by greying out unselected tags when length === MAX_USE_CASES).
 *
 * Tags not in the category's vocabulary are silently rejected —
 * preserves the closed-vocabulary contract regardless of how the
 * call site composed the tag (e.g. a category-change race that
 * hands an old tag to the new vocabulary).
 *
 * Pure helper — same input always produces the same output. The
 * screen mutator wraps this with `setState`.
 */
export function toggleUseCase(
  current: readonly string[],
  tag: string,
  vocabulary: readonly string[],
): readonly string[] {
  if (!vocabulary.includes(tag)) return current;
  const idx = current.indexOf(tag);
  if (idx >= 0) {
    return [...current.slice(0, idx), ...current.slice(idx + 1)];
  }
  if (current.length >= MAX_USE_CASES) return current;
  return [...current, tag];
}

/**
 * Human-readable label for a use-case tag. Inverse of the wire-side
 * snake_case (which AppView indexes as-is for ranking joins). The
 * label keeps the chip row readable.
 *
 * Single map covers ALL tags across categories — kept short + stable
 * since multiple categories share tags ("everyday", "kids", "travel"
 * appear in 3+ vocabularies).
 */
export const USE_CASE_LABEL: Readonly<Record<string, string>> = {
  everyday: 'Everyday',
  professional: 'Professional',
  travel: 'Travel',
  gaming: 'Gaming',
  creative: 'Creative',
  fiction: 'Fiction',
  nonfiction: 'Non-fiction',
  reference: 'Reference',
  kids: 'Kids',
  date_night: 'Date night',
  family: 'Family',
  business: 'Business',
  casual: 'Casual',
  late_night: 'Late night',
  special_occasion: 'Special occasion',
  home_office: 'Home office',
  office: 'Office',
  long_hours: 'Long hours',
};

/**
 * **TN-V2-REV-007.** Coarse "how recently did I use this?" buckets.
 * Order = display order (chronological — newest first). Six rows
 * fit the chip-row layout cleanly on a phone. Bucket boundaries
 * are tuned for the *signal* the badge surfaces ("is the review
 * still fresh?"), not for precise time-since-last-use.
 */
export type LastUsedBucket =
  | 'today'
  | 'past_week'
  | 'past_month'
  | 'past_6_months'
  | 'past_year'
  | 'over_a_year';

export const LAST_USED_BUCKETS: readonly LastUsedBucket[] = [
  'today',
  'past_week',
  'past_month',
  'past_6_months',
  'past_year',
  'over_a_year',
];

/** Human-readable bucket labels for the picker. */
export const LAST_USED_BUCKET_LABEL: Readonly<Record<LastUsedBucket, string>> = {
  today: 'Today',
  past_week: 'Past week',
  past_month: 'Past month',
  past_6_months: 'Past 6 months',
  past_year: 'Past year',
  over_a_year: 'Over a year ago',
};

/**
 * **TN-V2-REV-007.** Resolve a bucket → representative ms-since-
 * epoch for the wire record's `lastUsedMs` field.
 *
 * Each non-`today` bucket maps to the bucket's MIDPOINT (rough
 * centroid) — `past_week` resolves to "3 days ago" rather than
 * "exactly 7 days ago" or "exactly today". The midpoint is the
 * defensible reading: we're saying "somewhere in the past week",
 * not "exactly at the boundary".
 *
 * Pure helper — same `nowMs` always produces the same output.
 * Tests pin `nowMs` for stability.
 */
export function lastUsedMsForBucket(bucket: LastUsedBucket, nowMs: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  switch (bucket) {
    case 'today':
      return nowMs;
    case 'past_week':
      return nowMs - 3 * DAY;
    case 'past_month':
      return nowMs - 15 * DAY;
    case 'past_6_months':
      return nowMs - 3 * MONTH;
    case 'past_year':
      return nowMs - 6 * MONTH;
    case 'over_a_year':
      return nowMs - 2 * YEAR;
  }
}

/**
 * Per-kind subject input. The screen swaps the visible fields based on
 * `kind`, but the state shape is unified so a kind change doesn't
 * discard already-entered values (a user who types a name then picks
 * a different kind keeps the name).
 */
export interface WriteSubjectState {
  readonly kind: SubjectKind;
  readonly name: string;
  /** DID for `did` / `organization` subjects. */
  readonly did: string;
  /** URI for `content` / `dataset` subjects (often a URL). */
  readonly uri: string;
  /** Stable identifier for `product` / `claim` / `place`. */
  readonly identifier: string;
}

/**
 * Closed taxonomy of validation errors. Closed-enum lets the screen
 * exhaustive-switch the rendering — adding a new error class lights
 * up unhandled-case errors at every render site.
 */
export type WriteFormError =
  | 'headline_empty'
  | 'headline_too_long'
  | 'body_too_long'
  | 'sentiment_required'
  | 'confidence_required'
  | 'subject_name_required'
  | 'subject_name_too_long'
  | 'subject_did_required'
  | 'subject_did_invalid'
  | 'subject_uri_required'
  | 'subject_uri_invalid'
  | 'subject_identifier_required'
  | 'subject_identifier_too_long'
  | PriceFormError;

export interface WriteFormValidation {
  /** True when the form's current state can be published. */
  readonly canPublish: boolean;
  /** Per-field errors. Empty when the field is valid. */
  readonly errors: readonly WriteFormError[];
  /** Headline character count (bytes-of-UTF-16). Surfaced as "X / 140". */
  readonly headlineLength: number;
  /** Body character count. Surfaced as "X / 4000". */
  readonly bodyLength: number;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the empty initial state for a fresh compose flow.
 *
 * The screen passes this to its `useState`/store on mount when
 * starting a new review. For the EDIT flow the screen seeds the
 * state from the existing record's fields instead — `WriteFormState`
 * is the same shape either way.
 */
export function emptyWriteFormState(): WriteFormState {
  return {
    sentiment: null,
    headline: '',
    body: '',
    // Confidence is no longer surfaced in the form. We silently default
    // to 'moderate' so the wire record still carries a value (the
    // AppView search filter `minConfidence` and the legacy edit-mode
    // pre-fill path both expect a non-null value, and 'moderate' is
    // the neutral midpoint of the four-tier ladder). If a future
    // power-user surface re-introduces confidence as an opt-in, it
    // can override this default just like any other state field.
    confidence: 'moderate',
    subject: null,
    useCases: [],
    alternatives: [],
    lastUsedBucket: null,
    reviewerExperience: null,
    priceLow: '',
    priceHigh: '',
    priceCurrency: '',
    compliance: [],
    accessibility: [],
    compat: [],
    recommendFor: [],
    notRecommendFor: [],
  };
}

/**
 * Initial state when the user opens the form WITHOUT an existing
 * subjectId (the "describe a new item" path). The kind defaults to
 * `product` because that's the most common review target — the user
 * can pick another kind from the chip row.
 */
export function emptyWriteFormStateWithSubject(
  kind: SubjectKind = 'product',
): WriteFormState {
  return {
    ...emptyWriteFormState(),
    subject: emptySubjectState(kind),
  };
}

export function emptySubjectState(kind: SubjectKind): WriteSubjectState {
  return { kind, name: '', did: '', uri: '', identifier: '' };
}

/**
 * Validate the form. Pure, deterministic — call on every render
 * from a `useMemo` to drive the Publish button's disabled state and
 * the inline error labels.
 */
export function validateWriteForm(state: WriteFormState): WriteFormValidation {
  const errors: WriteFormError[] = [];
  const headline = state.headline.trim();
  const body = state.body.trim();

  if (headline.length === 0) errors.push('headline_empty');
  // Length cap uses the RAW value (untrimmed) — the user can see
  // their character count tick up exactly as they type.
  if (state.headline.length > HEADLINE_MAX_LENGTH) errors.push('headline_too_long');
  if (state.body.length > BODY_MAX_LENGTH) errors.push('body_too_long');
  if (state.sentiment === null) errors.push('sentiment_required');
  // Confidence is no longer required from the user; the form seeds it
  // to 'moderate'. The validator still flags `null` (defensive: a
  // mock state, an edit-mode pre-fill that explicitly clears it, or a
  // future power-user toggle that lets the field be cleared) so the
  // publish path's `confidence !== null` invariant stays load-bearing.
  if (state.confidence === null) errors.push('confidence_required');

  // Subject validation — only fires when the form is in
  // "describe a new subject" mode. Forms backed by an existing
  // subjectId leave `subject` null/undefined and skip these checks.
  // Treat undefined as null so legacy callers (tests with old-shape
  // `initial`, edit-mode payloads from the runner) keep working.
  if (state.subject != null) {
    errors.push(...validateSubjectState(state.subject));
  }

  // V2 price validation — only fires when the user has typed in the
  // low-price field. Empty `priceLow` means "field unset" — the
  // wire record omits the price block, so currency / high are
  // ignored. Mirrors the AppView Zod refines (cross-field
  // `low_e7 <= high_e7`, ISO 4217 alpha-3 currency).
  //
  // Defensive `??` against undefined: edit-mode + legacy callers
  // construct partial WriteFormState shapes (omitting V2 fields)
  // and rely on the validator treating those fields as "unset"
  // rather than throwing.
  const priceLow = state.priceLow ?? '';
  if (priceLow.trim().length > 0) {
    const resolved = priceFromForm({
      priceLow,
      priceHigh: state.priceHigh ?? '',
      priceCurrency: state.priceCurrency ?? '',
    });
    if (resolved.kind === 'invalid') errors.push(resolved.error);
  }

  // (scheduleLeadDays was dropped from the form — see WriteFormState
  // comment. The validator no longer fires `schedule_lead_days_invalid`
  // because there's no input that could carry an invalid value.)

  return {
    canPublish: errors.length === 0,
    errors,
    headlineLength: state.headline.length,
    bodyLength: body.length,
  };
}

/**
 * Per-kind subject validation. Returned errors are appended to the
 * outer form's error list so the screen renders them under the
 * relevant subject input.
 */
export function validateSubjectState(
  subject: WriteSubjectState,
): readonly WriteFormError[] {
  const errors: WriteFormError[] = [];
  const name = subject.name.trim();

  if (name.length === 0) errors.push('subject_name_required');
  if (subject.name.length > SUBJECT_NAME_MAX_LENGTH) errors.push('subject_name_too_long');

  switch (subject.kind) {
    case 'did':
      if (subject.did.trim().length === 0) errors.push('subject_did_required');
      else if (!isPlausibleDid(subject.did)) errors.push('subject_did_invalid');
      break;
    case 'organization':
      // Organization-level reviews don't strictly need a DID — a name
      // alone is fine (e.g. "Aeron Chairs" without a DID). If the user
      // does provide a DID, validate its shape.
      if (subject.did.trim().length > 0 && !isPlausibleDid(subject.did)) {
        errors.push('subject_did_invalid');
      }
      break;
    case 'content':
    case 'dataset':
      if (subject.uri.trim().length === 0) errors.push('subject_uri_required');
      else if (!isPlausibleUri(subject.uri)) errors.push('subject_uri_invalid');
      break;
    case 'product':
    case 'place':
    case 'claim':
      if (subject.identifier.length > SUBJECT_IDENTIFIER_MAX_LENGTH) {
        errors.push('subject_identifier_too_long');
      }
      // identifier is OPTIONAL for these kinds — name alone is enough
      // to disambiguate within AppView's hash-based subjectId.
      break;
  }
  return errors;
}

function isPlausibleDid(value: string): boolean {
  return /^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(value.trim());
}

function isPlausibleUri(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

/**
 * Human-readable label for a `WriteFormError`. Surfaced inline
 * under the affected field. Hard-coded en-only at this stage — the
 * keys are stable so a future i18n bundle lifts them out cleanly.
 */
export function describeWriteFormError(error: WriteFormError): string {
  switch (error) {
    case 'headline_empty':
      return 'A headline is required.';
    case 'headline_too_long':
      return `Headline must be ${HEADLINE_MAX_LENGTH} characters or fewer.`;
    case 'body_too_long':
      return `Body must be ${BODY_MAX_LENGTH} characters or fewer.`;
    case 'sentiment_required':
      return 'Choose a sentiment.';
    case 'confidence_required':
      return 'Choose a confidence level.';
    case 'subject_name_required':
      return 'Give the subject a name.';
    case 'subject_name_too_long':
      return `Name must be ${SUBJECT_NAME_MAX_LENGTH} characters or fewer.`;
    case 'subject_did_required':
      return 'Enter the subject’s DID (did:plc:… or did:web:…).';
    case 'subject_did_invalid':
      return 'That doesn’t look like a valid DID.';
    case 'subject_uri_required':
      return 'Enter the URL or AT-URI.';
    case 'subject_uri_invalid':
      return 'That URL or URI is malformed.';
    case 'subject_identifier_required':
      return 'An identifier is required.';
    case 'subject_identifier_too_long':
      return `Identifier must be ${SUBJECT_IDENTIFIER_MAX_LENGTH} characters or fewer.`;
    case 'price_low_invalid':
      return 'Enter a valid price (e.g. 29.99).';
    case 'price_high_invalid':
      return 'Enter a valid upper price, or leave blank for a single price.';
    case 'price_high_below_low':
      return 'Upper price must be at least as much as the lower price.';
    case 'price_currency_invalid':
      return 'Currency must be a 3-letter code (e.g. USD, EUR, GBP).';
  }
}

// ─── V2 wire-record serialization ─────────────────────────────────────────

/**
 * **TN-V2-MOBILE-WIRE.** Wire-shape extras the mobile compose form
 * adds to the base `com.dina.trust.attestation` record. Every field
 * is optional — only fields the reviewer actually populated travel
 * to the wire so AppView's empty-array → NULL collapse stays a
 * cheap server-side pass.
 *
 * Mirror of the V2 fields in `appview/src/shared/types/lexicon-types.ts`
 * Attestation. Kept structural (not nominal) so the publish path can
 * spread it onto the existing `record` object without an explicit
 * type cast — TypeScript structural-compat handles the merge.
 */
export interface AttestationV2Extras {
  useCases?: string[];
  lastUsedMs?: number;
  reviewerExperience?: ReviewerExperience;
  recommendFor?: string[];
  notRecommendFor?: string[];
  alternatives?: AlternativeWire[];
  compliance?: string[];
  accessibility?: string[];
  compat?: string[];
  price?: { low_e7: number; high_e7: number; currency: string; lastSeenMs: number };
  availability?: { regions?: string[]; shipsTo?: string[]; soldAt?: string[] };
  schedule?: { leadDays?: number; seasonal?: number[] };
}

/**
 * Wire-shape SubjectRef for an alternative entry. Mirrors the
 * AppView `subjectRefSchema` (the same shape `record.subject` rides
 * on). Kept here rather than imported from `appview_runtime` so this
 * data module stays runtime-free + jest-friendly.
 */
export interface AlternativeWire {
  type: SubjectKind;
  name?: string;
  did?: string;
  uri?: string;
  identifier?: string;
}

/**
 * Resolve a {@link WriteFormState} into the V2 extras the wire
 * record should carry. Fields the reviewer hasn't filled are simply
 * omitted (no empty arrays, no zero-valued objects). Pure helper —
 * deterministic given a fixed `now()`.
 *
 * Validation is the caller's job — call this only when the form
 * `canPublish` (passes {@link validateWriteForm}). On invalid input
 * (price.kind === 'invalid', leadDays unparseable) the helper
 * silently omits the field; this matches the contract that callers
 * gate publish on `canPublish` first.
 */
export function serializeFormToV2Extras(
  state: WriteFormState,
  now: () => number = Date.now,
): AttestationV2Extras {
  const out: AttestationV2Extras = {};

  if (state.useCases.length > 0) out.useCases = [...state.useCases];

  if (state.lastUsedBucket !== null) {
    out.lastUsedMs = lastUsedMsForBucket(state.lastUsedBucket, now());
  }

  if (state.reviewerExperience !== null) {
    out.reviewerExperience = state.reviewerExperience;
  }

  if (state.recommendFor.length > 0) out.recommendFor = [...state.recommendFor];
  if (state.notRecommendFor.length > 0) {
    out.notRecommendFor = [...state.notRecommendFor];
  }

  if (state.alternatives.length > 0) {
    out.alternatives = state.alternatives.map((a) => alternativeToWire(a));
  }

  if (state.compliance.length > 0) out.compliance = [...state.compliance];
  if (state.accessibility.length > 0) out.accessibility = [...state.accessibility];
  if (state.compat.length > 0) out.compat = [...state.compat];

  if (state.priceLow.trim().length > 0) {
    const resolved = priceFromForm(
      {
        priceLow: state.priceLow,
        priceHigh: state.priceHigh,
        priceCurrency: state.priceCurrency,
      },
      now,
    );
    if (resolved.kind === 'ok') out.price = resolved.price;
  }

  // availability + schedule are subject-owner facts, no longer
  // captured by the review form. The wire shape continues to accept
  // them (older records validate, AppView keeps indexing), but
  // serializeFormToV2Extras emits no `availability` / `schedule`
  // block because the form state has no fields to source them from.

  return out;
}

/**
 * Map a {@link ReviewAlternative} (form-state shape) into the wire
 * `SubjectRef` shape AppView's Zod expects. Empty fields are dropped
 * (matching `subjectStateToRef` in the screen's publish path).
 */
function alternativeToWire(a: ReviewAlternative): AlternativeWire {
  const out: AlternativeWire = { type: a.kind };
  if (a.name.trim().length > 0) out.name = a.name.trim();
  if (typeof a.did === 'string' && a.did.trim().length > 0) out.did = a.did.trim();
  if (typeof a.uri === 'string' && a.uri.trim().length > 0) out.uri = a.uri.trim();
  if (typeof a.identifier === 'string' && a.identifier.trim().length > 0) {
    out.identifier = a.identifier.trim();
  }
  return out;
}
