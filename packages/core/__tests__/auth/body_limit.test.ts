/**
 * T2.7 — Body limit middleware: reject bodies > 2MB.
 *
 * Source: ARCHITECTURE.md Task 2.7
 */

import {
  checkBodyLimit,
  getBodySize,
  setBodyLimit,
  getBodyLimit,
  resetBodyLimit,
} from '../../src/auth/body_limit';

describe('Body Limit Middleware', () => {
  beforeEach(() => resetBodyLimit());

  describe('checkBodyLimit', () => {
    it('allows small body', () => {
      const result = checkBodyLimit('hello world');
      expect(result.allowed).toBe(true);
      expect(result.bodySize).toBe(11);
    });

    it('allows empty body', () => {
      expect(checkBodyLimit(null).allowed).toBe(true);
      expect(checkBodyLimit(undefined).allowed).toBe(true);
      expect(checkBodyLimit('').allowed).toBe(true);
    });

    it('allows exactly 2MB', () => {
      const body = new Uint8Array(2_000_000);
      expect(checkBodyLimit(body).allowed).toBe(true);
    });

    it('rejects body > 2MB', () => {
      const body = new Uint8Array(2_000_001);
      const result = checkBodyLimit(body);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('too large');
    });

    it('rejects 3MB body', () => {
      const body = new Uint8Array(3_000_000);
      const result = checkBodyLimit(body);
      expect(result.allowed).toBe(false);
      expect(result.bodySize).toBe(3_000_000);
    });

    it('includes limit in result', () => {
      const result = checkBodyLimit('small');
      expect(result.limitBytes).toBe(2_000_000);
    });

    it('works with string bodies (UTF-8 encoded)', () => {
      const result = checkBodyLimit('a'.repeat(100));
      expect(result.bodySize).toBe(100);
    });

    it('handles multi-byte UTF-8 correctly', () => {
      const emoji = '😀'; // 4 bytes in UTF-8
      const result = checkBodyLimit(emoji);
      expect(result.bodySize).toBe(4);
    });

    it('works with Uint8Array bodies', () => {
      const body = new Uint8Array(500);
      const result = checkBodyLimit(body);
      expect(result.bodySize).toBe(500);
    });
  });

  describe('getBodySize', () => {
    it('null → 0', () => expect(getBodySize(null)).toBe(0));
    it('undefined → 0', () => expect(getBodySize(undefined)).toBe(0));
    it('empty string → 0', () => expect(getBodySize('')).toBe(0));
    it('Uint8Array → length', () => expect(getBodySize(new Uint8Array(42))).toBe(42));
    it('string → UTF-8 byte length', () => expect(getBodySize('hello')).toBe(5));
  });

  describe('configurable limit', () => {
    it('setBodyLimit changes the limit', () => {
      setBodyLimit(500);
      expect(getBodyLimit()).toBe(500);
      expect(checkBodyLimit(new Uint8Array(501)).allowed).toBe(false);
      expect(checkBodyLimit(new Uint8Array(500)).allowed).toBe(true);
    });

    it('resetBodyLimit restores default', () => {
      setBodyLimit(100);
      resetBodyLimit();
      expect(getBodyLimit()).toBe(2_000_000);
    });
  });
});
