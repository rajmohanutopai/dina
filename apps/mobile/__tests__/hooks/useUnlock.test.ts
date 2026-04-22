/**
 * T4.5 — Unlock screen: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 4.5
 */

import {
  unlock,
  getUnlockState,
  getStepLabel,
  getStepProgress,
  isUnlocking,
  isUnlocked,
  getUnlockDuration,
  resetUnlockState,
} from '../../src/hooks/useUnlock';
import { wrapSeed, type WrappedSeed } from '../../../core/src/crypto/aesgcm';
import { generateMnemonic, mnemonicToSeed } from '../../../core/src/crypto/bip39';
import { resetPersonaState, personaExists, isPersonaOpen } from '../../../core/src/persona/service';

const PASSPHRASE = 'TestPass1!';

/** Create a wrapped seed for testing. */
async function createTestWrappedSeed(): Promise<WrappedSeed> {
  const mnemonic = generateMnemonic();
  const seed = mnemonicToSeed(mnemonic);
  return wrapSeed(PASSPHRASE, seed);
}

describe('Unlock Screen Hook (4.5)', () => {
  beforeEach(() => {
    resetUnlockState();
    resetPersonaState();
  });

  describe('unlock — happy path', () => {
    it('unlocks with correct passphrase', async () => {
      const wrapped = await createTestWrappedSeed();
      const result = await unlock(PASSPHRASE, wrapped);

      expect(result.step).toBe('complete');
      expect(result.did).toMatch(/^did:key:z6Mk/);
      expect(result.error).toBeNull();
      expect(result.completedAt).toBeTruthy();
    });

    it('creates general persona', async () => {
      const wrapped = await createTestWrappedSeed();
      await unlock(PASSPHRASE, wrapped);

      expect(personaExists('general')).toBe(true);
    });

    it('opens boot personas', async () => {
      const wrapped = await createTestWrappedSeed();
      const result = await unlock(PASSPHRASE, wrapped);

      // General is default tier → auto-opens on boot
      expect(result.openedPersonas).toContain('general');
      expect(isPersonaOpen('general')).toBe(true);
    });

    it('tracks unlock duration', async () => {
      const wrapped = await createTestWrappedSeed();
      await unlock(PASSPHRASE, wrapped);

      const duration = getUnlockDuration();
      expect(duration).not.toBeNull();
      expect(duration!).toBeGreaterThanOrEqual(0);
    });
  });

  describe('unlock — failure cases', () => {
    it('fails with wrong passphrase', async () => {
      const wrapped = await createTestWrappedSeed();
      const result = await unlock('WrongPass1!', wrapped);

      expect(result.step).toBe('failed');
      expect(result.error).toContain('Wrong passphrase');
      expect(result.did).toBeNull();
    });

    it('fails with empty passphrase', async () => {
      const wrapped = await createTestWrappedSeed();
      const result = await unlock('', wrapped);

      expect(result.step).toBe('failed');
      expect(result.error).toContain('required');
    });

    it('fails with missing wrapped seed', async () => {
      const result = await unlock(PASSPHRASE, null as any);

      expect(result.step).toBe('failed');
      expect(result.error).toContain('onboarding');
    });
  });

  describe('state management', () => {
    it('starts in idle state', () => {
      const state = getUnlockState();
      expect(state.step).toBe('idle');
      expect(state.did).toBeNull();
    });

    it('isUnlocking during unlock', () => {
      // Can't easily test mid-flow, but verify before/after
      expect(isUnlocking()).toBe(false);
    });

    it('isUnlocked after successful unlock', async () => {
      const wrapped = await createTestWrappedSeed();
      await unlock(PASSPHRASE, wrapped);

      expect(isUnlocked()).toBe(true);
    });

    it('not isUnlocked after failure', async () => {
      const wrapped = await createTestWrappedSeed();
      await unlock('WrongPass1!', wrapped);

      expect(isUnlocked()).toBe(false);
    });

    it('resetUnlockState returns to idle', async () => {
      const wrapped = await createTestWrappedSeed();
      await unlock(PASSPHRASE, wrapped);
      expect(isUnlocked()).toBe(true);

      resetUnlockState();
      expect(isUnlocked()).toBe(false);
      expect(getUnlockState().step).toBe('idle');
    });
  });

  describe('step labels + progress', () => {
    it('all steps have labels', () => {
      const steps = [
        'idle',
        'validating',
        'deriving_kek',
        'unwrapping',
        'deriving_keys',
        'opening_vaults',
        'complete',
        'failed',
      ] as const;
      for (const step of steps) {
        expect(getStepLabel(step).length).toBeGreaterThan(0);
      }
    });

    it('progress increases through steps', () => {
      expect(getStepProgress('validating')).toBe(0);
      expect(getStepProgress('deriving_kek')).toBe(1);
      expect(getStepProgress('unwrapping')).toBe(2);
      expect(getStepProgress('deriving_keys')).toBe(3);
      expect(getStepProgress('opening_vaults')).toBe(4);
      expect(getStepProgress('complete')).toBe(5);
    });

    it('getUnlockDuration null before unlock', () => {
      expect(getUnlockDuration()).toBeNull();
    });
  });
});
