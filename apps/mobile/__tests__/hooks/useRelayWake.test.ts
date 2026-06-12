/**
 * Tests for the relay-wake hook (#351 foreground complement).
 *
 * Like `useAutoLock`, the hook ships in two parts: a pure
 * `installRelayWake` subscription (testable without React/AppState) and
 * a thin `useRelayWake` React mount that wires it to `AppState`. These
 * tests exercise the pure subscription — that's where the wake policy
 * lives (wake on any durable transition INTO `active`; ignore
 * `inactive` as a transient overlay; coalesce `active` duplicates). The
 * React wiring is shallow enough that asserting it via the mocked
 * AppState adds little beyond the pure surface.
 *
 * The contract that matters: on background→foreground we must call
 * `wakeRelay()` exactly once so the relay reconnects immediately rather
 * than waiting out the idle-staleness threshold (the ~90s / 10-min
 * window the keepalive would otherwise need to notice the dead socket).
 */

import { installRelayWake } from '../../src/hooks/useRelayWake';

describe('installRelayWake', () => {
  it('wakes on the cold first `active` (unknown → active)', () => {
    // App launches straight into the foreground after unlock. There is
    // no prior state, so the first `active` is a genuine resume edge.
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('active');
    expect(wakeFn).toHaveBeenCalledTimes(1);
  });

  it('wakes on a real background → active resume', () => {
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('active'); // cold start
    expect(wakeFn).toHaveBeenCalledTimes(1);

    sub.notify('background'); // app suspended (no wake)
    expect(wakeFn).toHaveBeenCalledTimes(1);

    sub.notify('active'); // resume — the case this hook exists for
    expect(wakeFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT wake on `background` or `inactive` — only the resume edge', () => {
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('background');
    sub.notify('inactive');
    expect(wakeFn).not.toHaveBeenCalled();
  });

  it('still wakes across the iOS background → inactive → active sequence', () => {
    // The bug this guards: iOS emits `background → inactive → active`
    // on resume. If `inactive` moved `lastState` off 'background', the
    // final edge would read as `inactive → active` — fine here — but
    // more importantly a lone `inactive` must not consume the resume.
    // We assert the full real-device sequence wakes exactly once.
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('active'); // cold start (1)
    sub.notify('background'); // suspend
    sub.notify('inactive'); // transient on the way back up — ignored
    expect(wakeFn).toHaveBeenCalledTimes(1);

    sub.notify('active'); // resume (2)
    expect(wakeFn).toHaveBeenCalledTimes(2);
  });

  it('treats `inactive` as transient and never as a resume edge', () => {
    // A lone `inactive → active` (Control Center pull, app-switcher
    // peek that the user dismisses) without an intervening background.
    // `inactive` returns early without touching lastState, so the
    // following `active` is still evaluated against the prior durable
    // state. From a cold start that prior state is 'unknown', so the
    // first real `active` legitimately wakes once.
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('inactive'); // ignored, lastState stays 'unknown'
    expect(wakeFn).not.toHaveBeenCalled();

    sub.notify('active'); // first durable active → wake (1)
    expect(wakeFn).toHaveBeenCalledTimes(1);

    sub.notify('inactive'); // transient overlay — ignored
    sub.notify('active'); // back from the overlay, no real suspend
    // lastState was already 'active' (inactive didn't move it), so this
    // is a coalesced duplicate — no second wake.
    expect(wakeFn).toHaveBeenCalledTimes(1);
  });

  it('coalesces duplicate `active` transitions RN may emit', () => {
    // RN can emit the same state twice for one OS event. A second
    // `active` with no intervening background must not double-wake.
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('active');
    sub.notify('active'); // duplicate — must be a no-op
    expect(wakeFn).toHaveBeenCalledTimes(1);
  });

  it('dispose() resets state so a fresh resume cycle wakes again', () => {
    // Hook unmount/remount (sign out → back in within one launch)
    // must reset the dedup. Without it, the cached last-state would
    // swallow the next `active` as a duplicate.
    const wakeFn = jest.fn();
    const sub = installRelayWake({ wakeFn });

    sub.notify('active');
    expect(wakeFn).toHaveBeenCalledTimes(1);

    sub.dispose(); // lastState → 'unknown'
    sub.notify('active'); // fresh cold-start edge after re-mount
    expect(wakeFn).toHaveBeenCalledTimes(2);
  });
});
