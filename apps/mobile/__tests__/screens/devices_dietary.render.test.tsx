/**
 * Render tests for the Devices + Dietary settings screens
 * (TN-V2-CTX-005 + TN-V2-CTX-006).
 *
 * Both consumers are thin wrappers around `MultiSelectScreen` —
 * the layout / a11y / toggle-fires-callback behaviour is pinned in
 * `multi_select_screen.test.tsx`. These tests focus on the
 * consumer-specific bits:
 *   - The right options render (and ONLY those).
 *   - Tapping a row writes through to the keystore via mutate().
 *   - Other profile fields are preserved when one row is toggled.
 *   - Rapid taps compose (race-safety pinned end-to-end via the screen).
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import DevicesScreen from '../../app/trust-preferences/devices';
import DietaryScreen from '../../app/trust-preferences/dietary';
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

// ─── Devices (CTX-005) ────────────────────────────────────────────────────

describe('DevicesScreen — render', () => {
  it('renders all 7 platform options', () => {
    const { getByTestId } = render(<DevicesScreen />);
    expect(getByTestId('devices-row-ios')).toBeTruthy();
    expect(getByTestId('devices-row-ipad')).toBeTruthy();
    expect(getByTestId('devices-row-android')).toBeTruthy();
    expect(getByTestId('devices-row-macos')).toBeTruthy();
    expect(getByTestId('devices-row-windows')).toBeTruthy();
    expect(getByTestId('devices-row-linux')).toBeTruthy();
    expect(getByTestId('devices-row-web')).toBeTruthy();
  });

  it('shows checkmarks on currently-selected devices', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: ['ios', 'macos'],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId, queryByTestId } = render(<DevicesScreen />);
    await waitFor(() => {
      expect(getByTestId('devices-check-ios')).toBeTruthy();
    });
    expect(getByTestId('devices-check-macos')).toBeTruthy();
    expect(queryByTestId('devices-check-android')).toBeNull();
  });
});

describe('DevicesScreen — toggle persists', () => {
  it('tapping an unselected row adds it to the keystore', async () => {
    const { getByTestId } = render(<DevicesScreen />);
    await waitFor(() => {
      expect(getByTestId('devices-row-ios')).toBeTruthy();
    });
    fireEvent.press(getByTestId('devices-row-ios'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.devices).toContain('ios');
    });
  });

  it('tapping a selected row removes it from the keystore', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: ['ios', 'android'],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<DevicesScreen />);
    await waitFor(() => {
      expect(getByTestId('devices-check-ios')).toBeTruthy();
    });
    fireEvent.press(getByTestId('devices-row-ios'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.devices).toEqual(['android']);
    });
  });

  it('preserves other profile fields when toggling devices', async () => {
    await saveUserPreferences({
      region: 'US',
      budget: { 'electronics/laptop': '$$$' },
      devices: [],
      languages: ['en-US'],
      dietary: ['vegan'],
      accessibility: ['screen-reader'],
    });
    const { getByTestId } = render(<DevicesScreen />);
    await waitFor(() => {
      expect(getByTestId('devices-row-ios')).toBeTruthy();
    });
    fireEvent.press(getByTestId('devices-row-ios'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored).toEqual({
        region: 'US',
        budget: { 'electronics/laptop': '$$$' },
        devices: ['ios'],
        languages: ['en-US'],
        dietary: ['vegan'],
        accessibility: ['screen-reader'],
      });
    });
  });

  it('rapid toggles compose — both updates land', async () => {
    // The motivating scenario for the mutate(updater) pattern. Rapid
    // taps in a single React event tick must NOT lose either update.
    const { getByTestId } = render(<DevicesScreen />);
    await waitFor(() => {
      expect(getByTestId('devices-row-ios')).toBeTruthy();
    });
    fireEvent.press(getByTestId('devices-row-ios'));
    fireEvent.press(getByTestId('devices-row-android'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.devices).toEqual(['ios', 'android']);
    });
  });
});

// ─── Dietary (CTX-006) ────────────────────────────────────────────────────

describe('DietaryScreen — render', () => {
  it('renders all 7 dietary options', () => {
    const { getByTestId } = render(<DietaryScreen />);
    expect(getByTestId('dietary-row-vegan')).toBeTruthy();
    expect(getByTestId('dietary-row-vegetarian')).toBeTruthy();
    expect(getByTestId('dietary-row-halal')).toBeTruthy();
    expect(getByTestId('dietary-row-kosher')).toBeTruthy();
    expect(getByTestId('dietary-row-gluten-free')).toBeTruthy();
    expect(getByTestId('dietary-row-dairy-free')).toBeTruthy();
    expect(getByTestId('dietary-row-nut-free')).toBeTruthy();
  });

  it('shows checkmarks on currently-selected tags', async () => {
    await saveUserPreferences({
      region: null,
      budget: {},
      devices: [],
      languages: [],
      dietary: ['vegan', 'gluten-free'],
      accessibility: [],
    });
    const { getByTestId, queryByTestId } = render(<DietaryScreen />);
    await waitFor(() => {
      expect(getByTestId('dietary-check-vegan')).toBeTruthy();
    });
    expect(getByTestId('dietary-check-gluten-free')).toBeTruthy();
    expect(queryByTestId('dietary-check-halal')).toBeNull();
  });
});

describe('DietaryScreen — toggle persists', () => {
  it('tapping a row toggles the value in the keystore', async () => {
    const { getByTestId } = render(<DietaryScreen />);
    await waitFor(() => {
      expect(getByTestId('dietary-row-vegan')).toBeTruthy();
    });
    fireEvent.press(getByTestId('dietary-row-vegan'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.dietary).toEqual(['vegan']);
    });
    // Toggle off.
    fireEvent.press(getByTestId('dietary-row-vegan'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.dietary).toEqual([]);
    });
  });

  it('preserves other profile fields when toggling dietary', async () => {
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: ['ios'],
      languages: ['en-IN'],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<DietaryScreen />);
    await waitFor(() => {
      expect(getByTestId('dietary-row-vegetarian')).toBeTruthy();
    });
    fireEvent.press(getByTestId('dietary-row-vegetarian'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.region).toBe('IN');
      expect(stored.devices).toEqual(['ios']);
      expect(stored.dietary).toEqual(['vegetarian']);
    });
  });
});

describe('DevicesScreen + DietaryScreen — Loyalty Law', () => {
  it('toggling a row never reaches the network', async () => {
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      const { getByTestId } = render(<DevicesScreen />);
      await waitFor(() => {
        expect(getByTestId('devices-row-ios')).toBeTruthy();
      });
      fireEvent.press(getByTestId('devices-row-ios'));
      await waitFor(async () => {
        const stored = await loadUserPreferences();
        expect(stored.devices).toContain('ios');
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });
});
