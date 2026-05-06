/**
 * Tests for the auto-lock hook (MT-40).
 *
 * The hook ships in two parts: a pure `installAutoLock` subscription
 * that's testable without React/AppState plumbing, and a `useAutoLock`
 * React mount that wires it to React Native's `AppState`. These tests
 * exercise the pure subscription — that's where the lock policy lives
 * (background → seal, active → cancel, inactive → ignore). The React
 * wiring is shallow enough that asserting it via the mocked AppState
 * adds little beyond what the pure surface already covers.
 */

import { installAutoLock } from '../../src/hooks/useAutoLock';

describe('installAutoLock', () => {
  function makeFakeTimer() {
    let pending: { cb: () => void; ms: number; id: number } | null = null;
    let nextId = 1;
    return {
      schedule: (cb: () => void, ms: number) => {
        const id = nextId++;
        pending = { cb, ms, id };
        return id;
      },
      cancel: (id: unknown) => {
        if (pending && pending.id === id) pending = null;
      },
      fire: () => {
        if (pending !== null) {
          const cb = pending.cb;
          pending = null;
          cb();
        }
      },
      isPending: () => pending !== null,
      pendingMs: () => (pending ? pending.ms : null),
    };
  }

  it('seals on `background` after the configured timeout', () => {
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 5,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    expect(timer.isPending()).toBe(true);
    expect(timer.pendingMs()).toBe(5000);
    expect(sealFn).not.toHaveBeenCalled();

    timer.fire();
    expect(sealFn).toHaveBeenCalledTimes(1);
    expect(sub.isPending()).toBe(false);
  });

  it('seals immediately when the timeout is 0', () => {
    // A user with "lock immediately on background" preference
    // shouldn't see a deferred seal — the contract is "by the time the
    // OS pauses JS, secrets are out of memory".
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 0,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    expect(sealFn).toHaveBeenCalledTimes(1);
    expect(timer.isPending()).toBe(false);
  });

  it('cancels the pending timer when foreground returns before expiry', () => {
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 60,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    expect(timer.isPending()).toBe(true);

    sub.notify('active');
    expect(timer.isPending()).toBe(false);
    expect(sealFn).not.toHaveBeenCalled();
  });

  it('ignores `inactive` so iOS Control Center / app switcher does NOT seal', () => {
    // 'inactive' is the transient state iOS emits during Control
    // Center pulls, the app switcher overlay, and incoming-call
    // splashes that the user dismisses. Sealing on these would force
    // a re-unlock for trivial UI overlays. Real backgrounding lands
    // on a subsequent 'background' state, which is what we honour.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 30,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('inactive');
    expect(timer.isPending()).toBe(false);
    expect(sealFn).not.toHaveBeenCalled();

    // Returning to 'active' is also a no-op — we never armed.
    sub.notify('active');
    expect(timer.isPending()).toBe(false);
    expect(sealFn).not.toHaveBeenCalled();
  });

  it('treats `inactive` mid-background as transient (does not cancel pending seal)', () => {
    // Once we're armed for a background seal, an `inactive` blip
    // (e.g. user pulls notification shade while the app is
    // backgrounded — Android can emit this) must NOT cancel the
    // timer. Only an actual `active` transition cancels.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 30,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    expect(timer.isPending()).toBe(true);

    sub.notify('inactive');
    expect(timer.isPending()).toBe(true);

    timer.fire();
    expect(sealFn).toHaveBeenCalledTimes(1);
  });

  it('coalesces duplicate transitions emitted by RN', () => {
    // RN sometimes emits the same state twice for one OS-level
    // event. Don't double-arm or double-cancel.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 30,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    const firstId = timer.pendingMs();
    sub.notify('background'); // duplicate — must be a no-op
    expect(timer.pendingMs()).toBe(firstId);

    sub.notify('active');
    sub.notify('active'); // duplicate — must not crash
    expect(timer.isPending()).toBe(false);
  });

  it('reads the timeout afresh on each background — Security-page changes take effect immediately', () => {
    // The user's Security-page "Background timeout" picker writes
    // through to `setBackgroundTimeout`. The next time the app
    // backgrounds, we should pick up the new value — not a value
    // captured at hook-mount time. Verifies the closure reads
    // `getTimeoutS()` at notify-time, not at install-time.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    let configuredTimeout = 60;
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => configuredTimeout,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    expect(timer.pendingMs()).toBe(60_000);

    sub.notify('active');
    configuredTimeout = 300;
    sub.notify('background');
    expect(timer.pendingMs()).toBe(300_000);
  });

  it('dispose() cancels any pending timer', () => {
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 30,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    sub.dispose();
    expect(timer.isPending()).toBe(false);
    expect(sealFn).not.toHaveBeenCalled();
  });

  it('seals on `active` resume when wall clock shows the timeout already elapsed (MT-40-I2)', () => {
    // iOS suspends JS while the app is in the background; setTimeout
    // does NOT fire while suspended. Without a wall-clock reconcile
    // on resume, a 90-second background under a 60-second policy
    // would foreground without ever sealing — the bug found during
    // live MT-40 verification on 2026-05-06.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    let nowMs = 1_000_000;
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 60,
      now: () => nowMs,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    expect(timer.isPending()).toBe(true);
    expect(sealFn).not.toHaveBeenCalled();

    // Simulate iOS suspending JS for 90 seconds (timer never fires).
    nowMs += 90_000;
    sub.notify('active');

    // Reconcile must seal even though the in-JS timer didn't fire.
    expect(sealFn).toHaveBeenCalledTimes(1);
    // And it must cancel the pending in-JS timer so a late wake of
    // the suspended event loop doesn't double-seal.
    expect(timer.isPending()).toBe(false);
  });

  it('does NOT reconcile-seal on `active` when wall clock is still under the timeout', () => {
    // Quick task-switch (e.g. glance at Settings, return to Dina
    // within 5s) must not seal. The reconcile only fires when the
    // background interval already exceeded the policy.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    let nowMs = 1_000_000;
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 60,
      now: () => nowMs,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    nowMs += 5_000; // 5s in background — well under 60s policy
    sub.notify('active');

    expect(sealFn).not.toHaveBeenCalled();
    expect(timer.isPending()).toBe(false);
  });

  it('clears the reconcile state after `active` so the next foreground→active no-op stays idle', () => {
    // After a successful reconcile-seal, the next `active`
    // transition (e.g. user unlocks and uses the app, then later
    // ignores Settings) must not seal again on its own.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    let nowMs = 1_000_000;
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 60,
      now: () => nowMs,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    nowMs += 90_000;
    sub.notify('active');
    expect(sealFn).toHaveBeenCalledTimes(1);

    // No further state transitions of consequence: simulate the user
    // staying in the app for a while. Another `active` (which RN
    // shouldn't emit, but defensive) must not re-seal.
    sub.notify('background');
    sub.notify('active');
    nowMs += 1_000;
    sub.notify('active');
    expect(sealFn).toHaveBeenCalledTimes(1);
  });

  it('dispose() resets state so a fresh background→active cycle works after re-mount', () => {
    // Hook unmount/remount (e.g. the user signs out and back in
    // within the same launch) must reset the dedup so the next
    // 'background' actually arms a timer. Without this, the cached
    // last-state would treat the next background as a duplicate.
    const timer = makeFakeTimer();
    const sealFn = jest.fn(async () => {});
    const sub = installAutoLock({
      sealFn,
      getTimeoutS: () => 30,
      scheduleTimer: timer.schedule,
      cancelTimer: timer.cancel,
    });

    sub.notify('background');
    sub.dispose();

    // Same `sub` instance — but dispose reset internal state. A
    // following 'background' must arm again.
    sub.notify('background');
    expect(timer.isPending()).toBe(true);
  });
});
