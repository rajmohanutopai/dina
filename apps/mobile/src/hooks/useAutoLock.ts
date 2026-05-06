/**
 * Auto-lock hook — seals the vault when the app moves to background.
 *
 * Without this, "Sign out" is the only way to drop the in-memory DEKs.
 * Users who hit the home button (or get a phone call, screen-lock the
 * device, switch apps) would leave the vault open in process memory
 * indefinitely — undermining the security promise of the unlock screen.
 *
 * Behaviour:
 *
 *   - On `background` state transition → record a `backgroundedAt`
 *     wall-clock stamp AND start a configurable timer (default
 *     `DEFAULT_BACKGROUND_TIMEOUT_S`, settable via `setBackgroundTimeout`).
 *     When the timer fires, call `sealVault()` and arm the
 *     force-prompt flag so the next foreground re-entry prompts for
 *     the passphrase even when `startupMode === 'auto'` (mirrors the
 *     explicit Sign out path).
 *
 *   - On `active` (foreground) → cancel any pending timer AND
 *     reconcile against wall clock: if `now - backgroundedAt` already
 *     exceeded the timeout, seal NOW. This is load-bearing on iOS:
 *     when the app is suspended in the background, JS is paused —
 *     `setTimeout` callbacks DO NOT fire. Without this reconcile a
 *     90-second background after a 60-second timeout would resume the
 *     foreground without ever sealing (MT-40-I2). The reconcile fires
 *     synchronously before the next render so UnlockGate renders the
 *     locked screen on the same frame as resume.
 *
 *   - `inactive` is treated as a transient overlay state and IGNORED.
 *     iOS emits `inactive` for Control Center, the notification pull,
 *     incoming calls without answer, and the app switcher. Sealing on
 *     those would force a re-unlock for trivial UI overlays — bad
 *     trade-off. The actual screen-lock / app-switch lands on
 *     `background` after the overlay clears.
 *
 * Two-phase design (pure function + React mount):
 *   - `installAutoLock({ now, sealFn, getTimeoutS })` returns a
 *     subscription object you can drive from a real AppState event or
 *     a test harness. Pure-Node testable.
 *   - `useAutoLock()` is the React hook the root layout calls; it
 *     wires the subscription against React Native's `AppState`.
 *
 * Future enhancement: idle-timeout while foregrounded (lock after N
 * minutes of no UI interaction). Requires instrumenting touch
 * handlers; out of scope for v1. The background-lock here covers the
 * 99% case (user puts the phone down).
 */

import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getBackgroundTimeout } from '@dina/core';

import { sealVault } from './useUnlock';

export interface AutoLockSubscription {
  /** Drive a state transition from a test or a real listener. */
  notify: (next: AppStateStatus) => void;
  /** Tear down the timer (no-op if none pending). Used by tests + React unmount. */
  dispose: () => void;
  /** True while a background-expiry timer is pending. Inspectable from tests. */
  isPending: () => boolean;
}

export interface InstallAutoLockOptions {
  /** Clock hook — defaults to Date.now. Tests inject a fake. */
  now?: () => number;
  /** Sealing function — defaults to `sealVault`. Tests inject a spy. */
  sealFn?: () => Promise<void> | void;
  /**
   * Timeout accessor — called when entering background. Defaults to
   * `getBackgroundTimeout()` so the user's "Background timeout"
   * setting in Security takes effect immediately on the next lock.
   * Tests inject a constant.
   */
  getTimeoutS?: () => number;
  /**
   * Schedule hook — defaults to `setTimeout`. Tests inject a fake to
   * simulate elapsed time without actual sleeping.
   */
  scheduleTimer?: (cb: () => void, ms: number) => unknown;
  /** Cancel hook for the schedule. */
  cancelTimer?: (id: unknown) => void;
}

/**
 * Install a state-driven auto-lock subscription. Returns a handle the
 * caller drives from real AppState events (or a test harness). Pure
 * function — does NOT touch React or `AppState` directly so it can be
 * unit-tested without a React Native runtime.
 */
export function installAutoLock(opts: InstallAutoLockOptions = {}): AutoLockSubscription {
  const sealFn = opts.sealFn ?? sealVault;
  const getTimeoutS = opts.getTimeoutS ?? getBackgroundTimeout;
  const now = opts.now ?? (() => Date.now());
  const scheduleTimer = opts.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const cancelTimer = opts.cancelTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let pendingTimer: unknown = null;
  let lastState: AppStateStatus | 'unknown' = 'unknown';
  // Wall-clock stamp of the last `background` transition. `null` while
  // foregrounded. Used by the `active` reconcile to detect a timeout
  // that elapsed while iOS had JS suspended (`setTimeout` does NOT
  // fire while backgrounded — MT-40-I2).
  let backgroundedAt: number | null = null;
  // Snapshot of the timeout in ms that was armed on the most recent
  // `background` transition. We could re-read `getTimeoutS()` on
  // resume, but pinning here means a Settings change made WHILE
  // backgrounded doesn't retroactively seal a session that the user
  // had already armed under a longer timeout.
  let armedTimeoutMs: number = 0;

  const cancelPending = (): void => {
    if (pendingTimer !== null) {
      cancelTimer(pendingTimer);
      pendingTimer = null;
    }
  };

  const notify = (next: AppStateStatus): void => {
    // Ignore the redundant active→active and background→background
    // transitions React Native sometimes emits during the same lifecycle
    // event (the platform fires duplicates on iOS Sequoia + RN 0.74+).
    if (next === lastState) return;
    lastState = next;

    if (next === 'background') {
      // Cancel any leftover timer (defensive — shouldn't be one).
      cancelPending();
      const timeoutS = Math.max(0, getTimeoutS());
      backgroundedAt = now();
      armedTimeoutMs = timeoutS * 1000;
      // A zero timeout means "lock immediately on background". Run the
      // seal synchronously so the vault is locked by the time the OS
      // pauses the JS engine — without this, a user who task-switches
      // mid-call could see secrets in memory until the JS thread next
      // runs (which on iOS may be never until foreground).
      if (timeoutS === 0) {
        void sealFn();
        return;
      }
      pendingTimer = scheduleTimer(() => {
        pendingTimer = null;
        void sealFn();
      }, armedTimeoutMs);
      return;
    }

    if (next === 'active') {
      cancelPending();
      // Reconcile against wall clock — covers the iOS-suspended case
      // where setTimeout never fired because JS was paused. If the
      // timeout already elapsed, seal NOW so the next render lands on
      // the locked screen on the same frame as resume. The `armedTimeoutMs > 0`
      // guard handles the zero-timeout case (already sealed in the
      // background branch) and the never-armed case (active→active
      // and inactive→active without a prior background).
      if (backgroundedAt !== null && armedTimeoutMs > 0) {
        const elapsed = now() - backgroundedAt;
        if (elapsed >= armedTimeoutMs) {
          void sealFn();
        }
      }
      backgroundedAt = null;
      armedTimeoutMs = 0;
      return;
    }

    // 'inactive' (iOS-only transient: Control Center, app switcher,
    // incoming-call splash, notification-shade pull). Don't touch
    // pending timers; the next durable transition (active or
    // background) decides.
  };

  return {
    notify,
    dispose: () => {
      cancelPending();
      lastState = 'unknown';
      backgroundedAt = null;
      armedTimeoutMs = 0;
    },
    isPending: () => pendingTimer !== null,
  };
}

/**
 * React hook — installs the AppState subscription for the lifetime of
 * the mounting component. Only mount once (typically at the root
 * layout), gated on the unlocked state so we don't seal an already-
 * sealed vault.
 *
 * The hook returns nothing — the side effect IS the value.
 */
export function useAutoLock(unlocked: boolean): void {
  useEffect(() => {
    if (!unlocked) return;
    const sub = installAutoLock();
    const listener = AppState.addEventListener('change', (next) => {
      sub.notify(next);
    });
    return () => {
      listener.remove();
      sub.dispose();
    };
  }, [unlocked]);
}
