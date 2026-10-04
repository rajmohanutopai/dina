/**
 * Check one request's canonical signature: the four headers present, the
 * time inside the ±5-minute window, the Ed25519 signature over method, path,
 * query, time, nonce and the body's hash, then the nonce unused. The nonce
 * is spent only once the signature is proven, so an unsigned request cannot
 * burn a caller's future nonces.
 *
 * One function for every Dina process that takes signed requests: Core's
 * auth middleware (with its key resolver and replay cache) and Brain's
 * caller check (with its own cache), so the two cannot drift. It never
 * throws: malformed material (a timestamp that is not RFC 3339, a signature
 * that is not hex) is a refusal like any other.
 */

import { extractPublicKey } from '../identity/did';

import { verifyRequest, verifySignedText } from './canonical';
import { isTimestampValid } from './timestamp';

/**
 * Spends a nonce: true the first time, false for a replay. It is handed the
 * request's time and DID so a guard can scope a nonce to its signer and keep
 * it as long as the signature passes the time check. Core's `NonceCache`
 * keeps every nonce for a fixed time and needs neither.
 */
export interface ReplayGuard {
  check(nonce: string, timestamp: string, did: string): boolean;
}

export interface SignedRequestParts {
  method: string;
  path: string;
  /** The query string as sent, without the `?`. */
  query: string;
  body: Uint8Array;
  did?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
}

/** What a signed request's text is built from, once its headers are known to be present. */
export interface SignedTextParts {
  method: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
  body: Uint8Array;
}

export type SignatureCheck =
  | { ok: true; did: string }
  | {
      ok: false;
      did?: string;
      rejectedAt: 'headers' | 'timestamp' | 'signature' | 'nonce';
      reason: string;
    };

export function checkRequestSignature(
  req: SignedRequestParts,
  options: {
    nonces: ReplayGuard;
    /** DIDs whose keys are not in the DID itself (`did:plc`); a `did:key` needs none. */
    resolvePublicKey?: ((did: string) => Uint8Array | null) | null;
    /**
     * The text the signature covers, when it is not Dina's canonical request
     * string: an A2A client's request signature adds a domain and its
     * audience (`didRequestSigningInput`).
     */
    signedText?: (parts: SignedTextParts) => string;
  },
): SignatureCheck {
  const { did, timestamp, nonce, signature } = req;
  if (!did || !timestamp || !nonce || !signature) {
    return {
      ok: false,
      rejectedAt: 'headers',
      reason: 'Missing required auth headers (X-DID, X-Timestamp, X-Nonce, X-Signature)',
    };
  }
  let timely: boolean;
  try {
    timely = isTimestampValid(timestamp);
  } catch {
    timely = false;
  }
  if (!timely) {
    return { ok: false, did, rejectedAt: 'timestamp', reason: 'Timestamp outside ±5 minute window' };
  }
  // The resolver first (`did:plc` and other DIDs that do not carry their
  // key); then `did:key`, whose key is in the DID itself.
  let publicKey: Uint8Array | null;
  try {
    publicKey = options.resolvePublicKey?.(did) ?? null;
  } catch {
    publicKey = null;
  }
  if (publicKey === null && did.startsWith('did:key:')) {
    try {
      publicKey = extractPublicKey(did);
    } catch {
      publicKey = null;
    }
  }
  if (publicKey === null) {
    return { ok: false, did, rejectedAt: 'signature', reason: 'Cannot resolve public key for DID' };
  }
  let verified: boolean;
  try {
    verified =
      options.signedText === undefined
        ? verifyRequest(req.method, req.path, req.query, timestamp, nonce, req.body, signature, publicKey)
        : verifySignedText(
            options.signedText({ method: req.method, path: req.path, query: req.query, timestamp, nonce, body: req.body }),
            signature,
            publicKey,
          );
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, did, rejectedAt: 'signature', reason: 'Ed25519 signature verification failed' };
  }
  if (!options.nonces.check(nonce, timestamp, did)) {
    return { ok: false, did, rejectedAt: 'nonce', reason: 'Nonce already used (replay detected)' };
  }
  return { ok: true, did };
}
