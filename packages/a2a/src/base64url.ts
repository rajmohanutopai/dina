/**
 * Base64url without padding (RFC 4648 §5), as JWS uses it (RFC 7515 §2).
 *
 * Decoding is strict: padding, characters outside the alphabet, an impossible
 * length, and non-zero trailing bits are all refused, so one byte string has
 * exactly one accepted spelling. A signature or header that decodes from two
 * spellings would let a relayed card differ from the signed one byte-for-byte.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = Object.create(null) as Record<string, number>;
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charAt(i)] = i;
  return table;
})();

export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  const at = (i: number): number => bytes[i] ?? 0;
  const sym = (n: number): string => ALPHABET.charAt(n & 63);
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    out += sym(n >> 18) + sym(n >> 12) + sym(n >> 6) + sym(n);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = at(i) << 16;
    out += sym(n >> 18) + sym(n >> 12);
  } else if (rest === 2) {
    const n = (at(i) << 16) | (at(i + 1) << 8);
    out += sym(n >> 18) + sym(n >> 12) + sym(n >> 6);
  }
  return out;
}

/** Decode, or `null` when the input is not the one canonical spelling. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const values = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const v = LOOKUP[text.charAt(i)];
    if (v === undefined) return null;
    values[i] = v;
  }
  const at = (i: number): number => values[i] ?? 0;
  const out = new Uint8Array(Math.floor((values.length * 6) / 8));
  let o = 0;
  let i = 0;
  for (; i + 3 < values.length; i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = values.length - i;
  if (rest === 2) {
    const n = (at(i) << 18) | (at(i + 1) << 12);
    if ((n & 0xffff) !== 0) return null; // non-zero trailing bits
    out[o++] = (n >> 16) & 255;
  } else if (rest === 3) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6);
    if ((n & 0xff) !== 0) return null; // non-zero trailing bits
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
  }
  return out;
}

export function base64urlEncodeUtf8(text: string): string {
  return base64urlEncode(new TextEncoder().encode(text));
}

/** Decode to a UTF-8 string, or `null` on a non-canonical spelling or bad UTF-8. */
export function base64urlDecodeUtf8(text: string): string | null {
  const bytes = base64urlDecode(text);
  if (bytes === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
