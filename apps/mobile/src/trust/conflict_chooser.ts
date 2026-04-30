/**
 * Compose-flow conflict-disambiguation chooser (TN-MOB-024).
 *
 * Per plan §6.3 + §8.5 step 1, the compose flow calls
 * `com.dina.trust.resolve` before publishing. AppView returns one of:
 *
 *   - `subjectId !== null`        — exact canonical match. The compose
 *                                   form pre-fills "Reviewing **<name>**
 *                                   — N reviewers".
 *   - `subjectId === null` and no
 *     `conflicts`                 — no candidate matched. The form
 *                                   shows "Creating new subject" and
 *                                   the user's draft `SubjectRef`
 *                                   gets published as-is.
 *   - `conflicts: [...]`           — ≥ 2 candidates partially matched
 *                                   (e.g. two "Aeron chair" entries
 *                                   with different identifiers). The
 *                                   user picks one or "None of these"
 *                                   (the latter degrades to "Creating
 *                                   new subject").
 *
 * This module owns the *data shape* the chooser screen renders.
 * Three concerns it pins:
 *
 *   1. Which mode the screen is in (auto-match / create-new / pick-one).
 *      Hard-coding the branch in the screen invites drift across the
 *      compose, edit, and re-resolve flows. One classifier here keeps
 *      the rule single-sourced.
 *
 *   2. Stable, ranked ordering of candidates. AppView's response order
 *      isn't a ranking — we rank by `reviewCount` (most-reviewed
 *      first, since that's the strongest "this is the canonical one"
 *      signal), with `subjectId` ascending as the tiebreak so the
 *      list doesn't reshuffle between renders.
 *
 *   3. The "None of these" terminal item. It's a UI primitive, not an
 *      AppView concept, so the data layer synthesises it as a
 *      separate `kind: 'none_of_these'` chooser item rather than
 *      letting every screen inject its own.
 *
 * Pure function, no state, runs under plain Jest. The screen layer
 * (write.tsx, when it lands) wraps this with the chooser sheet.
 */

import type { SubjectRef } from '@dina/protocol';

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * One candidate the AppView resolver suggests as a possible match.
 * Mirrors plan §6.3 — the wire shape comes from
 * `com.dina.trust.resolve` and is byte-stable across this module.
 */
export interface ConflictCandidate {
  readonly subjectId: string;
  readonly subject: SubjectRef;
  readonly reviewCount: number;
}

/**
 * The wire response from `com.dina.trust.resolve`. Mirrors plan §6.3
 * one-for-one — `lastAttestedAt` is included even though the chooser
 * doesn't read it directly so callers can pass the full response
 * through this module without losing fields the auto-match UX
 * needs (e.g. "last attested 3 days ago" subtext).
 */
export interface ResolveResult {
  readonly subjectId: string | null;
  readonly reviewCount: number;
  readonly lastAttestedAt: string | null;
  readonly conflicts?: readonly ConflictCandidate[];
}

/**
 * Which UX branch the chooser is in:
 *
 *   - `auto_match`  — `subjectId` is set; the form pre-fills with
 *                     the canonical subject.
 *   - `create_new`  — no candidates matched; the form publishes the
 *                     draft subject as-is.
 *   - `pick_one`    — multiple candidates; the user must choose.
 */
export type ChooserMode = 'auto_match' | 'create_new' | 'pick_one';

/**
 * One row in the chooser sheet. `kind: 'candidate'` carries the
 * candidate; `kind: 'none_of_these'` is the terminal "not in this
 * list" tap target.
 */
export type ChooserItem =
  | { readonly kind: 'candidate'; readonly candidate: ConflictCandidate }
  | { readonly kind: 'none_of_these' };

export interface ConflictChooser {
  readonly mode: ChooserMode;
  /**
   * The candidates + the "none of these" terminal, ranked. Empty
   * when `mode !== 'pick_one'` so screens can iterate
   * unconditionally.
   */
  readonly items: readonly ChooserItem[];
  /**
   * Populated only when `mode === 'auto_match'`. Carries the fields
   * the form's pre-fill path needs ("Reviewing X — N reviewers"
   * pill, "last attested 3d ago" subtext) so the screen doesn't have
   * to reach back into the raw resolve response.
   */
  readonly autoMatch?: {
    readonly subjectId: string;
    readonly reviewCount: number;
    readonly lastAttestedAt: string | null;
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the chooser data from an AppView resolve response.
 *
 * Mode rules (in priority order — first match wins):
 *
 *   1. `subjectId` set → `auto_match` (regardless of `conflicts`;
 *      AppView shouldn't return both, but if it does we honour the
 *      canonical match — that's the strongest signal).
 *   2. `conflicts` non-empty → `pick_one`.
 *   3. else → `create_new`.
 *
 * In `pick_one` mode, candidates are sorted:
 *   - by `reviewCount` desc (strongest "canonical" signal first)
 *   - then by `subjectId` asc (stable across renders)
 *
 * The "None of these" item is appended at the end so it's always
 * visually distinct from the candidate list.
 *
 * Negative or non-finite `reviewCount` clamps to `0` for sorting —
 * a malformed AppView row shouldn't poison the sort key, and the
 * candidate is still surfaced (the user can still pick it; AppView
 * might reject it on republish, but that's a downstream problem).
 */
export function buildConflictChooser(result: ResolveResult): ConflictChooser {
  if (result.subjectId !== null && result.subjectId !== undefined) {
    return Object.freeze({
      mode: 'auto_match' as const,
      items: Object.freeze([]) as readonly ChooserItem[],
      autoMatch: Object.freeze({
        subjectId: result.subjectId,
        reviewCount: sortKeyReviewCount(result.reviewCount),
        lastAttestedAt: result.lastAttestedAt,
      }),
    });
  }

  const conflicts = result.conflicts ?? [];
  if (conflicts.length === 0) {
    return Object.freeze({
      mode: 'create_new' as const,
      items: Object.freeze([]) as readonly ChooserItem[],
    });
  }

  const ranked = [...conflicts].sort((a, b) => {
    const ac = sortKeyReviewCount(a.reviewCount);
    const bc = sortKeyReviewCount(b.reviewCount);
    if (bc !== ac) return bc - ac;
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;
  });

  const items: ChooserItem[] = ranked.map((candidate) => ({
    kind: 'candidate',
    candidate,
  }));
  items.push({ kind: 'none_of_these' });

  return Object.freeze({
    mode: 'pick_one' as const,
    items: Object.freeze(items) as readonly ChooserItem[],
  });
}

// ─── Internal ─────────────────────────────────────────────────────────────

function sortKeyReviewCount(n: number): number {
  // Treat negative / non-finite as zero so they sort to the end of
  // the most-reviewed-first list rather than NaN-poisoning the
  // comparator (which produces nondeterministic order in JS).
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
