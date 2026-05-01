/**
 * `useViewerPreferences()` — React hook over the local viewer profile
 * keystore (TN-V2-CTX-008 / V2 actionability layer).
 *
 * Returns `{ profile, isHydrated, save }`. Powers filter / badge logic
 * across the trust-network screens — every place that needs to know
 * "what region does the viewer care about?" / "what languages?" reads
 * here.
 *
 * Why a `useSyncExternalStore` wrapper rather than a Context: the
 * viewer profile is a SINGLETON (one viewer per app instance). A
 * Context would require every consumer to live under a wrapping
 * component, and the React tree has many roots (modal stacks, native
 * screens, headless settings, etc). `useSyncExternalStore` over a
 * module-level snapshot is the canonical React pattern for app-wide
 * singletons that mutate.
 *
 * **Loyalty Law** — same posture as the underlying service: this hook
 * never sends preferences anywhere. The `save` callback writes to the
 * keystore; the `profile` value is read from in-memory snapshot. No
 * network code path on either side.
 *
 * Hydration semantics:
 *   - Before `hydrateUserPreferences()` resolves: `isHydrated=false`,
 *     `profile=defaultPreferences()`. Consumers can render against the
 *     defaults safely — the device-locale shape is good enough for
 *     a first paint, and the actual stored values arrive via re-render
 *     when hydration completes.
 *   - After hydrate: `isHydrated=true`, `profile=<actual>`.
 *   - On `save()`: `profile` updates synchronously (the snapshot
 *     mutates inside `saveUserPreferences()` after the keystore write
 *     succeeds), which triggers a notify and a re-render.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  defaultPreferences,
  getUserPreferencesSnapshot,
  hydrateUserPreferences,
  isUserPreferencesHydrated,
  mutateUserPreferences,
  saveUserPreferences,
  subscribeUserPreferences,
  type UserPreferences,
} from '../services/user_preferences';

export interface UseViewerPreferencesResult {
  /**
   * Current viewer profile. Always populated — pre-hydration this is
   * `defaultPreferences()` derived from the device locale, post-hydrate
   * it's the actual stored row.
   */
  readonly profile: UserPreferences;
  /**
   * `true` once the keystore has been read. Screens that legitimately
   * need to suppress UI until the real profile is known (rare —
   * defaults are usually fine) should gate on this.
   */
  readonly isHydrated: boolean;
  /**
   * Persist a new profile. Validates + writes through to the keystore,
   * then updates the snapshot, which triggers re-render across all
   * mounted consumers. Throws if the keystore write fails — caller
   * decides whether to surface an error to the user.
   *
   * Use this when you have a complete profile to write (e.g., a
   * "reset to defaults" button). For per-field edits, prefer
   * `mutate(updater)` — it composes correctly under rapid concurrent
   * edits, which `save()` does NOT (a captured `profile` closure goes
   * stale within a single render tick).
   */
  readonly save: (next: UserPreferences) => Promise<void>;
  /**
   * Apply a functional update to the profile. The updater receives
   * the LATEST stored profile when its turn in the queue arrives —
   * NOT the value captured at call time. Use this for any per-field
   * toggle (multi-select rows, single-row edits) where the user might
   * fire a second update before the first resolves.
   *
   * Example — toggling a device on:
   *
   *     mutate(p => ({ ...p, devices: [...p.devices, 'ios'] }));
   *
   * Two such calls in quick succession compose: the second sees the
   * effect of the first.
   */
  readonly mutate: (
    updater: (current: UserPreferences) => UserPreferences,
  ) => Promise<void>;
}

export function useViewerPreferences(): UseViewerPreferencesResult {
  // Kick off hydration on first mount. `hydrateUserPreferences()` is
  // idempotent — if boot already hydrated, this is a no-op. Without
  // this, screens that mount before boot would see `isHydrated=false`
  // forever.
  useEffect(() => {
    void hydrateUserPreferences();
  }, []);

  const snapshot = useSyncExternalStore(
    subscribeUserPreferences,
    getUserPreferencesSnapshot,
    // Server snapshot — same as client. RN doesn't SSR but the third
    // arg is required by the API; passing the same getter makes
    // future SSR-rendered builds (e.g., docs site demos) consistent.
    getUserPreferencesSnapshot,
  );
  const hydrated = useSyncExternalStore(
    subscribeUserPreferences,
    isUserPreferencesHydrated,
    isUserPreferencesHydrated,
  );

  // Provide a stable defaults reference across un-hydrated renders so
  // consumers downstream that key on `profile` (e.g., useMemo deps)
  // don't churn between renders. Falls back to a memoised
  // `defaultPreferences()` exactly once until the snapshot lands.
  const fallback = useMemo(() => defaultPreferences(), []);
  const profile = snapshot ?? fallback;

  const save = useCallback(async (next: UserPreferences): Promise<void> => {
    await saveUserPreferences(next);
  }, []);

  const mutate = useCallback(
    async (updater: (current: UserPreferences) => UserPreferences): Promise<void> => {
      await mutateUserPreferences(updater);
    },
    [],
  );

  return { profile, isHydrated: hydrated, save, mutate };
}
