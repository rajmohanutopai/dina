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
import { TIMESTAMP_WINDOW_SECONDS, isTimestampValid, parseRFC3339 } from './timestamp';

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
    /**
     * Accept a timestamp up to this many seconds in the past instead of the
     * usual ±5 minutes. The future side stays at 5 minutes. Only for the
     * few routes in `LONG_WINDOW_ROUTES`, whose own handlers refuse replays.
     */
    maxAgeSeconds?: number;
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
    timely =
      options.maxAgeSeconds === undefined
        ? isTimestampValid(timestamp)
        : isWithinAge(timestamp, options.maxAgeSeconds);
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

/** Up to `maxAgeSeconds` old, and no more than the usual window ahead. */
function isWithinAge(timestamp: string, maxAgeSeconds: number, now: number = Date.now()): boolean {
  const ts = parseRFC3339(timestamp).getTime();
  const age = now - ts;
  return age <= maxAgeSeconds * 1000 && -age <= TIMESTAMP_WINDOW_SECONDS * 1000;
}

/**
 * docs/DAILY_PLAN.md §4 — routes that accept an older signed timestamp,
 * because an agent leaves the request at MsgBox for a phone that is asleep.
 * Each handler refuses a second copy by its own id (the plan inbox keeps
 * batch ids for 3 days), since the 5-minute nonce cache cannot.
 */
export const LONG_WINDOW_ROUTES: readonly { method: string; path: string; maxAgeSeconds: number }[] = [
  { method: 'POST', path: '/v1/plan/inbox', maxAgeSeconds: 20 * 60 * 60 },
];

export function maxAgeForRoute(method: string, path: string): number | undefined {
  return LONG_WINDOW_ROUTES.find((r) => r.method === method.toUpperCase() && r.path === path)
    ?.maxAgeSeconds;
}
