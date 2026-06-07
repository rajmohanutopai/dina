/**
 * Guided-demo replay request — a one-shot signal so any screen can ask the
 * gate to (re)start the guided demo.
 *
 * Why this module exists: `startDemo()` lives inside `useGuidedDemoGate`, which
 * is instantiated once in `GuidedDemoGate` at the root layout. Screens that
 * want to launch the demo on demand (the Help screen's "See Dina in action"
 * CTA) aren't in that hook's scope. Rather than lift the gate into a Context
 * (which would couple every route to the layout's render tree), a module-level
 * fire+subscribe signal lets the gate listen and react. The first-run entry
 * screen still calls `startDemo()` directly — this is only the "any time" path.
 *
 * Mirrors the `navigation/menu_state.ts` external-store pattern.
 */

const listeners = new Set<() => void>();

/**
 * Ask the gate to start the guided demo. Fire-and-forget: the gate decides
 * whether to honor it (only from the normal running app, never mid-demo). The
 * caller typically also navigates to Chat so the demo dock is visible.
 */
export function requestGuidedDemoReplay(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — a subscriber bug must not break the emit */
    }
  }
}

/** Subscribe to replay requests. Returns an unsubscribe disposer. */
export function subscribeGuidedDemoReplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset for tests. */
export function resetGuidedDemoReplayForTest(): void {
  listeners.clear();
}
