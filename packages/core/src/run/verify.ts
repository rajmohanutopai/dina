/**
 * ISVC-10 — the run-response TRUST BOUNDARY (§6.2). A provider's pull response is
 * a runtime-issuer-signed `RunMessage`; before its content enters the run
 * lifecycle it MUST be verified: the signature is Ed25519 over the frozen,
 * domain-separated `buildRunMessageProjection` string, the `runtime_key_id` must
 * resolve to a key authorized at `issued_at`, and a bare/missing/expired/
 * cross-run message is rejected. This is a PURE function — key resolution is
 * injected (the boot resolves via the DID doc) so it does no I/O and is fully
 * unit-tested. The verified projection is mapped to the `VerifiedRunMessage` the
 * plane's `ingestPullResponse` admits.
 *
 * Envelope note: the D2D transit layer (crypto_box_seal + Ed25519 envelope
 * signature + inner-`from` sender-binding) is already verified by
 * `receive_pipeline.ts` BEFORE this runs — this is the ADDITIONAL app-layer
 * runtime-issuer check the design mandates, never a substitute for it.
 */

import { hexToBytes } from '@noble/hashes/utils.js';

import { buildRunMessageProjection } from '@dina/protocol';

import { verify as ed25519Verify } from '../crypto/ed25519';

import type { VerifiedRunMessage } from './ingest';

const enc = new TextEncoder();

/** The signed run-message body a provider delivers over D2D (§6.2 wire). The
 *  transit `payload` is the UNSEALED plaintext card+params (the D2D layer already
 *  decrypted it); Core envelope-encrypts it at rest on ingest (§13). */
export interface SignedRunMessageWire {
  provider_did: string;
  service_uri: string;
  run_id: string;
  message_id: string;
  sequence: number;
  dedup_key: string;
  kind: 'informational' | 'action';
  /** '' for informational. */
  action_type: string;
  /** SHA-256 hex of the bounded params. */
  params_digest: string;
  /** SHA-256 hex of the validated card — the content_digest carried forward. */
  card_digest: string;
  issued_at: number;
  expires_at: number;
  schema_version: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
  /** hex Ed25519 signature over `buildRunMessageProjection(...)`. */
  signature: string;
  /** the unsealed plaintext card+params bytes. */
  payload: Uint8Array;
}

/** What the run expected — the correlated reservation's binding (anti-cross-run). */
export interface ExpectedRunBinding {
  run_id: string;
  provider_did: string;
  service_uri: string;
  /** The reserved pull fetch position (`reservation.cursor`). A pull response
   *  MUST be for this cursor or later — a `sequence` BELOW it is a stale/replayed
   *  message for an already-advanced position and is rejected (§6.2/§7 pull
   *  sequence-window, E76-04). */
  expected_sequence: number;
}

/** Resolve a runtime-issuer's Ed25519 public key for `key_id`, authorized at
 *  `issued_at` (else null → rejected). Injected so the verifier does no I/O. */
export type ResolveRuntimeKey = (
  issuerDid: string,
  keyId: string,
  issuedAtSec: number,
) => Uint8Array | null;

export type VerifyRunMessageResult =
  | { ok: true; verified: VerifiedRunMessage }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'missing_signature'
        | 'cross_run'
        | 'out_of_window'
        | 'expired'
        | 'future_issued'
        | 'unauthorized_runtime_key'
        | 'bad_signature';
    };

/** Max clock skew (ms) allowed on `issued_at` being ahead of now. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a signed provider `RunMessage` and project it to a `VerifiedRunMessage`.
 * Fails CLOSED on every anomaly. `expected` binds the message to the run that
 * issued the correlated query (a provider cannot answer run A with run B's id).
 */
export function verifyRunMessage(
  wire: SignedRunMessageWire,
  expected: ExpectedRunBinding,
  resolveRuntimeKey: ResolveRuntimeKey,
  nowMs: number,
): VerifyRunMessageResult {
  // Shape: reject anything missing a required field (a malformed body must never
  // reach the projection or the lifecycle).
  if (
    typeof wire.message_id !== 'string' ||
    wire.message_id === '' ||
    typeof wire.dedup_key !== 'string' ||
    wire.dedup_key === '' ||
    (wire.kind !== 'informational' && wire.kind !== 'action') ||
    typeof wire.card_digest !== 'string' ||
    wire.card_digest === '' ||
    !(wire.payload instanceof Uint8Array)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof wire.signature !== 'string' || wire.signature === '') {
    return { ok: false, reason: 'missing_signature' };
  }
  // Bind to the expected run (anti-cross-run / anti-provider-substitution). The
  // provider_did/service_uri/run_id are signed below, so this also fixes WHICH
  // signed tuple must verify.
  if (
    wire.run_id !== expected.run_id ||
    wire.provider_did !== expected.provider_did ||
    wire.service_uri !== expected.service_uri
  ) {
    return { ok: false, reason: 'cross_run' };
  }
  // E76-03 — V1: the runtime issuer IS the provider. Bind them here so a message
  // whose `provider_did` matches the run but whose `runtime_issuer_did` is some
  // OTHER (attacker-resolvable) DID can never be admitted by resolving that other
  // DID's key. The runtime key must belong to the run's authorized provider.
  if (wire.runtime_issuer_did !== expected.provider_did) {
    return { ok: false, reason: 'unauthorized_runtime_key' };
  }
  // E76-04 — pull sequence window (§6.2/§7): the response must be for the reserved
  // fetch cursor or later. A `sequence` BELOW the reserved cursor is a stale or
  // replayed message for an already-advanced position — reject it before any
  // payload preparation so Core never records an out-of-window message while it
  // advances the (different) reserved cursor. `sequence` must be a finite number.
  if (typeof wire.sequence !== 'number' || !Number.isFinite(wire.sequence)) {
    return { ok: false, reason: 'malformed' };
  }
  if (wire.sequence < expected.expected_sequence) {
    return { ok: false, reason: 'out_of_window' };
  }
  // Time bounds: an already-expired message consumes nothing (§7 on-arrival
  // recheck also guards this, fail-closed here too); a message issued far in the
  // future is rejected as clock-forgery.
  if (nowMs >= wire.expires_at) return { ok: false, reason: 'expired' };
  if (wire.issued_at * 1000 - nowMs > MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future_issued' };
  }
  // Resolve the runtime-issuer key authorized at issue time. A missing/unknown/
  // unauthorized key is rejected (never fall back to an unsigned admit).
  const key = resolveRuntimeKey(wire.runtime_issuer_did, wire.runtime_key_id, wire.issued_at);
  if (key === null) return { ok: false, reason: 'unauthorized_runtime_key' };
  // Verify Ed25519 over the EXACT frozen projection string (§6.2 compatibility law).
  const projection = buildRunMessageProjection({
    provider_did: wire.provider_did,
    service_uri: wire.service_uri,
    run_id: wire.run_id,
    message_id: wire.message_id,
    sequence: wire.sequence,
    dedup_key: wire.dedup_key,
    kind: wire.kind,
    action_type: wire.action_type,
    params_digest: wire.params_digest,
    card_digest: wire.card_digest,
    issued_at: wire.issued_at,
    expires_at: wire.expires_at,
    schema_version: wire.schema_version,
    runtime_issuer_did: wire.runtime_issuer_did,
    runtime_key_id: wire.runtime_key_id,
  });
  // A malformed hex string OR a wrong-length signature must fail CLOSED, never
  // throw — `@noble` asserts a 64-byte signature and throws otherwise.
  let verified = false;
  try {
    verified = ed25519Verify(key, enc.encode(projection), hexToBytes(wire.signature));
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };
  // Verified. The signed `card_digest` is the content digest the lifecycle dedups
  // on; the plaintext `payload` is what Core envelope-encrypts on ingest (§13).
  return {
    ok: true,
    verified: {
      message_id: wire.message_id,
      sequence: wire.sequence,
      dedup_key: wire.dedup_key,
      kind: wire.kind,
      action_type: wire.kind === 'action' ? wire.action_type : null,
      expires_at: wire.expires_at,
      content_digest: wire.card_digest,
      payload: wire.payload,
    },
  };
}
