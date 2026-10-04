/**
 * Keys for remote Agent Card signatures (design §6.1, spec §8.4.3): resolve
 * the key a JWS protected header names, check the signature with it, and
 * name the key by its RFC 7638 thumbprint so the card pin records WHO
 * vouched, not which signature bytes they produced.
 *
 * A key comes from the header's `jku` (an HTTPS JWK Set fetched under the
 * outbound policy, design §6.6) and its `kid`. A key that declares a `use`
 * other than `sig`, or an `alg` other than the header's, is not used. A
 * header with no `jku` names no key Dina can fetch, so its signature cannot
 * verify. A verified signature says the card is unchanged since the holder
 * of that key signed it; it says nothing about who the holder is. The owner
 * sees the key's source on the review card.
 *
 * ES256 accepts both halves of S: JWS (RFC 7518 §3.4) does not normalize S,
 * and about half of a conforming signer's signatures are high-S.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  base64urlDecode,
  base64urlEncode,
  canonicalize,
  isPlainObject,
  parseStrictJson,
  type JsonValue,
  type JwsProtectedHeader,
  type JwsVerdict,
  type JwsVerifyFn,
} from '@dina/a2a';

import { A2A_FETCH_LIMITS, a2aFetch, type A2ATransportError } from './host_transport';

export type ParsedJwk =
  | { kty: 'EC'; crv: 'P-256'; x: Uint8Array; y: Uint8Array; kid?: string; use?: string; alg?: string }
  | { kty: 'OKP'; crv: 'Ed25519'; x: Uint8Array; kid?: string; use?: string; alg?: string };

function fixed(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const bytes = base64urlDecode(value);
  return bytes !== null && bytes.length === length ? bytes : null;
}

/** A P-256 or Ed25519 public JWK, or null. Private members (`d`) refuse the key. */
export function parsePublicJwk(value: unknown): ParsedJwk | null {
  if (!isPlainObject(value)) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'd')) return null;
  const meta: { kid?: string; use?: string; alg?: string } = {};
  for (const key of ['kid', 'use', 'alg'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    meta[key] = v;
  }
  if (value.kty === 'EC' && value.crv === 'P-256') {
    const x = fixed(value.x, 32);
    const y = fixed(value.y, 32);
    return x !== null && y !== null ? { kty: 'EC', crv: 'P-256', x, y, ...meta } : null;
  }
  if (value.kty === 'OKP' && value.crv === 'Ed25519') {
    const x = fixed(value.x, 32);
    return x !== null ? { kty: 'OKP', crv: 'Ed25519', x, ...meta } : null;
  }
  return null;
}

/** RFC 7638 thumbprint: base64url sha256 of the required members, sorted, no whitespace. */
export function jwkThumbprint(jwk: ParsedJwk): string {
  const required =
    jwk.kty === 'EC'
      ? { crv: jwk.crv, kty: jwk.kty, x: base64urlEncode(jwk.x), y: base64urlEncode(jwk.y) }
      : { crv: jwk.crv, kty: jwk.kty, x: base64urlEncode(jwk.x) };
  return base64urlEncode(sha256(new TextEncoder().encode(canonicalize(required))));
}

/** Check one JWS signature with one key. Never throws. */
export function verifyWithJwk(
  jwk: ParsedJwk,
  alg: JwsProtectedHeader['alg'],
  signingInput: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (alg === 'ES256' && jwk.kty === 'EC') {
      const point = new Uint8Array(65);
      point[0] = 0x04;
      point.set(jwk.x, 1);
      point.set(jwk.y, 33);
      return p256.verify(signature, signingInput, point, { lowS: false });
    }
    if (alg === 'EdDSA' && jwk.kty === 'OKP') {
      return ed25519.verify(signature, signingInput, jwk.x, { zip215: false });
    }
    return false;
  } catch {
    return false;
  }
}

export type KeySetFetch =
  | { ok: true; keys: JsonValue[] }
  | { ok: false; reason: A2ATransportError | 'status' | 'not_json' | 'not_a_key_set' | 'too_many_keys' };

/**
 * Keys one set may hold, and keys tried for one signature. Rotation needs a
 * few; a set of hundreds under one `kid` would make each card check run
 * thousands of verifications.
 */
export const MAX_KEYS_PER_SET = 32;
export const MAX_CANDIDATES_PER_KID = 4;

/** Fetch and parse a JWK Set under the outbound policy. */
export async function fetchKeySet(url: string): Promise<KeySetFetch> {
  const response = await a2aFetch({ method: 'GET', url, headers: {}, ...A2A_FETCH_LIMITS.keySet });
  if (!response.ok) return { ok: false, reason: response.error };
  if (response.status !== 200) return { ok: false, reason: 'status' };
  const parsed = parseStrictJson(response.body);
  if (!parsed.ok) return { ok: false, reason: 'not_json' };
  if (!isPlainObject(parsed.value) || !Array.isArray(parsed.value.keys)) {
    return { ok: false, reason: 'not_a_key_set' };
  }
  if (parsed.value.keys.length > MAX_KEYS_PER_SET) return { ok: false, reason: 'too_many_keys' };
  return { ok: true, keys: parsed.value.keys };
}

export interface KeyResolutionNote {
  kid: string;
  jku?: string;
  outcome: 'verified' | 'no_jku' | 'key_set_unavailable' | 'too_many_key_sets' | 'no_matching_key' | 'bad_signature';
}

/** Distinct `jku` key sets fetched for one card at most; each fetch has its own deadline. */
export const MAX_KEY_SETS_PER_CARD = 2;

/**
 * A `JwsVerifyFn` that resolves keys through `jku`, fetching each key set
 * once, and reports a verified key by its thumbprint. `notes` collects what
 * happened to every signature, for the owner's review card.
 */
export function createJkuVerifier(
  notes: KeyResolutionNote[],
  fetchSet: (url: string) => Promise<KeySetFetch> = fetchKeySet,
): JwsVerifyFn {
  const sets = new Map<string, Promise<KeySetFetch>>();
  return async ({ header, signingInputs, signature }): Promise<JwsVerdict> => {
    const note = (outcome: KeyResolutionNote['outcome']): void => {
      notes.push({ kid: header.kid, ...(header.jku !== undefined ? { jku: header.jku } : {}), outcome });
    };
    if (header.jku === undefined) {
      note('no_jku');
      return false;
    }
    let pending = sets.get(header.jku);
    if (pending === undefined) {
      if (sets.size >= MAX_KEY_SETS_PER_CARD) {
        note('too_many_key_sets');
        return false;
      }
      pending = fetchSet(header.jku);
      sets.set(header.jku, pending);
    }
    const set = await pending;
    if (!set.ok) {
      note('key_set_unavailable');
      return false;
    }
    const candidates = set.keys
      .slice(0, MAX_KEYS_PER_SET)
      .map(parsePublicJwk)
      .filter(
        (k): k is ParsedJwk =>
          k !== null &&
          k.kid === header.kid &&
          (k.use === undefined || k.use === 'sig') &&
          (k.alg === undefined || k.alg === header.alg),
      )
      .slice(0, MAX_CANDIDATES_PER_KID);
    if (candidates.length === 0) {
      note('no_matching_key');
      return false;
    }
    for (const key of candidates) {
      if (signingInputs.some((input) => verifyWithJwk(key, header.alg, input, signature))) {
        note('verified');
        return { signer: `jwk:${jwkThumbprint(key)}` };
      }
    }
    note('bad_signature');
    return false;
  };
}
