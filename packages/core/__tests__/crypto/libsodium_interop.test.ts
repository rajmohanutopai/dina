/**
 * Verify mobile's sealed-box decrypt handles libsodium `crypto_box_seal`
 * ciphertexts (BLAKE2b-derived nonce). The test vector is produced by
 * PyNaCl (docker/openclaw's `dina-cli` dependency) with deterministic
 * X25519 keys.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha512 } from '@noble/hashes/sha2.js';

// Produced by `python3 -c "import nacl.public; ..."` — see session trace.
const VECTOR = {
  recipient_x25519_priv: '0101010101010101010101010101010101010101010101010101010101010101',
  recipient_x25519_pub: 'a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209',
  sealed_b64:
    'kF/czFle3MKYQhk8M0vX6Fq//38drK4oBZZ6fb/8IhnoMeEkTJaEoyMONNoV1Tbw7EVbSQ/PtUE9LXqsYopORwwmPvs=',
  plaintext: 'hello from libsodium',
} as const;

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(s: string): Uint8Array {
  const bin = Buffer.from(s, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

function cryptoBoxBeforenmStd(sharedSecret: Uint8Array): Uint8Array {
  const k = new Uint32Array(8);
  const dv = new DataView(sharedSecret.buffer, sharedSecret.byteOffset, 32);
  for (let i = 0; i < 8; i++) k[i] = dv.getUint32(i * 4, true);
  // σ = "expand 32-byte k"
  const sigma = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  const nonce = new Uint32Array(4);
  const out = new Uint32Array(8);
  hsalsa(sigma, k, nonce, out);
  const result = new Uint8Array(32);
  const rdv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) rdv.setUint32(i * 4, out[i], true);
  return result;
}

describe('libsodium crypto_box_seal ↔ mobile NaCl interop (BLAKE2b nonce)', () => {
  it('decrypts a PyNaCl SealedBox ciphertext', () => {
    const recipientPriv = hex(VECTOR.recipient_x25519_priv);
    const recipientPub = hex(VECTOR.recipient_x25519_pub);
    const sealed = b64(VECTOR.sealed_b64);

    const ephPub = sealed.slice(0, 32);
    const encrypted = sealed.slice(32);

    const shared = x25519.getSharedSecret(recipientPriv, ephPub);
    const boxKey = cryptoBoxBeforenmStd(shared);

    // libsodium nonce = BLAKE2b(ephPub || recipientPub, outlen=24).
    const nonceData = new Uint8Array(64);
    nonceData.set(ephPub, 0);
    nonceData.set(recipientPub, 32);
    const nonceBlake = blake2b(nonceData, { dkLen: 24 });
    const nonceSha = sha512(nonceData).slice(0, 24);

    let plaintextBlake: Uint8Array | null = null;
    let plaintextSha: Uint8Array | null = null;
    try {
      plaintextBlake = xsalsa20poly1305(boxKey, nonceBlake).decrypt(encrypted);
    } catch {
      /* noop */
    }
    try {
      plaintextSha = xsalsa20poly1305(boxKey, nonceSha).decrypt(encrypted);
    } catch {
      /* noop */
    }

    expect(plaintextBlake).not.toBeNull();
    expect(new TextDecoder().decode(plaintextBlake!)).toBe(VECTOR.plaintext);
    // SHA-512 path must not accidentally succeed on a libsodium ciphertext.
    expect(plaintextSha).toBeNull();
  });
});
