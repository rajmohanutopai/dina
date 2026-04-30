/**
 * Trust Network empty-state copy + classifier (TN-MOB-031).
 *
 * Three states are in scope per the plan:
 *
 *   - `no_results`    — the user ran a search and nothing came back.
 *   - `zero_reviews`  — a subject card opened with no reviews yet.
 *   - `no_contacts`   — the user's contact ring is empty, so trust
 *                       scores can't be weighted by people they know.
 *
 * Each state is a small bundle of `{title, body, action?}`. `action`
 * is `null` for `zero_reviews` on purpose: nudging a user to "be the
 * first to review" reads as engagement-bait, which conflicts with
 * Silence First. The screens decide whether to render an action — the
 * data layer doesn't synthesise one we don't have.
 *
 * Why a classifier? The same screen can have multiple plausible empty
 * states. A subject detail screen with no reviews could be either
 * `zero_reviews` or `no_contacts` depending on whether the viewer has
 * a contact ring. Hard-coding that branch in every screen invites
 * drift; doing it once in `classifyEmptyState` keeps the rule pinned.
 *
 * Returns `null` when the input isn't actually empty — screens can
 * call this unconditionally and only render the empty-state slot when
 * the result is non-null. That keeps the call site one branch instead
 * of two.
 *
 * This module is React-free: copy as data, classification as pure
 * function, tested under plain Jest. The screen layer wraps it with
 * its own theme tokens / icons / layout.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export type EmptyState = 'no_results' | 'zero_reviews' | 'no_contacts';

export interface EmptyStateContent {
  readonly title: string;
  readonly body: string;
  /**
   * The CTA label, or `null` when there is no honest action to offer.
   * `zero_reviews` deliberately has no CTA — see file-header note.
   */
  readonly action: string | null;
}

// ─── Copy ─────────────────────────────────────────────────────────────────

/**
 * Empty-state copy bundle. Frozen so a downstream caller can't mutate
 * the shared dict and corrupt every render site. The frozen wrapper
 * is the only way callers should be reading this — exposing the raw
 * Record would let a typo silently mutate the source of truth.
 */
export const EMPTY_STATE_CONTENT: Readonly<Record<EmptyState, EmptyStateContent>> = Object.freeze({
  no_results: Object.freeze({
    title: 'No results',
    body: 'Try different keywords, or remove a filter to broaden the search.',
    action: 'Adjust filters',
  }),
  zero_reviews: Object.freeze({
    title: 'No reviews yet',
    body: "Nobody in your network has reviewed this. As people you trust review it, you'll see their take here.",
    // No CTA: encouraging "be the first to review" reads as
    // engagement-bait. The publish flow is one tap away from the
    // header; we don't need to nudge.
    action: null,
  }),
  no_contacts: Object.freeze({
    title: 'No contacts in your trust ring',
    body: 'Trust scores are weighted by people you know. Add contacts to see what they trust.',
    action: 'Add a contact',
  }),
});

// ─── Classifier ───────────────────────────────────────────────────────────

/**
 * Discriminated input for the classifier. Each `kind` carries only
 * the metrics the corresponding screen actually needs to know about
 * — keeping the input type tight is what lets the classifier's branch
 * coverage be exhaustive.
 */
export type EmptyStateInput =
  | { readonly kind: 'search'; readonly resultCount: number }
  | {
      readonly kind: 'subject';
      readonly reviewCount: number;
      /** Size of the viewer's contact ring (1-hop). 0 means "no ring". */
      readonly viewerContactCount: number;
    }
  | { readonly kind: 'contacts'; readonly contactCount: number };

/**
 * Decide which empty state — if any — applies to the given screen
 * context. Returns `null` when the screen is non-empty.
 *
 * Branch table:
 *
 *   search:   resultCount === 0           → 'no_results'
 *   subject:  reviewCount === 0
 *               viewerContactCount === 0  → 'no_contacts'
 *               viewerContactCount  > 0   → 'zero_reviews'
 *   contacts: contactCount === 0          → 'no_contacts'
 *
 * Negative inputs are treated as zero — a caller passing `-1` for
 * "unknown count" should be told the same thing as "0 known".
 * Throwing here would force every call site to pre-clamp; collapsing
 * the case keeps the consumer code linear.
 */
export function classifyEmptyState(input: EmptyStateInput): EmptyState | null {
  switch (input.kind) {
    case 'search':
      return atOrBelowZero(input.resultCount) ? 'no_results' : null;

    case 'subject': {
      if (!atOrBelowZero(input.reviewCount)) return null;
      // No reviews: pick which empty story to tell. If the viewer has
      // contacts, the gap is "nobody you know has reviewed yet"
      // (zero_reviews); if they don't, the deeper issue is the missing
      // contact ring (no_contacts) and we surface that instead so they
      // get pointed at the actionable fix.
      return atOrBelowZero(input.viewerContactCount) ? 'no_contacts' : 'zero_reviews';
    }

    case 'contacts':
      return atOrBelowZero(input.contactCount) ? 'no_contacts' : null;
  }
}

/**
 * Convenience: classify, then look up the content. Returns `null`
 * when the screen is non-empty so callers can use a single
 * conditional render gate.
 */
export function emptyStateContentFor(input: EmptyStateInput): EmptyStateContent | null {
  const state = classifyEmptyState(input);
  return state === null ? null : EMPTY_STATE_CONTENT[state];
}

// ─── Internal ─────────────────────────────────────────────────────────────

function atOrBelowZero(n: number): boolean {
  // Defensive: NaN coerces to "no information, treat as empty" so a
  // bad input doesn't accidentally hide an empty state.
  return !Number.isFinite(n) || n <= 0;
}
