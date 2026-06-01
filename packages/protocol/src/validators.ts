/**
 * Pure envelope validators — invariant checks extracted from
 * `@dina/core` so third-party Dina implementations reuse the same
 * contract enforcement.
 *
 * **Zero runtime deps** for the structural validators (`validateService*`,
 * `validateFutureSkew`, `parseMessageJSON`). Crypto-flavoured validators
 * (`verifyMessageSignature`) take a `verify` callback so protocol
 * never imports `@noble/ed25519`; core passes its concrete verifier,
 * mobile / third-party implementations pass theirs.
 *
 * All validators return a nullable error string (`null` on success,
 * error message on failure) rather than throwing — matches the
 * existing `@dina/core` convention so callers can branch without
 * try/catch. Tests pin the exact message text since Core + Brain
 * log these strings; changing them is a soft API break.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 1b task 1.20.
 */

import { MAX_SERVICE_TTL } from './constants';
import { buildMessageJSON } from './envelope_builder';

// ---------------------------------------------------------------------------
// DinaMessage parse (the read-side counterpart of buildMessageJSON)
// ---------------------------------------------------------------------------

/** Successful parse — preserves the wire field shape. */
export interface ParsedMessage {
  id: string;
  type: string;
  from: string;
  /** Always an array when it came from buildMessageJSON, but legacy
   *  peers may still send a bare string — parser accepts both. */
  to: string[];
  created_time: number;
  /** Body as base64 on the wire. Caller decodes with platform's
   *  base64 library (protocol is encoding-free). */
  bodyBase64: string;
}

const REQUIRED_FIELDS = ['id', 'type', 'from', 'to', 'created_time', 'body'] as const;

/**
 * Parse a DinaMessage JSON string. Structural-only: verifies field
 * presence + types, does NOT decode base64 (caller's responsibility —
 * `bodyBase64` is returned as-is).
 *
 * Throws on malformed JSON / missing fields — matches the donor
 * `parseMessage` API. Keeping throws here (rather than return-nullable)
 * because parse failures are hard errors: the wire payload is
 * unusable.
 */
export function parseMessageJSON(json: string): ParsedMessage {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('envelope: invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('envelope: JSON is not an object');
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      throw new Error(`envelope: missing required field "${field}"`);
    }
  }

  if (typeof parsed.id !== 'string') throw new Error('envelope: id must be a string');
  if (typeof parsed.type !== 'string') throw new Error('envelope: type must be a string');
  if (typeof parsed.from !== 'string') throw new Error('envelope: from must be a string');
  if (typeof parsed.to !== 'string' && !isStringArray(parsed.to)) {
    throw new Error('envelope: to must be a string or string array');
  }
  if (typeof parsed.created_time !== 'number')
    throw new Error('envelope: created_time must be a number');
  if (typeof parsed.body !== 'string') throw new Error('envelope: body must be a string');

  const to: string[] = typeof parsed.to === 'string' ? [parsed.to] : (parsed.to as string[]);
  return {
    id: parsed.id,
    type: parsed.type,
    from: parsed.from,
    to,
    created_time: parsed.created_time,
    bodyBase64: parsed.body,
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// ---------------------------------------------------------------------------
// service.query / service.response body validators
// ---------------------------------------------------------------------------

const VALID_SERVICE_STATUSES: ReadonlySet<string> = new Set(['success', 'unavailable', 'error']);

/**
 * Validate a `service.query` D2D body. `null` on success, error
 * string on the first violated invariant.
 */
/** AT-Proto NSID collection that service listings are published under. */
export const SERVICE_PROFILE_COLLECTION = 'com.dinakernel.service.profile'
/** AT-Proto record-key charset; bounds rkey length so a listing uri can't
 *  smuggle an unbounded blob into the provider's execution context. */
const SERVICE_LISTING_RKEY_RE = /^[A-Za-z0-9._~-]{1,512}$/

/**
 * Validate a service-listing record key (the `<rkey>` in
 * `at://<did>/com.dinakernel.service.profile/<rkey>`).
 *
 * SINGLE SOURCE OF TRUTH for the rkey charset/bounds — both the PARSE side
 * (`parseServiceListingUri`, which a provider runs over a requester-supplied
 * `service_uri`) and the PUBLISH side (the Brain + Home-Node-Lite service
 * publishers, which mint a listing under a chosen rkey) call this, so a key a
 * publisher writes is exactly the set a parser will later accept. Returns
 * `true` for a well-formed rkey: the bounded charset `[A-Za-z0-9._~-]{1,512}`,
 * excluding the path-traversal keys `.` and `..`. `'self'` (the single-listing
 * default) is valid.
 */
export function isValidServiceListingRkey(rkey: string): boolean {
  if (typeof rkey !== 'string') return false
  if (rkey === '.' || rkey === '..') return false
  return SERVICE_LISTING_RKEY_RE.test(rkey)
}

/**
 * Parse + structurally validate a service-listing AT-URI of the form
 * `at://<did>/com.dinakernel.service.profile/<rkey>`. Returns `{ did, rkey }` on
 * success or `null` when the uri is not a well-formed listing reference.
 *
 * `service_uri` is requester-supplied and flows into the provider's execution
 * context (it selects WHICH listing the provider answers for), so it must be
 * bound to the service-profile collection + a sane rkey rather than treated as
 * opaque text. The caller (Core's `/v1/service/query` route) additionally
 * binds `did` to the request's `to_did`.
 */
export function parseServiceListingUri(
  uri: string,
): { did: string; rkey: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return null
  const parts = uri.slice('at://'.length).split('/')
  if (parts.length !== 3) return null
  const [authority, collection, rkey] = parts
  // Narrow off `string | undefined` (noUncheckedIndexedAccess) — length===3
  // guarantees all three, but TS doesn't infer that from `.length`.
  if (authority === undefined || collection === undefined || rkey === undefined) return null
  if (!authority.startsWith('did:') || authority.length < 8) return null
  if (collection !== SERVICE_PROFILE_COLLECTION) return null
  if (!isValidServiceListingRkey(rkey)) return null
  return { did: authority, rkey }
}

export function validateServiceQueryBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return 'service.query: body must be a JSON object';
  }
  const b = body as Record<string, unknown>;

  if (typeof b.query_id !== 'string' || b.query_id === '') {
    return 'service.query: query_id is required';
  }
  if (typeof b.capability !== 'string' || b.capability === '') {
    return 'service.query: capability is required';
  }
  if (b.params === undefined || b.params === null) {
    return 'service.query: params is required';
  }
  if (typeof b.ttl_seconds !== 'number' || !Number.isFinite(b.ttl_seconds)) {
    return 'service.query: ttl_seconds is required and must be a number';
  }
  if (b.ttl_seconds <= 0 || b.ttl_seconds > MAX_SERVICE_TTL) {
    return `service.query: ttl_seconds must be 1-${MAX_SERVICE_TTL}, got ${b.ttl_seconds}`;
  }
  if (b.schema_hash !== undefined && typeof b.schema_hash !== 'string') {
    return 'service.query: schema_hash must be a string when present';
  }
  if (b.service_uri !== undefined) {
    if (typeof b.service_uri !== 'string') {
      return 'service.query: service_uri must be a string when present';
    }
    // Structural bind: a non-empty service_uri must be a well-formed
    // com.dinakernel.service.profile listing AT-URI (right collection + sane rkey),
    // NOT opaque text — it flows into the provider's execution context. This is
    // the D2D-inbound guard: a direct service.query envelope can carry a
    // service_uri the Core HTTP route never saw, so the check belongs here too.
    // (The cross-DID bind — authority === recipient — is enforced separately by
    // the callers that know the recipient DID: the Core HTTP route binds it to
    // `to_did`, and the inbound D2D path binds it via
    // `evaluateServiceIngressBypass`'s `recipientDID`. This validator only
    // enforces structure.) '' ⇒ absent.
    if (b.service_uri !== '' && parseServiceListingUri(b.service_uri) === null) {
      return 'service.query: service_uri must be an at://<did>/com.dinakernel.service.profile/<rkey> URI';
    }
  }
  return null;
}

/**
 * Validate a `service.response` D2D body. `null` on success, error
 * string on the first violated invariant.
 */
export function validateServiceResponseBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return 'service.response: body must be a JSON object';
  }
  const b = body as Record<string, unknown>;

  if (typeof b.query_id !== 'string' || b.query_id === '') {
    return 'service.response: query_id is required';
  }
  if (typeof b.capability !== 'string' || b.capability === '') {
    return 'service.response: capability is required';
  }
  if (typeof b.status !== 'string' || b.status === '') {
    return 'service.response: status is required';
  }
  if (!VALID_SERVICE_STATUSES.has(b.status)) {
    return `service.response: status must be success|unavailable|error, got "${b.status}"`;
  }
  if (typeof b.ttl_seconds !== 'number' || !Number.isFinite(b.ttl_seconds)) {
    return 'service.response: ttl_seconds is required and must be a number';
  }
  if (b.ttl_seconds <= 0 || b.ttl_seconds > MAX_SERVICE_TTL) {
    return `service.response: ttl_seconds must be 1-${MAX_SERVICE_TTL}, got ${b.ttl_seconds}`;
  }
  if (b.schema_hash !== undefined && typeof b.schema_hash !== 'string') {
    return 'service.response: schema_hash must be a string when present';
  }
  // `card` is optional and OPAQUE at the wire layer — a coarse shape check
  // only (non-null, non-array object). Deep CardSpec validation (badges,
  // https-only links, size caps) is the requester's job via
  // `validateCardSpec(card, { trusted: false })`; duplicating it here would
  // couple the wire validator to the whole card vocabulary.
  if (
    b.card !== undefined &&
    (b.card === null || typeof b.card !== 'object' || Array.isArray(b.card))
  ) {
    return 'service.response: card must be an object when present';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Future-skew clock validator
// ---------------------------------------------------------------------------

/**
 * Reject a message whose `created_time` is more than `maxSkewSeconds`
 * in the future, which would otherwise let a sender extend effective
 * freshness by lying about send time. Both inputs are Unix seconds.
 */
export function validateFutureSkew(
  createdTime: number,
  nowUnix: number,
  maxSkewSeconds = 60,
): string | null {
  if (!Number.isFinite(createdTime)) {
    return 'created_time must be a finite number';
  }
  if (createdTime > nowUnix + maxSkewSeconds) {
    return `created_time is ${createdTime - nowUnix}s in the future (max skew ${maxSkewSeconds}s)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ed25519 signature verifier — crypto via DI
// ---------------------------------------------------------------------------

/**
 * Caller-injected Ed25519 verify function. The shape mirrors
 * `@noble/ed25519.verify` and Core's `crypto/ed25519.verify`.
 * Protocol never imports a signature library; platform owners pass
 * their concrete implementation.
 */
export type Ed25519VerifyFn = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
) => boolean;

export interface VerifyMessageSignatureInput {
  /** The message whose body was signed — protocol rebuilds the
   *  canonical JSON bytes internally to match the signer side. */
  message: Parameters<typeof buildMessageJSON>[0];
  /** Hex-encoded Ed25519 signature (128 hex chars). */
  signatureHex: string;
  /** Candidate verification keys (rotation support). ANY match
   *  passes. Empty array = fail. */
  verificationKeys: Uint8Array[];
  /** Platform Ed25519 verifier. */
  verify: Ed25519VerifyFn;
  /** Hex → bytes converter. Protocol has no hex library; caller
   *  injects one (`@noble/hashes/utils.hexToBytes` is the standard). */
  hexToBytes: (hex: string) => Uint8Array;
}

/**
 * Verify an Ed25519 signature against a DinaMessage's canonical
 * JSON bytes. Returns `true` if any key in `verificationKeys`
 * matches. Catches all errors (bad hex, bad key length) and
 * returns `false` — matches the donor's fail-closed behavior.
 *
 * Why DI: `@dina/protocol` can't depend on `@noble/ed25519` /
 * `@noble/hashes` without violating the zero-runtime-deps rule
 * that makes the package reusable on any JS runtime.
 */
export function verifyMessageSignature(input: VerifyMessageSignatureInput): boolean {
  if (!input.verificationKeys || input.verificationKeys.length === 0) return false;
  if (
    typeof input.signatureHex !== 'string' ||
    input.signatureHex.length !== 128 ||
    !/^[0-9a-f]+$/i.test(input.signatureHex)
  ) {
    return false;
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = input.hexToBytes(input.signatureHex);
  } catch {
    return false;
  }

  const canonicalBytes = new TextEncoder().encode(buildMessageJSON(input.message));
  for (const key of input.verificationKeys) {
    try {
      if (input.verify(key, canonicalBytes, sigBytes)) return true;
    } catch {
      // Fall through — try the next key on any per-key failure.
    }
  }
  return false;
}
