/**
 * `@dina/crypto-node` secp256k1 behavior tests (task 3.23).
 *
 * secp256k1 is used for did:plc rotation keys. Must produce
 * byte-identical SLIP-0010/BIP-32 derivation output as
 * `@dina/core`'s impl.
 */

import { NodeCryptoAdapter } from '../src';

describe('NodeCryptoAdapter — secp256k1 (task 3.23)', () => {
  const adapter = new NodeCryptoAdapter();
  const seed = new Uint8Array(32).fill(0x73);

  describe('secp256k1DerivePath', () => {
    it('derives a deterministic keypair at a given path', async () => {
      const a = await adapter.secp256k1DerivePath(seed, "m/9999'/2'/0'");
      const b = await adapter.secp256k1DerivePath(seed, "m/9999'/2'/0'");
      expect(Array.from(a.privateKey)).toEqual(Array.from(b.privateKey));
      expect(Array.from(a.publicKey)).toEqual(Array.from(b.publicKey));
      expect(Array.from(a.chainCode)).toEqual(Array.from(b.chainCode));
    });

    it('returns 32-byte privateKey + 33-byte compressed publicKey + 32-byte chainCode', async () => {
      const d = await adapter.secp256k1DerivePath(seed, "m/0'");
      expect(d.privateKey.length).toBe(32);
      expect(d.publicKey.length).toBe(33); // compressed form
      expect(d.chainCode.length).toBe(32);
    });

    it('compressed public key has valid 0x02/0x03 prefix', async () => {
      const d = await adapter.secp256k1DerivePath(seed, "m/0'");
      // SEC1 compressed form: 0x02 = even y, 0x03 = odd y.
      expect([0x02, 0x03]).toContain(d.publicKey[0]);
    });

    it('different paths yield different keys', async () => {
      const a = await adapter.secp256k1DerivePath(seed, "m/9999'/2'/0'");
      const b = await adapter.secp256k1DerivePath(seed, "m/9999'/2'/1'");
      expect(Array.from(a.privateKey)).not.toEqual(Array.from(b.privateKey));
    });

    it('different seeds yield different keys', async () => {
      const a = await adapter.secp256k1DerivePath(seed, "m/0'");
      const b = await adapter.secp256k1DerivePath(
        new Uint8Array(32).fill(0x88),
        "m/0'",
      );
      expect(Array.from(a.privateKey)).not.toEqual(Array.from(b.privateKey));
    });

    it('rejects non-hardened paths (Dina hardened-only rule)', async () => {
      await expect(adapter.secp256k1DerivePath(seed, 'm/0/0')).rejects.toThrow(
        /non-hardened/,
      );
    });

    it('rejects all-zero seeds (fail-closed)', async () => {
      await expect(adapter.secp256k1DerivePath(new Uint8Array(32), "m/0'")).rejects.toThrow(
        /all-zero/,
      );
    });

    it('rejects too-short seeds', async () => {
      await expect(
        adapter.secp256k1DerivePath(new Uint8Array(8), "m/0'"),
      ).rejects.toThrow(/seed too short/);
    });
  });

  describe('secp256k1Sign + secp256k1Verify', () => {
    it('round-trips a message through sign + verify', async () => {
      const { privateKey, publicKey } = await adapter.secp256k1DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('rotate-plc');
      const sig = await adapter.secp256k1Sign(privateKey, message);
      expect(sig.length).toBe(64); // compact form: r (32) || s (32)
      expect(await adapter.secp256k1Verify(publicKey, message, sig)).toBe(true);
    });

    it('verify returns false for a wrong-key signature', async () => {
      const a = await adapter.secp256k1DerivePath(seed, "m/0'");
      const b = await adapter.secp256k1DerivePath(seed, "m/1'");
      const message = new TextEncoder().encode('msg');
      const sig = await adapter.secp256k1Sign(a.privateKey, message);
      expect(await adapter.secp256k1Verify(b.publicKey, message, sig)).toBe(false);
    });

    it('verify returns false for a tampered message', async () => {
      const { privateKey, publicKey } = await adapter.secp256k1DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('original');
      const sig = await adapter.secp256k1Sign(privateKey, message);
      const tampered = new TextEncoder().encode('tampered');
      expect(await adapter.secp256k1Verify(publicKey, tampered, sig)).toBe(false);
    });

    it('verify returns false for a tampered signature', async () => {
      const { privateKey, publicKey } = await adapter.secp256k1DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('msg');
      const sig = await adapter.secp256k1Sign(privateKey, message);
      const bad = new Uint8Array(sig);
      bad[0] = (bad[0] ?? 0) ^ 0x01;
      expect(await adapter.secp256k1Verify(publicKey, message, bad)).toBe(false);
    });

    it('verify fails closed on malformed pubkey length', async () => {
      // Compressed pubkey is 33 bytes; 32-byte input is invalid.
      const sig = new Uint8Array(64);
      expect(
        await adapter.secp256k1Verify(new Uint8Array(32), new Uint8Array(1), sig),
      ).toBe(false);
    });

    it('verify fails closed on malformed signature length', async () => {
      const { publicKey } = await adapter.secp256k1DerivePath(seed, "m/0'");
      expect(
        await adapter.secp256k1Verify(publicKey, new Uint8Array(1), new Uint8Array(63)),
      ).toBe(false);
    });
  });
});
