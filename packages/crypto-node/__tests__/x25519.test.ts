/**
 * `@dina/crypto-node` X25519 behavior tests (task 3.22).
 *
 * Covers:
 *   - Ed25519→X25519 public + private key conversion (32-byte outputs).
 *   - ECDH: two parties independently derive the same shared secret.
 *   - Round-trip: an Ed25519 keypair's X25519 derivation produces a
 *     (priv, pub) pair that X25519-self-multiplies to a known shape.
 */

import { NodeCryptoAdapter } from '../src';

describe('NodeCryptoAdapter — X25519 (task 3.22)', () => {
  const adapter = new NodeCryptoAdapter();
  const seed = new Uint8Array(32).fill(0x37);

  describe('x25519FromEd25519Public / Private', () => {
    it('produces 32-byte keys', async () => {
      const { privateKey, publicKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const xPub = await adapter.x25519FromEd25519Public(publicKey);
      const xPriv = await adapter.x25519FromEd25519Private(privateKey);
      expect(xPub.length).toBe(32);
      expect(xPriv.length).toBe(32);
    });

    it('is deterministic — same input, same output', async () => {
      const { publicKey } = await adapter.ed25519DerivePath(seed, "m/0'");
      const a = await adapter.x25519FromEd25519Public(publicKey);
      const b = await adapter.x25519FromEd25519Public(publicKey);
      expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('different Ed25519 keys produce different X25519 keys', async () => {
      const k0 = await adapter.ed25519DerivePath(seed, "m/0'");
      const k1 = await adapter.ed25519DerivePath(seed, "m/1'");
      const x0 = await adapter.x25519FromEd25519Public(k0.publicKey);
      const x1 = await adapter.x25519FromEd25519Public(k1.publicKey);
      expect(Array.from(x0)).not.toEqual(Array.from(x1));
    });
  });

  describe('x25519ScalarMult (ECDH)', () => {
    it('two parties derive the same shared secret (classic ECDH)', async () => {
      // Alice + Bob each derive an Ed25519 keypair, convert to X25519,
      // exchange publics, scalar-mult with their own private.
      const alice = await adapter.ed25519DerivePath(seed, "m/100'");
      const bob = await adapter.ed25519DerivePath(
        new Uint8Array(32).fill(0x88),
        "m/101'",
      );

      const alicePriv = await adapter.x25519FromEd25519Private(alice.privateKey);
      const alicePub = await adapter.x25519FromEd25519Public(alice.publicKey);
      const bobPriv = await adapter.x25519FromEd25519Private(bob.privateKey);
      const bobPub = await adapter.x25519FromEd25519Public(bob.publicKey);

      // Alice computes: scalarMult(alicePriv, bobPub)
      // Bob computes:   scalarMult(bobPriv, alicePub)
      // They MUST equal — that's the whole point of ECDH.
      const aliceSide = await adapter.x25519ScalarMult(alicePriv, bobPub);
      const bobSide = await adapter.x25519ScalarMult(bobPriv, alicePub);

      expect(Array.from(aliceSide)).toEqual(Array.from(bobSide));
      expect(aliceSide.length).toBe(32);
    });

    it('shared secret is non-zero for a real keypair', async () => {
      // Sanity: the result isn't all zeros (which would indicate
      // a small-subgroup or clamping failure).
      const { privateKey, publicKey } = await adapter.ed25519DerivePath(seed, "m/200'");
      const xPriv = await adapter.x25519FromEd25519Private(privateKey);
      const xPub = await adapter.x25519FromEd25519Public(publicKey);
      // Self-DH: scalarMult(priv, pub) — not a typical usage but the
      // result must still be non-zero for a real keypair.
      const shared = await adapter.x25519ScalarMult(xPriv, xPub);
      const allZero = shared.every((b) => b === 0);
      expect(allZero).toBe(false);
    });

    it('different (priv, pub) pairs produce different shared secrets', async () => {
      const alice = await adapter.ed25519DerivePath(seed, "m/300'");
      const bob = await adapter.ed25519DerivePath(seed, "m/301'");
      const carol = await adapter.ed25519DerivePath(seed, "m/302'");

      const alicePriv = await adapter.x25519FromEd25519Private(alice.privateKey);
      const bobPub = await adapter.x25519FromEd25519Public(bob.publicKey);
      const carolPub = await adapter.x25519FromEd25519Public(carol.publicKey);

      const ab = await adapter.x25519ScalarMult(alicePriv, bobPub);
      const ac = await adapter.x25519ScalarMult(alicePriv, carolPub);

      expect(Array.from(ab)).not.toEqual(Array.from(ac));
    });
  });
});
