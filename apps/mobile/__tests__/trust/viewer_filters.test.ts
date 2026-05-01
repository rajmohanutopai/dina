/**
 * Tests for the viewer-profile filter predicate engine
 * (TN-V2-RANK-005 — `viewer_filters.ts`).
 *
 * Pins:
 *   - Filter table shape (one entry per ViewerFilterId, no dupes).
 *   - applicableFilters: returns the right subset given a profile.
 *   - applyFilters: AND-composition across active filters.
 *   - "Missing field = pass" contract on the language predicate.
 *   - Stub predicates pass everything (don't accidentally filter).
 *   - Pure functions: no input mutation.
 */

import {
  ALL_VIEWER_FILTERS,
  _LANGUAGE_FILTER_FOR_TEST,
  applicableFilters,
  applyFilters,
  type ViewerFilterId,
} from '../../src/trust/preferences/viewer_filters';
import type { SubjectCardDisplay } from '../../src/trust/subject_card';
import type { UserPreferences } from '../../src/services/user_preferences';

function makeProfile(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    region: null,
    budget: {},
    devices: [],
    languages: [],
    dietary: [],
    accessibility: [],
    ...overrides,
  };
}

function makeDisplay(overrides: Partial<SubjectCardDisplay> = {}): SubjectCardDisplay {
  return {
    title: 'Aeron chair',
    subtitle: null,
    host: null,
    language: null,
    location: null,
    priceTier: null,
    recency: null,
    regionPill: null,
    score: { score: 0.7, label: '70', bandName: 'High', band: 'high', colorToken: 'high' },
    showNumericScore: true,
    reviewCount: 5,
    friendsPill: null,
    topReviewer: null,
    ...overrides,
  };
}

function makeResult(id: string, display: SubjectCardDisplay) {
  return { subjectId: id, display };
}

describe('ALL_VIEWER_FILTERS — table shape', () => {
  it('has one entry per ViewerFilterId', () => {
    const ids: ViewerFilterId[] = [
      'languages',
      'region',
      'budget',
      'devices',
      'dietary',
      'accessibility',
    ];
    expect(ALL_VIEWER_FILTERS.map((f) => f.id)).toEqual(ids);
  });

  it('every entry has a non-empty label', () => {
    for (const f of ALL_VIEWER_FILTERS) {
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it('every entry has callable isApplicable + predicate', () => {
    for (const f of ALL_VIEWER_FILTERS) {
      expect(typeof f.isApplicable).toBe('function');
      expect(typeof f.predicate).toBe('function');
    }
  });
});

describe('applicableFilters — which chips render', () => {
  it('returns empty for a fully-default empty profile', () => {
    expect(applicableFilters(makeProfile())).toEqual([]);
  });

  it('returns the languages filter when languages are set', () => {
    const result = applicableFilters(makeProfile({ languages: ['en'] }));
    expect(result.map((f) => f.id)).toEqual(['languages']);
  });

  it('does NOT return stub-only filters even when their preference is set', () => {
    // Today, region/budget/devices/dietary/accessibility are stubs
    // with isApplicable=false. Setting the preference should NOT
    // resurrect them — they're hidden until META-* lands. This test
    // pins that contract so a future "I'll just enable them visually"
    // change has to also wire up a real predicate.
    const profile = makeProfile({
      region: 'US',
      languages: [],
      devices: ['ios'],
      dietary: ['vegan'],
      accessibility: ['wheelchair'],
    });
    expect(applicableFilters(profile)).toEqual([]);
  });

  it('returns the languages filter alongside others when both are set', () => {
    const result = applicableFilters(
      makeProfile({ languages: ['en'], region: 'US', devices: ['ios'] }),
    );
    // Only languages applies today; the other two are stubs.
    expect(result.map((f) => f.id)).toEqual(['languages']);
  });
});

describe('language predicate — "missing field = pass"', () => {
  const lang = _LANGUAGE_FILTER_FOR_TEST.predicate;

  it('passes a result with display.language=null even when viewer has preferences', () => {
    const profile = makeProfile({ languages: ['en'] });
    expect(lang(makeDisplay({ language: null }), profile)).toBe(true);
  });

  it('passes when subject language matches a viewer language exactly', () => {
    const profile = makeProfile({ languages: ['en'] });
    expect(lang(makeDisplay({ language: 'EN' }), profile)).toBe(true);
  });

  it('passes case-insensitively', () => {
    expect(
      lang(makeDisplay({ language: 'EN' }), makeProfile({ languages: ['EN'] })),
    ).toBe(true);
    expect(
      lang(makeDisplay({ language: 'en' }), makeProfile({ languages: ['EN-US'] })),
    ).toBe(true);
  });

  it('passes when viewer has en-US and subject has EN (subtag match)', () => {
    // Pinned: a viewer specifying en-US still wants results in en
    // because en doesn't carry region info — the subtag match is the
    // looser-but-correct behaviour for content language.
    const profile = makeProfile({ languages: ['en-US'] });
    expect(lang(makeDisplay({ language: 'EN' }), profile)).toBe(true);
  });

  it('passes when viewer has en and subject has en-US', () => {
    const profile = makeProfile({ languages: ['en'] });
    expect(lang(makeDisplay({ language: 'EN-US' }), profile)).toBe(true);
  });

  it('FAILS when subject language is set and does not match any viewer language', () => {
    const profile = makeProfile({ languages: ['en'] });
    expect(lang(makeDisplay({ language: 'PT-BR' }), profile)).toBe(false);
  });

  it('passes for any subject when viewer has no language preferences', () => {
    const profile = makeProfile({ languages: [] });
    expect(lang(makeDisplay({ language: 'PT-BR' }), profile)).toBe(true);
  });

  it('matches against multiple viewer languages — any match passes', () => {
    const profile = makeProfile({ languages: ['en', 'es', 'fr'] });
    expect(lang(makeDisplay({ language: 'ES' }), profile)).toBe(true);
    expect(lang(makeDisplay({ language: 'FR-CA' }), profile)).toBe(true);
    expect(lang(makeDisplay({ language: 'JA' }), profile)).toBe(false);
  });
});

describe('applyFilters — AND-composition + immutability', () => {
  const PROFILE = makeProfile({ languages: ['en'] });

  it('returns the input list when activeIds is empty (no filtering)', () => {
    const results = [
      makeResult('a', makeDisplay({ language: 'PT-BR' })),
      makeResult('b', makeDisplay({ language: 'ZH-HANS' })),
    ];
    const out = applyFilters(results, PROFILE, new Set());
    expect(out).toEqual(results);
  });

  it('filters out non-matching languages when languages chip is active', () => {
    const results = [
      makeResult('a', makeDisplay({ language: 'EN' })),
      makeResult('b', makeDisplay({ language: 'PT-BR' })),
      makeResult('c', makeDisplay({ language: null })), // unknown — passes
    ];
    const out = applyFilters(results, PROFILE, new Set(['languages']));
    expect(out.map((r) => r.subjectId)).toEqual(['a', 'c']);
  });

  it('multiple active filters compose with AND semantics', () => {
    // Both language AND a stub filter active: stub passes everything,
    // so result is the same as language-only.
    const results = [
      makeResult('a', makeDisplay({ language: 'EN' })),
      makeResult('b', makeDisplay({ language: 'PT-BR' })),
    ];
    const out = applyFilters(results, PROFILE, new Set(['languages', 'region']));
    expect(out.map((r) => r.subjectId)).toEqual(['a']);
  });

  it('does not mutate the input results array', () => {
    const results = [
      makeResult('a', makeDisplay({ language: 'EN' })),
      makeResult('b', makeDisplay({ language: 'PT-BR' })),
    ];
    const before = [...results];
    applyFilters(results, PROFILE, new Set(['languages']));
    expect(results).toEqual(before);
  });

  it('does not mutate the active set', () => {
    const active = new Set<ViewerFilterId>(['languages']);
    const before = new Set(active);
    applyFilters(
      [makeResult('a', makeDisplay({ language: 'EN' }))],
      PROFILE,
      active,
    );
    expect(active).toEqual(before);
  });
});

describe('stub filters — pass-all today', () => {
  it('region predicate passes any subject (stub until META-007)', () => {
    const region = ALL_VIEWER_FILTERS.find((f) => f.id === 'region')!;
    const profile = makeProfile({ region: 'US' });
    expect(region.predicate(makeDisplay({ host: 'amazon.de' }), profile)).toBe(true);
    expect(region.predicate(makeDisplay({ host: null }), profile)).toBe(true);
  });

  it('devices/budget/dietary/accessibility predicates also pass-all today', () => {
    const stubs = ['devices', 'budget', 'dietary', 'accessibility'] as const;
    for (const id of stubs) {
      const f = ALL_VIEWER_FILTERS.find((x) => x.id === id)!;
      expect(f.predicate(makeDisplay(), makeProfile())).toBe(true);
    }
  });
});
