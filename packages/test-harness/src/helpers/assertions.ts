/**
 * Custom test assertions — TypeScript equivalents of Go testutil.go helpers.
 *
 * These extend Jest's built-in matchers with domain-specific assertions
 * that produce clear error messages for Dina-specific failures.
 */

import { bytesToHex, bytesEqual } from './bytes';

/**
 * Assert two Uint8Arrays are byte-identical.
 * Produces a hex diff on failure for easy debugging.
 */
export function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  if (!bytesEqual(actual, expected)) {
    const maxShow = 64;
    const actualHex = bytesToHex(actual).substring(0, maxShow * 2);
    const expectedHex = bytesToHex(expected).substring(0, maxShow * 2);
    throw new Error(
      `Byte mismatch:\n` +
        `  actual   (${actual.length} bytes): ${actualHex}${actual.length > maxShow ? '...' : ''}\n` +
        `  expected (${expected.length} bytes): ${expectedHex}${expected.length > maxShow ? '...' : ''}`,
    );
  }
}

/**
 * Assert two Uint8Arrays are NOT identical.
 */
export function expectBytesNotEqual(actual: Uint8Array, other: Uint8Array): void {
  if (bytesEqual(actual, other)) {
    throw new Error('Expected byte arrays to differ, but they are identical');
  }
}

/**
 * Assert a Uint8Array has the expected length.
 */
export function expectBytesLength(actual: Uint8Array, length: number): void {
  if (actual.length !== length) {
    throw new Error(`Expected ${length} bytes, got ${actual.length}`);
  }
}

/**
 * Assert a hex string matches the hex encoding of a Uint8Array.
 * Normalizes both to lowercase before comparison.
 */
export function expectHexEqual(actual: Uint8Array, expectedHex: string): void {
  const actualHex = bytesToHex(actual);
  const normalizedExpected = expectedHex.toLowerCase();
  if (actualHex !== normalizedExpected) {
    throw new Error(`Hex mismatch:\n  actual:   ${actualHex}\n  expected: ${normalizedExpected}`);
  }
}

/**
 * Assert a string starts with a prefix.
 */
export function expectPrefix(actual: string, prefix: string): void {
  if (!actual.startsWith(prefix)) {
    throw new Error(`Expected "${actual.substring(0, 40)}..." to start with "${prefix}"`);
  }
}

/**
 * Assert a string contains a substring.
 */
export function expectContains(actual: string, substring: string): void {
  if (!actual.includes(substring)) {
    throw new Error(`Expected "${actual.substring(0, 80)}..." to contain "${substring}"`);
  }
}

/**
 * Assert an async function throws an error matching a pattern.
 * Returns the caught error for further inspection (e.g., checking error type).
 *
 * Usage:
 *   const err = await expectAsyncThrows(() => unlock('health'), 'locked');
 *   expect(err).toBeInstanceOf(PersonaLockedError);
 */
export async function expectAsyncThrows(
  fn: () => Promise<unknown>,
  pattern?: string | RegExp,
): Promise<Error> {
  let error: Error | undefined;
  try {
    await fn();
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  if (!error) {
    throw new Error('Expected function to throw, but it did not');
  }
  if (pattern) {
    const matches =
      typeof pattern === 'string' ? error.message.includes(pattern) : pattern.test(error.message);
    if (!matches) {
      throw new Error(`Error message "${error.message}" does not match pattern: ${pattern}`);
    }
  }
  return error;
}

/**
 * Assert that a Uint8Array is not all zeros (reject zero seed/key).
 */
export function expectNotAllZero(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return;
  }
  throw new Error(`Expected non-zero bytes, got all zeros (${bytes.length} bytes)`);
}
