/**
 * Viewer-preferences inference (TN-V2-CTX-009 follow-on / Loyalty Law
 * polish).
 *
 * Why this exists: the trust-network ranking layer reads
 * `useViewerPreferences()` for region / languages / devices / dietary
 * filters. Asking the user to type those into a 6-screen settings
 * flow is the kind of friction Dina is supposed to eliminate — Dina
 * already has the vault, the device locale, and the platform; she
 * should figure these out herself and let the user *correct* her,
 * not data-entry into her.
 *
 * This module is the inference engine. Pure function, deterministic
 * keyword-and-locale rules. No LLM call (yet — a Brain pass is a
 * follow-on if/when the keyword rules feel too crude). Runs once at
 * first hydration in `hydrateUserPreferences()`; subsequent launches
 * load the persisted row as today.
 *
 * Scope decisions:
 *
 *   - **Region** is already inferred from device locale by
 *     `defaultPreferences()`. We re-emit it here so a future change
 *     can route it through the same code path, but don't strengthen
 *     the signal beyond locale.
 *   - **Languages** — locale is the floor; vault-item BCP-47 detection
 *     could add more, but franc-min isn't bundled here. For v1 the
 *     locale's bcp47 tag is enough. (Follow-on: scan vault for
 *     non-locale languages the user actually reads.)
 *   - **Devices** — `Platform.OS` resolves to a single value. iPad
 *     bumps to `'ipad'` over `'ios'` so the ranker doesn't downrank
 *     iPad-native apps. macOS Catalyst → `'macos'`. Web build →
 *     `'web'`. We don't infer secondary devices from vault content
 *     (too noisy — "I emailed Linux package list" doesn't mean the
 *     user runs Linux).
 *   - **Dietary** — keyword scan over vault item text (headline +
 *     body preview). Conservative: only declare a tag when the user
 *     explicitly asserted it ("I'm vegan", not "vegan options").
 *     False positives are worse than false negatives — a wrong
 *     dietary filter mutes results the user wanted.
 *   - **Budget** — skipped. Tier inference per category needs harder
 *     reasoning (price points across many subjects); leaving as
 *     manual until the data justifies it.
 *   - **Accessibility** — skipped on purpose. Privacy-sensitive (a
 *     user's screen-reader / wheelchair status shouldn't leak into a
 *     filter from passive vault reading). Stays manual.
 *
 * The output is always a `Partial<UserPreferences>`. Fields the
 * inferer can't determine confidently are omitted, NOT defaulted —
 * the caller decides whether to fill from `defaultPreferences()` or
 * leave empty. This keeps the inferer single-purpose: signal
 * extraction, not policy.
 */

import type {
  DietaryTag,
  DeviceCompat,
  UserPreferences,
} from './user_preferences';

/**
 * Vault snapshot the inferer reads. Just the text fields it needs —
 * we don't pass the whole `VaultItemUI` shape so the inferer stays
 * unit-testable without a mock-vault dependency. The hydrate caller
 * is responsible for projecting `VaultItemUI` rows to this shape.
 */
export interface VaultEvidence {
  /** Display headline. Free-form text. */
  readonly headline: string;
  /** Body preview (first ~200 chars). May be empty. */
  readonly bodyPreview: string;
}

export interface InferenceContext {
  /** Vault items in display order (newest first; we don't sort). */
  readonly vaultItems: ReadonlyArray<VaultEvidence>;
  /** ISO 3166-1 alpha-2 from device locale, or null. */
  readonly localeRegion: string | null;
  /** BCP-47 language tag from device locale, or null. */
  readonly localeBcp47: string | null;
  /**
   * Resolved platform identity. The inferer is pure — the caller
   * resolves this from `Platform.OS` (or any other source) and
   * passes the value in. `undefined` means "no signal" and the
   * resulting `devices` array is omitted from the output.
   */
  readonly platform?: 'ios' | 'android' | 'macos' | 'web' | 'windows';
  /** True when the device is an iPad (drives `ios` → `ipad` upgrade). */
  readonly isIpad?: boolean;
}

/**
 * Run inference. Returns a partial preferences shape — fields with
 * insufficient signal are omitted entirely.
 */
export function inferPreferences(
  ctx: InferenceContext,
): Partial<UserPreferences> {
  // Build a mutable shape under a non-readonly type, then return as
  // the readonly Partial<UserPreferences>. The fields on
  // `UserPreferences` are `readonly`; assigning to them via index
  // expressions trips TS even when the object is brand new. The
  // local mutable type keeps the construction ergonomic.
  type Mutable = {
    -readonly [K in keyof UserPreferences]?: UserPreferences[K];
  };
  const out: Mutable = {};

  const region = inferRegion(ctx);
  if (region !== null) out.region = region;

  const languages = inferLanguages(ctx);
  if (languages.length > 0) out.languages = languages;

  const devices = inferDevices(ctx);
  if (devices.length > 0) out.devices = devices;

  const dietary = inferDietary(ctx.vaultItems);
  if (dietary.length > 0) out.dietary = dietary;

  return out;
}

// ─── Per-field inferers ──────────────────────────────────────────────────

function inferRegion(ctx: InferenceContext): string | null {
  // Locale is the only signal we trust here. A future revision can
  // cross-reference vault content (mailing addresses, "I live in…"
  // assertions) for users whose device locale lies about their
  // actual region.
  return ctx.localeRegion;
}

function inferLanguages(ctx: InferenceContext): string[] {
  // Floor: device locale's BCP-47. The settings screen can layer
  // additional languages on top once the user opens the screen and
  // multi-selects.
  if (ctx.localeBcp47 === null) return [];
  return [ctx.localeBcp47];
}

function inferDevices(ctx: InferenceContext): DeviceCompat[] {
  const platform = ctx.platform;
  const isIpad = ctx.isIpad ?? false;

  // The user is *on* this device right now. That's the strongest
  // possible signal — emit it. The ranker treats `devices` as an
  // include-list; a user who only set 'ios' still sees Android-only
  // results, just downranked. So broadening here doesn't hurt
  // downstream behaviour.
  if (platform === 'ios') {
    return isIpad ? ['ipad'] : ['ios'];
  }
  if (platform === 'macos') return ['macos'];
  if (platform === 'android') return ['android'];
  if (platform === 'windows') return ['windows'];
  if (platform === 'web') return ['web'];
  return [];
}

/**
 * Dietary-tag keyword set. Each tag → list of regex patterns the
 * user might have used to declare the constraint. Conservative
 * matching: we look for first-person assertions ("I'm vegan",
 * "I am gluten-free", "I follow halal"), NOT generic mentions of
 * the term. Avoiding false positives on phrases like "vegan options
 * available" or "halal restaurants nearby" keeps the inferer
 * trustworthy — a wrong filter mutes results the user actually
 * wanted to see.
 */
const DIETARY_PATTERNS: ReadonlyArray<{
  readonly tag: DietaryTag;
  readonly patterns: ReadonlyArray<RegExp>;
}> = [
  {
    tag: 'vegan',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) (?:a |an |strict(?:ly)? )?vegan\b/i,
      /\bi (?:eat|follow|am on) (?:a )?vegan\b/i,
      /\bgone vegan\b/i,
    ],
  },
  {
    tag: 'vegetarian',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) (?:a |strictly )?vegetarian\b/i,
      /\bi (?:eat|follow|am on) (?:a )?vegetarian\b/i,
    ],
  },
  {
    tag: 'halal',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) halal\b/i,
      /\bi (?:eat|follow|keep) halal\b/i,
      /\bi only eat halal\b/i,
    ],
  },
  {
    tag: 'kosher',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) kosher\b/i,
      /\bi (?:eat|keep|follow) kosher\b/i,
    ],
  },
  {
    tag: 'gluten-free',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) gluten[- ]free\b/i,
      /\bi (?:can['’ ]?t|cannot|don['’ ]?t) (?:eat|have) gluten\b/i,
      /\bcoeliac\b/i,
      /\bceliac\b/i,
    ],
  },
  {
    tag: 'dairy-free',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) (?:dairy[- ]free|lactose intolerant)\b/i,
      /\bi (?:can['’ ]?t|cannot) (?:eat|have|drink|do) (?:dairy|lactose|milk)\b/i,
    ],
  },
  {
    tag: 'nut-free',
    patterns: [
      /\b(?:i['’ ]?m|i am|i'm) (?:allergic to|nut[- ]free)\b.{0,20}\bnuts?\b/i,
      /\bnut allerg/i,
      /\bpeanut allerg/i,
    ],
  },
];

function inferDietary(items: ReadonlyArray<VaultEvidence>): DietaryTag[] {
  if (items.length === 0) return [];
  const seen = new Set<DietaryTag>();
  for (const item of items) {
    // Stop at the first match per item-and-tag — multiple matches
    // don't strengthen the signal here.
    const corpus = `${item.headline}\n${item.bodyPreview}`;
    for (const { tag, patterns } of DIETARY_PATTERNS) {
      if (seen.has(tag)) continue;
      for (const pattern of patterns) {
        if (pattern.test(corpus)) {
          seen.add(tag);
          break;
        }
      }
    }
    if (seen.size === DIETARY_PATTERNS.length) break;
  }
  // Stable order — alphabetical by tag value — so two runs over the
  // same corpus produce the exact same array (matters for the
  // hydrate path that compares "did anything change?").
  return Array.from(seen).sort();
}

