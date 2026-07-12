/**
 * Content-derived release rkey — `rkey == f(cid)` (§5).
 *
 * ATProto lets a publisher overwrite a record at the same rkey, so
 * "immutable release" must be ENFORCED, not assumed: the release rkey
 * is the lowercase base32 (RFC 4648, no padding) encoding of the
 * SHA-256 digest inside the record's CID — the same bytes ATProto's
 * own record CID hashes (CIDv1, dag-cbor, sha2-256). Any holder of the
 * record can check `rkey == releaseRkeyFromCid(cid)` with no bespoke
 * canonicalization scheme to get wrong. 52 chars, inside the rkey
 * charset ([A-Za-z0-9._:~-]) and length (≤512) limits.
 *
 * An overwritten release fails this check at EVERY verifier — the
 * on-node installer and AppView alike — with no reliance on AppView
 * having watched the firehose (§5: direct install bypasses AppView by
 * design and gets the same guarantee).
 *
 * CID parsing here is deliberately narrow: CIDv1, multibase 'b'
 * (base32-lower), codec dag-cbor (0x71), multihash sha2-256 (0x12,
 * length 32). Anything else returns null — closed-default, like every
 * verifier in this package. ATProto records are exactly this shape;
 * accepting more would only widen the forgery surface.
 *
 * Pure functions. Zero runtime deps.
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const BASE32_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < BASE32_ALPHABET.length; i++) table[BASE32_ALPHABET.charAt(i)] = i;
  return table;
})();

/** RFC 4648 base32, lowercase, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode lowercase base32 (no padding). Returns null on any bad char. */
export function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = BASE32_LOOKUP[ch];
    if (v === undefined) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** dag-cbor multicodec. */
const CODEC_DAG_CBOR = 0x71;
/** sha2-256 multihash code + digest length. */
const MULTIHASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 32;

/**
 * Extract the SHA-256 digest from a CIDv1 string (multibase 'b',
 * dag-cbor, sha2-256). Returns null for anything else — including
 * CIDv0, other codecs, other hash functions, or malformed varints.
 */
export function sha256DigestFromCid(cid: string): Uint8Array | null {
  if (typeof cid !== 'string' || cid.length < 8 || cid[0] !== 'b') return null;
  const body = cid.slice(1);
  const bytes = base32Decode(body);
  if (bytes === null || bytes.length < 4) return null;
  // Audit D9: reject NON-CANONICAL base32 (CID malleability). base32
  // can encode the same bytes multiple ways (unused trailing bits); a
  // malleable CID string breaks the "content-addressed" invariant since
  // two distinct strings would map to one digest. Round-trip: the
  // canonical re-encode must equal the input, else it is malleable.
  if (base32Encode(bytes) !== body) return null;
  // Layout: version varint (0x01), codec varint, mh code varint,
  // mh length varint, digest. All our varints are single-byte for
  // this shape (0x01, 0x71, 0x12, 0x20) — values < 0x80.
  if (bytes[0] !== 0x01) return null; // CIDv1 only
  if (bytes[1] !== CODEC_DAG_CBOR) return null;
  if (bytes[2] !== MULTIHASH_SHA2_256) return null;
  if (bytes[3] !== SHA2_256_LENGTH) return null;
  if (bytes.length !== 4 + SHA2_256_LENGTH) return null;
  return bytes.slice(4);
}

/**
 * The content-derived rkey for a release CID, or null when the CID is
 * not the expected shape. 52 lowercase base32 chars.
 */
export function releaseRkeyFromCid(cid: string): string | null {
  const digest = sha256DigestFromCid(cid);
  if (digest === null) return null;
  return base32Encode(digest);
}

/**
 * The verifier check (§5): does this record's rkey match its CID's
 * digest? False on any malformed input — closed-default.
 */
export function isValidReleaseRkey(rkey: string, cid: string): boolean {
  if (typeof rkey !== 'string' || rkey.length === 0) return false;
  const expected = releaseRkeyFromCid(cid);
  return expected !== null && expected === rkey;
}
