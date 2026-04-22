/**
 * Task 4.20 — canonical-string builder for inbound signed requests.
 *
 * Wraps `@dina/protocol`'s pure `buildCanonicalPayload` with the
 * Fastify-adjacent concerns that aren't protocol's business:
 *
 *   - Hashing the raw request body (SHA-256 hex, lowercase) via
 *     `@dina/crypto-node`. The protocol package is deliberately
 *     zero-runtime-dep; the crypto backend lives here.
 *
 *   - Extracting method + path + (raw) query string from a Fastify
 *     request. `req.raw.url` is `"<path>?<query>"` — we split there
 *     rather than trusting `req.url` (which Fastify may rewrite).
 *
 *   - Body representation normalisation. Fastify may parse the body
 *     into an object (JSON route), leave it as a Buffer (raw route),
 *     or leave it `undefined` (GET/DELETE). We canonicalise to
 *     "exactly the bytes the client signed" — the caller is
 *     responsible for ensuring the RAW body is available (task 4.19
 *     wires a `contentTypeParser` that hands us `Buffer` for all
 *     application/json + octet-stream routes).
 *
 * **Byte-parity with Go Core.** Go's `auth/canonical.go` uses the same
 * string format; `buildCanonicalPayload` re-exports that exact shape.
 * Our job here is to feed it the same 6 fields Go would — so a request
 * signed by a TS Brain verifies on a Go Core and vice versa.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.20.
 */

import { buildCanonicalPayload } from '@dina/protocol';
import { Crypto } from '@dina/adapters-node';

export interface CanonicalRequestInput {
  method: string;
  /** URL path without query, e.g. `/v1/vault/store`. */
  path: string;
  /** Raw query string without leading `?`. Empty string if none. */
  query: string;
  /** RFC3339 or epoch-ms — as received in `X-Timestamp`. */
  timestamp: string;
  /** Hex string from `X-Nonce`. */
  nonce: string;
  /** Raw request body bytes. Empty/undefined → hash of the empty string. */
  body: Uint8Array | undefined;
}

/**
 * Build the canonical string for an incoming Fastify request.
 *
 * Async because the SHA-256 hash is computed via the crypto-node adapter
 * (which is async at the port boundary — every port method returns a
 * Promise, matching Phase 2's async-port rule).
 *
 * Caller-visible invariants:
 *   - Method is normalised to uppercase (`get` → `GET`).
 *   - Body hash for missing/empty bodies = `SHA-256("")` hex. Matches
 *     Go's behaviour for empty-body requests.
 *   - No trailing newline in the returned string.
 */
export async function buildCanonicalRequest(
  input: CanonicalRequestInput,
  crypto: Crypto = new Crypto(),
): Promise<string> {
  const body = input.body ?? new Uint8Array(0);
  const hashBytes = await crypto.sha256(body);
  const bodyHash = bytesToHexLower(hashBytes);
  return buildCanonicalPayload(
    input.method.toUpperCase(),
    input.path,
    input.query,
    input.timestamp,
    input.nonce,
    bodyHash,
  );
}

/**
 * Split a URL of the form `"<path>?<query>"` into its two halves. Never
 * throws; returns `{path: "<raw>", query: ""}` when no `?` is present.
 * Matches Go's `net/url.URL.Path` + `RawQuery` split semantics for our
 * purposes (we don't URL-decode — the canonical string signs the
 * on-wire form).
 */
export function splitUrl(rawUrl: string): { path: string; query: string } {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return { path: rawUrl, query: '' };
  return { path: rawUrl.slice(0, qIdx), query: rawUrl.slice(qIdx + 1) };
}

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) continue;
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
