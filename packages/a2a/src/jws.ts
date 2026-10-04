/**
 * Agent Card signatures: JWS (RFC 7515) over the RFC 8785 card payload, in
 * the `AgentCardSignature` shape (spec §8.4.2–§8.4.3).
 *
 * Crypto is injected, keeping this package dependency-free. Signatures are
 * the raw JWS form: for ES256, the 64-byte `r || s` concatenation (RFC 7518
 * §3.4), never DER. For EdDSA (RFC 8037), the 64-byte Ed25519 signature.
 *
 * Verification is strict about the protected header: it must be a JSON
 * object with `alg` and `kid` (spec: MUST), `alg` must be one the verifier
 * supports (never `none`), and any `crit` entry fails the signature, since
 * Dina understands no critical extensions (RFC 7515 §4.1.11).
 *
 * A signature may cover either of a card's two forms: §8.4.1's, or the one
 * the reference SDK signs (`cardSdkSigningPayload`). Both are checked, so a
 * card the SDK signed verifies here, and Dina signs its own card over each
 * form that differs, so the SDK's verifier accepts it too.
 */

import {
  base64urlDecode,
  base64urlDecodeUtf8,
  base64urlEncode,
  base64urlEncodeUtf8,
} from './base64url';
import { cardFormPayload, cardSdkSigningPayload, cardSigningPayload, type CardSigningForm } from './card';
import { isPlainObject, utf8Bytes } from './json';
import { parseStrictJson } from './strict_json';

import type { AgentCardSignature } from './types';

export type JwsAlgorithm = 'ES256' | 'EdDSA';

export const SUPPORTED_JWS_ALGORITHMS: ReadonlySet<string> = new Set<JwsAlgorithm>([
  'ES256',
  'EdDSA',
]);

/** Both supported algorithms produce exactly 64 signature bytes (RFC 7518 §3.4, RFC 8037 §3.1). */
const SIGNATURE_BYTES: Readonly<Record<JwsAlgorithm, number>> = { ES256: 64, EdDSA: 64 };

export interface JwsProtectedHeader {
  alg: JwsAlgorithm;
  /** As the signer wrote it; Dina writes `JOSE` (spec §8.4.2: SHOULD). */
  typ?: string;
  kid: string;
  jku?: string;
}

export type JwsSignFn = (signingInput: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * What a verifier says about one signature: `false` when it does not verify,
 * or when the key is unknown, expired, or revoked (the spec forbids verifying
 * with such keys, §8.4.3). On success it may name the key that verified, as
 * a stable identity such as an RFC 7638 thumbprint; a bare `true` is
 * identified by the header's `jku` and `kid`. A throw counts as `false`.
 */
export type JwsVerdict = boolean | { signer: string };

/**
 * Called once per signature. `signingInputs` holds the JWS signing input of
 * every form of the card the signature may cover (§8.4.1's first, then the
 * reference SDK's when it differs): the signature verifies when it covers
 * any of them.
 */
export type JwsVerifyFn = (args: {
  header: JwsProtectedHeader;
  signingInputs: readonly Uint8Array[];
  signature: Uint8Array;
}) => JwsVerdict | Promise<JwsVerdict>;

function signingInput(protectedB64: string, payload: string): Uint8Array {
  return utf8Bytes(`${protectedB64}.${base64urlEncodeUtf8(payload)}`);
}

/** One signature over one form of the card (§8.4.1's unless `form` says otherwise). */
export async function signAgentCard(
  card: Record<string, unknown>,
  header: JwsProtectedHeader,
  sign: JwsSignFn,
  form: CardSigningForm = 'spec',
): Promise<AgentCardSignature> {
  const headerJson: Record<string, string> = {
    alg: header.alg,
    typ: header.typ ?? 'JOSE',
    kid: header.kid,
  };
  if (header.jku !== undefined) headerJson.jku = header.jku;
  const protectedB64 = base64urlEncodeUtf8(JSON.stringify(headerJson));
  const signature = await sign(signingInput(protectedB64, cardFormPayload(card, form)));
  if (signature.length !== SIGNATURE_BYTES[header.alg]) {
    throw new Error(
      `signAgentCard: ${header.alg} signature must be ${SIGNATURE_BYTES[header.alg]} raw bytes`,
    );
  }
  return { protected: protectedB64, signature: base64urlEncode(signature) };
}

export function parseProtectedHeader(protectedB64: string): JwsProtectedHeader | null {
  const text = base64urlDecodeUtf8(protectedB64);
  if (text === null) return null;
  const parsed = parseStrictJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const value = parsed.value;
  if (typeof value.alg !== 'string' || !SUPPORTED_JWS_ALGORITHMS.has(value.alg)) return null;
  if (typeof value.kid !== 'string' || value.kid === '') return null;
  if (Object.prototype.hasOwnProperty.call(value, 'crit')) return null;
  // `typ` SHOULD be "JOSE" (spec §8.4.2), not MUST: a peer's other spelling is tolerated.
  if (Object.prototype.hasOwnProperty.call(value, 'typ') && typeof value.typ !== 'string')
    return null;
  if (Object.prototype.hasOwnProperty.call(value, 'jku') && typeof value.jku !== 'string')
    return null;
  const header: JwsProtectedHeader = { alg: value.alg as JwsAlgorithm, kid: value.kid };
  if (typeof value.typ === 'string') header.typ = value.typ;
  if (typeof value.jku === 'string') header.jku = value.jku;
  return header;
}

export type CardSignatureState = 'verified' | 'unsigned' | 'invalid';

/**
 * Signatures checked on one card at most. Several support key rotation; a
 * card with more is refused as invalid, so a hostile card cannot make its
 * reader verify (and fetch keys for) without end.
 */
export const MAX_CARD_SIGNATURES = 8;

export interface CardSignatureReport {
  state: CardSignatureState;
  /** `kid`s whose signature verified. */
  verifiedKids: string[];
  /** Identities of the keys that verified, for the card pin (`cardPinText`). */
  verifiedSigners: string[];
}

/**
 * Verify every signature on a card. `verified` when at least one checks out
 * over either form (spec: SHOULD verify at least one; several support key
 * rotation),
 * `unsigned` when the card has no `signatures` member or an empty one,
 * `invalid` when the member is malformed or longer than
 * `MAX_CARD_SIGNATURES`, when the card has no canonical form, or when every
 * signature fails.
 */
export async function verifyAgentCardSignatures(
  card: Record<string, unknown>,
  verify: JwsVerifyFn,
): Promise<CardSignatureReport> {
  const invalid: CardSignatureReport = { state: 'invalid', verifiedKids: [], verifiedSigners: [] };
  const signatures = card.signatures;
  if (signatures === undefined || (Array.isArray(signatures) && signatures.length === 0)) {
    return { state: 'unsigned', verifiedKids: [], verifiedSigners: [] };
  }
  if (!Array.isArray(signatures) || signatures.length > MAX_CARD_SIGNATURES) return invalid;
  let payloads: string[];
  try {
    const spec = cardSigningPayload(card);
    const sdk = cardSdkSigningPayload(card);
    payloads = sdk === spec ? [spec] : [spec, sdk];
  } catch {
    return invalid;
  }
  const verifiedKids: string[] = [];
  const verifiedSigners: string[] = [];
  for (const sig of signatures) {
    if (
      !isPlainObject(sig) ||
      typeof sig.protected !== 'string' ||
      typeof sig.signature !== 'string'
    ) {
      continue;
    }
    const protectedB64 = sig.protected;
    const header = parseProtectedHeader(protectedB64);
    const signature = base64urlDecode(sig.signature);
    if (header === null || signature === null) continue;
    if (signature.length !== SIGNATURE_BYTES[header.alg]) continue;
    let verdict: JwsVerdict = false;
    try {
      verdict = await verify({
        header,
        signingInputs: payloads.map((payload) => signingInput(protectedB64, payload)),
        signature,
      });
    } catch {
      // A verifier that throws (bad point, unreachable key set) has not verified anything.
      verdict = false;
    }
    if (verdict === false) continue;
    const signer = verdict === true ? `${header.jku ?? ''}#${header.kid}` : verdict.signer;
    if (!verifiedKids.includes(header.kid)) verifiedKids.push(header.kid);
    if (!verifiedSigners.includes(signer)) verifiedSigners.push(signer);
  }
  return verifiedKids.length > 0 ? { state: 'verified', verifiedKids, verifiedSigners } : invalid;
}
