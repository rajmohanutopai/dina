/**
 * Task 4.21 — canonical signed-request header extraction.
 *
 * Dina's auth middleware (task 4.19-4.26) expects four headers on
 * every inbound request that requires Ed25519 verification:
 *
 *   - `X-DID`        — caller's DID (`did:plc:...` or `did:key:...`).
 *   - `X-Timestamp`  — RFC3339 or epoch-ms (see `timestamp_window.ts`).
 *   - `X-Nonce`      — per-request random (16 hex bytes = 32 chars).
 *   - `X-Signature`  — 64-byte Ed25519 sig, hex-encoded (128 chars).
 *
 * This module **only extracts + shape-validates** the headers; it does
 * not verify the signature. Verification lands in task 4.19 (Ed25519
 * verifier) once the canonical string builder (4.20) is wired.
 *
 * Returning a structured result (not throwing) lets the middleware
 * render a consistent error envelope per task 4.8 and log the
 * rejection reason to the request's bound log context.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.21.
 */

// Shape we pull from Fastify's req.headers (or any HTTP lib, for
// testability). Header values may be string | string[] | undefined;
// Fastify lowercases incoming header names.
export type HeaderBag = {
  [name: string]: string | string[] | undefined;
};

export interface ExtractedSignedHeaders {
  did: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export type HeaderRejectionReason =
  | 'missing_did'
  | 'missing_timestamp'
  | 'missing_nonce'
  | 'missing_signature'
  | 'multiple_values' // same header sent twice — reject rather than guess
  | 'malformed_did'
  | 'malformed_nonce'
  | 'malformed_signature';

export type HeaderExtractionResult =
  | { ok: true; headers: ExtractedSignedHeaders }
  | { ok: false; reason: HeaderRejectionReason; detail?: string };

/** Canonical header names (lowercased — Fastify normalises). */
export const HEADER_DID = 'x-did';
export const HEADER_TIMESTAMP = 'x-timestamp';
export const HEADER_NONCE = 'x-nonce';
export const HEADER_SIGNATURE = 'x-signature';

/** Expected sizes per the Dina protocol spec. */
const NONCE_HEX_LENGTH = 32; // 16 random bytes
const SIGNATURE_HEX_LENGTH = 128; // 64-byte Ed25519 sig

const HEX_REGEX = /^[0-9a-f]+$/;
const DID_REGEX = /^did:[a-z0-9]+:.+/;

/**
 * Extract + shape-validate the four canonical headers. Timestamp-window
 * validation lives in `timestamp_window.ts` (task 4.22); signature
 * verification in the Ed25519 verifier (task 4.19). Both are called
 * AFTER this extraction succeeds.
 *
 * Rejects on:
 *   - Any header missing (empty string counts as missing).
 *   - Any header sent as an array (multi-value — ambiguous in signing
 *     context; fail closed rather than pick one).
 *   - DID not matching `did:<method>:<id>`.
 *   - Nonce not exactly 32 lowercase hex chars.
 *   - Signature not exactly 128 lowercase hex chars.
 *   - Timestamp is passed through verbatim; window check is downstream.
 */
export function extractSignedHeaders(headers: HeaderBag): HeaderExtractionResult {
  // Per-header read. `readHeader` returns:
  //   - `{present: true, value}` on a single non-empty value
  //   - `{present: false}` on missing / empty
  //   - `{error: 'multiple_values'}` on an array (ambiguous — which
  //      value was signed? Fail closed.)
  const didR = readHeader(headers[HEADER_DID]);
  if (didR.error) return { ok: false, reason: didR.error, detail: HEADER_DID };
  if (!didR.present) return { ok: false, reason: 'missing_did' };

  const tsR = readHeader(headers[HEADER_TIMESTAMP]);
  if (tsR.error) return { ok: false, reason: tsR.error, detail: HEADER_TIMESTAMP };
  if (!tsR.present) return { ok: false, reason: 'missing_timestamp' };

  const nonceR = readHeader(headers[HEADER_NONCE]);
  if (nonceR.error) return { ok: false, reason: nonceR.error, detail: HEADER_NONCE };
  if (!nonceR.present) return { ok: false, reason: 'missing_nonce' };

  const sigR = readHeader(headers[HEADER_SIGNATURE]);
  if (sigR.error) return { ok: false, reason: sigR.error, detail: HEADER_SIGNATURE };
  if (!sigR.present) return { ok: false, reason: 'missing_signature' };

  // Shape validation.
  if (!DID_REGEX.test(didR.value)) {
    return { ok: false, reason: 'malformed_did', detail: didR.value };
  }
  if (nonceR.value.length !== NONCE_HEX_LENGTH || !HEX_REGEX.test(nonceR.value)) {
    return {
      ok: false,
      reason: 'malformed_nonce',
      detail: `expected ${NONCE_HEX_LENGTH} lowercase hex chars, got len=${nonceR.value.length}`,
    };
  }
  if (sigR.value.length !== SIGNATURE_HEX_LENGTH || !HEX_REGEX.test(sigR.value)) {
    return {
      ok: false,
      reason: 'malformed_signature',
      detail: `expected ${SIGNATURE_HEX_LENGTH} lowercase hex chars, got len=${sigR.value.length}`,
    };
  }

  return {
    ok: true,
    headers: {
      did: didR.value,
      timestamp: tsR.value,
      nonce: nonceR.value,
      signature: sigR.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HeaderRead =
  | { present: true; value: string; error: undefined }
  | { present: false; error: undefined }
  | { present: false; error: 'multiple_values' };

function readHeader(raw: string | string[] | undefined): HeaderRead {
  if (raw === undefined || raw === '') return { present: false, error: undefined };
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { present: false, error: undefined };
    return { present: false, error: 'multiple_values' };
  }
  return { present: true, value: raw, error: undefined };
}
