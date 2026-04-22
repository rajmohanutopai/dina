/**
 * `@dina/crypto-node` HKDF-SHA256 behavior tests (task 3.25).
 *
 * Covers RFC 5869 test vectors + the boundary checks Dina needs.
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

describe('NodeCryptoAdapter — HKDF-SHA256 (task 3.25)', () => {
  const adapter = new NodeCryptoAdapter();

  describe('RFC 5869 test vectors', () => {
    // Test Case 1 from RFC 5869 §A.1.
    it('Test Case 1: Basic SHA-256', async () => {
      const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
      const salt = hexToBytes('000102030405060708090a0b0c');
      const info = hexToBytes('f0f1f2f3f4f5f6f7f8f9');
      const out = await adapter.hkdfSha256(ikm, salt, info, 42);
      expect(bytesToHex(out)).toBe(
        '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      );
    });

    // Test Case 2 from RFC 5869 §A.2 — longer inputs.
    it('Test Case 2: SHA-256 with longer inputs', async () => {
      const ikm = hexToBytes(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
          '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f' +
          '404142434445464748494a4b4c4d4e4f',
      );
      const salt = hexToBytes(
        '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f' +
          '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f' +
          'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf',
      );
      const info = hexToBytes(
        'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf' +
          'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef' +
          'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
      );
      const out = await adapter.hkdfSha256(ikm, salt, info, 82);
      expect(bytesToHex(out)).toBe(
        'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c' +
          '59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71' +
          'cc30c58179ec3e87c14c01d5c1f3434f1d87',
      );
    });

    // Test Case 3: empty salt + empty info.
    it('Test Case 3: SHA-256 with empty salt/info', async () => {
      const ikm = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
      const salt = new Uint8Array(0);
      const info = new Uint8Array(0);
      const out = await adapter.hkdfSha256(ikm, salt, info, 42);
      expect(bytesToHex(out)).toBe(
        '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
      );
    });
  });

  describe('validation', () => {
    it('rejects outLen < 1', async () => {
      await expect(
        adapter.hkdfSha256(new Uint8Array(32), new Uint8Array(0), new Uint8Array(0), 0),
      ).rejects.toThrow(/outLen must be >= 1/);
    });

    it('rejects outLen > 8160 (RFC 5869 cap = 255 * 32)', async () => {
      await expect(
        adapter.hkdfSha256(new Uint8Array(32), new Uint8Array(0), new Uint8Array(0), 8161),
      ).rejects.toThrow(/exceeds RFC 5869 cap/);
    });

    it('accepts the max output length (8160 bytes)', async () => {
      const out = await adapter.hkdfSha256(
        new Uint8Array(32).fill(1),
        new Uint8Array(16),
        new Uint8Array(0),
        8160,
      );
      expect(out.length).toBe(8160);
    });
  });

  describe('properties', () => {
    it('is deterministic', async () => {
      const ikm = new Uint8Array(32).fill(0x42);
      const salt = new Uint8Array(16);
      const info = new TextEncoder().encode('dina.persona.dek');
      const a = await adapter.hkdfSha256(ikm, salt, info, 64);
      const b = await adapter.hkdfSha256(ikm, salt, info, 64);
      expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('different info produces different output (context separation)', async () => {
      const ikm = new Uint8Array(32).fill(0x42);
      const salt = new Uint8Array(16);
      const a = await adapter.hkdfSha256(ikm, salt, new TextEncoder().encode('context-a'), 32);
      const b = await adapter.hkdfSha256(ikm, salt, new TextEncoder().encode('context-b'), 32);
      expect(Array.from(a)).not.toEqual(Array.from(b));
    });

    it('different salt produces different output', async () => {
      const ikm = new Uint8Array(32).fill(0x42);
      const info = new TextEncoder().encode('info');
      const a = await adapter.hkdfSha256(ikm, new Uint8Array(16).fill(1), info, 32);
      const b = await adapter.hkdfSha256(ikm, new Uint8Array(16).fill(2), info, 32);
      expect(Array.from(a)).not.toEqual(Array.from(b));
    });
  });
});
