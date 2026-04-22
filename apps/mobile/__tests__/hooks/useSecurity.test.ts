/**
 * T4.15 — Settings security: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.15
 */

import {
  initSecurity,
  getSecurityStatus,
  validatePassphrase,
  doChangePassphrase,
  setBackgroundTimeoutS,
  setBiometric,
  isBiometricEnabled,
  getPassphraseStrength,
  getTimeoutPresets,
  resetSecurityHook,
} from '../../src/hooks/useSecurity';
import { wrapSeed } from '../../../core/src/crypto/aesgcm';
import { resetPersonaState, createPersona, openPersona } from '../../../core/src/persona/service';
import { resetLifecycleState } from '../../../core/src/lifecycle/sleep_wake';

describe('Security Settings Hook (4.15)', () => {
  beforeEach(() => {
    resetSecurityHook();
    resetPersonaState();
    resetLifecycleState();
  });

  describe('getSecurityStatus', () => {
    it('returns status with no wrapped seed', () => {
      const status = getSecurityStatus();
      expect(status.passphraseSet).toBe(false);
      expect(status.biometricEnabled).toBe(false);
      expect(status.backgroundTimeoutS).toBeGreaterThan(0);
      expect(status.activePersonas).toBe(0);
    });

    it('reflects persona counts', () => {
      createPersona('general', 'default');
      createPersona('work', 'standard');
      openPersona('general', true);

      const status = getSecurityStatus();
      expect(status.totalPersonas).toBe(2);
      expect(status.activePersonas).toBe(1);
    });

    it('reflects biometric state', () => {
      setBiometric(true);
      expect(getSecurityStatus().biometricEnabled).toBe(true);

      setBiometric(false);
      expect(getSecurityStatus().biometricEnabled).toBe(false);
    });
  });

  describe('validatePassphrase', () => {
    it('accepts strong passphrase', () => {
      const result = validatePassphrase('MyStr0ngPass');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects too-short passphrase', () => {
      const result = validatePassphrase('Ab1');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('at least 8');
    });

    it('rejects missing uppercase', () => {
      const result = validatePassphrase('lowercase1');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('uppercase')]));
    });

    it('rejects missing lowercase', () => {
      const result = validatePassphrase('UPPERCASE1');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('lowercase')]));
    });

    it('rejects missing number', () => {
      const result = validatePassphrase('NoNumbers');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('number')]));
    });

    it('can have multiple errors', () => {
      const result = validatePassphrase('ab');
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe('doChangePassphrase', () => {
    it('rejects when not initialized', async () => {
      const result = await doChangePassphrase('old', 'NewPass1!');
      expect(result.success).toBe(false);
      expect(result.error).toContain('unlock first');
    });

    it('changes passphrase successfully', async () => {
      const seed = new Uint8Array(32).fill(0x42);
      const wrapped = await wrapSeed('OldPass1!', seed);
      initSecurity(wrapped);

      const result = await doChangePassphrase('OldPass1!', 'NewPass1!');
      expect(result.success).toBe(true);
    });

    it('rejects wrong old passphrase', async () => {
      const seed = new Uint8Array(32).fill(0x42);
      const wrapped = await wrapSeed('CorrectPass1', seed);
      initSecurity(wrapped);

      const result = await doChangePassphrase('WrongPass1', 'NewPass1!');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Wrong old passphrase');
    });

    it('rejects weak new passphrase', async () => {
      const seed = new Uint8Array(32).fill(0x42);
      const wrapped = await wrapSeed('OldPass1!', seed);
      initSecurity(wrapped);

      const result = await doChangePassphrase('OldPass1!', 'weak');
      expect(result.success).toBe(false);
    });

    it('rejects same old and new passphrase', async () => {
      const seed = new Uint8Array(32).fill(0x42);
      const wrapped = await wrapSeed('SamePass1!', seed);
      initSecurity(wrapped);

      const result = await doChangePassphrase('SamePass1!', 'SamePass1!');
      expect(result.success).toBe(false);
      expect(result.error).toContain('different');
    });
  });

  describe('setBackgroundTimeoutS', () => {
    it('accepts valid timeout', () => {
      const err = setBackgroundTimeoutS(300);
      expect(err).toBeNull();
      expect(getSecurityStatus().backgroundTimeoutS).toBe(300);
    });

    it('rejects too-short timeout', () => {
      expect(setBackgroundTimeoutS(10)).toContain('at least 30');
    });

    it('rejects too-long timeout', () => {
      expect(setBackgroundTimeoutS(7200)).toContain('at most 1 hour');
    });
  });

  describe('biometric toggle', () => {
    it('defaults to disabled', () => {
      expect(isBiometricEnabled()).toBe(false);
    });

    it('can be enabled and disabled', () => {
      setBiometric(true);
      expect(isBiometricEnabled()).toBe(true);

      setBiometric(false);
      expect(isBiometricEnabled()).toBe(false);
    });
  });

  describe('getPassphraseStrength', () => {
    it('rates weak passphrase', () => {
      expect(getPassphraseStrength('ab')).toBe('weak');
    });

    it('rates fair passphrase', () => {
      expect(getPassphraseStrength('Abcdef12')).toBe('fair');
    });

    it('rates strong passphrase', () => {
      expect(getPassphraseStrength('StrongPass123')).toBe('strong');
    });

    it('rates very strong passphrase', () => {
      expect(getPassphraseStrength('V3ry$tr0ngP@ss!')).toBe('very_strong');
    });
  });

  describe('getTimeoutPresets', () => {
    it('returns 5 presets', () => {
      const presets = getTimeoutPresets();
      expect(presets).toHaveLength(5);
      expect(presets[0]).toEqual({ value: 60, label: '1 minute' });
      expect(presets[4]).toEqual({ value: 3600, label: '1 hour' });
    });
  });
});
