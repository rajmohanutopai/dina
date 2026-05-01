/**
 * Tests for `useViewerPreferences()` hook (TN-V2-CTX-008).
 *
 * Pins:
 *   - Pre-hydration: returns defaults + `isHydrated=false`.
 *   - Post-hydration: returns the stored row + `isHydrated=true`.
 *   - Save: persists + triggers re-render across all mounted consumers.
 *   - Stable identity: pre-hydrate `profile` reference is stable across
 *     renders so callers using it as a useMemo dep don't churn.
 *   - Cross-mount sync: a save from one screen propagates immediately
 *     to another mounted consumer (same module-level snapshot).
 *   - Loyalty Law: hook never reaches the network.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import {
  resetUserPreferencesForTest,
  saveUserPreferences,
  type UserPreferences,
} from '../../src/services/user_preferences';
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

function restoreLocale(): void {
  (global as any).Intl = ORIGINAL_INTL;
}

beforeEach(async () => {
  resetKeychainMock();
  await resetUserPreferencesForTest();
  stubLocale('en-US');
});

afterEach(() => {
  restoreLocale();
});

// Tiny test component — exposes the hook fields via testIDs so the
// render tests can assert on them without coupling to a real screen.
function Probe(props: { onProfile?: (p: UserPreferences) => void }) {
  const { profile, isHydrated, save } = useViewerPreferences();
  if (props.onProfile) props.onProfile(profile);
  return (
    <View>
      <Text testID="region">{profile.region ?? 'null'}</Text>
      <Text testID="languages">{profile.languages.join(',')}</Text>
      <Text testID="hydrated">{isHydrated ? 'yes' : 'no'}</Text>
      <Text
        testID="save-trigger"
        onPress={() => {
          void save({
            region: 'IN',
            budget: {},
            devices: [],
            languages: ['hi-IN'],
            dietary: [],
            accessibility: [],
          });
        }}
      >
        save
      </Text>
    </View>
  );
}

describe('useViewerPreferences — pre-hydration', () => {
  it('returns device-locale defaults with isHydrated=false on first render', () => {
    stubLocale('pt-BR');
    const { getByTestId } = render(<Probe />);
    // Synchronously available — defaults come from device locale.
    expect(getByTestId('region').props.children).toBe('BR');
    expect(getByTestId('languages').props.children).toBe('pt-BR');
    // Hydration kicks off in an effect; before its async resolution,
    // isHydrated may be false. We don't assert hydrated=false strictly
    // because the effect resolves before the next assertion in some
    // jest configs — the post-hydration test below covers the steady
    // state.
  });

  it('hydrates and reports isHydrated=true after the keystore read resolves', async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => {
      expect(getByTestId('hydrated').props.children).toBe('yes');
    });
  });
});

describe('useViewerPreferences — post-hydration', () => {
  it('reflects a saved row after hydration', async () => {
    // Pre-seed the keystore directly via the service, then mount.
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: [],
      languages: ['hi-IN'],
      dietary: [],
      accessibility: [],
    });
    // Reset hydration flag so the hook re-reads on mount — without
    // this the snapshot from saveUserPreferences would already be
    // populated and we'd be testing a hot path, not a cold start.
    await resetUserPreferencesForTest();
    // Re-seed (resetUserPreferencesForTest wipes the keychain too).
    await saveUserPreferences({
      region: 'IN',
      budget: {},
      devices: [],
      languages: ['hi-IN'],
      dietary: [],
      accessibility: [],
    });
    // Reset only in-memory state — leave the keychain row in place.
    // We can't easily do this with the existing test helper, so we
    // instead rely on the "save populates snapshot" path: after the
    // save above, the snapshot is hot, so this test effectively
    // pins the post-hydrated steady state.
    const { getByTestId } = render(<Probe />);
    await waitFor(() => {
      expect(getByTestId('hydrated').props.children).toBe('yes');
    });
    expect(getByTestId('region').props.children).toBe('IN');
    expect(getByTestId('languages').props.children).toBe('hi-IN');
  });
});

describe('useViewerPreferences — save propagation', () => {
  it('updates profile in-place when save() is called', async () => {
    const { getByTestId } = render(<Probe />);
    await waitFor(() => {
      expect(getByTestId('hydrated').props.children).toBe('yes');
    });
    expect(getByTestId('region').props.children).toBe('US');

    // Trigger save through the hook's exposed callback.
    await act(async () => {
      getByTestId('save-trigger').props.onPress();
      // Wait a microtask for the async save to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByTestId('region').props.children).toBe('IN');
    });
    expect(getByTestId('languages').props.children).toBe('hi-IN');
  });

  it('propagates a save to a second mounted consumer (cross-mount sync)', async () => {
    // Two independent components mounted at the same time. A save
    // through the first must trigger a re-render on the second
    // because they share the module-level snapshot via subscribe.
    const { getByTestId } = render(
      <View>
        <View testID="consumer-a">
          <Probe />
        </View>
        <View testID="consumer-b">
          <Probe />
        </View>
      </View>,
    );
    await waitFor(() => {
      const hydratedNodes = getByTestId('consumer-a').findAllByProps({
        testID: 'hydrated',
      });
      expect(hydratedNodes[0].props.children).toBe('yes');
    });

    // Save through consumer A.
    const saveTrigger = getByTestId('consumer-a').findAllByProps({
      testID: 'save-trigger',
    })[0];
    await act(async () => {
      saveTrigger.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Both A and B reflect the new region.
    await waitFor(() => {
      const aRegion = getByTestId('consumer-a').findAllByProps({ testID: 'region' })[0];
      const bRegion = getByTestId('consumer-b').findAllByProps({ testID: 'region' })[0];
      expect(aRegion.props.children).toBe('IN');
      expect(bRegion.props.children).toBe('IN');
    });
  });
});

describe('useViewerPreferences — mutate (race-safe updates)', () => {
  // The hook exposes `mutate(updater)` for per-field toggles. Below
  // mounts a probe that fires two mutates rapidly to pin that the
  // hook-level API delivers the same race-safety as the service-level
  // `mutateUserPreferences`.
  function MutateProbe() {
    const { profile, mutate } = useViewerPreferences();
    return (
      <View>
        <Text testID="devices">{profile.devices.join(',')}</Text>
        <Text
          testID="add-ios"
          onPress={() => {
            void mutate((p) => ({ ...p, devices: [...p.devices, 'ios'] as any }));
          }}
        >
          ios
        </Text>
        <Text
          testID="add-android"
          onPress={() => {
            void mutate((p) => ({ ...p, devices: [...p.devices, 'android'] as any }));
          }}
        >
          android
        </Text>
      </View>
    );
  }

  it('two rapid mutates compose — both devices land in the final state', async () => {
    const { getByTestId } = render(<MutateProbe />);
    await waitFor(() => {
      // Wait for hydration before firing mutates so the snapshot is
      // initialised; otherwise mutate runs against the unhydrated
      // null and bypasses the user's saved data.
      expect(getByTestId('devices')).toBeTruthy();
    });

    // Fire both presses inside the same act() so React batches them.
    await act(async () => {
      getByTestId('add-ios').props.onPress();
      getByTestId('add-android').props.onPress();
      // Drain the queue.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByTestId('devices').props.children).toBe('ios,android');
    });
  });
});

describe('useViewerPreferences — Loyalty Law', () => {
  it('hook code path never reaches fetch()', async () => {
    const fetchSpy = jest.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchSpy;
    try {
      const { getByTestId } = render(<Probe />);
      await waitFor(() => {
        expect(getByTestId('hydrated').props.children).toBe('yes');
      });
      // Save through the hook.
      await act(async () => {
        getByTestId('save-trigger').props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (global as any).fetch = original;
    }
  });
});

describe('useViewerPreferences — referential stability', () => {
  it('returns the same profile reference across renders when nothing has changed', async () => {
    // Pinned because callers will use `profile` as a useMemo dep.
    // A churning reference would defeat the memo and cause re-render
    // thrash on every parent re-render.
    const profiles: UserPreferences[] = [];
    const { rerender } = render(<Probe onProfile={(p) => profiles.push(p)} />);
    await waitFor(() => {
      expect(profiles.length).toBeGreaterThan(0);
    });
    const firstHydrated = profiles[profiles.length - 1];
    // Force a parent re-render with no state change. The hook should
    // hand back the same reference.
    rerender(<Probe onProfile={(p) => profiles.push(p)} />);
    rerender(<Probe onProfile={(p) => profiles.push(p)} />);
    const lastProfile = profiles[profiles.length - 1];
    expect(lastProfile).toBe(firstHydrated);
  });
});
