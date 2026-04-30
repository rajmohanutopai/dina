/**
 * Internal: RFC 4648 base32 — lowercase, no padding.
 *
 * Used by:
 *   - did:plc derivation in `directory.ts` (truncated to 24 chars after the
 *     "did:plc:" prefix per the AT Protocol PLC spec).
 *   - CID multibase encoding in `plc_namespace_update.ts` (full output with
 *     a `b` multibase prefix).
 *
 * Not exported from `@dina/core`'s public surface — both call sites are
 * internal to the identity module. Hoisted here so the two copies don't
 * drift; a regression in either consumer would otherwise leak into PLC
 * wire formatting.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Encode bytes as RFC 4648 base32, lowercase, no padding. */
export function base32LowercaseNoPad(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    result += ALPHABET[(value << (5 - bits)) & 31];
  }
  return result;
}
