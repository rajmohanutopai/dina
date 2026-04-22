/**
 * T1A.4 — HKDF-SHA256 per-persona DEK derivation.
 *
 * Category A: fixture-based. Verifies all 11 persona DEKs match Go
 * output for the same seed, user salt, and info strings.
 *
 * HKDF params (from Go keyderiver.go):
 *   IKM:  masterSeed (first 32 bytes of BIP-39 seed)
 *   Salt: userSalt (32-byte random, stored alongside wrapped seed)
 *   Info: "dina:vault:{name}:v1"
 *   Len:  32
 *
 * Source: core/internal/adapter/crypto/keyderiver.go
 */

import { derivePersonaDEK, deriveBackupKey, deriveDEKHash } from '../../src/crypto/hkdf';
import {
  TEST_MNEMONIC_SEED,
  TEST_USER_SALT,
  HKDF_INFO_STRINGS,
  hasFixture,
  loadVectors,
  hexToBytes,
  bytesToHex,
} from '@dina/test-harness';

describe('HKDF-SHA256 DEK Derivation', () => {
  const masterSeed = TEST_MNEMONIC_SEED.slice(0, 32);
  const userSalt = TEST_USER_SALT;

  describe('derivePersonaDEK', () => {
    for (const personaName of Object.keys(HKDF_INFO_STRINGS)) {
      it(`derives DEK for "${personaName}" persona`, () => {
        const dek = derivePersonaDEK(masterSeed, personaName, userSalt);
        expect(dek.length).toBe(32);
      });
    }

    it('produces 32-byte DEK', () => {
      const dek = derivePersonaDEK(masterSeed, 'health', userSalt);
      expect(dek).toBeInstanceOf(Uint8Array);
      expect(dek.length).toBe(32);
    });

    it('produces different DEKs for different personas', () => {
      const healthDek = derivePersonaDEK(masterSeed, 'health', userSalt);
      const financialDek = derivePersonaDEK(masterSeed, 'financial', userSalt);
      expect(bytesToHex(healthDek)).not.toBe(bytesToHex(financialDek));
    });

    it('is deterministic (same inputs → same DEK)', () => {
      const dek1 = derivePersonaDEK(masterSeed, 'general', userSalt);
      const dek2 = derivePersonaDEK(masterSeed, 'general', userSalt);
      expect(bytesToHex(dek1)).toBe(bytesToHex(dek2));
    });

    it('rejects empty persona name', () => {
      expect(() => derivePersonaDEK(masterSeed, '', userSalt)).toThrow('empty persona name');
    });

    it('rejects short master seed', () => {
      expect(() => derivePersonaDEK(new Uint8Array(8), 'health', userSalt)).toThrow(
        'master seed too short',
      );
    });

    it('rejects short user salt', () => {
      expect(() => derivePersonaDEK(masterSeed, 'health', new Uint8Array(8))).toThrow(
        'user salt too short',
      );
    });
  });

  describe('deriveBackupKey', () => {
    it('derives a 32-byte backup encryption key', () => {
      const key = deriveBackupKey(masterSeed, userSalt);
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('backup key differs from all persona DEKs', () => {
      const backupKey = bytesToHex(deriveBackupKey(masterSeed, userSalt));
      for (const name of Object.keys(HKDF_INFO_STRINGS)) {
        const dek = bytesToHex(derivePersonaDEK(masterSeed, name, userSalt));
        expect(backupKey).not.toBe(dek);
      }
    });
  });

  describe('deriveDEKHash', () => {
    it('computes SHA-256 hex hash of a DEK', () => {
      const dek = derivePersonaDEK(masterSeed, 'identity', userSalt);
      const hash = deriveDEKHash(dek);
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // hex SHA-256
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    });

    it('produces deterministic hash', () => {
      const dek = derivePersonaDEK(masterSeed, 'general', userSalt);
      const h1 = deriveDEKHash(dek);
      const h2 = deriveDEKHash(dek);
      expect(h1).toBe(h2);
    });

    it('rejects non-32-byte input', () => {
      expect(() => deriveDEKHash(new Uint8Array(16))).toThrow('DEK must be exactly 32 bytes');
    });
  });

  // ------------------------------------------------------------------
  // Fixture-based cross-language verification
  // ------------------------------------------------------------------

  const fixture = 'crypto/hkdf_persona_deks.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: HKDF DEKs (Go fixtures)', () => {
    const vectors = loadVectors<
      { master_seed_hex: string; user_salt_hex: string; persona_name: string },
      { dek_hex: string; dek_hash_hex: string }
    >(fixture);

    for (const v of vectors) {
      it(`${v.inputs.persona_name} DEK matches Go`, () => {
        const dek = derivePersonaDEK(
          hexToBytes(v.inputs.master_seed_hex),
          v.inputs.persona_name,
          hexToBytes(v.inputs.user_salt_hex),
        );
        expect(bytesToHex(dek)).toBe(v.expected.dek_hex);
      });

      it(`${v.inputs.persona_name} DEK hash matches Go`, () => {
        const dek = derivePersonaDEK(
          hexToBytes(v.inputs.master_seed_hex),
          v.inputs.persona_name,
          hexToBytes(v.inputs.user_salt_hex),
        );
        expect(deriveDEKHash(dek)).toBe(v.expected.dek_hash_hex);
      });
    }
  });
});
