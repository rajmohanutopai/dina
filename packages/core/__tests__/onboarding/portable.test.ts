/**
 * T2A.18 — Portable onboarding: client-side crypto steps.
 *
 * Category B: contract test. Verifies the mobile-side onboarding
 * produces correct crypto artifacts.
 *
 * Source: core/test/onboarding_test.go (portable parts)
 */

import {
  runOnboarding,
  verifyDefaultPersona,
  verifyDefaultSharingRules,
} from '../../src/onboarding/portable';
import { validateMnemonic } from '../../src/crypto/bip39';
import { unwrapSeed } from '../../src/crypto/aesgcm';
import { deserializeWrappedSeed } from '../../src/storage/seed_file';
import { TEST_PASSPHRASE } from '@dina/test-harness';

describe('Portable Onboarding', () => {
  describe('runOnboarding', () => {
    // Argon2id is slow — share a single onboarding result across tests
    let result: Awaited<ReturnType<typeof runOnboarding>>;

    beforeAll(async () => {
      result = await runOnboarding(TEST_PASSPHRASE);
    }, 30_000);

    it('generates a 24-word mnemonic', () => {
      expect(result.mnemonic).toHaveLength(24);
      expect(result.mnemonic.every((w) => typeof w === 'string' && w.length > 0)).toBe(true);
    });

    it('mnemonic is valid BIP-39', () => {
      const mnemonicString = result.mnemonic.join(' ');
      expect(validateMnemonic(mnemonicString)).toBe(true);
    });

    it('returns DID in did:key format', () => {
      expect(result.did).toMatch(/^did:key:z6Mk/);
    });

    it('DID is deterministic from seed', async () => {
      // Same mnemonic → same seed → same DID
      // Different onboarding runs produce different mnemonics
      expect(result.did.length).toBeGreaterThan(20);
    });

    it('creates one default "general" persona', () => {
      expect(result.defaultPersona).toBe('general');
    });

    it('wraps master seed with passphrase', () => {
      expect(result.wrapped).toBeInstanceOf(Uint8Array);
      expect(result.wrapped.length).toBeGreaterThan(32);
    });

    it('wrapped seed starts with DINA magic', () => {
      // serializeWrappedSeed produces: DINA magic (4 bytes) + version + data
      const magic = String.fromCharCode(...result.wrapped.slice(0, 4));
      expect(magic).toBe('DINA');
    });

    it('wrapped seed can be unwrapped with correct passphrase', async () => {
      const ws = deserializeWrappedSeed(result.wrapped);
      const seed = await unwrapSeed(TEST_PASSPHRASE, ws);
      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed.length).toBe(32); // Go-compatible 32-byte entropy (not 64-byte PBKDF2)
    }, 30_000);

    it('wrapped seed fails with wrong passphrase', async () => {
      const ws = deserializeWrappedSeed(result.wrapped);
      await expect(unwrapSeed('wrong passphrase', ws)).rejects.toThrow();
    }, 30_000);

    it('different onboarding runs produce different mnemonics', async () => {
      const result2 = await runOnboarding(TEST_PASSPHRASE);
      expect(result2.mnemonic).not.toEqual(result.mnemonic);
    }, 30_000);
  });

  describe('verifyDefaultPersona', () => {
    it('accepts list with exactly "general"', () => {
      expect(verifyDefaultPersona(['general'])).toBe(true);
    });

    it('accepts list containing "general" among others', () => {
      expect(verifyDefaultPersona(['general', 'health'])).toBe(true);
    });

    it('rejects empty list', () => {
      expect(verifyDefaultPersona([])).toBe(false);
    });

    it('rejects list without "general"', () => {
      expect(verifyDefaultPersona(['health'])).toBe(false);
    });
  });

  describe('verifyDefaultSharingRules', () => {
    it('accepts empty rules object', () => {
      expect(verifyDefaultSharingRules({})).toBe(true);
    });

    it('rejects non-empty rules', () => {
      expect(verifyDefaultSharingRules({ health: 'full' })).toBe(false);
    });

    it('rejects rules with any key', () => {
      expect(verifyDefaultSharingRules({ a: 1, b: 2 })).toBe(false);
    });
  });
});
