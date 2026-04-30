/**
 * Mobile-side trust UX helpers (TN-MOB-002 + TN-MOB-003).
 *
 * Thin facade over `@dina/protocol`'s canonical score-band + identifier
 * primitives. Mobile screens import from THIS module rather than
 * directly from protocol so:
 *   - the import surface is grouped with the rest of mobile's trust
 *     code (search.tsx, write.tsx, the trust feed)
 *   - we can layer mobile-specific concerns (theme colours, locale-
 *     formatted strings) without leaking them into the wire-format
 *     package
 *
 * The logic itself stays in `@dina/protocol` — this file just
 * re-exports + adds the rendering metadata that's React-specific.
 */

import {
  BAND_HIGH,
  BAND_LOW,
  BAND_MODERATE,
  trustBandFor,
  trustScoreDisplay,
  trustScoreLabel,
  type TrustBand,
} from '@dina/protocol';

// Re-export the protocol primitives so mobile screens have one
// import surface for "everything trust-display".
export {
  BAND_HIGH,
  BAND_LOW,
  BAND_MODERATE,
  trustBandFor,
  trustScoreDisplay,
  trustScoreLabel,
};
export type { TrustBand };

// TN-MOB-003: re-export the shared identifier parser so mobile
// compose flows can `import { parseIdentifier } from
// '../trust/score_helpers'` rather than reaching into protocol.
// (The parser doesn't actually live in score_helpers conceptually —
//  it's grouped here as the Trust-tab utility surface; future
//  refactor may split it into its own file when more identifier
//  helpers land.)
export {
  parseIdentifier,
  parseAsin,
  parseDoi,
  parseArxiv,
  parseIsbn13,
  parseIsbn10,
  parseEan13,
  parseUpc,
  parsePlaceId,
} from '@dina/protocol';
export type { IdentifierType, ParsedIdentifier } from '@dina/protocol';

// ── Mobile-specific UX overlays ────────────────────────────────────

/**
 * Human-friendly band label for a `TrustBand`.
 *
 * Why a separate function (vs. just using the band literal): the
 * Trust feed renders these in card headers and the strings need to
 * be capitalised + occasionally pluralised differently from the
 * machine-readable enum. Future i18n hooks land here.
 */
export function bandDisplayName(band: TrustBand): string {
  switch (band) {
    case 'high':
      return 'High trust';
    case 'moderate':
      return 'Moderate trust';
    case 'low':
      return 'Low trust';
    case 'very-low':
      return 'Very low trust';
    case 'unrated':
      return 'Unrated';
  }
}

/**
 * Stable token a styling layer can map to a colour. Returning a
 * token (not a hex / Tailwind class) keeps theme details out of
 * this file — the mobile theme system maps `success` / `caution`
 * etc. to actual paint via its own token table.
 *
 * Mapping (matches the Anti-Dark-Pattern principle in plan §13.1 —
 * "low trust" reads warning, not danger; "very low trust" reads
 * danger so users notice it):
 *   high      → success    (green)
 *   moderate  → neutral    (text colour)
 *   low       → caution    (amber)
 *   very-low  → danger     (red)
 *   unrated   → muted      (grey)
 */
export type TrustBandToken = 'success' | 'neutral' | 'caution' | 'danger' | 'muted';

export function bandColorToken(band: TrustBand): TrustBandToken {
  switch (band) {
    case 'high':
      return 'success';
    case 'moderate':
      return 'neutral';
    case 'low':
      return 'caution';
    case 'very-low':
      return 'danger';
    case 'unrated':
      return 'muted';
  }
}

/**
 * One-shot helper for "given a wire score, return everything a
 * card needs to render the trust pill". Cuts down on the
 * 3-call boilerplate at every render site.
 */
export interface TrustDisplay {
  /** Integer 0–100 for `<Text>{display}</Text>`, or `null` when unrated. */
  score: number | null;
  /** "78" or "—" — pre-formatted string ready for `<Text>`. */
  label: string;
  /** Coarse category label like "Moderate trust". */
  bandName: string;
  /** Machine-readable band for branching logic. */
  band: TrustBand;
  /** Theme-token name the styling layer maps to a paint colour. */
  colorToken: TrustBandToken;
}

export function trustDisplayFor(score: number | null | undefined): TrustDisplay {
  const band = trustBandFor(score);
  return {
    score: trustScoreDisplay(score),
    label: trustScoreLabel(score),
    bandName: bandDisplayName(band),
    band,
    colorToken: bandColorToken(band),
  };
}
