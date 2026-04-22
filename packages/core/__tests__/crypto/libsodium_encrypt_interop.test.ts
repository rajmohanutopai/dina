/**
 * Mobile → libsodium direction: mobile's `sealEncrypt(.., .., 'blake2b')`
 * must produce a ciphertext `nacl.public.SealedBox(priv).decrypt(ct)`
 * can read. This test pins that direction — the one that makes pair
 * RESPONSES from mobile land in dina-cli correctly.
 *
 * Strategy: encrypt a known plaintext with mobile's code, write the
 * ciphertext + keys to a temp file, and assert via a subprocess node
 * run against `@noble` that we can self-roundtrip. Then the companion
 * docker-based check (`libsodium_interop.test.ts`) provides the
 * PyNaCl-side half.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sealEncrypt, ed25519PubToX25519 } from '../../src/crypto/nacl';
import { getPublicKey } from '../../src/crypto/ed25519';

const KNOWN_ED25519_SEED = new Uint8Array(32).fill(0x42);

function cryptoBoxBeforenmStd(sharedSecret: Uint8Array): Uint8Array {
  const k = new Uint32Array(8);
  const dv = new DataView(sharedSecret.buffer, sharedSecret.byteOffset, 32);
  for (let i = 0; i < 8; i++) k[i] = dv.getUint32(i * 4, true);
  const sigma = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  const nonce = new Uint32Array(4);
  const out = new Uint32Array(8);
  hsalsa(sigma, k, nonce, out);
  const result = new Uint8Array(32);
  const rdv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) rdv.setUint32(i * 4, out[i], true);
  return result;
}

function openSealedWithBlake2AndStdKey(
  sealed: Uint8Array,
  recipientEd25519Seed: Uint8Array,
): Uint8Array {
  // Mirror what libsodium `SealedBox(priv).decrypt` does:
  //   1. priv_x = ed25519_sk_to_curve25519(seed + pub)
  //   2. pub_x  = ed25519_pk_to_curve25519(pub)
  //   3. eph_pub = ct[:32]
  //   4. shared = x25519(priv_x, eph_pub)
  //   5. key    = HSalsa20(shared, zero16, σ="expand 32-byte k")
  //   6. nonce  = BLAKE2b-24(eph_pub || pub_x)
  //   7. plaintext = xsalsa20poly1305_open(ct[32:], nonce, key)
  const recipientEdPub = getPublicKey(recipientEd25519Seed);
  const recipientX25519Pub = ed25519PubToX25519(recipientEdPub);
  // ed25519_sk_to_curve25519 is equivalent to sha512(seed)[:32] + clamping.
  // Mobile's `ed25519SecToX25519` does this; re-import it via sealDecrypt
  // for brevity, but we need the X25519 priv explicitly here, so inline:
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sha512 } = require('@noble/hashes/sha2.js');
  const digest: Uint8Array = sha512(recipientEd25519Seed);
  const privX: Uint8Array = digest.slice(0, 32);
  privX[0] &= 248;
  privX[31] &= 127;
  privX[31] |= 64;

  const ephPub = sealed.slice(0, 32);
  const encrypted = sealed.slice(32);
  const shared = x25519.getSharedSecret(privX, ephPub);
  const boxKey = cryptoBoxBeforenmStd(shared);

  const nonceData = new Uint8Array(64);
  nonceData.set(ephPub, 0);
  nonceData.set(recipientX25519Pub, 32);
  const nonce = blake2b(nonceData, { dkLen: 24 });

  return xsalsa20poly1305(boxKey, nonce).decrypt(encrypted);
}

describe('mobile sealEncrypt(blake2b) → libsodium-style decrypt', () => {
  it('produces a ciphertext a libsodium consumer can decrypt', () => {
    const recipientEdPub = getPublicKey(KNOWN_ED25519_SEED);
    const plaintext = new TextEncoder().encode('hello from mobile via BLAKE2b');

    const sealed = sealEncrypt(plaintext, recipientEdPub, 'blake2b');

    // Self-roundtrip via the libsodium-equivalent decrypt path.
    const recovered = openSealedWithBlake2AndStdKey(sealed, KNOWN_ED25519_SEED);
    expect(new TextDecoder().decode(recovered)).toBe('hello from mobile via BLAKE2b');
  });

  it('sealEncrypt(sha512) ciphertext is NOT readable via libsodium scheme', () => {
    // Regression: the old Dina-Go custom scheme must NOT accidentally
    // decrypt under libsodium rules, otherwise the interop fallback
    // in `sealDecryptWithScheme` would silently pick the wrong path.
    const recipientEdPub = getPublicKey(KNOWN_ED25519_SEED);
    const plaintext = new TextEncoder().encode('sha512 variant');
    const sealed = sealEncrypt(plaintext, recipientEdPub, 'sha512');

    expect(() => openSealedWithBlake2AndStdKey(sealed, KNOWN_ED25519_SEED)).toThrow();
  });
});
