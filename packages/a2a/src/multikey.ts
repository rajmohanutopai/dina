/**
 * Multikey public keys (W3C Controlled Identifiers; did:key): `z` and the
 * base58btc of a multicodec prefix and the raw key. The two a Dina node's
 * DID document carries for A2A (design §8.2, §8.3): its Ed25519
 * `dina_signing` key (multicodec 0xed, varint `ed 01`, 32 bytes), which
 * signs the directory envelope and the fence, and the P-256 key that signs
 * its Agent Card (multicodec 0x1200, varint `80 24`, the 33-byte
 * compressed point), which AppView verifies the card's JWS against.
 *
 * Pure byte work: no curve math, so no crypto dependency. A decoder that
 * finds the wrong prefix or length answers null.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

export function base58btcDecode(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const value = INDEX.get(text[i] ?? '');
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes.reverse(), zeros);
  return out;
}

const ED25519_PREFIX = [0xed, 0x01] as const;
const P256_PREFIX = [0x80, 0x24] as const;

function encode(prefix: readonly number[], key: Uint8Array): string {
  const bytes = new Uint8Array(prefix.length + key.length);
  bytes.set(prefix);
  bytes.set(key, prefix.length);
  return `z${base58btcEncode(bytes)}`;
}

function decode(prefix: readonly number[], keyLength: number, multibase: string): Uint8Array | null {
  if (!multibase.startsWith('z')) return null;
  const bytes = base58btcDecode(multibase.slice(1));
  if (bytes === null || bytes.length !== prefix.length + keyLength) return null;
  if (!prefix.every((b, i) => bytes[i] === b)) return null;
  return bytes.slice(prefix.length);
}

export function ed25519Multikey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('multikey: an Ed25519 key is 32 bytes');
  return encode(ED25519_PREFIX, publicKey);
}

/** The 32-byte Ed25519 key a Multikey names, or null. */
export function ed25519FromMultikey(multibase: string): Uint8Array | null {
  return decode(ED25519_PREFIX, 32, multibase);
}

export function p256Multikey(compressedPoint: Uint8Array): string {
  if (compressedPoint.length !== 33 || (compressedPoint[0] !== 0x02 && compressedPoint[0] !== 0x03)) {
    throw new Error('multikey: a P-256 key is a 33-byte compressed point');
  }
  return encode(P256_PREFIX, compressedPoint);
}

/** The 33-byte compressed P-256 point a Multikey names, or null. */
export function p256FromMultikey(multibase: string): Uint8Array | null {
  const point = decode(P256_PREFIX, 33, multibase);
  return point !== null && (point[0] === 0x02 || point[0] === 0x03) ? point : null;
}

/** The fragment under which a node's DID document names its card-signing key (design §8.3). */
export const A2A_CARD_KEY_FRAGMENT = 'a2a_card';
/** The fragment of its `dina_signing` key, as PLC renders it. */
export const DINA_SIGNING_FRAGMENT = 'dina_signing';
