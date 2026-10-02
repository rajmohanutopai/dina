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
 * On `background` (native only) it calls `suspendRelay()`: MsgBox counts a
 * frame as delivered once written to the socket it holds for this DID, and a
 * suspended app leaves that socket open but unread — so anything a peer sent
 * while the app was in the background (a checkout link, payment evidence)
 * was written, counted as delivered, and lost. Closing the socket first makes
 * MsgBox see the DID offline and buffer; the `active` edge's `wakeRelay()`
 * reconnects and MsgBox drains the buffer. The web build keeps its socket: a
 * hidden browser tab still runs and reads it.
 *
 * `inactive` is ignored (a transient overlay, not a suspension); sealing
 * the vault stays `useAutoLock`'s job.
 *
 * Two-phase (pure function + React mount), matching `useAutoLock`:
 *   - `installRelayWake({ wakeFn })` — pure, Node-testable, no RN/AppState.
 *   - `useRelayWake()` — the React hook the root layout mounts.
 */

import { useEffect } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { suspendRelay, wakeRelay } from '@dina/core';

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
  /**
   * Suspend function — called on each durable `background` transition so
   * MsgBox buffers instead of writing into a socket nobody reads. Absent,
   * nothing is suspended (the hook passes `suspendRelay` on native only).
   */
  suspendFn?: () => void;
}

/**
 * Install a state-driven relay-wake subscription. Pure — does not touch
 * React or `AppState`, so it unit-tests without a React Native runtime.
 */
export function installRelayWake(opts: InstallRelayWakeOptions = {}): RelayWakeSubscription {
  const wakeFn = opts.wakeFn ?? wakeRelay;
  const suspendFn = opts.suspendFn;
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
    if (next === 'background' && prev !== 'background') {
      suspendFn?.();
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
    const sub = installRelayWake({ suspendFn: Platform.OS === 'web' ? undefined : suspendRelay });
    const listener = AppState.addEventListener('change', (next) => {
      sub.notify(next);
    });
    return () => {
      listener.remove();
      sub.dispose();
    };
  }, [unlocked]);
}
