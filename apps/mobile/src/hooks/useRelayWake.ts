/**
 * Relay-wake hook — force the MsgBox relay to reconnect IMMEDIATELY when
 * the app returns to the foreground.
 *
 * The complement to the idle-staleness keepalive (#351, in
 * `packages/core/src/relay/msgbox_ws.ts`). That keepalive handles a
 * socket going stale WHILE the app runs. This handles the
 * background→foreground transition:
 *
 *   On iOS, a backgrounded app has its JS suspended — every timer (the
 *   keepalive tick AND any pending backoff reconnect) freezes — and the
 *   OS tears the socket down. On resume the timers fire again, but
 *   recovery is then IMPLICIT: the next keepalive tick has to first
 *   NOTICE staleness (up to the 90s / 10-min threshold) before it
 *   force-reconnects. During that window the Home Node is unreachable to
 *   agents/peers even though the user is looking at the app — a `/task`
 *   delegation, an inbound Talk, or a service query would all time out.
 *
 *   `wakeRelay()` collapses that window to ~0. On the `active`
 *   transition we call it: if the relay is already authenticated on an
 *   OPEN socket it is a no-op; otherwise it tears down any half-open
 *   socket the suspended period left behind and reconnects from
 *   attempt 0 (no backoff penalty — the user is back).
 *
 * `background` / `inactive` are ignored — sealing/teardown is
 * `useAutoLock`'s job; this hook only needs the resume edge.
 *
 * Two-phase (pure function + React mount), matching `useAutoLock`:
 *   - `installRelayWake({ wakeFn })` — pure, Node-testable, no RN/AppState.
 *   - `useRelayWake()` — the React hook the root layout mounts.
 */

import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { wakeRelay } from '@dina/core';

export interface RelayWakeSubscription {
  /** Drive a state transition from a test or a real listener. */
  notify: (next: AppStateStatus) => void;
  /** Reset internal state (React unmount / tests). */
  dispose: () => void;
}

export interface InstallRelayWakeOptions {
  /**
   * Wake function — defaults to `wakeRelay`. Tests inject a spy. Called
   * on every durable `active` transition (a no-op when the relay is
   * already healthy, so calling it eagerly is safe).
   */
  wakeFn?: () => void;
}

/**
 * Install a state-driven relay-wake subscription. Pure — does not touch
 * React or `AppState`, so it unit-tests without a React Native runtime.
 */
export function installRelayWake(opts: InstallRelayWakeOptions = {}): RelayWakeSubscription {
  const wakeFn = opts.wakeFn ?? wakeRelay;
  // Track the last DURABLE state so we only wake on a real
  // background→active (or inactive→active) edge, not on the redundant
  // active→active duplicates RN emits on iOS Sequoia + RN 0.74+.
  let lastState: AppStateStatus | 'unknown' = 'unknown';

  const notify = (next: AppStateStatus): void => {
    if (next === lastState) return;
    // 'inactive' is a transient overlay (Control Center, app switcher,
    // incoming-call splash). It is NOT a resume edge and must not move
    // `lastState` off 'background' — otherwise the real `background →
    // inactive → active` sequence iOS emits would land as
    // `inactive → active` and we'd skip the wake. Leave lastState alone.
    if (next === 'inactive') return;
    const prev = lastState;
    lastState = next;
    // Wake on any transition INTO active (covers background→active and
    // the cold first 'active'). `wakeRelay()` self-noops when healthy,
    // so an over-eager call costs nothing.
    if (next === 'active' && prev !== 'active') {
      wakeFn();
    }
  };

  return {
    notify,
    dispose: () => {
      lastState = 'unknown';
    },
  };
}

/**
 * React hook — installs the AppState subscription for the lifetime of
 * the mounting component. Mount once at the root layout, gated on the
 * unlocked state (no relay before unlock, and a long background that
 * sealed the vault re-boots a fresh relay on re-unlock anyway).
 */
export function useRelayWake(unlocked: boolean): void {
  useEffect(() => {
    if (!unlocked) return;
    const sub = installRelayWake();
    const listener = AppState.addEventListener('change', (next) => {
      sub.notify(next);
    });
    return () => {
      listener.remove();
      sub.dispose();
    };
  }, [unlocked]);
}
