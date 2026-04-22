/**
 * Crockford Base32 alphabet + pairing-code generator.
 *
 * Used for human-enterable device-pairing codes in the MsgBox workstream.
 * The alphabet excludes `I`, `L`, `O`, `U` to avoid visual confusion with
 * `1`, `0`, and rude words. On decode we canonicalize user typos:
 *   - Case-insensitive
 *   - `I`/`i` → `1`
 *   - `L`/`l` → `1`
 *   - `O`/`o` → `0`
 *   - Whitespace + hyphens stripped
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-013 / CORE-P0-014 / CORE-P0-015.
 */

/** 32 characters, one per 5-bit symbol. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

/** Reverse lookup populated once at module load. */
const CROCKFORD_INDEX: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
    m.set(CROCKFORD_ALPHABET[i], i);
  }
  return m;
})();

/** Pairing-code length. 8 chars × 5 bits = 40-bit codespace (~1.1 trillion). */
export const PAIRING_CODE_LENGTH = 8;
/** Random-bytes length feeding one pairing code. 40 bits = 5 bytes. */
export const PAIRING_CODE_BYTES = 5;

/**
 * Encode a non-negative `bigint` to Crockford Base32.
 * Returns `"0"` for zero. No padding, no separators.
 */
export function encodeCrockford(n: bigint): string {
  if (n < 0n) {
    throw new Error('encodeCrockford: value must be non-negative');
  }
  if (n === 0n) return '0';
  let out = '';
  let x = n;
  while (x > 0n) {
    const digit = Number(x & 31n);
    out = CROCKFORD_ALPHABET[digit] + out;
    x >>= 5n;
  }
  return out;
}

/**
 * Decode a Crockford Base32 string (post-canonicalisation) to a `bigint`.
 * Throws on unknown characters after canonicalisation.
 */
export function decodeCrockford(s: string): bigint {
  const canonical = canonicalizeCrockford(s);
  if (canonical === '') {
    throw new Error('decodeCrockford: empty input after canonicalisation');
  }
  let n = 0n;
  for (const ch of canonical) {
    const digit = CROCKFORD_INDEX.get(ch);
    if (digit === undefined) {
      throw new Error(`decodeCrockford: unexpected character "${ch}"`);
    }
    n = (n << 5n) | BigInt(digit);
  }
  return n;
}

/**
 * Canonicalise a user-entered code to the alphabet:
 *   - Uppercase
 *   - `I`/`L` → `1`, `O` → `0`
 *   - Strip whitespace + hyphens
 *
 * Returned string contains only characters from `CROCKFORD_ALPHABET` if input
 * was well-formed. Callers typically feed this into `decodeCrockford`.
 */
export function canonicalizeCrockford(raw: string): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '-') {
      continue;
    }
    if (ch === 'I' || ch === 'L') {
      out += '1';
      continue;
    }
    if (ch === 'O') {
      out += '0';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Generate a fresh 8-character pairing code from 5 random bytes.
 * Codespace: 32^8 = 2^40 ≈ 1.1 trillion. No burn counter — each call returns
 * a unique random code. Caller supplies randomness (pass `randomBytes(5)`
 * from `@noble/ciphers/utils.js` in production, deterministic bytes in
 * tests).
 */
export function generatePairingCode(bytes: Uint8Array): string {
  if (bytes.length !== PAIRING_CODE_BYTES) {
    throw new Error(
      `generatePairingCode: expected ${PAIRING_CODE_BYTES} bytes, got ${bytes.length}`,
    );
  }
  // Pack 5 bytes (40 bits) into a single bigint, then encode + left-pad to 8.
  let n = 0n;
  for (const b of bytes) {
    n = (n << 8n) | BigInt(b);
  }
  let code = encodeCrockford(n);
  if (code.length < PAIRING_CODE_LENGTH) {
    code = '0'.repeat(PAIRING_CODE_LENGTH - code.length) + code;
  }
  return code;
}
