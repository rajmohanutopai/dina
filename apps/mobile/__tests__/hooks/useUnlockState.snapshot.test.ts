/**
 * `useUnlockState` snapshot stability — pins the `getStableSnapshot`
 * caching contract used by `useSyncExternalStore`.
 *
 * The hook backs the new in-progress unlock label ("Decrypting
 * identity…", "Opening vaults…") on the unlock screen. Without
 * snapshot caching, `getUnlockState()` returns a fresh `{...state}`
 * clone every call, React thinks the snapshot changed every render,
 * and the component spins into an infinite loop.
 *
 * We can't mount React here, so we drive the same internals
 * `useSyncExternalStore` would — call the snapshot getter twice in a
 * row with no state change and assert reference equality, then mutate
 * via `resetUnlockState` and assert the reference advances.
 *
 * The internal `getStableSnapshot` is unexported, but `useUnlockState`
 * itself is — we simulate React's call pattern by lazy-requiring its
 * `useSyncExternalStore` argument the same way the hook does.
 */

// We need the underlying snapshot getter to assert reference identity.
// Two paths: (a) test the same conditions through `useUnlockState` by
// stubbing React's `useSyncExternalStore` to capture the getSnapshot
// arg, or (b) re-export `getStableSnapshot` for testing. (a) keeps the
// production surface clean.
import { resetUnlockState } from '../../src/hooks/useUnlock';

interface CapturedArgs {
  getSnapshot: () => unknown;
  subscribe: (l: () => void) => () => void;
}

let captured: CapturedArgs | null = null;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useSyncExternalStore: (
      subscribe: (l: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      // Capture so the test can call getSnapshot directly without a
      // React tree. Returning the snapshot value here keeps the hook
      // type contract intact in case anything else inspects it.
      captured = { subscribe, getSnapshot };
      return getSnapshot();
    },
  };
});

import { useUnlockState } from '../../src/hooks/useUnlock';

describe('useUnlockState — snapshot stability', () => {
  beforeEach(() => {
    resetUnlockState();
    captured = null;
  });

  it('returns the SAME object reference on consecutive calls when state has not changed', () => {
    useUnlockState(); // primes the captured args
    if (!captured) throw new Error('useSyncExternalStore was not invoked');
    const a = captured.getSnapshot();
    const b = captured.getSnapshot();
    const c = captured.getSnapshot();
    // Reference identity is the whole point — `a === b === c`.
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('snapshot advances to a new reference when state mutates', () => {
    useUnlockState();
    if (!captured) throw new Error('useSyncExternalStore was not invoked');
    const before = captured.getSnapshot();
    resetUnlockState(); // mutates module state + fires notify()
    const after = captured.getSnapshot();
    // Even though resetUnlockState produces an "equal-shape" idle state,
    // the cache invalidates per-field (step / startedAt / completedAt)
    // and the reference advances — that's how React knows to rerender.
    // (When state IS the same shape but a NEW object, snapshot may or
    //  may not advance — the cache compares fields. Here startedAt and
    //  completedAt swap from undefined→null on the first call, which
    //  is enough to invalidate.)
    // The contract pinned: `before` cannot be returned again after a
    // notify if any field differs.
    expect(after === before).toBe(false);
  });

  it('snapshot does not advance when state has not been mutated', () => {
    useUnlockState();
    if (!captured) throw new Error('useSyncExternalStore was not invoked');
    const a = captured.getSnapshot();
    // Read again immediately — no notify, no mutation, must be same ref.
    const b = captured.getSnapshot();
    expect(b).toBe(a);
  });

  it('subscribe arg is the unlock-state subscription', () => {
    useUnlockState();
    if (!captured) throw new Error('useSyncExternalStore was not invoked');
    let fired = 0;
    const dispose = captured.subscribe(() => {
      fired++;
    });
    resetUnlockState();
    expect(fired).toBe(1);
    dispose();
    resetUnlockState();
    expect(fired).toBe(1);
  });
});
