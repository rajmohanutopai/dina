/**
 * Trust-band → display tokens (iter-53 DRY refactor).
 *
 * Three trust screens (subject card, subject detail, reviewer
 * profile) and one shared component (subject_card_view) all bind
 * `TrustBand` values to (a) a colour token from the theme palette and
 * (b) a human-readable label string. Until iter-53 each call site
 * re-declared its own `BAND_COLOUR: Record<TrustBand, string>` and
 * `BAND_LABEL: Record<TrustBand, string>` map — four copies of the
 * same data, drift-prone on every band change.
 *
 * One source of truth here means changing the band palette (e.g.,
 * swapping `colors.warning` for a custom amber token) lands at one
 * import. The label map is hard-coded en-only; future i18n lifts
 * the keys out of this file directly.
 *
 * Pure data, no React, zero runtime work — just two frozen maps.
 *
 * **Why a separate file rather than appending to `score_helpers.ts`**:
 * `score_helpers.ts` is the score-band derivation surface (pure
 * functions over numeric inputs). The colour / label PRESENTATION
 * tokens belong with the theme — they depend on `colors` from
 * `theme.ts`, which `score_helpers.ts` is deliberately decoupled
 * from (so the helpers can be exported to non-mobile consumers
 * unchanged). Splitting the presentation tokens into their own
 * module preserves that independence.
 */

import { colors } from '../theme';
import type { TrustBand } from './score_helpers';

/**
 * Theme colour applied to score badges + mini-bands per trust band.
 * Frozen so a caller mutating it crashes loudly rather than silently
 * corrupting the source of truth across all consumers.
 */
export const BAND_COLOUR: Readonly<Record<TrustBand, string>> = Object.freeze({
  high: colors.success,
  moderate: colors.accent,
  low: colors.warning,
  'very-low': colors.error,
  unrated: colors.textMuted,
});

/**
 * Display label rendered inside the badge when the band is the
 * primary signal (e.g., not enough attestations for a numeric
 * score per Plan §8.3.1's N≥3 rule, or accessibility labels).
 *
 * 'unrated' renders as an em-dash so consumers using `BAND_LABEL` to
 * stand in for "the score" produce visible-but-honest copy ("trust
 * —" rather than "trust UNRATED" which reads like a verdict).
 */
export const BAND_LABEL: Readonly<Record<TrustBand, string>> = Object.freeze({
  high: 'HIGH',
  moderate: 'MODERATE',
  low: 'LOW',
  'very-low': 'VERY LOW',
  unrated: '—',
});
