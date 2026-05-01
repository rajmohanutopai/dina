/**
 * Render tests for the Languages + Accessibility settings screens
 * (TN-V2-CTX-004 + TN-V2-CTX-007).
 *
 * Both consumers wrap `MultiSelectScreen`. The shared component's
 * layout / a11y / toggle behaviour is pinned in
 * `multi_select_screen.test.tsx` — these tests focus on the
 * consumer-specific bits (option list shape, persistence, search
 * for languages).
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import AccessibilityScreen from '../../app/trust-preferences/accessibility';
import LanguagesScreen from '../../app/trust-preferences/languages';
import {
  loadUserPreferences,
  resetUserPreferencesForTest,
  saveUserPreferences,
} from '../../src/services/user_preferences';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

const ORIGINAL_INTL = global.Intl;

function stubLocale(localeStr: string): void {
  (global as any).Intl = {
    ...ORIGINAL_INTL,
    DateTimeFormat: function () {
      return { resolvedOptions: () => ({ locale: localeStr }) };
    },
    DisplayNames: ORIGINAL_INTL.DisplayNames,
    Collator: ORIGINAL_INTL.Collator,
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

// ─── Accessibility (CTX-007) ──────────────────────────────────────────────

describe('AccessibilityScreen — render', () => {
  it('renders all 4 accessibility tag options', () => {
    const { getByTestId } = render(<AccessibilityScreen />);
    expect(getByTestId('accessibility-row-wheelchair')).toBeTruthy();
    expect(getByTestId('accessibility-row-captions')).toBeTruthy();
    expect(getByTestId('accessibility-row-screen-reader')).toBeTruthy();
    expect(getByTestId('accessibility-row-color-blind-safe')).toBeTruthy();
  });

  it('shows checkmarks on currently-selected tags', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: ['wheelchair', 'screen-reader'],
    });
    const { getByTestId, queryByTestId } = render(<AccessibilityScreen />);
    await waitFor(() => {
      expect(getByTestId('accessibility-check-wheelchair')).toBeTruthy();
    });
    expect(getByTestId('accessibility-check-screen-reader')).toBeTruthy();
    expect(queryByTestId('accessibility-check-captions')).toBeNull();
  });

  it('does NOT render a search box (small-list mode)', () => {
    const { queryByTestId } = render(<AccessibilityScreen />);
    expect(queryByTestId('accessibility-search')).toBeNull();
  });
});

describe('AccessibilityScreen — toggle persists', () => {
  it('tapping a row toggles the value in the keystore', async () => {
    const { getByTestId } = render(<AccessibilityScreen />);
    await waitFor(() => {
      expect(getByTestId('accessibility-row-captions')).toBeTruthy();
    });
    fireEvent.press(getByTestId('accessibility-row-captions'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.accessibility).toEqual(['captions']);
    });
    // Toggle off.
    fireEvent.press(getByTestId('accessibility-row-captions'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.accessibility).toEqual([]);
    });
  });

  it('preserves other profile fields when toggling accessibility', async () => {
    await saveUserPreferences({
      region: 'GB',
      budget: { 'electronics/laptop': '$$' },
      devices: ['ios'],
      languages: ['en-GB'],
      dietary: ['vegan'],
      accessibility: [],
    });
    const { getByTestId } = render(<AccessibilityScreen />);
    await waitFor(() => {
      expect(getByTestId('accessibility-row-wheelchair')).toBeTruthy();
    });
    fireEvent.press(getByTestId('accessibility-row-wheelchair'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored).toEqual({
        region: 'GB',
        budget: { 'electronics/laptop': '$$' },
        devices: ['ios'],
        languages: ['en-GB'],
        dietary: ['vegan'],
        accessibility: ['wheelchair'],
      });
    });
  });
});

// ─── Languages (CTX-004) ──────────────────────────────────────────────────

describe('LanguagesScreen — render', () => {
  it('renders a search box (large-list mode)', () => {
    const { getByTestId } = render(<LanguagesScreen />);
    expect(getByTestId('languages-search')).toBeTruthy();
  });

  it('renders rows for canonical languages (en, fr, ja, zh-Hans)', async () => {
    const { getByTestId } = render(<LanguagesScreen />);
    await waitFor(() => {
      expect(getByTestId('languages-row-en')).toBeTruthy();
    });
    expect(getByTestId('languages-row-fr')).toBeTruthy();
    expect(getByTestId('languages-row-ja')).toBeTruthy();
    expect(getByTestId('languages-row-zh-Hans')).toBeTruthy();
  });

  it('shows checkmarks on currently-selected languages', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en', 'fr'],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId, queryByTestId } = render(<LanguagesScreen />);
    await waitFor(() => {
      expect(getByTestId('languages-check-en')).toBeTruthy();
    });
    expect(getByTestId('languages-check-fr')).toBeTruthy();
    expect(queryByTestId('languages-check-de')).toBeNull();
  });
});

describe('LanguagesScreen — search', () => {
  it('search filters the list to matching tags', () => {
    const { getByTestId, queryByTestId } = render(<LanguagesScreen />);
    fireEvent.changeText(getByTestId('languages-search'), 'french');
    expect(getByTestId('languages-row-fr')).toBeTruthy();
    expect(queryByTestId('languages-row-en')).toBeNull();
  });

  it('search matches on the BCP-47 tag (case-insensitive)', () => {
    const { getByTestId, queryByTestId } = render(<LanguagesScreen />);
    fireEvent.changeText(getByTestId('languages-search'), 'JA');
    expect(getByTestId('languages-row-ja')).toBeTruthy();
    expect(queryByTestId('languages-row-en')).toBeNull();
  });

  it('shows "No matches" when query has no results', () => {
    const { getByTestId, queryByText } = render(<LanguagesScreen />);
    fireEvent.changeText(getByTestId('languages-search'), 'xyzzy123');
    expect(getByTestId('languages-empty')).toBeTruthy();
    expect(queryByText(/No matches/)).toBeTruthy();
  });
});

describe('LanguagesScreen — toggle persists', () => {
  it('tapping a language row toggles it in the keystore', async () => {
    // Pre-seed empty languages so we don't have the device-default
    // "en-US" pre-checked. (Defaults are derived on first read; the
    // pre-seed forces an explicit empty list for this test.)
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<LanguagesScreen />);
    await waitFor(() => {
      expect(getByTestId('languages-row-fr')).toBeTruthy();
    });
    fireEvent.press(getByTestId('languages-row-fr'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.languages).toEqual(['fr']);
    });
  });

  it('preserves other profile fields when toggling languages', async () => {
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: ['ios'],
      languages: [],
      dietary: ['vegetarian'],
      accessibility: [],
    });
    const { getByTestId } = render(<LanguagesScreen />);
    await waitFor(() => {
      expect(getByTestId('languages-row-hi')).toBeTruthy();
    });
    fireEvent.press(getByTestId('languages-row-hi'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.region).toBe('IN');
      expect(stored.devices).toEqual(['ios']);
      expect(stored.dietary).toEqual(['vegetarian']);
      expect(stored.languages).toEqual(['hi']);
    });
  });

  it('rapid taps compose — no lost updates', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<LanguagesScreen />);
    await waitFor(() => {
      expect(getByTestId('languages-row-en')).toBeTruthy();
    });
    fireEvent.press(getByTestId('languages-row-en'));
    fireEvent.press(getByTestId('languages-row-fr'));
    fireEvent.press(getByTestId('languages-row-ja'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.languages).toEqual(['en', 'fr', 'ja']);
    });
  });
});

describe('LanguagesScreen + AccessibilityScreen — Loyalty Law', () => {
  it('toggling rows never reaches the network', async () => {
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      const { getByTestId: getLanguages } = render(<LanguagesScreen />);
      await waitFor(() => {
        expect(getLanguages('languages-row-en')).toBeTruthy();
      });
      fireEvent.press(getLanguages('languages-row-en'));

      const { getByTestId: getA11y } = render(<AccessibilityScreen />);
      await waitFor(() => {
        expect(getA11y('accessibility-row-wheelchair')).toBeTruthy();
      });
      fireEvent.press(getA11y('accessibility-row-wheelchair'));

      // Drain async writes.
      await waitFor(async () => {
        const stored = await loadUserPreferences();
        expect(stored.accessibility).toContain('wheelchair');
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });
});
