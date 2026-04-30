/**
 * Loading skeletons data-layer tests (TN-MOB-029).
 *
 * Pins the contract that the Trust tab feed, subject-detail rail,
 * and search-results screen all share:
 *
 *   - First-viewport row counts (4 subjects, 6 reviewers — plan §8.4).
 *   - Stable React keys per row (`skeleton-<surface>-<index>`).
 *   - Identity-stable factory output (same reference across calls
 *     when no count override) — keeps React's reconciler from
 *     re-allocating on every shimmer frame.
 *   - Frozen at every level so a renderer can't mutate the shared
 *     array.
 *   - `selectSkeletonOrData` discriminator: data-wins-over-loading
 *     (background refetches don't flicker back to skeleton).
 *   - Count validation rejects non-integers / negatives / non-numbers.
 *
 * Pure-function tests — runs under plain Jest, no RN deps.
 */

import {
  REVIEWER_LIST_SKELETON_COUNT,
  SUBJECT_LIST_SKELETON_COUNT,
  buildReviewerListSkeleton,
  buildSubjectListSkeleton,
  selectSkeletonOrData,
  type SubjectCardSkeletonRow,
} from '../../src/trust/skeletons';

// ─── Default counts ──────────────────────────────────────────────────────

describe('skeleton counts — plan §8.4 first-viewport tuning', () => {
  it('subject-list default count is 4 (plan §8.4)', () => {
    // Pinning the constant defends against silent UX drift if a
    // future refactor bumps it without updating the plan reference.
    expect(SUBJECT_LIST_SKELETON_COUNT).toBe(4);
  });

  it('reviewer-list default count is 6 (plan §8.4)', () => {
    expect(REVIEWER_LIST_SKELETON_COUNT).toBe(6);
  });

  it('default-call uses the constant counts', () => {
    expect(buildSubjectListSkeleton()).toHaveLength(SUBJECT_LIST_SKELETON_COUNT);
    expect(buildReviewerListSkeleton()).toHaveLength(REVIEWER_LIST_SKELETON_COUNT);
  });
});

// ─── Row shape ───────────────────────────────────────────────────────────

describe('skeleton row shape', () => {
  it('subject rows have stable React keys with a per-surface prefix', () => {
    const rows = buildSubjectListSkeleton();
    expect(rows[0]?.id).toBe('skeleton-subject-0');
    expect(rows[1]?.id).toBe('skeleton-subject-1');
    // No collision with the reviewer surface — separate prefixes
    // matter when the screen lays both kinds in one FlatList.
    expect(rows[0]?.id).not.toEqual(buildReviewerListSkeleton()[0]?.id);
  });

  it('reviewer rows have their own prefix', () => {
    const rows = buildReviewerListSkeleton();
    expect(rows[0]?.id).toBe('skeleton-reviewer-0');
  });

  it('every row carries kind === "skeleton" so the renderer can branch', () => {
    for (const r of buildSubjectListSkeleton()) {
      expect(r.kind).toBe('skeleton');
    }
    for (const r of buildReviewerListSkeleton()) {
      expect(r.kind).toBe('skeleton');
    }
  });

  it('row order is deterministic 0..N-1', () => {
    const rows = buildSubjectListSkeleton(7);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([
      'skeleton-subject-0',
      'skeleton-subject-1',
      'skeleton-subject-2',
      'skeleton-subject-3',
      'skeleton-subject-4',
      'skeleton-subject-5',
      'skeleton-subject-6',
    ]);
  });
});

// ─── Identity stability ──────────────────────────────────────────────────

describe('factory identity stability — reconciler short-circuit', () => {
  // React's reconciler short-circuits when the prop reference is
  // identical to the previous render. Re-allocating a fresh array on
  // every loading frame defeats that optimisation. We pin the
  // identity-stable contract here.
  it('default-call returns the same reference every time', () => {
    expect(buildSubjectListSkeleton()).toBe(buildSubjectListSkeleton());
    expect(buildReviewerListSkeleton()).toBe(buildReviewerListSkeleton());
  });

  it('count-override allocates fresh (caller is asking for a non-default)', () => {
    // Non-default counts are screen-specific (a drawer, a modal); we
    // don't cache them. The shape contract still holds.
    expect(buildSubjectListSkeleton(3)).not.toBe(buildSubjectListSkeleton(3));
  });

  it('count-override === default-count still returns a fresh array (no auto-canonicalisation)', () => {
    // The override path is documented as "fresh" — short-circuiting
    // an explicit `count: 4` to the cached default would be cute but
    // surprising for a caller who passed the count deliberately.
    expect(buildSubjectListSkeleton(SUBJECT_LIST_SKELETON_COUNT)).not.toBe(
      buildSubjectListSkeleton(),
    );
  });
});

// ─── Frozen arrays / rows ────────────────────────────────────────────────

describe('skeleton — frozen at every level', () => {
  it('top-level array is frozen (cannot push or splice)', () => {
    const rows = buildSubjectListSkeleton();
    expect(Object.isFrozen(rows)).toBe(true);
    expect(() => {
      // @ts-expect-error — runtime defensive check
      rows.push({ id: 'x', kind: 'skeleton' });
    }).toThrow(TypeError);
  });

  it('individual rows are frozen (cannot mutate the row object)', () => {
    const rows = buildSubjectListSkeleton();
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(() => {
      // @ts-expect-error — runtime defensive check
      rows[0].id = 'mutated';
    }).toThrow(TypeError);
  });

  it('count-override path returns frozen rows too', () => {
    const rows = buildReviewerListSkeleton(2);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });
});

// ─── Count validation ───────────────────────────────────────────────────

describe('count validation', () => {
  it('count = 0 produces an empty array (not an error — caller may want a no-op skeleton)', () => {
    expect(buildSubjectListSkeleton(0)).toEqual([]);
    expect(buildReviewerListSkeleton(0)).toEqual([]);
  });

  it('rejects negative counts', () => {
    expect(() => buildSubjectListSkeleton(-1)).toThrow(/non-negative/);
    expect(() => buildReviewerListSkeleton(-5)).toThrow(/non-negative/);
  });

  it('rejects non-integer counts', () => {
    expect(() => buildSubjectListSkeleton(2.5)).toThrow(/integer/);
  });

  it('rejects NaN', () => {
    expect(() => buildSubjectListSkeleton(NaN)).toThrow(/finite/);
  });

  it('rejects Infinity', () => {
    expect(() => buildSubjectListSkeleton(Infinity)).toThrow(/finite/);
  });

  it('rejects non-number types', () => {
    // @ts-expect-error — runtime guard
    expect(() => buildSubjectListSkeleton('4')).toThrow(/finite/);
    // @ts-expect-error — runtime guard
    expect(() => buildSubjectListSkeleton(null)).toThrow(/finite/);
  });
});

// ─── selectSkeletonOrData discriminator ─────────────────────────────────

describe('selectSkeletonOrData — render-branch discriminator', () => {
  const subjectSkeleton = buildSubjectListSkeleton();
  const realData: readonly SubjectCardSkeletonRow[] = [
    // Pretending these are real subject cards — same shape works
    // for the test, the discriminator doesn't introspect.
    { id: 'real-1', kind: 'skeleton' },
  ];

  it('data present + loading=false → kind: "data"', () => {
    const r = selectSkeletonOrData({
      loading: false,
      data: realData,
      skeleton: subjectSkeleton,
    });
    expect(r.kind).toBe('data');
    if (r.kind === 'data') expect(r.data).toBe(realData);
  });

  it('data present + loading=true (background refetch) → STILL kind: "data" (no flicker)', () => {
    // The "data wins" rule — once the user has seen real content, a
    // transient loading flag shouldn't snap them back to placeholders.
    const r = selectSkeletonOrData({
      loading: true,
      data: realData,
      skeleton: subjectSkeleton,
    });
    expect(r.kind).toBe('data');
  });

  it('data null + loading=true → kind: "skeleton"', () => {
    const r = selectSkeletonOrData({
      loading: true,
      data: null,
      skeleton: subjectSkeleton,
    });
    expect(r.kind).toBe('skeleton');
    if (r.kind === 'skeleton') expect(r.skeleton).toBe(subjectSkeleton);
  });

  it('data undefined + loading=true → kind: "skeleton" (undefined treated like null)', () => {
    const r = selectSkeletonOrData({
      loading: true,
      data: undefined,
      skeleton: subjectSkeleton,
    });
    expect(r.kind).toBe('skeleton');
  });

  it('data null + loading=false → kind: "skeleton" (pre-fetch initial state)', () => {
    // A null/undefined-data, not-loading state is "we never started
    // a fetch yet". Showing the skeleton keeps the screen visually
    // stable while the fetch kicks off; rendering empty here would
    // flicker once the load actually starts.
    const r = selectSkeletonOrData({
      loading: false,
      data: null,
      skeleton: subjectSkeleton,
    });
    expect(r.kind).toBe('skeleton');
  });

  it('genericity: works for any T (not pinned to skeleton row arrays)', () => {
    type Score = { value: number };
    const r = selectSkeletonOrData<Score>({
      loading: false,
      data: { value: 42 },
      skeleton: { value: 0 },
    });
    expect(r.kind).toBe('data');
    if (r.kind === 'data') expect(r.data.value).toBe(42);
  });

  it('result kinds are exclusive (typed discriminated union)', () => {
    const r = selectSkeletonOrData({
      loading: false,
      data: realData,
      skeleton: subjectSkeleton,
    });
    // TypeScript enforces this at compile time, but pin at runtime
    // too: a result either has `data` or `skeleton`, never both.
    if (r.kind === 'data') {
      expect('skeleton' in r).toBe(false);
    } else {
      expect('data' in r).toBe(false);
    }
  });
});

