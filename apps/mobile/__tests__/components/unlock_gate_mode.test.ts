/**
 * UnlockGate mode-transition contract.
 *
 * Pins the wipe→onboarding fix: after the vault transitions from
 * unlocked to sealed, the gate must route to `onboarding` when the
 * wrapped seed is gone (Sign out / Erase everything) instead of showing
 * the "Welcome back / enter passphrase" form for a vault that no longer
 * exists. A plain seal / background auto-lock (wrapped seed still
 * present) still goes to `locked`.
 */

import { modeAfterSeal, staffRouteView, type Mode } from '../../src/components/unlock_gate';

describe('modeAfterSeal', () => {
  it('Erase everything / Sign out (seed deleted) → onboarding, not a passphrase prompt', () => {
    expect(modeAfterSeal('unlocked', false)).toBe('onboarding');
  });

  it('manual seal / background auto-lock (seed kept) → locked', () => {
    expect(modeAfterSeal('unlocked', true)).toBe('locked');
  });

  it('first-render and other prior modes are left to the mount probe (no-op)', () => {
    const untouched: Mode[] = ['loading', 'onboarding', 'locked', 'unlocking'];
    for (const prev of untouched) {
      expect(modeAfterSeal(prev, false)).toBe(prev);
      expect(modeAfterSeal(prev, true)).toBe(prev);
    }
  });
});

describe('staffRouteView — a staff phone has no vault, and still has screens (§6.3)', () => {
  it('onboarding lets "Join as staff" render, and nothing else', () => {
    expect(staffRouteView('onboarding', '/staff-join')).toBe('navigator');
    expect(staffRouteView('onboarding', '/')).toBe('onboarding');
    expect(staffRouteView('onboarding', '/staff-home')).toBe('onboarding');
  });

  it('staff mode renders the staff home, the join screen and the tender; anything else goes home', () => {
    expect(staffRouteView('staff', '/staff-home')).toBe('navigator');
    expect(staffRouteView('staff', '/tender')).toBe('navigator');
    expect(staffRouteView('staff', '/staff-join')).toBe('navigator');
    expect(staffRouteView('staff', '/')).toBe('staff_redirect');
    expect(staffRouteView('staff', '/vault')).toBe('staff_redirect');
  });

  it('leaves every vault mode to the gate', () => {
    for (const mode of ['loading', 'locked', 'unlocking', 'unlocked'] as Mode[]) {
      expect(staffRouteView(mode, '/staff-home')).toBeNull();
    }
  });
});
