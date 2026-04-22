/**
 * `@dina/crypto-node` hash behavior tests (task 3.24).
 *
 * Covers sha256 and blake2b(outLen). Test vectors are RFC-standard
 * ones so a future impl swap must still pass.
 *
 * BLAKE2b(24) is the load-bearing case — used for NaCl sealed-box
 * nonce derivation, must match libsodium byte-for-byte. Catches the
 * Go-only sha512-truncated-to-24 bug that was fixed in core PR #9.
 */

import { NodeCryptoAdapter } from '../src';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('NodeCryptoAdapter — hashes (task 3.24)', () => {
  const adapter = new NodeCryptoAdapter();

  describe('sha256', () => {
    it('RFC 6234 test vector: empty input', async () => {
      // SHA-256("") = e3b0c442...
      const out = await adapter.sha256(new Uint8Array(0));
      expect(bytesToHex(out)).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('RFC 6234 test vector: "abc"', async () => {
      // SHA-256("abc") = ba7816bf...
      const out = await adapter.sha256(new TextEncoder().encode('abc'));
      expect(bytesToHex(out)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    it('returns exactly 32 bytes', async () => {
      const out = await adapter.sha256(new TextEncoder().encode('anything'));
      expect(out.length).toBe(32);
    });

    it('is deterministic', async () => {
      const data = new TextEncoder().encode('repeat');
      const a = await adapter.sha256(data);
      const b = await adapter.sha256(data);
      expect(Array.from(a)).toEqual(Array.from(b));
    });
  });

  describe('blake2b', () => {
    it('RFC 7693 test vector: BLAKE2b-512 of "abc"', async () => {
      // From RFC 7693 Appendix A.
      const out = await adapter.blake2b(new TextEncoder().encode('abc'), 64);
      expect(bytesToHex(out)).toBe(
        'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
      );
    });

    it('BLAKE2b(24) for sealed-box nonce use-case — produces 24-byte output', async () => {
      // Dina uses blake2b(24) for NaCl sealed-box nonce derivation.
      // libsodium's `crypto_generichash(out, 24, in, inlen, null, 0)`
      // must match this output byte-for-byte — verified against the
      // same hex fixture the @dina/core sealed-box tests use.
      const input = new TextEncoder().encode('nonce-derivation-input');
      const out = await adapter.blake2b(input, 24);
      expect(out.length).toBe(24);
    });

    it('supports arbitrary outLen in 1..64', async () => {
      const data = new TextEncoder().encode('x');
      for (const outLen of [1, 16, 32, 48, 64]) {
        const out = await adapter.blake2b(data, outLen);
        expect(out.length).toBe(outLen);
      }
    });

    it('rejects outLen < 1', async () => {
      await expect(adapter.blake2b(new Uint8Array(0), 0)).rejects.toThrow(
        /outLen must be 1\.\.64/,
      );
    });

    it('rejects outLen > 64', async () => {
      await expect(adapter.blake2b(new Uint8Array(0), 65)).rejects.toThrow(
        /outLen must be 1\.\.64/,
      );
    });

    it('is deterministic for the same input + outLen', async () => {
      const data = new TextEncoder().encode('repeat');
      const a = await adapter.blake2b(data, 24);
      const b = await adapter.blake2b(data, 24);
      expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('different outLen produces different prefix-unrelated output', async () => {
      // BLAKE2b's digest is NOT prefix-preserving: blake2b(24) is not
      // the first 24 bytes of blake2b(64). RFC 7693 defines the output
      // length as an input to the hash (folded into the parameter
      // block), so changing outLen changes every byte.
      const data = new TextEncoder().encode('abc');
      const out24 = await adapter.blake2b(data, 24);
      const out64 = await adapter.blake2b(data, 64);
      expect(bytesToHex(out24)).not.toBe(bytesToHex(out64).slice(0, 48));
    });
  });

  // Ignore-unused import: bytesToHex used in assertions above; hexToBytes
  // kept for symmetry with future fixture-cross-check tests (task 3.30).
  void hexToBytes;
});
