/**
 * ISVC-2 — generic AES-256-GCM AEAD primitive (crypto/aead.ts).
 */

import { AeadError, aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';

const enc = new TextEncoder();

describe('aead', () => {
  it('round-trips plaintext under a fresh key', () => {
    const key = generateAeadKey();
    const pt = enc.encode('hello interactive run');
    const ct = aeadEncrypt(key, pt);
    expect(ct).not.toEqual(pt);
    expect(Array.from(aeadDecrypt(key, ct))).toEqual(Array.from(pt));
  });

  it('produces a distinct ciphertext each call (random nonce)', () => {
    const key = generateAeadKey();
    const pt = enc.encode('same');
    expect(Array.from(aeadEncrypt(key, pt))).not.toEqual(Array.from(aeadEncrypt(key, pt)));
  });

  it('fails closed on a wrong key', () => {
    const ct = aeadEncrypt(generateAeadKey(), enc.encode('secret'));
    expect(() => aeadDecrypt(generateAeadKey(), ct)).toThrow(AeadError);
  });

  it('authenticates AAD (mismatch → fail closed)', () => {
    const key = generateAeadKey();
    const ct = aeadEncrypt(key, enc.encode('x'), enc.encode('aad-1'));
    expect(Array.from(aeadDecrypt(key, ct, enc.encode('aad-1')))).toEqual(
      Array.from(enc.encode('x')),
    );
    expect(() => aeadDecrypt(key, ct, enc.encode('aad-2'))).toThrow(AeadError);
  });

  it('rejects a non-32-byte key', () => {
    expect(() => aeadEncrypt(new Uint8Array(16), enc.encode('x'))).toThrow(AeadError);
    expect(() => aeadDecrypt(new Uint8Array(31), new Uint8Array(40))).toThrow(AeadError);
  });

  it('rejects a too-short envelope', () => {
    expect(() => aeadDecrypt(generateAeadKey(), new Uint8Array(5))).toThrow(/too short/);
  });
});
