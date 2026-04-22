/**
 * Task 5.14 — nonce generator tests.
 */

import {
  NONCE_BYTES,
  NONCE_HEX_LENGTH,
  createNonceGenerator,
  generateNonce,
  isValidNonceFormat,
} from '../src/brain/nonce_generator';

function seeded(bytes: number[]): (n: number) => Uint8Array {
  return (n) => {
    if (n !== bytes.length) throw new Error(`expected ${bytes.length} bytes`);
    return new Uint8Array(bytes);
  };
}

describe('nonce generator (task 5.14)', () => {
  describe('constants', () => {
    it('NONCE_BYTES is 16 (128 bits)', () => {
      expect(NONCE_BYTES).toBe(16);
    });
    it('NONCE_HEX_LENGTH is 32 (16 bytes × 2 hex chars)', () => {
      expect(NONCE_HEX_LENGTH).toBe(32);
    });
  });

  describe('createNonceGenerator', () => {
    it('returns 32-char lowercase hex', () => {
      const gen = createNonceGenerator();
      const nonce = gen();
      expect(nonce).toHaveLength(32);
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces a distinct nonce per call (overwhelmingly likely)', () => {
      const gen = createNonceGenerator();
      const set = new Set<string>();
      for (let i = 0; i < 100; i++) set.add(gen());
      expect(set.size).toBe(100);
    });

    it('honours an injected randomBytesFn', () => {
      const bytes = Array.from({ length: 16 }, (_, i) => i);
      const gen = createNonceGenerator({ randomBytesFn: seeded(bytes) });
      expect(gen()).toBe('000102030405060708090a0b0c0d0e0f');
    });

    it('rejects randomBytesFn returning wrong length', () => {
      const gen = createNonceGenerator({
        randomBytesFn: () => new Uint8Array(8),
      });
      expect(() => gen()).toThrow(/returned 8 bytes, expected 16/);
    });

    it('concurrent calls do not collide (no shared state)', () => {
      const gen = createNonceGenerator();
      const results: string[] = [];
      for (let i = 0; i < 1000; i++) results.push(gen());
      expect(new Set(results).size).toBe(1000);
    });
  });

  describe('generateNonce (one-shot)', () => {
    it('produces a valid nonce', () => {
      expect(isValidNonceFormat(generateNonce())).toBe(true);
    });

    it('each call is independent', () => {
      const a = generateNonce();
      const b = generateNonce();
      expect(a).not.toBe(b);
    });
  });

  describe('isValidNonceFormat', () => {
    it('accepts a real nonce', () => {
      expect(isValidNonceFormat('0123456789abcdef0123456789abcdef')).toBe(true);
    });

    it.each([
      ['too short', 'ab'],
      ['too long', 'a'.repeat(33)],
      ['uppercase', 'A'.repeat(32)],
      ['non-hex', 'g'.repeat(32)],
      ['mixed hex + non-hex', '0123456789abcdefghijklmnopqrstuv'],
      ['empty', ''],
      ['number', 123 as unknown as string],
      ['undefined', undefined as unknown as string],
      ['null', null as unknown as string],
    ])('rejects %s', (_label, candidate) => {
      expect(isValidNonceFormat(candidate)).toBe(false);
    });
  });
});
