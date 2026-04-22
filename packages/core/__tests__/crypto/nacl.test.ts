/**
 * T1A.8 — NaCl crypto_box_seal + Ed25519↔X25519 key conversion.
 *
 * Category A: fixture-based. Verifies:
 * - Seal/unseal round-trip
 * - Key conversion matches Go output
 * - Wrong key fails to decrypt
 * - Corrupted ciphertext fails
 *
 * Source: core/test/transport_d2d_sig_test.go, crypto_test.go
 */

import {
  sealEncrypt,
  sealDecrypt,
  ed25519PubToX25519,
  ed25519SecToX25519,
} from '../../src/crypto/nacl';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  TEST_ED25519_SEED,
  TEST_MESSAGE,
  hasFixture,
  loadVectors,
  hexToBytes,
  bytesToHex,
} from '@dina/test-harness';

describe('NaCl crypto_box_seal', () => {
  const recipientPriv = TEST_ED25519_SEED;
  const recipientPub = getPublicKey(recipientPriv);

  describe('sealEncrypt', () => {
    it('encrypts plaintext with recipient public key', () => {
      const sealed = sealEncrypt(TEST_MESSAGE, recipientPub);
      expect(sealed).toBeInstanceOf(Uint8Array);
      // sealed = eph_pub(32) + ciphertext(msgLen) + poly1305_tag(16)
      expect(sealed.length).toBe(32 + TEST_MESSAGE.length + 16);
    });

    it('produces different ciphertext each time (ephemeral keys)', () => {
      const s1 = sealEncrypt(TEST_MESSAGE, recipientPub);
      const s2 = sealEncrypt(TEST_MESSAGE, recipientPub);
      expect(bytesToHex(s1)).not.toBe(bytesToHex(s2));
    });

    it('encrypts empty message', () => {
      const sealed = sealEncrypt(new Uint8Array(0), recipientPub);
      // eph_pub(32) + tag(16), no ciphertext body
      expect(sealed.length).toBe(32 + 16);
    });

    it('rejects invalid public key length', () => {
      expect(() => sealEncrypt(TEST_MESSAGE, new Uint8Array(16))).toThrow('must be 32 bytes');
    });
  });

  describe('sealDecrypt', () => {
    it('decrypts with correct recipient keypair', () => {
      const sealed = sealEncrypt(TEST_MESSAGE, recipientPub);
      const decrypted = sealDecrypt(sealed, recipientPub, recipientPriv);
      expect(bytesToHex(decrypted)).toBe(bytesToHex(TEST_MESSAGE));
    });

    it('fails with wrong recipient private key', () => {
      const sealed = sealEncrypt(TEST_MESSAGE, recipientPub);
      const wrongKey = new Uint8Array(32);
      wrongKey[0] = 0x42;
      expect(() => sealDecrypt(sealed, recipientPub, wrongKey)).toThrow('decryption failed');
    });

    it('fails with corrupted ciphertext', () => {
      const sealed = sealEncrypt(TEST_MESSAGE, recipientPub);
      // Flip a byte in the encrypted portion (after the 32-byte eph_pub)
      sealed[40] ^= 0xff;
      expect(() => sealDecrypt(sealed, recipientPub, recipientPriv)).toThrow('decryption failed');
    });

    it('rejects ciphertext shorter than overhead', () => {
      expect(() => sealDecrypt(new Uint8Array(30), recipientPub, recipientPriv)).toThrow(
        'ciphertext too short',
      );
    });
  });

  describe('round-trip', () => {
    it('encrypt → decrypt recovers plaintext', () => {
      const sealed = sealEncrypt(TEST_MESSAGE, recipientPub);
      const recovered = sealDecrypt(sealed, recipientPub, recipientPriv);
      expect(bytesToHex(recovered)).toBe(bytesToHex(TEST_MESSAGE));
    });

    it('round-trips empty message', () => {
      const empty = new Uint8Array(0);
      const sealed = sealEncrypt(empty, recipientPub);
      const recovered = sealDecrypt(sealed, recipientPub, recipientPriv);
      expect(recovered.length).toBe(0);
    });

    it('round-trips large message (1KB)', () => {
      const large = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) large[i] = i & 0xff;
      const sealed = sealEncrypt(large, recipientPub);
      const recovered = sealDecrypt(sealed, recipientPub, recipientPriv);
      expect(bytesToHex(recovered)).toBe(bytesToHex(large));
    });

    it("different recipients cannot decrypt each other's messages", () => {
      const otherPriv = new Uint8Array(32);
      otherPriv[0] = 0x99;
      const otherPub = getPublicKey(otherPriv);

      const sealed = sealEncrypt(TEST_MESSAGE, recipientPub);
      // Other recipient tries to decrypt with their own keys
      expect(() => sealDecrypt(sealed, otherPub, otherPriv)).toThrow('decryption failed');
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'crypto/nacl_seal_unseal.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: NaCl seal (Go fixtures)', () => {
    const vectors = loadVectors<
      { ed25519_seed_hex: string; plaintext_hex: string; x25519_pub_hex: string },
      { roundtrip_matches: boolean; sealed_length_min: number; unsealed_hex: string }
    >(fixture);

    for (const v of vectors) {
      it(`${v.description}: TS seal → unseal round-trip matches plaintext`, () => {
        const edSeed = hexToBytes(v.inputs.ed25519_seed_hex);
        const edPub = getPublicKey(edSeed);
        const plaintext = hexToBytes(v.inputs.plaintext_hex);

        const sealed = sealEncrypt(plaintext, edPub);
        expect(sealed.length).toBeGreaterThanOrEqual(v.expected.sealed_length_min);

        const recovered = sealDecrypt(sealed, edPub, edSeed);
        expect(bytesToHex(recovered)).toBe(v.expected.unsealed_hex);
      });

      it(`${v.description}: key conversion matches Go`, () => {
        const edSeed = hexToBytes(v.inputs.ed25519_seed_hex);
        const edPub = getPublicKey(edSeed);
        const x25519Pub = ed25519PubToX25519(edPub);
        expect(bytesToHex(x25519Pub)).toBe(v.inputs.x25519_pub_hex);
      });
    }
  });
});

describe('Ed25519 ↔ X25519 Key Conversion', () => {
  const ed25519Sec = TEST_ED25519_SEED;
  const ed25519Pub = getPublicKey(ed25519Sec);

  describe('ed25519PubToX25519', () => {
    it('converts Ed25519 public key to X25519', () => {
      const x25519Pub = ed25519PubToX25519(ed25519Pub);
      expect(x25519Pub).toBeInstanceOf(Uint8Array);
      expect(x25519Pub.length).toBe(32);
    });

    it('is deterministic', () => {
      const a = ed25519PubToX25519(ed25519Pub);
      const b = ed25519PubToX25519(ed25519Pub);
      expect(bytesToHex(a)).toBe(bytesToHex(b));
    });

    it('produces different X25519 keys for different Ed25519 keys', () => {
      const otherSec = new Uint8Array(32);
      otherSec[0] = 0x42;
      const otherPub = getPublicKey(otherSec);
      const x1 = ed25519PubToX25519(ed25519Pub);
      const x2 = ed25519PubToX25519(otherPub);
      expect(bytesToHex(x1)).not.toBe(bytesToHex(x2));
    });

    it('rejects invalid key length', () => {
      expect(() => ed25519PubToX25519(new Uint8Array(16))).toThrow('must be 32 bytes');
    });
  });

  describe('ed25519SecToX25519', () => {
    it('converts Ed25519 private key to X25519', () => {
      const x25519Sec = ed25519SecToX25519(ed25519Sec);
      expect(x25519Sec).toBeInstanceOf(Uint8Array);
      expect(x25519Sec.length).toBe(32);
    });

    it('is deterministic', () => {
      const a = ed25519SecToX25519(ed25519Sec);
      const b = ed25519SecToX25519(ed25519Sec);
      expect(bytesToHex(a)).toBe(bytesToHex(b));
    });

    it('output is properly clamped (X25519 scalar format)', () => {
      const scalar = ed25519SecToX25519(ed25519Sec);
      expect(scalar[0] & 7).toBe(0);
      expect(scalar[31] & 128).toBe(0);
      expect(scalar[31] & 64).toBe(64);
    });

    it('rejects invalid key length', () => {
      expect(() => ed25519SecToX25519(new Uint8Array(16))).toThrow('must be 32 bytes');
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'crypto/key_convert_ed25519_x25519.json';
  const suite = hasFixture(fixture) ? describe : describe.skip;
  suite('cross-language: Ed25519↔X25519 (Go fixtures)', () => {
    const vectors = loadVectors<
      { ed25519_pub_hex?: string; ed25519_priv_hex?: string },
      { x25519_pub_hex?: string; x25519_priv_hex?: string }
    >(fixture);

    for (const v of vectors) {
      if (v.inputs.ed25519_pub_hex && v.expected.x25519_pub_hex) {
        it(`pub: ${v.description}`, () => {
          const x25519Pub = ed25519PubToX25519(hexToBytes(v.inputs.ed25519_pub_hex!));
          expect(bytesToHex(x25519Pub)).toBe(v.expected.x25519_pub_hex);
        });
      }
      if (v.inputs.ed25519_priv_hex && v.expected.x25519_priv_hex) {
        it(`priv: ${v.description}`, () => {
          const x25519Priv = ed25519SecToX25519(hexToBytes(v.inputs.ed25519_priv_hex!));
          expect(bytesToHex(x25519Priv)).toBe(v.expected.x25519_priv_hex);
        });
      }
    }
  });
});
