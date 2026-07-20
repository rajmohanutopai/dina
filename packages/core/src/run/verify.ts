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

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

import {
  buildRunMessageProjection,
  buildRunExhaustedProjection,
  buildRunResultProjection,
} from '@dina/protocol';

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

const RUN_CONTENT_DOMAIN = 'dina:run:content:v1';

/**
 * 81B-03 — the CANONICAL content digest (§7.1 point 3 / §13, line 374): a SHA-256
 * over ALL the message's immutable semantic + lifecycle fields, EXCLUDING the ones
 * that legitimately vary across a re-issued / key-rotated retry (`message_id`,
 * `sequence`, `signature`, `issued_at`, `runtime_issuer_did`, `runtime_key_id`).
 * This is the stable content identity Core dedups on — so a same-`dedup_key` retry
 * that mutates params/card/kind/expiry produces a DIFFERENT digest and is rejected
 * rather than silently collapsed as the original.
 */
export function computeRunContentDigest(w: {
  provider_did: string;
  service_uri: string;
  run_id: string;
  dedup_key: string;
  kind: string;
  action_type: string;
  expires_at: number;
  schema_version: string;
  params_digest: string;
  card_digest: string;
}): string {
  const canonical = [
    RUN_CONTENT_DOMAIN,
    w.provider_did,
    w.service_uri,
    w.run_id,
    w.dedup_key,
    w.kind,
    w.action_type,
    String(w.expires_at),
    w.schema_version,
    w.params_digest,
    w.card_digest,
  ].join('\n');
  return bytesToHex(sha256(enc.encode(canonical)));
}

// 81B-02 — every frozen projection field is validated BEFORE key resolution so a
// blank/missing key id, empty schema, non-finite timestamp, or malformed digest
// can never reach the signature check (NaN arithmetic silently skips comparisons).
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** The issuer/key/schema/issued_at fields common to EVERY signed run projection. */
function commonProjectionValid(w: {
  issued_at: unknown;
  schema_version: unknown;
  runtime_issuer_did: unknown;
  runtime_key_id: unknown;
}): boolean {
  return (
    isFiniteNum(w.issued_at) &&
    isNonEmptyStr(w.schema_version) &&
    isNonEmptyStr(w.runtime_issuer_did) &&
    isNonEmptyStr(w.runtime_key_id)
  );
}

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
    !isNonEmptyStr(wire.message_id) ||
    !isNonEmptyStr(wire.dedup_key) ||
    (wire.kind !== 'informational' && wire.kind !== 'action') ||
    // action ⇒ non-empty action_type; informational ⇒ EXACTLY '' (§6.2).
    (wire.kind === 'action' ? !isNonEmptyStr(wire.action_type) : wire.action_type !== '') ||
    !isHex64(wire.params_digest) ||
    !isHex64(wire.card_digest) ||
    !isFiniteNum(wire.expires_at) ||
    !commonProjectionValid(wire) ||
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
  // Verified. `content_digest` is the CANONICAL all-immutable-fields digest (81B-03)
  // — the stable content identity the lifecycle dedups on (NOT just `card_digest`),
  // so a mutated same-`dedup_key` retry is caught. The plaintext `payload` is what
  // Core envelope-encrypts on ingest (§13).
  return {
    ok: true,
    verified: {
      message_id: wire.message_id,
      sequence: wire.sequence,
      dedup_key: wire.dedup_key,
      kind: wire.kind,
      action_type: wire.kind === 'action' ? wire.action_type : null,
      expires_at: wire.expires_at,
      content_digest: computeRunContentDigest(wire),
      payload: wire.payload,
    },
  };
}

// ---------------------------------------------------------------------------
// E76-07 — the two OTHER signed provider terminals over their own DISTINCT,
// domain-separated projections (§6.2): the pull `exhausted` marker and the
// action-result completion. Same fail-closed discipline as verifyRunMessage; the
// domain-separation prefix means a message signature can never be replayed as an
// exhausted/result signature.
// ---------------------------------------------------------------------------

/** The signed pull `exhausted` marker a provider delivers (§6.2/§7.1, pull only). */
export interface SignedRunExhaustedWire {
  provider_did: string;
  service_uri: string;
  run_id: string;
  cursor: number;
  issued_at: number;
  schema_version: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
  signature: string;
}

/** What the run expected for an exhausted marker — the reserved fetch cursor. */
export interface ExpectedExhaustedBinding {
  run_id: string;
  provider_did: string;
  service_uri: string;
  /** The reserved pull cursor this exhausted marker must be for. */
  expected_cursor: number;
}

export type VerifyRunExhaustedResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'missing_signature'
        | 'cross_run'
        | 'out_of_window'
        | 'future_issued'
        | 'unauthorized_runtime_key'
        | 'bad_signature';
    };

/**
 * Verify a signed pull `exhausted` marker. Binds it to the run + the reserved
 * cursor (an exhausted for a DIFFERENT cursor is out-of-window) and to the
 * provider-as-runtime-issuer, fail-closed on every anomaly. There is no
 * `expires_at` on an exhausted marker (§6.2), so only future-issue is time-checked.
 */
export function verifyRunExhausted(
  wire: SignedRunExhaustedWire,
  expected: ExpectedExhaustedBinding,
  resolveRuntimeKey: ResolveRuntimeKey,
  nowMs: number,
): VerifyRunExhaustedResult {
  if (!isFiniteNum(wire.cursor) || !commonProjectionValid(wire)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof wire.signature !== 'string' || wire.signature === '') {
    return { ok: false, reason: 'missing_signature' };
  }
  if (
    wire.run_id !== expected.run_id ||
    wire.provider_did !== expected.provider_did ||
    wire.service_uri !== expected.service_uri
  ) {
    return { ok: false, reason: 'cross_run' };
  }
  if (wire.runtime_issuer_did !== expected.provider_did) {
    return { ok: false, reason: 'unauthorized_runtime_key' };
  }
  // The exhausted marker MUST be for the reserved cursor (not an earlier/later one).
  if (wire.cursor !== expected.expected_cursor) {
    return { ok: false, reason: 'out_of_window' };
  }
  if (wire.issued_at * 1000 - nowMs > MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future_issued' };
  }
  const key = resolveRuntimeKey(wire.runtime_issuer_did, wire.runtime_key_id, wire.issued_at);
  if (key === null) return { ok: false, reason: 'unauthorized_runtime_key' };
  const projection = buildRunExhaustedProjection({
    provider_did: wire.provider_did,
    service_uri: wire.service_uri,
    run_id: wire.run_id,
    cursor: wire.cursor,
    issued_at: wire.issued_at,
    schema_version: wire.schema_version,
    runtime_issuer_did: wire.runtime_issuer_did,
    runtime_key_id: wire.runtime_key_id,
  });
  let verified = false;
  try {
    verified = ed25519Verify(key, enc.encode(projection), hexToBytes(wire.signature));
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/** The signed action-result completion a provider delivers (§6.2/§6.3). */
export interface SignedRunResultWire {
  provider_did: string;
  service_uri: string;
  run_id: string;
  message_id: string;
  delegation_id: string;
  decision_revision: number;
  status: 'completed' | 'failed';
  result_card_digest: string;
  issued_at: number;
  schema_version: string;
  runtime_issuer_did: string;
  runtime_key_id: string;
  signature: string;
}

/** What the run expected for a completion — the dispatched delegation. */
export interface ExpectedResultBinding {
  run_id: string;
  provider_did: string;
  service_uri: string;
  /** The delegation id Core dispatched (from the `deleg-<id>` correlation). */
  delegation_id: string;
}

/** The verified completion, projected to `IngestCompletionInput` by the caller. */
export interface VerifiedRunResult {
  message_id: string;
  delegation_id: string;
  run_id: string;
  status: 'completed' | 'failed';
  result_card_digest: string;
  issued_at: number;
}

export type VerifyRunResultResult =
  | { ok: true; verified: VerifiedRunResult }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'missing_signature'
        | 'cross_run'
        | 'wrong_delegation'
        | 'unknown_status'
        | 'future_issued'
        | 'unauthorized_runtime_key'
        | 'bad_signature';
    };

/**
 * Verify a signed action-result completion. Binds it to the run, the dispatched
 * `delegation_id`, and the provider-as-runtime-issuer, fail-closed. The caller
 * (`plane_node`) turns a verified result into an `IngestCompletionInput`, which
 * the CompletionService additionally binds to the stored message (§6.3).
 */
export function verifyRunResult(
  wire: SignedRunResultWire,
  expected: ExpectedResultBinding,
  resolveRuntimeKey: ResolveRuntimeKey,
  nowMs: number,
): VerifyRunResultResult {
  if (
    !isNonEmptyStr(wire.message_id) ||
    !isNonEmptyStr(wire.delegation_id) ||
    !isFiniteNum(wire.decision_revision) ||
    !isHex64(wire.result_card_digest) ||
    !commonProjectionValid(wire)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof wire.signature !== 'string' || wire.signature === '') {
    return { ok: false, reason: 'missing_signature' };
  }
  if (wire.status !== 'completed' && wire.status !== 'failed') {
    return { ok: false, reason: 'unknown_status' };
  }
  if (
    wire.run_id !== expected.run_id ||
    wire.provider_did !== expected.provider_did ||
    wire.service_uri !== expected.service_uri
  ) {
    return { ok: false, reason: 'cross_run' };
  }
  // Bind to the delegation Core actually dispatched (the correlation authority).
  if (wire.delegation_id !== expected.delegation_id) {
    return { ok: false, reason: 'wrong_delegation' };
  }
  if (wire.runtime_issuer_did !== expected.provider_did) {
    return { ok: false, reason: 'unauthorized_runtime_key' };
  }
  if (wire.issued_at * 1000 - nowMs > MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future_issued' };
  }
  const key = resolveRuntimeKey(wire.runtime_issuer_did, wire.runtime_key_id, wire.issued_at);
  if (key === null) return { ok: false, reason: 'unauthorized_runtime_key' };
  const projection = buildRunResultProjection({
    provider_did: wire.provider_did,
    service_uri: wire.service_uri,
    run_id: wire.run_id,
    message_id: wire.message_id,
    delegation_id: wire.delegation_id,
    decision_revision: wire.decision_revision,
    status: wire.status,
    result_card_digest: wire.result_card_digest,
    issued_at: wire.issued_at,
    schema_version: wire.schema_version,
    runtime_issuer_did: wire.runtime_issuer_did,
    runtime_key_id: wire.runtime_key_id,
  });
  let verified = false;
  try {
    verified = ed25519Verify(key, enc.encode(projection), hexToBytes(wire.signature));
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };
  return {
    ok: true,
    verified: {
      message_id: wire.message_id,
      delegation_id: wire.delegation_id,
      run_id: wire.run_id,
      status: wire.status,
      result_card_digest: wire.result_card_digest,
      issued_at: wire.issued_at,
    },
  };
}
