/**
 * T4.3 — Identity recovery from mnemonic.
 *
 * Source: ARCHITECTURE.md Task 4.3
 */

import { recoverFromMnemonic, validateRecoveryMnemonic } from '../../src/onboarding/recovery';
import { runOnboarding } from '../../src/onboarding/portable';
import { TEST_PASSPHRASE, TEST_PASSPHRASE_WRONG } from '@dina/test-harness';
import { deserializeWrappedSeed } from '../../src/storage/seed_file';
import { unwrapSeed } from '../../src/crypto/aesgcm';

describe('Identity Recovery from Mnemonic', () => {
  // Generate a real mnemonic to test recovery
  let mnemonic: string[];
  let originalDID: string;

  beforeAll(async () => {
    const onboarding = await runOnboarding(TEST_PASSPHRASE);
    mnemonic = onboarding.mnemonic;
    originalDID = onboarding.did;
  }, 30_000);

  describe('recoverFromMnemonic', () => {
    it('recovers the same DID from the same mnemonic', async () => {
      const result = await recoverFromMnemonic(mnemonic, TEST_PASSPHRASE);
      expect(result.did).toBe(originalDID);
      expect(result.mnemonicValid).toBe(true);
    }, 30_000);

    it('accepts string input (space-separated)', async () => {
      const result = await recoverFromMnemonic(mnemonic.join(' '), TEST_PASSPHRASE);
      expect(result.did).toBe(originalDID);
    }, 30_000);

    it('wraps seed with new passphrase', async () => {
      const result = await recoverFromMnemonic(mnemonic, 'new-passphrase');
      expect(result.wrapped.length).toBeGreaterThan(32);
      // Verify the new passphrase works
      const ws = deserializeWrappedSeed(result.wrapped);
      const seed = await unwrapSeed('new-passphrase', ws);
      expect(seed.length).toBe(32); // Go-compatible 32-byte entropy
    }, 60_000);

    it('old passphrase does NOT decrypt new wrapped seed', async () => {
      const result = await recoverFromMnemonic(mnemonic, 'brand-new-passphrase');
      const ws = deserializeWrappedSeed(result.wrapped);
      await expect(unwrapSeed(TEST_PASSPHRASE, ws)).rejects.toThrow();
    }, 60_000);

    it('wrapped seed starts with DINA magic', async () => {
      const result = await recoverFromMnemonic(mnemonic, TEST_PASSPHRASE);
      expect(String.fromCharCode(...result.wrapped.slice(0, 4))).toBe('DINA');
    }, 30_000);

    it('verifies DID matches expected', async () => {
      await expect(
        recoverFromMnemonic(mnemonic, TEST_PASSPHRASE, originalDID),
      ).resolves.toBeDefined();
    }, 30_000);

    it('throws on DID mismatch', async () => {
      await expect(
        recoverFromMnemonic(mnemonic, TEST_PASSPHRASE, 'did:key:z6MkWrong'),
      ).rejects.toThrow('DID mismatch');
    }, 30_000);

    it('throws on invalid mnemonic', async () => {
      await expect(
        recoverFromMnemonic(
          'invalid words that are not a real mnemonic phrase at all',
          TEST_PASSPHRASE,
        ),
      ).rejects.toThrow('invalid mnemonic');
    });
  });

  describe('validateRecoveryMnemonic', () => {
    it('valid 24-word mnemonic → valid', () => {
      const result = validateRecoveryMnemonic(mnemonic);
      expect(result.valid).toBe(true);
      expect(result.wordCount).toBe(24);
    });

    it('wrong word count → invalid', () => {
      const result = validateRecoveryMnemonic('one two three');
      expect(result.valid).toBe(false);
      expect(result.wordCount).toBe(3);
      expect(result.error).toContain('Expected 24');
    });

    it('invalid checksum → invalid', () => {
      // Replace last word to break checksum
      const broken = [...mnemonic];
      broken[23] = broken[23] === 'abandon' ? 'zoo' : 'abandon';
      const result = validateRecoveryMnemonic(broken);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('checksum');
    });

    it('accepts array input', () => {
      expect(validateRecoveryMnemonic(mnemonic).valid).toBe(true);
    });

    it('accepts string input', () => {
      expect(validateRecoveryMnemonic(mnemonic.join(' ')).valid).toBe(true);
    });

    it('empty → invalid', () => {
      expect(validateRecoveryMnemonic('').valid).toBe(false);
    });
  });
});
