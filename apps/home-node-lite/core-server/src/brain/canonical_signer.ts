/**
 * Canonical request signer (closes 5.9 follow-up flagged in its done-note).
 *
 * `ed25519_signer.ts` (5.9 half A) signs arbitrary bytes. `node_http_client.ts`
 * (5.9 half B) sends HTTP requests. Missing piece: the composition that
 * takes a Brain→Core request descriptor + produces the 4 auth headers
 * (`X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature`).
 *
 * **Canonical-payload format** is owned by `@dina/protocol.buildCanonicalPayload`;
 * this module just composes it with signing. Byte-parity with Go Core
 * is the `@dina/protocol` module's job; if that ever drifts, inbound
 * verification drifts with it (the inbound `canonical_request.ts` uses
 * the same builder).
 *
 * **SHA-256 body hash** — Core's canonical string includes
 * `SHA-256(body)` as a lowercase-hex digest. We reuse `node:crypto` so
 * there's zero extra dep; `ed25519_signer.ts` made the same choice.
 *
 * **DID is bound at construction** — a signer instance represents one
 * identity. Mobile in-process transport skips signing entirely, so this
 * primitive is only wired on the HTTP transport path.
 *
 * **Timestamp + nonce are per-call**:
 *   - Timestamp: caller supplies OR signer uses injected `nowMsFn`. Emitted
 *     as unix-ms as a decimal string (Core accepts both ms and RFC3339;
 *     ms is cheaper to produce). The inbound side's `timestamp_window.ts`
 *     accepts either — this matches.
 *   - Nonce: injected `nonceFn` (see 5.14 `createNonceGenerator`) — defaults
 *     to 16-byte-random lowercase hex. Unique per request.
 *
 * **Never throws** other than at construction — runtime signing can't fail
 * once the seed was validated. Body encoding is the only realistic failure
 * (non-object body passed as JSON) and that fails fast at build time.
 */

import { createHash } from 'node:crypto';

import { createNonceGenerator } from './nonce_generator';
import type { Ed25519Signer } from './ed25519_signer';

/**
 * Inbound and outbound must agree on the canonical-payload format. The
 * exact string is: `METHOD\nPATH\nQUERY\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX`
 * (LF-separated, no trailing newline). Matches Go Core's
 * `auth/canonical.go` byte-for-byte.
 */
export function buildCanonicalString(input: {
  method: string;
  path: string;
  query: string;
  timestamp: string;
  nonce: string;
  bodyHashHex: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.query,
    input.timestamp,
    input.nonce,
    input.bodyHashHex,
  ].join('\n');
}

export interface CanonicalSignerOptions {
  did: string;
  signer: Ed25519Signer;
  /** Nonce generator. Defaults to a fresh `createNonceGenerator()` instance. */
  nonceFn?: () => string;
  /** Clock. Defaults to `Date.now`. Emitted as decimal unix-ms string. */
  nowMsFn?: () => number;
  /** SHA-256 hash fn. Defaults to node:crypto. Returns raw 32-byte digest. */
  sha256Fn?: (data: Uint8Array) => Uint8Array;
}

export interface SignRequestInput {
  method: string;
  path: string;
  /** Raw query string without `?`. Empty when absent. */
  query?: string;
  /**
   * Body to sign. String is UTF-8 encoded, object is JSON-serialised
   * (same as node_http_client would send), Uint8Array is passed
   * through. `undefined` → empty-body hash.
   */
  body?: string | Uint8Array | Record<string, unknown> | unknown[];
  /** Override timestamp. Defaults to `nowMsFn()`. */
  timestampMs?: number;
  /** Override nonce. Defaults to `nonceFn()`. */
  nonce?: string;
}

export interface SignedHeaders {
  'x-did': string;
  'x-timestamp': string;
  'x-nonce': string;
  'x-signature': string;
}

export interface SignedRequest {
  /** Headers ready to spread into `fetch` init. */
  headers: SignedHeaders;
  /** The canonical string the signature was computed over — useful for debug. */
  canonicalString: string;
  /** Raw body bytes that were hashed. */
  bodyBytes: Uint8Array;
}

export const EMPTY_BODY_HASH_HEX =
  // SHA-256("") — precomputed so an empty-body request doesn't hash on every call.
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Build a signer bound to a DID + ed25519 key. Returned object has one
 * method: `sign(req) → SignedRequest`.
 */
export function createCanonicalSigner(opts: CanonicalSignerOptions): {
  did: string;
  sign(req: SignRequestInput): SignedRequest;
} {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('createCanonicalSigner: opts required');
  }
  if (typeof opts.did !== 'string' || !opts.did.startsWith('did:')) {
    throw new TypeError('createCanonicalSigner: did must be a DID string');
  }
  if (!opts.signer || typeof opts.signer.sign !== 'function') {
    throw new TypeError('createCanonicalSigner: ed25519 signer required');
  }
  const nonceFn = opts.nonceFn ?? createNonceGenerator();
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const sha256Fn = opts.sha256Fn ?? defaultSha256;
  const signer = opts.signer;
  const did = opts.did;

  return {
    did,
    sign(req: SignRequestInput): SignedRequest {
      validateSignRequest(req);
      const bodyBytes = encodeBody(req.body);
      const bodyHashHex =
        bodyBytes.length === 0
          ? EMPTY_BODY_HASH_HEX
          : toLowerHex(sha256Fn(bodyBytes));
      const timestamp = String(req.timestampMs ?? nowMsFn());
      const nonce = req.nonce ?? nonceFn();
      const canonicalString = buildCanonicalString({
        method: req.method,
        path: req.path,
        query: req.query ?? '',
        timestamp,
        nonce,
        bodyHashHex,
      });
      const sigBytes = signer.sign(new TextEncoder().encode(canonicalString));
      const signature = toBase64(sigBytes);
      return {
        headers: {
          'x-did': did,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': signature,
        },
        canonicalString,
        bodyBytes,
      };
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateSignRequest(req: SignRequestInput): void {
  if (!req || typeof req !== 'object') {
    throw new TypeError('sign: request required');
  }
  if (typeof req.method !== 'string' || req.method === '') {
    throw new TypeError('sign: method required');
  }
  if (typeof req.path !== 'string' || req.path === '') {
    throw new TypeError('sign: path required');
  }
  if (req.query !== undefined && typeof req.query !== 'string') {
    throw new TypeError('sign: query must be a string');
  }
  if (req.timestampMs !== undefined && !Number.isFinite(req.timestampMs)) {
    throw new TypeError('sign: timestampMs must be finite');
  }
  if (req.nonce !== undefined && (typeof req.nonce !== 'string' || req.nonce === '')) {
    throw new TypeError('sign: nonce must be non-empty string');
  }
}

function encodeBody(body: SignRequestInput['body']): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  // Object or array → JSON-encoded (matches node_http_client's behavior).
  return new TextEncoder().encode(JSON.stringify(body));
}

function defaultSha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function toLowerHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
