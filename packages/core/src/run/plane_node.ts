/**
 * ISVC-10 — the BOOT ASSEMBLY that makes the pull loop run in the product. Both
 * boots (server `wire_workflow_plane.ts`, mobile `bootstrap.ts`) call
 * `wireRunPlaneNode` with their signed D2D sender + a runtime-key resolver; it
 * builds the egress effects + the `PersonaCipher` over the vault DEK, composes
 * the run plane (`wireRunPlane`), and returns a `handleServiceResponse` the D2D
 * receive path calls for a run-correlated provider `service.response`:
 *
 *   pacer.emitQuery → signed `service.query` (query_id = reservation correlation)
 *   provider → signed `RunMessage` in a `service.response`
 *   receive → handleServiceResponse → verifyRunMessage (§6.2 trust boundary)
 *           → plane.ingestPullResponse → lifecycle.
 *
 * The egress reuses the boot's vetted `sendD2D` (sign + resolve + WS/HTTP); the
 * verify reuses the pure `verifyRunMessage`. This file adds only the assembly.
 */

import { hexToBytes } from '@noble/hashes/utils.js';

import { INTERACTIVE_RUN_CAPABILITY } from '@dina/protocol';

import { MsgTypeServiceQuery, MAX_SERVICE_TTL } from '../d2d/families';
import { hasDEK, unwrapWithPersonaDEK, wrapWithPersonaDEK } from '../persona/orchestrator';

import { SQLiteErasureKeyStore, type ErasureKeyStore } from './erasure_store';
import { type PersonaCipher } from './payload_store';
import { wireRunPlane, type RunPlane } from './plane';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRepository } from './reservation';
import { verifyRunMessage, type ResolveRuntimeKey, type SignedRunMessageWire } from './verify';

import type { EmitDelegationEffect, EmitQueryEffect } from './engine';
import type { DatabaseAdapter } from '../storage/db_adapter';

/** The signed D2D egress the boot already wired (sign + resolve + WS/HTTP). */
export type SendD2D = (to: string, type: string, body: Record<string, unknown>) => Promise<void>;

export interface RunPlaneNodeDeps {
  /** Tier-0 db (`identity.sqlite`). */
  db: DatabaseAdapter;
  /** Signed D2D sender (`makeSendD2D` on server; `setD2DSender` value on mobile). */
  sendD2D: SendD2D;
  /**
   * Resolve a provider/runtime-issuer's Ed25519 verification key (async — DID
   * doc). Returns null when the DID/key is unknown or unauthorized → the
   * response is rejected. In V1 the runtime issuer IS the provider, so this is
   * the provider's verification key (the SAME key the D2D envelope was verified
   * against upstream).
   */
  resolveVerificationKey: (
    issuerDid: string,
    keyId: string,
    issuedAtSec: number,
  ) => Promise<Uint8Array | null>;
  /** Persona cipher over the vault DEK (default: the orchestrator adapter). */
  personaCipher?: PersonaCipher;
  /** Persona-open predicate (default: the vault DEK presence). */
  isPersonaOpen?: (persona: string) => boolean;
  /** Erasure backend (default: durable SQLite `logical_deletion` over `db`). */
  erasureStore?: ErasureKeyStore;
  nowMsFn?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  engineIntervalMs?: number;
  sweeperIntervalMs?: number;
  classifyIntervalMs?: number;
  completionIntervalMs?: number;
  runRepo?: RunRepository;
  reservationRepo?: ReservationRepository;
}

export interface RunPlaneNode {
  readonly plane: RunPlane;
  /**
   * D2D receive hook for a run-correlated provider `service.response`. Returns
   * `true` iff it was a run response (so the caller SKIPS the workflow-task path),
   * whether it verified or was rejected; `false` if the body is not a run
   * response (a normal service.response for the requester window).
   */
  handleServiceResponse: (senderDID: string, body: unknown) => Promise<boolean>;
  start: () => void;
  stop: () => Promise<void>;
}

/** The default `PersonaCipher` over the running vault: wrap/unwrap under the
 *  active persona DEK (null when the persona is locked). Persona-open is a
 *  separate `hasDEK` predicate (see `isPersonaOpen` below). */
const vaultPersonaCipher: PersonaCipher = {
  wrap: (persona, pt) => wrapWithPersonaDEK(persona, pt),
  unwrap: (persona, ct) => unwrapWithPersonaDEK(persona, ct),
};

export function wireRunPlaneNode(deps: RunPlaneNodeDeps): RunPlaneNode {
  const now = deps.nowMsFn ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const personaCipher = deps.personaCipher ?? vaultPersonaCipher;
  const isPersonaOpen = deps.isPersonaOpen ?? ((p: string) => hasDEK(p));

  const emitQuery: EmitQueryEffect = async ({ run, cursor, correlationId }) => {
    // Clamp the per-query TTL to the protocol maximum (`MAX_SERVICE_TTL` = 300s).
    // A run's `expires_at` can be hours out; the wire validator
    // (`validateServiceQueryBody`) rejects any `ttl_seconds > 300` and the egress
    // gate throws on that denial — so an unclamped lifetime-length TTL would make
    // the pacer's `service.query` fail before it ever reaches the provider (§3/§7).
    // The pacer re-issues each interval, so a per-query ceiling is correct; the
    // run's own `expires_at` remains the hard lifetime bound enforced elsewhere.
    const ttl = Math.max(
      1,
      Math.min(MAX_SERVICE_TTL, Math.round((run.expires_at - now()) / 1000)),
    );
    await deps.sendD2D(run.provider_did, MsgTypeServiceQuery, {
      query_id: correlationId,
      capability: INTERACTIVE_RUN_CAPABILITY,
      params: { run_id: run.run_id, fetch_cursor: cursor },
      ttl_seconds: ttl,
      service_uri: run.service_uri,
      ...(run.provider_grant_id !== null ? { grant_id: run.provider_grant_id } : {}),
    });
  };

  const emitDelegation: EmitDelegationEffect = async ({ run, message, delegationId }) => {
    // Dispatch an approved action to the provider (fire-and-forget; the signed
    // completion returns via the receive path). Correlated by the STABLE
    // delegation id so a resend is idempotent (§8/§6.2).
    // Clamp to the protocol max (see emitQuery) — an unclamped message-expiry TTL
    // would be rejected by the wire validator and never reach the provider.
    const ttl = Math.max(
      1,
      Math.min(MAX_SERVICE_TTL, Math.round((message.expires_at - now()) / 1000)),
    );
    await deps.sendD2D(run.provider_did, MsgTypeServiceQuery, {
      query_id: `deleg-${delegationId}`,
      capability: INTERACTIVE_RUN_CAPABILITY,
      params: {
        run_id: run.run_id,
        delegation_id: delegationId,
        message_id: message.message_id,
        action_type: message.action_type,
        decision_revision: message.decision_revision,
      },
      ttl_seconds: ttl,
      service_uri: run.service_uri,
      ...(run.provider_grant_id !== null ? { grant_id: run.provider_grant_id } : {}),
    });
  };

  const plane = wireRunPlane({
    db: deps.db,
    personaCipher,
    isPersonaOpen,
    emitQuery,
    emitDelegation,
    erasureStore: deps.erasureStore ?? new SQLiteErasureKeyStore(deps.db),
    // Minimal Core-owned classify view (§212): the signed content digest, no
    // vault context, no params. The full decrypted-card title/body is a Brain-
    // classify-path refinement; Brain is non-load-bearing (the classify-timeout
    // fallback finalizes without it).
    buildClassificationView: (m) => ({ title: '', body: '', content_digest: m.payload_ref ?? '' }),
    // No completion verifier wired ⇒ CompletionService fail-closed: an action
    // dispatches, and if its signed completion cannot be verified it reconciles
    // to `outcome_unknown` at the drain deadline (honest V1; the signed-completion
    // receive path is the next layer).
    nowMsFn: now,
    log: deps.log,
    engineIntervalMs: deps.engineIntervalMs,
    sweeperIntervalMs: deps.sweeperIntervalMs,
    classifyIntervalMs: deps.classifyIntervalMs,
    completionIntervalMs: deps.completionIntervalMs,
    runRepo: deps.runRepo,
    reservationRepo: deps.reservationRepo,
  });

  const handleServiceResponse = async (senderDID: string, body: unknown): Promise<boolean> => {
    if (body === null || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    if (b.capability !== INTERACTIVE_RUN_CAPABILITY) return false;
    const correlationId = typeof b.query_id === 'string' ? b.query_id : '';
    if (correlationId === '') return false;
    const reservations = deps.reservationRepo ?? getReservationRepository();
    const runs = deps.runRepo ?? getRunRepository();
    if (reservations === null || runs === null) return false;
    // Recover the reserved slot by the correlation id the pacer stamped. Absent
    // ⇒ not a live run response (already handled / unknown / a plain requester
    // service.response) → let the caller's normal path handle it.
    const res = reservations.getByCorrelation(correlationId);
    if (res === null) return false;
    const run = runs.getById(res.run_id);
    if (run === null) return false;
    // From here it IS a run-correlated response: handle it (verify or reject) and
    // NEVER fall through to the workflow-task requester path.
    const raw = b.result;
    if (raw === null || typeof raw !== 'object') {
      log({ evt: 'run_plane.response_rejected', reason: 'no_result', run_id: run.run_id });
      return true;
    }
    const r = raw as Record<string, unknown>;
    let payload: Uint8Array;
    try {
      payload = typeof r.payload === 'string' ? hexToBytes(r.payload) : new Uint8Array();
    } catch {
      log({ evt: 'run_plane.response_rejected', reason: 'bad_payload', run_id: run.run_id });
      return true;
    }
    // A wrongly-typed field just yields a different projection string → the
    // signature fails; the verifier's own shape checks catch the rest. So the
    // cast is safe (fail-closed).
    const wire = { ...r, payload } as unknown as SignedRunMessageWire;
    const issuerDid = typeof r.runtime_issuer_did === 'string' ? r.runtime_issuer_did : senderDID;
    const keyId = typeof r.runtime_key_id === 'string' ? r.runtime_key_id : '';
    const issuedAt = typeof r.issued_at === 'number' ? r.issued_at : 0;
    // Resolve the runtime-issuer key for THIS key id at THIS issue time (E76-03);
    // the boot's resolver honours `key_id`/`issued_at`. `verifyRunMessage` then
    // additionally binds issuer===provider + the sequence window (E76-03/04).
    const key = await deps.resolveVerificationKey(issuerDid, keyId, issuedAt);
    const resolve: ResolveRuntimeKey = () => key;
    const verified = verifyRunMessage(
      wire,
      {
        run_id: run.run_id,
        provider_did: run.provider_did,
        service_uri: run.service_uri,
        // The reserved pull fetch position — a response below it is out-of-window.
        expected_sequence: res.cursor,
      },
      resolve,
      now(),
    );
    if (!verified.ok) {
      log({ evt: 'run_plane.response_rejected', reason: verified.reason, run_id: run.run_id });
      return true;
    }
    const outcome = plane.ingestPullResponse(correlationId, verified.verified);
    log({ evt: 'run_plane.response_ingested', run_id: run.run_id, outcome: outcome.outcome });
    return true;
  };

  return { plane, handleServiceResponse, start: plane.start, stop: plane.stop };
}
