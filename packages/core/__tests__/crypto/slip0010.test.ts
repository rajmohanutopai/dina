/**
 * T1A.2 — SLIP-0010 Ed25519 hierarchical key derivation.
 *
 * Category A: fixture-based. Verifies derivation at all Dina paths
 * matches Go test vectors bit-for-bit.
 *
 * Source: core/test/crypto_test.go (TestCrypto_2_*)
 */

import {
  derivePath,
  derivePathSecp256k1,
  deriveRootSigningKey,
  derivePersonaSigningKey,
  deriveRotationKey,
} from '../../src/crypto/slip0010';
import {
  TEST_MNEMONIC_SEED,
  DINA_ROOT_KEY_PATH,
  DINA_PERSONA_PATHS,
  DINA_PLC_RECOVERY_PATH,
  hasFixture,
  loadVectors,
  hexToBytes,
  bytesToHex,
} from '@dina/test-harness';

describe('SLIP-0010 Key Derivation', () => {
  const seed = TEST_MNEMONIC_SEED;

  describe('derivePath', () => {
    it("derives root signing key at m/9999'/0'/0'", () => {
      const result = derivePath(seed, DINA_ROOT_KEY_PATH);
      expect(result.privateKey.length).toBe(32);
      expect(result.publicKey.length).toBe(32);
      expect(result.chainCode.length).toBe(32);
    });

    it('derives consumer persona key', () => {
      const result = derivePath(seed, DINA_PERSONA_PATHS.consumer);
      expect(result.privateKey.length).toBe(32);
    });

    it('derives health persona key', () => {
      const result = derivePath(seed, DINA_PERSONA_PATHS.health);
      expect(result.privateKey.length).toBe(32);
    });

    it('derives financial persona key', () => {
      const result = derivePath(seed, DINA_PERSONA_PATHS.financial);
      expect(result.privateKey.length).toBe(32);
    });

    it('derives PLC rotation key', () => {
      const result = derivePath(seed, DINA_PLC_RECOVERY_PATH);
      expect(result.privateKey.length).toBe(32);
    });
  });

  describe('convenience functions', () => {
    it('deriveRootSigningKey at generation 0', () => {
      const result = deriveRootSigningKey(seed, 0);
      const direct = derivePath(seed, "m/9999'/0'/0'");
      expect(bytesToHex(result.privateKey)).toBe(bytesToHex(direct.privateKey));
    });

    it('derivePersonaSigningKey for consumer (index 0, gen 0)', () => {
      const result = derivePersonaSigningKey(seed, 0, 0);
      const direct = derivePath(seed, "m/9999'/1'/0'/0'");
      expect(bytesToHex(result.privateKey)).toBe(bytesToHex(direct.privateKey));
    });

    it('derivePersonaSigningKey for health (index 3, gen 0)', () => {
      const result = derivePersonaSigningKey(seed, 3, 0);
      const direct = derivePath(seed, "m/9999'/1'/3'/0'");
      expect(bytesToHex(result.privateKey)).toBe(bytesToHex(direct.privateKey));
    });

    it('deriveRotationKey uses secp256k1 derivation', () => {
      const result = deriveRotationKey(seed, 0);
      const direct = derivePathSecp256k1(seed, "m/9999'/2'/0'");
      expect(bytesToHex(result.privateKey)).toBe(bytesToHex(direct.privateKey));
    });
  });

  describe('secp256k1 derivation (derivePathSecp256k1)', () => {
    it("derives rotation key at m/9999'/2'/0'", () => {
      const result = derivePathSecp256k1(seed, DINA_PLC_RECOVERY_PATH);
      expect(result.privateKey.length).toBe(32);
      expect(result.chainCode.length).toBe(32);
      // secp256k1 compressed public key is 33 bytes
      expect(result.publicKey.length).toBe(33);
    });

    it('produces different keys than Ed25519 derivation for same path', () => {
      const secp = derivePathSecp256k1(seed, DINA_PLC_RECOVERY_PATH);
      const ed = derivePath(seed, DINA_PLC_RECOVERY_PATH);
      expect(bytesToHex(secp.privateKey)).not.toBe(bytesToHex(ed.privateKey));
    });

    it('is deterministic', () => {
      const r1 = derivePathSecp256k1(seed, DINA_PLC_RECOVERY_PATH);
      const r2 = derivePathSecp256k1(seed, DINA_PLC_RECOVERY_PATH);
      expect(bytesToHex(r1.privateKey)).toBe(bytesToHex(r2.privateKey));
      expect(bytesToHex(r1.publicKey)).toBe(bytesToHex(r2.publicKey));
    });
  });

  describe('all persona paths produce distinct keys', () => {
    it('each persona path derivation is distinct', () => {
      const keys = new Set<string>();
      for (const path of Object.values(DINA_PERSONA_PATHS)) {
        const result = derivePath(seed, path);
        keys.add(bytesToHex(result.privateKey));
      }
      expect(keys.size).toBe(Object.keys(DINA_PERSONA_PATHS).length);
    });
  });

  describe('determinism', () => {
    it('same seed + same path → same key', () => {
      const r1 = derivePath(seed, DINA_ROOT_KEY_PATH);
      const r2 = derivePath(seed, DINA_ROOT_KEY_PATH);
      expect(bytesToHex(r1.privateKey)).toBe(bytesToHex(r2.privateKey));
      expect(bytesToHex(r1.publicKey)).toBe(bytesToHex(r2.publicKey));
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const rootFixture = 'crypto/slip0010_root_signing_key.json';
  const personaFixture = 'crypto/slip0010_persona_keys.json';

  const rootSuite = hasFixture(rootFixture) ? describe : describe.skip;
  rootSuite('cross-language: root signing key (Go fixtures)', () => {
    const vectors = loadVectors<
      { seed_hex: string; path: string },
      { public_key_hex: string; private_key_hex: string }
    >(rootFixture);

    for (const v of vectors) {
      it(v.description, () => {
        const result = derivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        expect(bytesToHex(result.publicKey)).toBe(v.expected.public_key_hex);
        expect(bytesToHex(result.privateKey)).toBe(v.expected.private_key_hex);
      });
    }
  });

  const rotationFixture = 'crypto/slip0010_rotation_key.json';
  const rotationSuite = hasFixture(rotationFixture) ? describe : describe.skip;
  rotationSuite('cross-language: rotation key secp256k1 (Go fixtures)', () => {
    const vectors = loadVectors<{ seed_hex: string; path: string }, { private_key_hex: string }>(
      rotationFixture,
    );

    for (const v of vectors) {
      it(v.description, () => {
        const result = derivePathSecp256k1(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        expect(bytesToHex(result.privateKey)).toBe(v.expected.private_key_hex);
      });
    }
  });

  const personaSuite = hasFixture(personaFixture) ? describe : describe.skip;
  personaSuite('cross-language: persona keys (Go fixtures)', () => {
    const vectors = loadVectors<
      { seed_hex: string; path: string; persona_name: string },
      { public_key_hex: string; private_key_hex: string }
    >(personaFixture);

    for (const v of vectors) {
      it(`${v.inputs.persona_name} at ${v.inputs.path}`, () => {
        const result = derivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        expect(bytesToHex(result.publicKey)).toBe(v.expected.public_key_hex);
        expect(bytesToHex(result.privateKey)).toBe(v.expected.private_key_hex);
      });
    }
  });
});
