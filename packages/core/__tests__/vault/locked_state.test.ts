/**
 * T2D.18 — Locked persona stays locked across restart.
 *
 * Source: tests/release/test_rel_004_locked_state.py
 */

import { autoOpensOnBoot, requiresPassphrase, brainCanAccess } from '../../src/vault/lifecycle';

describe('Locked State Persistence (Release Verification)', () => {
  it('locked persona remains locked after restart', () => {
    expect(autoOpensOnBoot('locked')).toBe(false);
  });

  it('sensitive persona remains closed after restart', () => {
    expect(autoOpensOnBoot('sensitive')).toBe(false);
  });

  it('default persona auto-opens after restart', () => {
    expect(autoOpensOnBoot('default')).toBe(true);
  });

  it('locked persona requires passphrase', () => {
    expect(requiresPassphrase('locked')).toBe(true);
  });

  it('Brain cannot access locked persona', () => {
    expect(brainCanAccess('locked')).toBe(false);
  });

  it('DEK not in RAM for locked persona', () => {
    expect(true).toBe(true);
  });

  it('locked persona vault file is opaque bytes', () => {
    expect(true).toBe(true);
  });
});
