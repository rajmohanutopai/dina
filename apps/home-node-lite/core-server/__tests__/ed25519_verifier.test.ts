/**
 * Task 4.19 — Ed25519 verifier tests.
 *
 * Uses real keys from @dina/adapters-node's Crypto so the verifier is
 * tested end-to-end against actual Ed25519 signatures. No mocks of the
 * cryptographic surface — the point is to exercise the real
 * verification path.
 */

import { Crypto } from '@dina/adapters-node';
import { verifySignature } from '../src/auth/ed25519_verifier';

/**
 * Build an Ed25519 keypair + sign a message. Reused across tests to
 * keep setup tight.
 */
async function signedPair(canonical: string) {
  const crypto = new Crypto();
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const { publicKey, privateKey } = await crypto.ed25519DerivePath(
    seed,
    "m/9999'/0'/0'",
  );
  const message = new TextEncoder().encode(canonical);
  const sig = await crypto.ed25519Sign(privateKey, message);
  return {
    crypto,
    publicKey,
    privateKey,
    signatureHex: bytesToHex(sig),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

describe('verifySignature (task 4.19)', () => {
  const canonical =
    'POST\n/v1/vault/store\npersona=health\n2026-04-21T22:00:00.000Z\nnnnn\naaaa';

  describe('happy path', () => {
    it('returns ok: true for a valid signature', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: pair.signatureHex,
        publicKey: pair.publicKey,
      });
      expect(res).toEqual({ ok: true });
    });
  });

  describe('bad_public_key', () => {
    it('rejects wrong-length public key', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: pair.signatureHex,
        publicKey: new Uint8Array(31), // short
      });
      expect(res).toEqual({ ok: false, reason: 'bad_public_key' });
    });

    it('rejects empty public key', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: pair.signatureHex,
        publicKey: new Uint8Array(0),
      });
      expect(res).toMatchObject({ ok: false, reason: 'bad_public_key' });
    });
  });

  describe('bad_signature_encoding', () => {
    it('rejects odd-length hex', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: 'abc', // odd length
        publicKey: pair.publicKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'bad_signature_encoding' });
    });

    it('rejects non-hex chars', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: 'zz'.repeat(64),
        publicKey: pair.publicKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'bad_signature_encoding' });
    });

    it('rejects wrong-length (but well-formed hex) signature', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: 'aa'.repeat(32), // 32 bytes, not 64
        publicKey: pair.publicKey,
      });
      expect(res).toMatchObject({ ok: false, reason: 'bad_signature_encoding' });
    });
  });

  describe('signature_mismatch', () => {
    it('rejects when canonical string was tampered with', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: canonical.replace('/v1/vault/store', '/v1/vault/DROP'),
        signatureHex: pair.signatureHex,
        publicKey: pair.publicKey,
      });
      expect(res).toEqual({ ok: false, reason: 'signature_mismatch' });
    });

    it('rejects when signature was tampered with (flip one byte)', async () => {
      const pair = await signedPair(canonical);
      const flipped =
        pair.signatureHex.slice(0, 2) === '00'
          ? 'ff' + pair.signatureHex.slice(2)
          : '00' + pair.signatureHex.slice(2);
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: flipped,
        publicKey: pair.publicKey,
      });
      expect(res).toEqual({ ok: false, reason: 'signature_mismatch' });
    });

    it('rejects when public key does not match the signing key', async () => {
      const pair = await signedPair(canonical);
      const wrong = new Uint8Array(pair.publicKey);
      wrong[0] = (wrong[0] ?? 0) ^ 0x01; // flip one bit
      const res = await verifySignature({
        canonicalString: canonical,
        signatureHex: pair.signatureHex,
        publicKey: wrong,
      });
      // Flipping one bit produces a public key that's still 32 bytes
      // and (for @noble/ed25519 v3+) decoded-valid but does not verify.
      expect(res).toEqual({ ok: false, reason: 'signature_mismatch' });
    });

    it('rejects when empty canonical string is signed with a different canonical', async () => {
      const pair = await signedPair(canonical);
      const res = await verifySignature({
        canonicalString: '',
        signatureHex: pair.signatureHex,
        publicKey: pair.publicKey,
      });
      expect(res).toEqual({ ok: false, reason: 'signature_mismatch' });
    });
  });

  describe('injected Crypto', () => {
    it('uses caller-provided Crypto instance', async () => {
      const crypto = new Crypto();
      const pair = await signedPair(canonical);
      // Explicit pass — exercises the DI surface. Using a different
      // Crypto instance than the default makes no behavioral difference
      // but covers the code path.
      const res = await verifySignature(
        {
          canonicalString: canonical,
          signatureHex: pair.signatureHex,
          publicKey: pair.publicKey,
        },
        crypto,
      );
      expect(res).toEqual({ ok: true });
    });
  });
});
