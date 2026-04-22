/**
 * T1.52 — Full unlock flow: passphrase → crypto → persona → ready.
 *
 * Source: ARCHITECTURE.md Task 1.52
 */

import { fullUnlock, verifyPassphrase } from '../../src/lifecycle/unlock';
import { wrapSeed } from '../../src/crypto/aesgcm';
import { mnemonicToSeed, generateMnemonic } from '../../src/crypto/bip39';
import { resetPersonaState, listPersonas, isPersonaOpen } from '../../src/persona/service';
import { resetRotationState, getCurrentGeneration } from '../../src/identity/rotation';
import { resetLifecycleState, areSecretsZeroed } from '../../src/lifecycle/sleep_wake';
import { TEST_PASSPHRASE, TEST_PASSPHRASE_WRONG } from '@dina/test-harness';

describe('Full Unlock Flow', () => {
  let wrappedSeed: Awaited<ReturnType<typeof wrapSeed>>;
  let masterSeed: Uint8Array;

  beforeAll(async () => {
    const mnemonic = generateMnemonic();
    masterSeed = mnemonicToSeed(mnemonic);
    wrappedSeed = await wrapSeed(TEST_PASSPHRASE, masterSeed);
  }, 30_000);

  beforeEach(() => {
    resetPersonaState();
    resetRotationState();
    resetLifecycleState();
  });

  describe('fullUnlock', () => {
    it('unlocks and returns DID', async () => {
      const result = await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
        personas: [{ name: 'general', tier: 'default' }],
      });
      expect(result.did).toMatch(/^did:key:z6Mk/);
    }, 30_000);

    it('opens boot personas (default + standard)', async () => {
      const result = await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
        personas: [
          { name: 'general', tier: 'default' },
          { name: 'work', tier: 'standard' },
          { name: 'health', tier: 'sensitive' },
        ],
      });
      expect(result.personasOpened).toContain('general');
      expect(result.personasOpened).toContain('work');
      expect(result.personasOpened).not.toContain('health');
      expect(result.totalPersonas).toBe(3);
    }, 30_000);

    it('general persona is open after unlock', async () => {
      await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
        personas: [{ name: 'general', tier: 'default' }],
      });
      expect(isPersonaOpen('general')).toBe(true);
    }, 30_000);

    it('sensitive persona stays closed after unlock', async () => {
      await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
        personas: [
          { name: 'general', tier: 'default' },
          { name: 'health', tier: 'sensitive' },
        ],
      });
      expect(isPersonaOpen('health')).toBe(false);
    }, 30_000);

    it('initializes key rotation', async () => {
      await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
      });
      expect(getCurrentGeneration()).toBe(0);
    }, 30_000);

    it('marks secrets restored', async () => {
      await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
      });
      expect(areSecretsZeroed()).toBe(false);
    }, 30_000);

    it('wrong passphrase throws', async () => {
      await expect(
        fullUnlock({
          passphrase: TEST_PASSPHRASE_WRONG,
          wrappedSeed,
        }),
      ).rejects.toThrow();
    }, 30_000);

    it('tracks unlock time', async () => {
      const result = await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
      });
      expect(result.unlockTimeMs).toBeGreaterThan(0);
    }, 30_000);

    it('idempotent on re-unlock (personas already exist)', async () => {
      await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
        personas: [{ name: 'general', tier: 'default' }],
      });
      // Re-unlock should not throw
      const result = await fullUnlock({
        passphrase: TEST_PASSPHRASE,
        wrappedSeed,
        personas: [{ name: 'general', tier: 'default' }],
      });
      expect(result.did).toMatch(/^did:key:z6Mk/);
    }, 60_000);
  });

  describe('verifyPassphrase', () => {
    it('correct passphrase → true', async () => {
      expect(await verifyPassphrase(TEST_PASSPHRASE, wrappedSeed)).toBe(true);
    }, 30_000);

    it('wrong passphrase → false', async () => {
      expect(await verifyPassphrase(TEST_PASSPHRASE_WRONG, wrappedSeed)).toBe(false);
    }, 30_000);
  });
});
