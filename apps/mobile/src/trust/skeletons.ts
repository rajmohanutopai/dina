/**
 * Loading skeletons data layer (TN-MOB-029).
 *
 * Plan §8.4:
 *
 *   > Trust-tab surfaces show shimmer placeholders during the initial
 *   > fetch. Subject card, reviewer list, and the spotlight band all
 *   > render skeleton-shaped rows so the layout doesn't pop in when
 *   > data arrives.
 *
 * This module owns the **shape** of those placeholders, not the
 * pixels:
 *
 *   - Number of placeholder rows per surface (subject-card list = 4,
 *     reviewer list = 6 — matches the plan's "first viewport"
 *     guidance so the skeleton fills the screen but doesn't push
 *     real data below the fold once it arrives).
 *   - The *shape* of one placeholder card (frozen, identity-stable
 *     so React's render reconciler doesn't re-allocate the array on
 *     every loading frame).
 *   - A `selectSkeletonOrData<T>` discriminator the screen calls
 *     once per render and switches on. Centralised so two screens
 *     never disagree about "still loading?" — they all pass through
 *     the same predicate.
 *
 * The shimmer animation itself is the screen layer's concern (RN
 * `Animated` API, theme tokens, dark/light variants). This module
 * emits zero RN deps so it tests under plain Jest.
 *
 * Why a separate module rather than a per-screen `SubjectCardSkeleton`
 * component:
 *   - The same skeleton row is used by the Trust tab feed, the
 *     subject-detail "related items" rail, and the search results
 *     screen. One canonical shape avoids drift.
 *   - Tests pin the row-count + shape so a future "let's bump
 *     subject-list to 5 placeholders" decision is a deliberate
 *     constant change, not silent UX drift on one of three surfaces.
 *   - The `selectSkeletonOrData` discriminator is the API the
 *     screens import — the screen never branches on
 *     `loading && !data` directly; it asks this module.
 */

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * One placeholder row on the subject-card list. The screen renders
 * shimmer rectangles where the title, subtitle, score, and reviewer
 * line would land. The data-layer concern is just *which* fields
 * exist (so React's keyed list can use the same shape pre/post
 * load) and the per-row id used as the React `key`.
 */
export interface SubjectCardSkeletonRow {
  /** Stable React key — `'skeleton-subject-<index>'`. */
  readonly id: string;
  /** Marker so the renderer can branch on `kind === 'skeleton'`. */
  readonly kind: 'skeleton';
}

/** Same shape for reviewer-list placeholders — separate id namespace. */
export interface ReviewerListSkeletonRow {
  readonly id: string;
  readonly kind: 'skeleton';
}

/**
 * Result of `selectSkeletonOrData`. Discriminated union so the
 * screen's render branch is `switch (result.kind)` — no boolean +
 * payload coupling that lets a refactor accidentally render shimmer
 * over real data or vice versa.
 */
export type SkeletonOrData<T> =
  | { readonly kind: 'skeleton'; readonly skeleton: T }
  | { readonly kind: 'data'; readonly data: T };

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * First-viewport row counts. Tuned in plan §8.4 to fill the screen
 * on a small phone (5.4") without pushing real data below the fold
 * once it arrives.
 */
export const SUBJECT_LIST_SKELETON_COUNT = 4;
export const REVIEWER_LIST_SKELETON_COUNT = 6;

/**
 * Pre-allocated frozen skeleton lists. Module-level constants so two
 * `buildSubjectListSkeleton()` calls return the SAME reference —
 * React's reconciler can short-circuit the diff when the prop
 * identity doesn't change between loading frames.
 */
const SUBJECT_LIST_SKELETON: readonly SubjectCardSkeletonRow[] = Object.freeze(
  Array.from({ length: SUBJECT_LIST_SKELETON_COUNT }, (_, i) =>
    Object.freeze({ id: `skeleton-subject-${i}`, kind: 'skeleton' as const }),
  ),
);

const REVIEWER_LIST_SKELETON: readonly ReviewerListSkeletonRow[] = Object.freeze(
  Array.from({ length: REVIEWER_LIST_SKELETON_COUNT }, (_, i) =>
    Object.freeze({ id: `skeleton-reviewer-${i}`, kind: 'skeleton' as const }),
  ),
);

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Return the canonical subject-list skeleton — a frozen array of N
 * placeholder rows with stable React keys. Identity-stable across
 * calls (same reference returned each time).
 *
 * Optional `count` override is for the rare screen that wants a
 * different first-viewport size (e.g., a half-height drawer that
 * only shows 2 placeholders). The default is the plan's tuned value.
 */
export function buildSubjectListSkeleton(
  count?: number,
): readonly SubjectCardSkeletonRow[] {
  if (count === undefined) return SUBJECT_LIST_SKELETON;
  validateCount(count, 'buildSubjectListSkeleton');
  return Object.freeze(
    Array.from({ length: count }, (_, i) =>
      Object.freeze({ id: `skeleton-subject-${i}`, kind: 'skeleton' as const }),
    ),
  );
}

/** Reviewer-list counterpart — same contract. */
export function buildReviewerListSkeleton(
  count?: number,
): readonly ReviewerListSkeletonRow[] {
  if (count === undefined) return REVIEWER_LIST_SKELETON;
  validateCount(count, 'buildReviewerListSkeleton');
  return Object.freeze(
    Array.from({ length: count }, (_, i) =>
      Object.freeze({ id: `skeleton-reviewer-${i}`, kind: 'skeleton' as const }),
    ),
  );
}

/**
 * Decide whether to render the skeleton or the real data.
 *
 * Rules (in order):
 *   - If `data` is non-null AND non-undefined → render data
 *     (regardless of the `loading` flag — once data has arrived the
 *     skeleton never returns, even on background refetches).
 *   - Else if `loading` is true → render skeleton.
 *   - Else (`!loading && data == null`) → render skeleton.
 *     A null/undefined-data, not-loading state is "we never started
 *     a fetch" — showing the skeleton keeps the screen visually
 *     stable while the fetch kicks off; an empty surface here would
 *     flicker once the load actually starts.
 *
 * Why "data wins over loading" rather than "loading wins": skeletons
 * during background refetches make the screen look stuck. Once the
 * user has seen real data, a transient `loading=true` shouldn't
 * reset their UI to placeholders.
 */
export function selectSkeletonOrData<T>(args: {
  readonly loading: boolean;
  readonly data: T | null | undefined;
  readonly skeleton: T;
}): SkeletonOrData<T> {
  if (args.data !== null && args.data !== undefined) {
    return { kind: 'data', data: args.data };
  }
  return { kind: 'skeleton', skeleton: args.skeleton };
}

// ─── Internal ────────────────────────────────────────────────────────────

function validateCount(count: number, fnName: string): void {
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error(`${fnName}: count must be a finite number`);
  }
  if (!Number.isInteger(count)) {
    throw new Error(`${fnName}: count must be an integer`);
  }
  if (count < 0) {
    throw new Error(`${fnName}: count must be non-negative`);
  }
}
