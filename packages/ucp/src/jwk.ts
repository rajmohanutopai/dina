/**
 * Public JWKs as UCP profiles carry them (profile.json `$defs/jwk_public_key`;
 * signatures.md:95-209): Dina signs and verifies ES256 (EC P-256) only, the one
 * algorithm every verifier must support. Other key types are kept as unusable,
 * never as a reason to refuse the key set (signatures.md:102-108).
 */

import { base64urlDecode, base64urlEncode, isPlainObject, utf8Bytes } from '@dina/a2a';

import type { Sha256Fn } from './signatures';

export interface Es256Jwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  use?: string;
  alg?: 'ES256';
  key_ops?: string[];
}

/** RFC 7638 SHA-256 thumbprint of a P-256 key: base64url of SHA-256 over `{"crv","kty","x","y"}`. */
export function es256Thumbprint(x: string, y: string, sha256: Sha256Fn): string {
  return base64urlEncode(sha256(utf8Bytes(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)));
}

/** The JWK Dina publishes for an uncompressed P-256 public key (0x04 ‖ X ‖ Y). */
export function es256PublicJwk(publicKey: Uint8Array, sha256: Sha256Fn): Es256Jwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04)
    throw new Error('jwk: expected an uncompressed P-256 public key');
  const x = base64urlEncode(publicKey.slice(1, 33));
  const y = base64urlEncode(publicKey.slice(33, 65));
  return {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    kid: es256Thumbprint(x, y, sha256),
    use: 'sig',
    alg: 'ES256',
  };
}

export interface UsableKey {
  kid: string;
  /** Uncompressed point, 65 bytes. */
  publicKey: Uint8Array;
}

/**
 * The verification keys a profile's `keys[]` offers: EC P-256 keys whose `use`
 * is not `enc`, whose `key_ops` (if any) include `verify`, whose `alg` (if any)
 * is ES256 and which carry no private member. Everything else is skipped, not
 * fatal (overview :2418-2424).
 */
export function usableEs256Keys(keys: unknown): UsableKey[] {
  if (!Array.isArray(keys)) return [];
  const out: UsableKey[] = [];
  for (const k of keys) {
    if (!isPlainObject(k) || typeof k.kid !== 'string' || k.kid === '') continue;
    if (k.kty !== 'EC' || k.crv !== 'P-256') continue;
    if (k.use === 'enc') continue;
    if (k.key_ops !== undefined && !(Array.isArray(k.key_ops) && k.key_ops.includes('verify')))
      continue;
    if (k.alg !== undefined && k.alg !== 'ES256') continue;
    if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((m) => m in k)) continue;
    if (typeof k.x !== 'string' || typeof k.y !== 'string') continue;
    const x = base64urlDecode(k.x);
    const y = base64urlDecode(k.y);
    if (x === null || y === null || x.length !== 32 || y.length !== 32) continue;
    out.push({ kid: k.kid, publicKey: new Uint8Array([0x04, ...x, ...y]) });
  }
  return out;
}
