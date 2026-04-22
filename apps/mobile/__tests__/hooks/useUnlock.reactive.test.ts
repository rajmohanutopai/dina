/**
 * useUnlock reactivity contract — `subscribeToUnlockState` is what
 * `useIsUnlocked` hangs on so the RootLayout re-runs boot the moment
 * unlock flips. Without this the layout only saw `isUnlocked()` at
 * mount and relied on navigation remounts (issue #12).
 *
 * Test strategy: drive state via the public `resetUnlockState` /
 * mutation helpers and assert the subscriber fired the right number of
 * times. We don't mount React.
 */

import { subscribeToUnlockState, resetUnlockState, isUnlocked } from '../../src/hooks/useUnlock';

describe('subscribeToUnlockState — notifies on state transitions', () => {
  it('fires the listener when resetUnlockState is called', () => {
    let fired = 0;
    const unsubscribe = subscribeToUnlockState(() => {
      fired++;
    });
    resetUnlockState();
    expect(fired).toBe(1);
    resetUnlockState();
    expect(fired).toBe(2);
    unsubscribe();
    resetUnlockState();
    expect(fired).toBe(2); // unsubscribe actually removes the listener
  });

  it('multiple subscribers all fire', () => {
    const seen: string[] = [];
    const u1 = subscribeToUnlockState(() => seen.push('a'));
    const u2 = subscribeToUnlockState(() => seen.push('b'));
    resetUnlockState();
    expect(seen).toEqual(['a', 'b']);
    u1();
    u2();
  });

  it('a throwing listener does not block other listeners', () => {
    const seen: string[] = [];
    const u1 = subscribeToUnlockState(() => {
      throw new Error('boom');
    });
    const u2 = subscribeToUnlockState(() => seen.push('still-fires'));
    // Must NOT throw out of notify — the unlock flow calls notify()
    // from inside state transitions and can't have a broken subscriber
    // corrupt global state.
    expect(() => resetUnlockState()).not.toThrow();
    expect(seen).toEqual(['still-fires']);
    u1();
    u2();
  });
});

describe('isUnlocked snapshot — used as the getSnapshot for useSyncExternalStore', () => {
  it('returns false when no unlock has completed', () => {
    resetUnlockState();
    expect(isUnlocked()).toBe(false);
  });
});
