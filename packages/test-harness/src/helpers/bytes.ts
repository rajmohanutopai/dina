/**
 * Byte ↔ hex conversion utilities for test assertions.
 *
 * These are used by fixture-based tests to convert between JSON hex strings
 * and Uint8Array values. They must be correct — incorrect conversion silently
 * produces wrong test results.
 */

/**
 * Convert hex string to Uint8Array.
 * Rejects odd-length strings and non-hex characters.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith('0x') || hex.startsWith('0X')) {
    throw new Error(`hexToBytes: unexpected 0x prefix — pass raw hex without prefix`);
  }
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`hexToBytes: contains non-hex characters: "${hex.substring(0, 20)}..."`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to lowercase hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compare two Uint8Arrays for equality.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if a Uint8Array is all zeros.
 */
export function isAllZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * UTF-8 encode a string to Uint8Array.
 */
export function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * UTF-8 decode a Uint8Array to string.
 */
export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
