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

import { modeAfterSeal, type Mode } from '../../src/components/unlock_gate';

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
