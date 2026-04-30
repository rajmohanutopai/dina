/**
 * Compose conflict-chooser tests (TN-MOB-024).
 *
 * Pins the three modes (`auto_match` / `create_new` / `pick_one`) +
 * the candidate ranking + the "none of these" terminal. Critical
 * regression guards:
 *
 *   - Mode classification doesn't drift across compose / edit /
 *     re-resolve flows because it's single-sourced.
 *   - Sort key is deterministic — same input → same output, no
 *     reshuffle between renders.
 *   - Malformed reviewCount (NaN, negative) doesn't poison the
 *     comparator (which would be nondeterministic in JS).
 *   - "None of these" is the LAST item so it's visually distinct
 *     from candidates.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  buildConflictChooser,
  type ChooserItem,
  type ChooserMode,
  type ConflictCandidate,
  type ResolveResult,
} from '../../src/trust/conflict_chooser';

import type { SubjectRef } from '@dina/protocol';

function candidate(
  subjectId: string,
  reviewCount: number,
  name = subjectId,
): ConflictCandidate {
  const subject: SubjectRef = { type: 'product', name };
  return { subjectId, subject, reviewCount };
}

function resolveResult(
  partial: Partial<ResolveResult> & { subjectId: string | null },
): ResolveResult {
  return {
    reviewCount: 0,
    lastAttestedAt: null,
    ...partial,
  };
}

// ─── auto_match ───────────────────────────────────────────────────────────

describe('buildConflictChooser — auto_match', () => {
  it('subjectId set → auto_match with full autoMatch payload', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: 'subj:abc',
        reviewCount: 14,
        lastAttestedAt: '2026-04-29T12:00:00Z',
      }),
    );
    expect(c.mode).toBe('auto_match');
    expect(c.autoMatch).toEqual({
      subjectId: 'subj:abc',
      reviewCount: 14,
      lastAttestedAt: '2026-04-29T12:00:00Z',
    });
    expect(c.items).toEqual([]);
  });

  it('subjectId set + conflicts present → still auto_match (canonical match wins)', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: 'subj:abc',
        reviewCount: 3,
        conflicts: [candidate('subj:other', 5)],
      }),
    );
    expect(c.mode).toBe('auto_match');
    expect(c.autoMatch?.subjectId).toBe('subj:abc');
    expect(c.items).toEqual([]); // candidates are NOT shown when subjectId is set
  });

  it('autoMatch.reviewCount clamps NaN/negative to 0 (sort-key consistency)', () => {
    const c = buildConflictChooser(
      resolveResult({ subjectId: 'subj:x', reviewCount: Number.NaN }),
    );
    expect(c.autoMatch?.reviewCount).toBe(0);
  });
});

// ─── create_new ───────────────────────────────────────────────────────────

describe('buildConflictChooser — create_new', () => {
  it('subjectId null + no conflicts → create_new', () => {
    const c = buildConflictChooser(resolveResult({ subjectId: null }));
    expect(c.mode).toBe('create_new');
    expect(c.items).toEqual([]);
    expect(c.autoMatch).toBeUndefined();
  });

  it('subjectId null + empty conflicts array → create_new (defensive)', () => {
    const c = buildConflictChooser(resolveResult({ subjectId: null, conflicts: [] }));
    expect(c.mode).toBe('create_new');
    expect(c.items).toEqual([]);
  });
});

// ─── pick_one ─────────────────────────────────────────────────────────────

describe('buildConflictChooser — pick_one', () => {
  it('subjectId null + non-empty conflicts → pick_one', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [candidate('a', 3), candidate('b', 7)],
      }),
    );
    expect(c.mode).toBe('pick_one');
    // Two candidates + "none of these" = 3 items
    expect(c.items).toHaveLength(3);
  });

  it('candidates ranked by reviewCount desc', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [candidate('a', 3), candidate('b', 7), candidate('c', 1)],
      }),
    );
    const ids = c.items
      .filter((i) => i.kind === 'candidate')
      .map((i) => (i.kind === 'candidate' ? i.candidate.subjectId : null));
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('breaks reviewCount ties by subjectId ascending (stable order)', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [candidate('zebra', 5), candidate('apple', 5), candidate('mango', 5)],
      }),
    );
    const ids = c.items
      .filter((i) => i.kind === 'candidate')
      .map((i) => (i.kind === 'candidate' ? i.candidate.subjectId : null));
    expect(ids).toEqual(['apple', 'mango', 'zebra']);
  });

  it('"none of these" is the LAST item', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [candidate('a', 1), candidate('b', 2)],
      }),
    );
    expect(c.items[c.items.length - 1]?.kind).toBe('none_of_these');
    for (let i = 0; i < c.items.length - 1; i++) {
      expect(c.items[i]?.kind).toBe('candidate');
    }
  });

  it('single-conflict (defensive — spec says "≥2" but UI handles 1) still renders', () => {
    const c = buildConflictChooser(
      resolveResult({ subjectId: null, conflicts: [candidate('only', 4)] }),
    );
    expect(c.mode).toBe('pick_one');
    expect(c.items).toHaveLength(2);
    expect(c.items[0]?.kind).toBe('candidate');
    expect(c.items[1]?.kind).toBe('none_of_these');
  });

  it('preserves the candidate object identity (no copying — screen reads subject directly)', () => {
    const original = candidate('a', 3);
    const c = buildConflictChooser(
      resolveResult({ subjectId: null, conflicts: [original] }),
    );
    const first = c.items[0];
    expect(first?.kind).toBe('candidate');
    if (first?.kind === 'candidate') {
      expect(first.candidate).toBe(original);
    }
  });
});

// ─── Defensive: malformed reviewCount ─────────────────────────────────────

describe('buildConflictChooser — malformed reviewCount', () => {
  it('NaN reviewCount sorts to the end without poisoning the comparator', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [
          candidate('good', 5),
          candidate('bad', Number.NaN),
          candidate('also_good', 2),
        ],
      }),
    );
    const candidates = c.items
      .filter((i) => i.kind === 'candidate')
      .map((i) => (i.kind === 'candidate' ? i.candidate.subjectId : null));
    expect(candidates[0]).toBe('good');
    expect(candidates[1]).toBe('also_good');
    expect(candidates[2]).toBe('bad');
  });

  it('negative reviewCount clamps to 0 (still surfaced — user may pick it)', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [candidate('a', -5), candidate('b', 0)],
      }),
    );
    const candidates = c.items
      .filter((i) => i.kind === 'candidate')
      .map((i) => (i.kind === 'candidate' ? i.candidate.subjectId : null));
    expect(candidates).toEqual(['a', 'b']);
    expect(c.mode).toBe('pick_one');
  });

  it('Infinity reviewCount clamps to 0 (no special "infinitely best" placement)', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [
          candidate('finite', 100),
          candidate('infinite', Number.POSITIVE_INFINITY),
        ],
      }),
    );
    const candidates = c.items
      .filter((i) => i.kind === 'candidate')
      .map((i) => (i.kind === 'candidate' ? i.candidate.subjectId : null));
    expect(candidates[0]).toBe('finite');
    expect(candidates[1]).toBe('infinite');
  });
});

// ─── Frozen invariants — every mode + every nested level ─────────────────
// The production code calls `Object.freeze` on the chooser, the items
// array, and (in auto_match) the nested autoMatch payload — but no
// test pinned this. A future refactor that dropped a freeze() (e.g.
// "performance optimisation: skip freeze in hot path") would silently
// regress the immutability contract. Two render sites consuming the
// SAME chooser reference (the chooser sheet + the form's pre-fill
// hook) rely on freeze to prevent one site from mutating shared state
// the other reads on the next render.
//
// Pin: every chooser returned, regardless of mode, is structurally
// frozen — top-level + every nested array/object accessible through
// the public surface — AND mutation attempts are silently no-op'd in
// sloppy mode / TypeError-thrown in strict mode.

describe('buildConflictChooser — frozen invariants', () => {
  it('auto_match: chooser + autoMatch are frozen', () => {
    const c = buildConflictChooser(
      resolveResult({ subjectId: 'subj:abc', reviewCount: 5 }),
    );
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.items)).toBe(true);
    expect(c.autoMatch).toBeDefined();
    expect(Object.isFrozen(c.autoMatch)).toBe(true);
  });

  it('create_new: chooser + items array are frozen', () => {
    const c = buildConflictChooser(resolveResult({ subjectId: null }));
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.items)).toBe(true);
  });

  it('pick_one: chooser + items array are frozen', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: null,
        conflicts: [candidate('a', 3), candidate('b', 1)],
      }),
    );
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.items)).toBe(true);
  });

  it('pick_one: items array cannot be push/pop/spliced (frozen array contract)', () => {
    // The freeze on the items ARRAY prevents a screen from
    // accidentally mutating the canonical chooser state — which would
    // poison every other consumer holding the same reference.
    const c = buildConflictChooser(
      resolveResult({ subjectId: null, conflicts: [candidate('a', 3)] }),
    );
    const lenBefore = c.items.length;
    try {
      // Casting away readonly to attempt the mutation a buggy caller
      // might write. In strict mode (Jest's default) this throws; in
      // sloppy mode it silently no-ops. Either way length is unchanged.
      (c.items as ChooserItem[]).push({ kind: 'none_of_these' });
    } catch {
      /* TypeError in strict mode is fine — freeze working as intended */
    }
    expect(c.items.length).toBe(lenBefore);
  });

  it('auto_match: autoMatch field reads are stable across mutation attempts', () => {
    const c = buildConflictChooser(
      resolveResult({
        subjectId: 'subj:abc',
        reviewCount: 14,
        lastAttestedAt: '2026-04-29T12:00:00Z',
      }),
    );
    const before = c.autoMatch?.subjectId;
    try {
      (c.autoMatch as { subjectId: string }).subjectId = 'subj:HACKED';
    } catch {
      /* strict-mode TypeError */
    }
    expect(c.autoMatch?.subjectId).toBe(before);
  });

  it('chooser top-level mode field is immutable (no rewriting after construction)', () => {
    const c = buildConflictChooser(resolveResult({ subjectId: null }));
    const before = c.mode;
    try {
      (c as { mode: ChooserMode }).mode = 'auto_match';
    } catch {
      /* strict-mode TypeError */
    }
    expect(c.mode).toBe(before);
  });

  it('two calls return DIFFERENT chooser objects (no accidental sharing across calls)', () => {
    // Even though both choosers are frozen, they MUST be distinct
    // objects — a future micro-optimisation that returned a cached
    // empty-items array would conflate render histories from
    // unrelated screens. Counter-pin: freeze means immutable, NOT
    // shared.
    const a = buildConflictChooser(resolveResult({ subjectId: null }));
    const b = buildConflictChooser(resolveResult({ subjectId: null }));
    expect(a).not.toBe(b);
  });
});
