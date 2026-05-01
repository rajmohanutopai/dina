/**
 * Render tests for the Region settings screen (TN-V2-CTX-002).
 *
 * Pins:
 *   - Auto row pinned at top, always visible.
 *   - Country list renders entries.
 *   - Tapping a row writes through `useViewerPreferences().save()`
 *     and pops back via expo-router.
 *   - Search filters the visible rows.
 *   - Currently-selected region shows the checkmark.
 *   - Loyalty Law: no fetch / network.
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import RegionScreen from '../../app/trust-preferences/region';
import {
  resetUserPreferencesForTest,
  saveUserPreferences,
} from '../../src/services/user_preferences';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

// Capture router.back calls so the test can assert pop-on-select.
let backCalls = 0;
jest.mock('expo-router', () => {
  const actual = jest.requireActual('../../__mocks__/expo-router');
  return {
    ...actual,
    useRouter: () => ({
      push: () => undefined,
      replace: () => undefined,
      back: () => {
        backCalls += 1;
      },
      canGoBack: () => true,
    }),
  };
});

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
  backCalls = 0;
});

afterEach(() => {
  (global as any).Intl = ORIGINAL_INTL;
});

describe('RegionScreen — render', () => {
  it('renders the Auto row pinned at the top', () => {
    const { getByTestId } = render(<RegionScreen />);
    expect(getByTestId('region-row-auto')).toBeTruthy();
  });

  it('shows the search input', () => {
    const { getByPlaceholderText } = render(<RegionScreen />);
    expect(getByPlaceholderText('Search countries')).toBeTruthy();
  });

  it('renders country rows for known anchors (US, GB, IN)', async () => {
    const { getByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-row-US')).toBeTruthy();
    });
    expect(getByTestId('region-row-GB')).toBeTruthy();
    expect(getByTestId('region-row-IN')).toBeTruthy();
  });

  it('shows the checkmark on the Auto row when region is null', async () => {
    // Default (post-hydration) is region="US" because device locale is
    // 'en-US'. Save explicit-null first to reproduce the auto state.
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: ['en-US'],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId, queryByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-check-auto')).toBeTruthy();
    });
    // No checkmark on US because we saved region=null.
    expect(queryByTestId('region-check-US')).toBeNull();
  });

  it('shows the checkmark on the selected country row', async () => {
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: [],
      languages: ['en-IN'],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId, queryByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-check-IN')).toBeTruthy();
    });
    expect(queryByTestId('region-check-auto')).toBeNull();
    expect(queryByTestId('region-check-US')).toBeNull();
  });
});

describe('RegionScreen — selection writes through', () => {
  it('tapping a country row saves the region and pops back', async () => {
    const { getByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-row-IN')).toBeTruthy();
    });

    fireEvent.press(getByTestId('region-row-IN'));

    // Wait for the async save to settle.
    await waitFor(() => {
      expect(backCalls).toBe(1);
    });
    // The keystore now has region=IN.
    const { loadUserPreferences } = await import('../../src/services/user_preferences');
    const stored = await loadUserPreferences();
    expect(stored.region).toBe('IN');
  });

  it('tapping the Auto row saves region=null', async () => {
    // Pre-seed with a non-null region.
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: [],
      languages: ['en-IN'],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-row-auto')).toBeTruthy();
    });

    fireEvent.press(getByTestId('region-row-auto'));

    await waitFor(() => {
      expect(backCalls).toBe(1);
    });
    const { loadUserPreferences } = await import('../../src/services/user_preferences');
    const stored = await loadUserPreferences();
    expect(stored.region).toBeNull();
  });

  it('selection preserves other profile fields (only region changes)', async () => {
    // Pre-seed with a fully-populated profile to make sure no other
    // fields get clobbered when we edit region.
    await saveUserPreferences({
      region: 'US',
      budget: { 'electronics/laptop': '$$$' },
      devices: ['ios', 'macos'],
      languages: ['en-US', 'es-MX'],
      dietary: ['vegan'],
      accessibility: ['screen-reader'],
    });
    const { getByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-row-MX')).toBeTruthy();
    });

    fireEvent.press(getByTestId('region-row-MX'));

    await waitFor(() => {
      expect(backCalls).toBe(1);
    });
    const { loadUserPreferences } = await import('../../src/services/user_preferences');
    const stored = await loadUserPreferences();
    expect(stored).toEqual({
      region: 'MX',
      budget: { 'electronics/laptop': '$$$' },
      devices: ['ios', 'macos'],
      languages: ['en-US', 'es-MX'],
      dietary: ['vegan'],
      accessibility: ['screen-reader'],
    });
  });
});

describe('RegionScreen — search', () => {
  it('typing a query filters the visible rows', async () => {
    const { getByPlaceholderText, queryByTestId, getByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-row-US')).toBeTruthy();
    });

    fireEvent.changeText(getByPlaceholderText('Search countries'), 'germ');

    await waitFor(() => {
      expect(getByTestId('region-row-DE')).toBeTruthy();
    });
    // US no longer in the visible list.
    expect(queryByTestId('region-row-US')).toBeNull();
  });

  it('Auto row stays visible regardless of query', async () => {
    const { getByPlaceholderText, getByTestId } = render(<RegionScreen />);
    await waitFor(() => {
      expect(getByTestId('region-row-US')).toBeTruthy();
    });
    // Type a query that matches no country.
    fireEvent.changeText(getByPlaceholderText('Search countries'), 'mars');
    // Auto row is rendered above the FlatList — search doesn't hide it.
    expect(getByTestId('region-row-auto')).toBeTruthy();
  });

  it('shows a placeholder when no countries match', async () => {
    const { getByPlaceholderText, queryByText } = render(<RegionScreen />);
    fireEvent.changeText(getByPlaceholderText('Search countries'), 'xyzzy');
    await waitFor(() => {
      expect(queryByText(/No countries match/)).toBeTruthy();
    });
  });

  it('matches by ISO code as well as display name', async () => {
    const { getByPlaceholderText, getByTestId } = render(<RegionScreen />);
    fireEvent.changeText(getByPlaceholderText('Search countries'), 'JP');
    await waitFor(() => {
      expect(getByTestId('region-row-JP')).toBeTruthy();
    });
  });
});

describe('RegionScreen — Loyalty Law', () => {
  it('selecting a row never reaches the network', async () => {
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      const { getByTestId } = render(<RegionScreen />);
      await waitFor(() => {
        expect(getByTestId('region-row-IN')).toBeTruthy();
      });
      fireEvent.press(getByTestId('region-row-IN'));
      await waitFor(() => {
        expect(backCalls).toBe(1);
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });
});
