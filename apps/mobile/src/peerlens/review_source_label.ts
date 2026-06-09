/**
 * Chat source-pill copy for a resolved Dina answer.
 *
 * The ask coordinator stamps a `reviewsrc:<count>` token onto the message's
 * `sources` when network reviews from other Dinas informed the answer (see
 * `@dina/brain` ask_coordinator / coordinator_ask_handler). This turns that token
 * into the pill label, gated so we only CLAIM a ranking when there actually is
 * one:
 *   - count ≥ 3  → "Ranked reviews"   (a real ranking)
 *   - count 1–2  → "Network reviews"  (reviews, but no ranking claim)
 *   - count 0 / no token → null        (no pill)
 */

export const RANKED_MIN_REVIEWS = 3;

const TOKEN_PREFIX = 'reviewsrc:';

export function reviewSourceLabel(sources: readonly string[] | undefined): string | null {
  if (sources === undefined) return null;
  for (const s of sources) {
    if (!s.startsWith(TOKEN_PREFIX)) continue;
    const n = Number.parseInt(s.slice(TOKEN_PREFIX.length), 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= RANKED_MIN_REVIEWS ? 'Ranked reviews' : 'Network reviews';
  }
  return null;
}
