/**
 * `@dina/crypto-node` Ed25519 behavior tests (task 3.21).
 *
 * Goals:
 *   - Verify SLIP-0010 derivation is deterministic + hardened-only.
 *   - Verify sign/verify round-trips correctly.
 *   - Verify malformed inputs fail closed (return false from verify)
 *     rather than crashing.
 *
 * Byte-parity with `@dina/core/src/crypto/*` happens via the shared
 * `@noble/*` libraries — both code paths call the same underlying
 * functions so their outputs match by construction. A cross-check
 * against Go Core hex fixtures is task 3.30's scope.
 */

import { NodeCryptoAdapter } from '../src';

describe('NodeCryptoAdapter — Ed25519 (task 3.21)', () => {
  const adapter = new NodeCryptoAdapter();

  // A deterministic 32-byte seed — tests pin specific paths against
  // repeatable derivation outputs.
  const seed = new Uint8Array(32).fill(0x42);

  describe('ed25519DerivePath', () => {
    it('derives a deterministic keypair at a given path', async () => {
      const a = await adapter.ed25519DerivePath(seed, "m/9999'/0'/0'");
      const b = await adapter.ed25519DerivePath(seed, "m/9999'/0'/0'");
      expect(Array.from(a.privateKey)).toEqual(Array.from(b.privateKey));
      expect(Array.from(a.publicKey)).toEqual(Array.from(b.publicKey));
      expect(Array.from(a.chainCode)).toEqual(Array.from(b.chainCode));
    });

    it('returns 32-byte keys + 32-byte chain code', async () => {
      const d = await adapter.ed25519DerivePath(seed, "m/9999'/0'/0'");
      expect(d.privateKey.length).toBe(32);
      expect(d.publicKey.length).toBe(32);
      expect(d.chainCode.length).toBe(32);
    });

    it('different paths yield different keys', async () => {
      const a = await adapter.ed25519DerivePath(seed, "m/9999'/0'/0'");
      const b = await adapter.ed25519DerivePath(seed, "m/9999'/0'/1'");
      expect(Array.from(a.privateKey)).not.toEqual(Array.from(b.privateKey));
      expect(Array.from(a.publicKey)).not.toEqual(Array.from(b.publicKey));
    });

    it('rejects non-hardened paths', async () => {
      await expect(adapter.ed25519DerivePath(seed, 'm/0/0')).rejects.toThrow(
        /non-hardened/,
      );
    });

    it('rejects BIP-44 purpose 44 prime', async () => {
      await expect(adapter.ed25519DerivePath(seed, "m/44'/0'/0'")).rejects.toThrow(
        /BIP-44 purpose 44/,
      );
    });

    it('rejects empty path / no-segments path', async () => {
      await expect(adapter.ed25519DerivePath(seed, '')).rejects.toThrow(/invalid path format/);
      await expect(adapter.ed25519DerivePath(seed, 'm/')).rejects.toThrow(/no segments/);
    });

    it('rejects paths that do not start with m/', async () => {
      await expect(adapter.ed25519DerivePath(seed, "9999'/0'/0'")).rejects.toThrow(
        /invalid path format/,
      );
    });

    it('rejects too-short seeds', async () => {
      await expect(
        adapter.ed25519DerivePath(new Uint8Array(8), "m/0'"),
      ).rejects.toThrow(/seed too short/);
    });

    it('rejects all-zero seeds (fail-closed)', async () => {
      await expect(
        adapter.ed25519DerivePath(new Uint8Array(32), "m/0'"),
      ).rejects.toThrow(/all-zero/);
    });
  });

  describe('ed25519Sign + ed25519Verify', () => {
    it('round-trips a message through sign + verify', async () => {
      const { privateKey, publicKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('hello dina');
      const sig = await adapter.ed25519Sign(privateKey, message);
      expect(sig.length).toBe(64);
      expect(await adapter.ed25519Verify(publicKey, message, sig)).toBe(true);
    });

    it('signature is deterministic for the same (key, message)', async () => {
      // Ed25519 is deterministic by RFC 8032 — identical inputs →
      // identical signature bytes.
      const { privateKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('deterministic');
      const s1 = await adapter.ed25519Sign(privateKey, message);
      const s2 = await adapter.ed25519Sign(privateKey, message);
      expect(Array.from(s1)).toEqual(Array.from(s2));
    });

    it('verify returns false for a wrong-key signature', async () => {
      const a = await adapter.ed25519DerivePath(seed, "m/0'");
      const b = await adapter.ed25519DerivePath(seed, "m/1'");
      const message = new TextEncoder().encode('msg');
      const sig = await adapter.ed25519Sign(a.privateKey, message);
      // Sig was made with A's key; B's pubkey shouldn't verify.
      expect(await adapter.ed25519Verify(b.publicKey, message, sig)).toBe(false);
    });

    it('verify returns false for a tampered message', async () => {
      const { privateKey, publicKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('original');
      const sig = await adapter.ed25519Sign(privateKey, message);
      const tampered = new TextEncoder().encode('tampered');
      expect(await adapter.ed25519Verify(publicKey, tampered, sig)).toBe(false);
    });

    it('verify returns false for a tampered signature', async () => {
      const { privateKey, publicKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const message = new TextEncoder().encode('msg');
      const sig = await adapter.ed25519Sign(privateKey, message);
      // Flip a bit.
      const bad = new Uint8Array(sig);
      bad[0] = (bad[0] ?? 0) ^ 0x01;
      expect(await adapter.ed25519Verify(publicKey, message, bad)).toBe(false);
    });

    it('verify fails closed (returns false, does not throw) on malformed key length', async () => {
      // Wrong-length pubkey — @noble throws internally; our wrapper
      // should catch and return false so callers don't need try/catch.
      const badPub = new Uint8Array(31);
      const sig = new Uint8Array(64);
      expect(await adapter.ed25519Verify(badPub, new Uint8Array(1), sig)).toBe(false);
    });

    it('verify fails closed on malformed signature length', async () => {
      const { publicKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const badSig = new Uint8Array(63);
      expect(await adapter.ed25519Verify(publicKey, new Uint8Array(1), badSig)).toBe(false);
    });
  });
});
