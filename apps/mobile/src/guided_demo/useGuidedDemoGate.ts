/**
 * Guided-demo gate state — the first-run / recovery / running state machine the
 * gate component renders, plus the step runner that drives the scripted demo
 * once a demo scope is active.
 *
 *   checking → (boot) deciding which surface to show
 *   recovery → a demo was active at last shutdown (Continue / Delete)
 *   entry    → first run, offer "See Dina in action" (Start demo / Start empty)
 *   running  → render the app (with banner iff a demo scope is active)
 *
 * While `demoActive`, the banner exposes the current step's caption and a
 * "Next" affordance that calls `advanceDemo()` → the runner fires that step
 * through the REAL composer / approval / chat paths (`makeGuidedDemoSeams`).
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Entry" / "Crash / Restart
 * Recovery" / Phase 5.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  currentDataScope,
  isGuidedDemoScope,
  hasSeenGuidedDemoEntry,
  markGuidedDemoEntrySeen,
} from '@dina/core';

import {
  beginGuidedDemo,
  beginEmpty,
  endGuidedDemoAndRefresh,
  pendingGuidedDemo,
  resumeGuidedDemoAndRefresh,
} from './controller';
import { makeGuidedDemoSeams } from './providers';
import { subscribeGuidedDemoReplay } from './replay_request';
import { GuidedDemoRunner, type DemoAction, type GuidedDemoSeams } from './runner';

/**
 * Yield one macrotask so React can commit + paint a pending state change before
 * the caller proceeds with synchronous-blocking work. Used by the demo teardown
 * so the banner removal renders before op-sqlite's synchronous cleanup blocks
 * the JS thread.
 */
function yieldToPaint(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type GuidedDemoGatePhase = 'checking' | 'entry' | 'recovery' | 'running' | 'tearing_down';

export interface GuidedDemoGateState {
  phase: GuidedDemoGatePhase;
  /** True while a guided-demo scope is active → show the banner. */
  demoActive: boolean;
  /** The next scripted step to run, or null when the demo is complete. Drives
   *  the advance button (its label/mode), NOT the dock caption. */
  currentAction: DemoAction | null;
  /** Caption of the step currently ON SCREEN (the running step, or the last
   *  completed one), so the dock describes what the user sees, not the next step. */
  caption: string | null;
  /** 1-based number of the step currently on screen (`step` of `stepCount`). */
  step: number;
  stepCount: number;
  /** True once every scripted step has run. */
  demoComplete: boolean;
  /** True while a scripted step is running — the banner disables "Next". */
  actionInFlight: boolean;
  startDemo: () => Promise<void>;
  skip: () => Promise<void>;
  continueDemo: () => Promise<void>;
  deleteDemo: () => Promise<void>;
  exitDemo: () => Promise<void>;
  /** Run the next scripted step through the real paths. */
  advanceDemo: () => Promise<void>;
}

export interface UseGuidedDemoGateOptions {
  /** Inject runner seams (tests). Defaults to the real `makeGuidedDemoSeams`. */
  makeSeams?: () => GuidedDemoSeams;
}

export function useGuidedDemoGate(
  enabled = true,
  options: UseGuidedDemoGateOptions = {},
): GuidedDemoGateState {
  const [phase, setPhase] = useState<GuidedDemoGatePhase>('checking');
  const [demoActive, setDemoActive] = useState(false);
  // Runner snapshot mirrored into state so the banner re-renders on advance.
  const [runnerTick, setRunnerTick] = useState(0);
  const runnerRef = useRef<GuidedDemoRunner | null>(null);
  // In-flight scripted action. Serializes advanceDemo (a double-tap on "Next"
  // must not run two steps) AND lets exit/delete WAIT for an in-flight step to
  // finish writing into the DEMO scope before the scope is reset to user —
  // otherwise a still-draining /remember could land in the real user vault.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const makeSeams = options.makeSeams ?? makeGuidedDemoSeams;

  // Live mirrors of phase + demoActive so the (once-installed) replay-request
  // subscriber reads current values without re-subscribing on every change.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const demoActiveRef = useRef(demoActive);
  demoActiveRef.current = demoActive;

  const newRunner = useCallback((): GuidedDemoRunner => {
    const runner = new GuidedDemoRunner(makeSeams());
    runnerRef.current = runner;
    setRunnerTick((t) => t + 1);
    return runner;
  }, [makeSeams]);

  const tearDownRunner = useCallback(() => {
    runnerRef.current?.teardown();
    runnerRef.current = null;
    setRunnerTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      // Recovery takes priority — never silently merge a crashed demo.
      const pending = await pendingGuidedDemo();
      if (cancelled) return;
      if (pending !== null) {
        setPhase('recovery');
        return;
      }
      const seen = await hasSeenGuidedDemoEntry();
      if (cancelled) return;
      setPhase(seen ? 'running' : 'entry');
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const startDemo = useCallback(async () => {
    await beginGuidedDemo();
    await markGuidedDemoEntrySeen();
    newRunner();
    setDemoActive(isGuidedDemoScope(currentDataScope()));
    setPhase('running');
  }, [newRunner]);

  // "Replay the tour" — any screen (e.g. Help) can request a demo on demand.
  // Only honor it from the normal running app: never restart mid-demo, and
  // never while still checking / recovering / tearing down (those are boot or
  // transitional states a replay must not stomp). The first-run entry screen
  // uses startDemo() directly; this is the "any time" entry point.
  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeGuidedDemoReplay(() => {
      if (phaseRef.current !== 'running' || demoActiveRef.current) return;
      void startDemo();
    });
  }, [enabled, startDemo]);

  const skip = useCallback(async () => {
    beginEmpty();
    await markGuidedDemoEntrySeen();
    setDemoActive(false);
    setPhase('running');
  }, []);

  const continueDemo = useCallback(async () => {
    const resumed = await resumeGuidedDemoAndRefresh();
    const runner = newRunner();
    // Fast-forward past the last completed step recorded in the active record.
    if (resumed !== null) runner.resumeAfter(resumed.step);
    setRunnerTick((t) => t + 1);
    setDemoActive(isGuidedDemoScope(currentDataScope()));
    setPhase('running');
  }, [newRunner]);

  /**
   * Wait for any in-flight scripted action to finish. A step's seam (e.g.
   * `/remember`) writes into the DEMO scope asynchronously; we must let it
   * complete BEFORE resetting the scope, or its tail lands in the user vault.
   * A failed step is fine to ignore here — teardown cleans the scope regardless.
   */
  const settleInFlight = useCallback(async () => {
    const pending = inFlightRef.current;
    if (pending === null) return;
    try {
      await pending;
    } catch {
      /* a failed demo step still gets cleaned up by teardown */
    }
  }, []);

  /**
   * Shared teardown: clear the banner on tap, but show a NON-INTERACTIVE
   * "tearing_down" surface (NOT the live app) until the scope is actually reset.
   * The runtime scope is still `guided_demo:*` from now until
   * `endGuidedDemoAndRefresh()` returns; if we revealed the interactive app in
   * that window, anything the user typed/tapped (especially during a long
   * in-flight `/remember`) would be written to the demo scope and then deleted
   * by teardown — silent data loss with no banner. The overlay blocks that.
   * yieldToPaint lets the overlay render before op-sqlite's synchronous cleanup
   * blocks the JS thread.
   */
  const teardown = useCallback(async () => {
    tearDownRunner();
    setDemoActive(false);
    setPhase('tearing_down');
    await yieldToPaint();
    // Let an in-flight step finish writing into the demo scope, THEN reset the
    // scope (cleanup deletes whatever it just wrote). The user is blocked
    // (tearing_down overlay) throughout, so no new writes land in the demo scope.
    await settleInFlight();
    await endGuidedDemoAndRefresh();
    // Scope is now `user` — safe to reveal the live app.
    setPhase('running');
  }, [tearDownRunner, settleInFlight]);

  const deleteDemo = useCallback(async () => {
    await teardown();
    await markGuidedDemoEntrySeen();
  }, [teardown]);

  const exitDemo = useCallback(async () => {
    await teardown();
  }, [teardown]);

  const advanceDemo = useCallback(async () => {
    const runner = runnerRef.current;
    if (runner === null) return;
    // Serialize: ignore a second tap while a step is still running, so a
    // double-tap on "Next" can't run two steps (duplicate / skipped step).
    if (inFlightRef.current !== null) return;
    const run = (async () => {
      await runner.advance();
      setRunnerTick((t) => t + 1);
    })();
    inFlightRef.current = run;
    setActionInFlight(true);
    try {
      await run;
    } finally {
      inFlightRef.current = null;
      setActionInFlight(false);
    }
  }, []);

  // `runnerTick` participates so the snapshot recomputes on every runner change.
  void runnerTick;
  const runner = runnerRef.current;
  // `currentAction` is the NEXT action — it drives the advance button (label/mode).
  const currentAction = runner?.currentAction ?? null;
  const stepCount = runner?.total ?? 0;
  const demoComplete = runner?.isComplete ?? false;

  // The dock describes the step the user is LOOKING AT, not the one the button
  // will run next. While a step runs it IS that step (its content is appearing,
  // so `currentAction`); when idle it's the last completed step (`previousAction`);
  // before anything has run, fall back to the first step as the intro prompt.
  const displayedAction = actionInFlight ? currentAction : (runner?.previousAction ?? currentAction);
  const caption = displayedAction?.caption ?? null;
  const step =
    runner === null
      ? 0
      : actionInFlight
        ? Math.min(runner.position + 1, runner.total)
        : Math.max(1, runner.position);

  return {
    phase,
    demoActive,
    currentAction,
    caption,
    step,
    stepCount,
    demoComplete,
    actionInFlight,
    startDemo,
    skip,
    continueDemo,
    deleteDemo,
    exitDemo,
    advanceDemo,
  };
}
