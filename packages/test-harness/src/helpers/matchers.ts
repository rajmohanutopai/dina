/**
 * Custom Jest matchers for Dina-specific assertions.
 *
 * Register in jest.setup.ts:
 *   import { dinaMatchers } from '@dina/test-harness';
 *   expect.extend(dinaMatchers);
 *
 * Usage in tests:
 *   expect(actual).toEqualBytes(expected);
 *   expect(actual).toMatchHex('abcdef...');
 *   expect(actual).toHavePrefix('did:key:z6Mk');
 *   expect(actual).toBeNonZeroBytes();
 */

import { bytesToHex, bytesEqual, isAllZero } from './bytes';

export const dinaMatchers = {
  /**
   * Assert two Uint8Arrays are byte-identical.
   */
  toEqualBytes(received: Uint8Array, expected: Uint8Array) {
    const pass = bytesEqual(received, expected);
    const maxShow = 64;
    return {
      pass,
      message: () =>
        pass
          ? `Expected bytes NOT to equal:\n  ${bytesToHex(expected).substring(0, maxShow * 2)}`
          : `Byte mismatch:\n` +
            `  received (${received.length} bytes): ${bytesToHex(received).substring(0, maxShow * 2)}${received.length > maxShow ? '...' : ''}\n` +
            `  expected (${expected.length} bytes): ${bytesToHex(expected).substring(0, maxShow * 2)}${expected.length > maxShow ? '...' : ''}`,
    };
  },

  /**
   * Assert a Uint8Array matches a hex string (case-insensitive).
   */
  toMatchHex(received: Uint8Array, expectedHex: string) {
    const actualHex = bytesToHex(received);
    const normalizedExpected = expectedHex.toLowerCase();
    const pass = actualHex === normalizedExpected;
    return {
      pass,
      message: () =>
        pass
          ? `Expected hex NOT to match: ${normalizedExpected}`
          : `Hex mismatch:\n  received: ${actualHex}\n  expected: ${normalizedExpected}`,
    };
  },

  /**
   * Assert a Uint8Array has the expected length.
   */
  toBeBytesOfLength(received: Uint8Array, length: number) {
    const pass = received.length === length;
    return {
      pass,
      message: () =>
        pass
          ? `Expected NOT to be ${length} bytes`
          : `Expected ${length} bytes, got ${received.length}`,
    };
  },

  /**
   * Assert a Uint8Array is NOT all zeros.
   */
  toBeNonZeroBytes(received: Uint8Array) {
    const pass = !isAllZero(received);
    return {
      pass,
      message: () =>
        pass
          ? `Expected all-zero bytes`
          : `Expected non-zero bytes, got all zeros (${received.length} bytes)`,
    };
  },

  /**
   * Assert a string starts with a prefix.
   */
  toHavePrefix(received: string, prefix: string) {
    const pass = received.startsWith(prefix);
    return {
      pass,
      message: () =>
        pass
          ? `Expected "${received.substring(0, 60)}" NOT to start with "${prefix}"`
          : `Expected "${received.substring(0, 60)}${received.length > 60 ? '...' : ''}" to start with "${prefix}"`,
    };
  },
};

// ---------------------------------------------------------------------------
// TypeScript declaration merging for Jest
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toEqualBytes(expected: Uint8Array): R;
      toMatchHex(expectedHex: string): R;
      toBeBytesOfLength(length: number): R;
      toBeNonZeroBytes(): R;
      toHavePrefix(prefix: string): R;
    }
  }
}
