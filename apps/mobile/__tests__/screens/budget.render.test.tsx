/**
 * Render tests for the Budget settings screen (TN-V2-CTX-003).
 *
 * Pins:
 *   - Curated category list shape (no dupes, all keys valid).
 *   - Each row renders a 4-segment radio group.
 *   - Selection mirrors `profile.budget[category]` (null = "None").
 *   - Tap a tier segment → mutates the budget map.
 *   - Tap "None" → deletes the category key entirely (not stores `null`).
 *   - Other budget categories preserved when one row changes.
 *   - Race-safety: rapid taps across categories compose.
 *   - a11y: row uses accessibilityRole="radiogroup", segments use "radio".
 *   - Loyalty Law: no fetch on segment press.
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import BudgetScreen from '../../app/trust-preferences/budget';
import {
  loadUserPreferences,
  resetUserPreferencesForTest,
  saveUserPreferences,
} from '../../src/services/user_preferences';
import {
  BUDGET_CATEGORIES,
  BUDGET_CATEGORY_KEYS,
} from '../../src/trust/preferences/budget_categories';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

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

describe('BUDGET_CATEGORIES — list shape', () => {
  it('every entry has a non-empty key + label', () => {
    for (const cat of BUDGET_CATEGORIES) {
      expect(cat.key.length).toBeGreaterThan(0);
      expect(cat.label.length).toBeGreaterThan(0);
    }
  });

  it('keys are unique (no duplicates)', () => {
    const seen = new Set<string>();
    for (const cat of BUDGET_CATEGORIES) {
      expect(seen.has(cat.key)).toBe(false);
      seen.add(cat.key);
    }
  });

  it('keys are slug-safe (lowercase, no spaces or special chars)', () => {
    for (const cat of BUDGET_CATEGORIES) {
      expect(cat.key).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });

  it('lookup set agrees with array', () => {
    expect(BUDGET_CATEGORY_KEYS.size).toBe(BUDGET_CATEGORIES.length);
    for (const cat of BUDGET_CATEGORIES) {
      expect(BUDGET_CATEGORY_KEYS.has(cat.key)).toBe(true);
    }
  });

  it('contains the canonical anchor categories', () => {
    const keys = new Set(BUDGET_CATEGORIES.map((c) => c.key));
    for (const expected of [
      'food',
      'electronics',
      'home',
      'travel',
      'clothing',
    ]) {
      expect(keys.has(expected)).toBe(true);
    }
  });
});

describe('BudgetScreen — render', () => {
  it('renders one row per curated category', () => {
    const { getByTestId } = render(<BudgetScreen />);
    for (const cat of BUDGET_CATEGORIES) {
      expect(getByTestId(`budget-segments-${cat.key}`)).toBeTruthy();
    }
  });

  it('renders the 4 segments (None / $ / $$ / $$$) per row', () => {
    const { getByTestId } = render(<BudgetScreen />);
    expect(getByTestId('budget-segment-electronics-none')).toBeTruthy();
    expect(getByTestId('budget-segment-electronics-tier-1')).toBeTruthy();
    expect(getByTestId('budget-segment-electronics-tier-2')).toBeTruthy();
    expect(getByTestId('budget-segment-electronics-tier-3')).toBeTruthy();
  });

  it('selects "None" by default for every category', async () => {
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(getByTestId('budget-segments-electronics')).toBeTruthy();
    });
    // None segment carries accessibilityState.selected = true on a
    // category with no stored tier.
    const none = getByTestId('budget-segment-electronics-none');
    expect(none.props.accessibilityState.selected).toBe(true);
    const tier1 = getByTestId('budget-segment-electronics-tier-1');
    expect(tier1.props.accessibilityState.selected).toBe(false);
  });

  it('reflects a stored tier on the corresponding segment', async () => {
    await saveUserPreferences({
      region: null,
      budget: { electronics: '$$', food: '$$$' },
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(
        getByTestId('budget-segment-electronics-tier-2').props.accessibilityState.selected,
      ).toBe(true);
    });
    expect(
      getByTestId('budget-segment-electronics-none').props.accessibilityState.selected,
    ).toBe(false);
    expect(
      getByTestId('budget-segment-food-tier-3').props.accessibilityState.selected,
    ).toBe(true);
    // A category with no stored tier is None-selected.
    expect(
      getByTestId('budget-segment-clothing-none').props.accessibilityState.selected,
    ).toBe(true);
  });
});

describe('BudgetScreen — selection writes through', () => {
  it('tapping a tier sets it in profile.budget', async () => {
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(getByTestId('budget-segment-electronics-tier-2')).toBeTruthy();
    });
    fireEvent.press(getByTestId('budget-segment-electronics-tier-2'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.budget).toEqual({ electronics: '$$' });
    });
  });

  it('tapping "None" removes the category key entirely (not stores null)', async () => {
    // Pre-seed with an existing tier on this category.
    await saveUserPreferences({
      region: null,
      budget: { electronics: '$$', food: '$' },
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(
        getByTestId('budget-segment-electronics-tier-2').props.accessibilityState.selected,
      ).toBe(true);
    });
    fireEvent.press(getByTestId('budget-segment-electronics-none'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      // Crucial: "electronics" key is GONE from the budget object,
      // not present-with-null. Empty / unset categories must round-trip
      // as absent so the parser's "value validation" doesn't have to
      // distinguish "explicitly None" from "not set".
      expect('electronics' in stored.budget).toBe(false);
      expect(stored.budget).toEqual({ food: '$' });
    });
  });

  it('switching tiers replaces the existing entry', async () => {
    await saveUserPreferences({
      region: null,
      budget: { electronics: '$' },
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(
        getByTestId('budget-segment-electronics-tier-1').props.accessibilityState.selected,
      ).toBe(true);
    });
    fireEvent.press(getByTestId('budget-segment-electronics-tier-3'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.budget).toEqual({ electronics: '$$$' });
    });
  });

  it('preserves OTHER budget categories when one row changes', async () => {
    await saveUserPreferences({
      region: null,
      budget: { electronics: '$$', food: '$$$', clothing: '$' },
      devices: [],
      languages: [],
      dietary: [],
      accessibility: [],
    });
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(getByTestId('budget-segments-electronics')).toBeTruthy();
    });
    fireEvent.press(getByTestId('budget-segment-electronics-tier-1'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.budget).toEqual({
        electronics: '$',
        food: '$$$',
        clothing: '$',
      });
    });
  });

  it('preserves other profile fields when toggling a tier', async () => {
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: ['ios'],
      languages: ['hi-IN'],
      dietary: ['vegetarian'],
      accessibility: ['wheelchair'],
    });
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(getByTestId('budget-segments-food')).toBeTruthy();
    });
    fireEvent.press(getByTestId('budget-segment-food-tier-2'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored).toEqual({
        region: 'IN',
        budget: { food: '$$' },
        devices: ['ios'],
        languages: ['hi-IN'],
        dietary: ['vegetarian'],
        accessibility: ['wheelchair'],
      });
    });
  });

  it('rapid taps across categories compose — no lost updates', async () => {
    const { getByTestId } = render(<BudgetScreen />);
    await waitFor(() => {
      expect(getByTestId('budget-segments-electronics')).toBeTruthy();
    });
    fireEvent.press(getByTestId('budget-segment-electronics-tier-1'));
    fireEvent.press(getByTestId('budget-segment-food-tier-2'));
    fireEvent.press(getByTestId('budget-segment-travel-tier-3'));
    await waitFor(async () => {
      const stored = await loadUserPreferences();
      expect(stored.budget).toEqual({
        electronics: '$',
        food: '$$',
        travel: '$$$',
      });
    });
  });
});

describe('BudgetScreen — accessibility', () => {
  it('segment group has accessibilityRole=radiogroup', () => {
    const { getByTestId } = render(<BudgetScreen />);
    const group = getByTestId('budget-segments-electronics');
    expect(group.props.accessibilityRole).toBe('radiogroup');
  });

  it('each segment has accessibilityRole=radio with selected state', () => {
    const { getByTestId } = render(<BudgetScreen />);
    const seg = getByTestId('budget-segment-electronics-none');
    expect(seg.props.accessibilityRole).toBe('radio');
    expect(typeof seg.props.accessibilityState.selected).toBe('boolean');
  });

  it('a11y label distinguishes None from tier values', () => {
    const { getByTestId } = render(<BudgetScreen />);
    expect(getByTestId('budget-segment-electronics-none').props.accessibilityLabel).toBe(
      'No filter',
    );
    expect(
      getByTestId('budget-segment-electronics-tier-1').props.accessibilityLabel,
    ).toBe('Tier $');
    expect(
      getByTestId('budget-segment-electronics-tier-3').props.accessibilityLabel,
    ).toBe('Tier $$$');
  });
});

describe('BudgetScreen — Loyalty Law', () => {
  it('selecting a tier never reaches the network', async () => {
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      const { getByTestId } = render(<BudgetScreen />);
      await waitFor(() => {
        expect(getByTestId('budget-segment-electronics-tier-2')).toBeTruthy();
      });
      fireEvent.press(getByTestId('budget-segment-electronics-tier-2'));
      await waitFor(async () => {
        const stored = await loadUserPreferences();
        expect(stored.budget.electronics).toBe('$$');
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });
});
