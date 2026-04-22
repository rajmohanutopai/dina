/**
 * Task 3.26 — NaCl sealed-box (anonymous sender, recipient Ed25519 keypair).
 *
 * Validates:
 *   - round-trip seal/open recovers the plaintext
 *   - each seal produces a fresh ephemeral key (ciphertext differs)
 *   - wrong-key open rejects
 *   - tampered ciphertext rejects
 *   - ciphertext layout is `ephemeral_pk (32) || boxed` — the standard
 *     libsodium `crypto_box_seal` shape
 *   - input validation (32-byte key lengths enforced at the port boundary)
 */

import { NodeCryptoAdapter } from '../src';

async function fixtureKeypair(adapter: NodeCryptoAdapter, label: string) {
  // Derive deterministic test keys so assertions are reproducible
  // without depending on the runtime RNG.
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i ^ label.charCodeAt(0);
  const { publicKey, privateKey } = await adapter.ed25519DerivePath(seed, "m/9999'/99'/0'");
  return { publicKey, privateKey };
}

describe('NodeCryptoAdapter — sealed-box (3.26)', () => {
  it('seal → open recovers plaintext', async () => {
    const adapter = new NodeCryptoAdapter();
    const { publicKey, privateKey } = await fixtureKeypair(adapter, 'A');
    const message = new TextEncoder().encode('the medium is the message');

    const sealed = await adapter.sealedBoxSeal(message, publicKey);
    const opened = await adapter.sealedBoxOpen(sealed, publicKey, privateKey);

    expect(opened).toEqual(message);
  });

  it('each seal is non-deterministic (fresh ephemeral key)', async () => {
    const adapter = new NodeCryptoAdapter();
    const { publicKey } = await fixtureKeypair(adapter, 'A');
    const message = new TextEncoder().encode('same plaintext');

    const sealed1 = await adapter.sealedBoxSeal(message, publicKey);
    const sealed2 = await adapter.sealedBoxSeal(message, publicKey);

    expect(sealed1).not.toEqual(sealed2);
    // Layout: 32-byte ephemeral pk + 16-byte MAC + len(plaintext) bytes.
    expect(sealed1.length).toBe(32 + 16 + message.length);
    expect(sealed2.length).toBe(32 + 16 + message.length);
  });

  it('open with wrong recipient private key rejects', async () => {
    const adapter = new NodeCryptoAdapter();
    const a = await fixtureKeypair(adapter, 'A');
    const b = await fixtureKeypair(adapter, 'B');
    const message = new TextEncoder().encode('for A only');

    const sealed = await adapter.sealedBoxSeal(message, a.publicKey);
    await expect(adapter.sealedBoxOpen(sealed, b.publicKey, b.privateKey)).rejects.toThrow();
  });

  it('tampered ciphertext rejects', async () => {
    const adapter = new NodeCryptoAdapter();
    const { publicKey, privateKey } = await fixtureKeypair(adapter, 'A');
    const message = new TextEncoder().encode('untampered');

    const sealed = await adapter.sealedBoxSeal(message, publicKey);
    // Flip a byte past the ephemeral-pk prefix so we're corrupting the
    // boxed ciphertext + MAC, not the pubkey lookup.
    const tampered = new Uint8Array(sealed);
    tampered[40] = (tampered[40] ?? 0) ^ 0x01;

    await expect(adapter.sealedBoxOpen(tampered, publicKey, privateKey)).rejects.toThrow();
  });

  it('empty plaintext round-trips', async () => {
    const adapter = new NodeCryptoAdapter();
    const { publicKey, privateKey } = await fixtureKeypair(adapter, 'A');
    const message = new Uint8Array(0);

    const sealed = await adapter.sealedBoxSeal(message, publicKey);
    const opened = await adapter.sealedBoxOpen(sealed, publicKey, privateKey);

    expect(opened.length).toBe(0);
    // Empty plaintext still has 32-byte ephemeral pk + 16-byte MAC.
    expect(sealed.length).toBe(48);
  });

  it('rejects wrong-length recipient pubkey', async () => {
    const adapter = new NodeCryptoAdapter();
    await expect(
      adapter.sealedBoxSeal(new Uint8Array(1), new Uint8Array(31)),
    ).rejects.toThrow(/recipient pubkey must be 32 bytes/);
    await expect(
      adapter.sealedBoxOpen(new Uint8Array(48), new Uint8Array(31), new Uint8Array(32)),
    ).rejects.toThrow(/recipient pubkey must be 32 bytes/);
  });

  it('rejects wrong-length recipient privkey', async () => {
    const adapter = new NodeCryptoAdapter();
    await expect(
      adapter.sealedBoxOpen(new Uint8Array(48), new Uint8Array(32), new Uint8Array(31)),
    ).rejects.toThrow(/recipient privkey must be 32 bytes/);
  });
});
