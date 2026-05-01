/**
 * End-to-end integration test for the viewer-profile filter chips
 * on the search screen (TN-V2-RANK-005).
 *
 * The pure data layer (predicate engine + chip-row component) is
 * tested separately. This file pins the SCREEN-level glue: the
 * `useViewerPreferences` hook ↔ chip-row ↔ `applyFilters` wiring
 * inside `app/trust/search.tsx`.
 *
 * One round-trip scenario:
 *   1. Pre-seed profile with `languages: ['en']`.
 *   2. Mount SearchScreen with mixed-language results.
 *   3. Assert chip is rendered (language preference is set).
 *   4. Assert all results visible (chip is OFF by default).
 *   5. Tap the chip.
 *   6. Assert only language-matching results visible.
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import SearchScreen from '../../app/trust/search';
import {
  resetUserPreferencesForTest,
  saveUserPreferences,
} from '../../src/services/user_preferences';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

import type { SubjectCardDisplay } from '../../src/trust/subject_card';
import type { FacetBar } from '../../src/trust/facets';

const ORIGINAL_INTL = global.Intl;

function stubLocale(localeStr: string): void {
  (global as any).Intl = {
    ...ORIGINAL_INTL,
    DateTimeFormat: function () {
      return { resolvedOptions: () => ({ locale: localeStr }) };
    },
  };
}

beforeEach(async () => {
  resetKeychainMock();
  await resetUserPreferencesForTest();
  stubLocale('en-US');
});

afterEach(() => {
  (global as any).Intl = ORIGINAL_INTL;
});

const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };

function makeDisplay(language: string | null): SubjectCardDisplay {
  return {
    title: 'Sample',
    subtitle: null,
    host: null,
    language,
    location: null,
    priceTier: null,
    recency: null,
    regionPill: null,
    score: { score: 0.7, label: '70', bandName: 'High', band: 'high', colorToken: 'high' },
    showNumericScore: true,
    reviewCount: 5,
    friendsPill: null,
    topReviewer: null,
  };
}

describe('SearchScreen — viewer-filter chip integration (TN-V2-RANK-005)', () => {
  it('renders the language chip when viewer has a language preference', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en'],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} />,
    );
    await waitFor(() => {
      expect(getByTestId('viewer-filter-chip-languages')).toBeTruthy();
    });
  });

  it('hides the chip row when no preferences are set', async () => {
    // Profile with only locale-defaults (no explicit user choice)
    // would still have languages=['en-US'] from the device locale,
    // so save an explicit-empty profile to test the empty case.
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { queryByTestId } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} />,
    );
    await waitFor(() => {
      // Container hidden because no chips apply.
      expect(queryByTestId('viewer-filter-chips')).toBeNull();
    });
  });

  it('does NOT filter results when chip is OFF (default state)', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en'],
      dietary: [],
      accessibility: [],
    });
    const results = [
      { subjectId: 's1', display: makeDisplay('EN') },
      { subjectId: 's2', display: makeDisplay('PT-BR') },
      { subjectId: 's3', display: makeDisplay(null) },
    ];
    const { getByTestId } = render(
      <SearchScreen results={results} facets={EMPTY_FACETS} />,
    );
    await waitFor(() => {
      expect(getByTestId('subject-card-s1')).toBeTruthy();
      expect(getByTestId('subject-card-s2')).toBeTruthy();
      expect(getByTestId('subject-card-s3')).toBeTruthy();
    });
  });

  it('filters results when chip is toggled ON, preserving missing-field passes', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en'],
      dietary: [],
      accessibility: [],
    });
    const results = [
      { subjectId: 's1', display: makeDisplay('EN') },     // viewer-language match
      { subjectId: 's2', display: makeDisplay('PT-BR') },  // mismatch — should be filtered
      { subjectId: 's3', display: makeDisplay(null) },     // unknown — passes per contract
    ];
    const { getByTestId, queryByTestId } = render(
      <SearchScreen results={results} facets={EMPTY_FACETS} />,
    );
    await waitFor(() => {
      expect(getByTestId('viewer-filter-chip-languages')).toBeTruthy();
    });

    fireEvent.press(getByTestId('viewer-filter-chip-languages'));

    await waitFor(() => {
      // EN match: still visible.
      expect(getByTestId('subject-card-s1')).toBeTruthy();
      // PT-BR mismatch: filtered out.
      expect(queryByTestId('subject-card-s2')).toBeNull();
      // null language: passes per "missing = pass" contract.
      expect(getByTestId('subject-card-s3')).toBeTruthy();
    });
  });

  it('toggling OFF the chip restores the unfiltered list', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en'],
      dietary: [],
      accessibility: [],
    });
    const results = [
      { subjectId: 's1', display: makeDisplay('EN') },
      { subjectId: 's2', display: makeDisplay('PT-BR') },
    ];
    const { getByTestId, queryByTestId } = render(
      <SearchScreen results={results} facets={EMPTY_FACETS} />,
    );
    await waitFor(() => {
      expect(getByTestId('viewer-filter-chip-languages')).toBeTruthy();
    });

    // Toggle ON.
    fireEvent.press(getByTestId('viewer-filter-chip-languages'));
    await waitFor(() => {
      expect(queryByTestId('subject-card-s2')).toBeNull();
    });

    // Toggle OFF.
    fireEvent.press(getByTestId('viewer-filter-chip-languages'));
    await waitFor(() => {
      expect(getByTestId('subject-card-s2')).toBeTruthy();
    });
  });

  it('chip toggle never reaches the network (Loyalty Law)', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en'],
      dietary: [],
      accessibility: [],
    });
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      const { getByTestId } = render(
        <SearchScreen
          results={[{ subjectId: 's1', display: makeDisplay('EN') }]}
          facets={EMPTY_FACETS}
        />,
      );
      await waitFor(() => {
        expect(getByTestId('viewer-filter-chip-languages')).toBeTruthy();
      });
      fireEvent.press(getByTestId('viewer-filter-chip-languages'));
      // Drain microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });
});
