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
import { PersonaLockedError } from '../errors';
import { hasDEK, unwrapWithPersonaDEK, wrapWithPersonaDEK } from '../persona/orchestrator';

import { parseRunMessagePayload, parseResultCardPayload } from './card';
import { SQLiteErasureKeyStore, type ErasureKeyStore } from './erasure_store';
import { type PersonaCipher } from './payload_store';
import { wireRunPlane, type RunPlane } from './plane';
import { getRunRepository, type RunRepository } from './repository';
import { getReservationRepository, type ReservationRepository } from './reservation';
import {
  verifyRunMessage,
  verifyRunExhausted,
  verifyRunResult,
  type ResolveRuntimeKey,
  type SignedRunMessageWire,
  type SignedRunExhaustedWire,
  type SignedRunResultWire,
} from './verify';

import type { EmitDelegationEffect, EmitQueryEffect } from './engine';
import type { DatabaseAdapter } from '../storage/db_adapter';

/** The signed D2D egress the boot already wired (sign + resolve + WS/HTTP). */
export type SendD2D = (to: string, type: string, body: Record<string, unknown>) => Promise<void>;

/** Correlation-id prefix for an action DELEGATION query (§6.3). A provider's
 *  action-result completion echoes it, so the receive path routes it to the
 *  completion branch (not the reservation-correlated pull branch). */
const DELEGATION_CORRELATION_PREFIX = 'deleg-';

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
      query_id: `${DELEGATION_CORRELATION_PREFIX}${delegationId}`,
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
    // E76-06 — no `buildClassificationView` override: the plane's OWN default
    // decrypts the stored payload via the PayloadStore for an open persona and
    // renders the card title/body + the verified content digest (§6.2/§12.6).
    // E76-07 — an action-result completion is cryptographically verified at the
    // D2D receive boundary (`verifyRunResult` in `handleServiceResponse`) BEFORE
    // `ingestCompletion` is called, and the CompletionService additionally binds
    // it to the stored message + dedups (§6.3). So the receipt hook affirms the
    // pre-verified input; a completion that fails the boundary verifier never
    // reaches here (the action then reconciles to `outcome_unknown` at drain).
    verifyReceipt: () => true,
    nowMsFn: now,
    log: deps.log,
    engineIntervalMs: deps.engineIntervalMs,
    sweeperIntervalMs: deps.sweeperIntervalMs,
    classifyIntervalMs: deps.classifyIntervalMs,
    completionIntervalMs: deps.completionIntervalMs,
    runRepo: deps.runRepo,
    reservationRepo: deps.reservationRepo,
  });

  // Resolve the runtime-issuer key for a signed provider terminal (E76-03). The
  // boot's resolver honours `key_id`/`issued_at`; each `verify*` additionally
  // binds issuer===provider. Shared by the message / exhausted / result branches.
  const resolveKeyFor = async (
    r: Record<string, unknown>,
    fallbackIssuer: string,
  ): Promise<ResolveRuntimeKey> => {
    const issuerDid = typeof r.runtime_issuer_did === 'string' ? r.runtime_issuer_did : fallbackIssuer;
    const keyId = typeof r.runtime_key_id === 'string' ? r.runtime_key_id : '';
    const issuedAt = typeof r.issued_at === 'number' ? r.issued_at : 0;
    const key = await deps.resolveVerificationKey(issuerDid, keyId, issuedAt);
    return () => key;
  };

  const handleServiceResponse = async (senderDID: string, body: unknown): Promise<boolean> => {
    if (body === null || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    if (b.capability !== INTERACTIVE_RUN_CAPABILITY) return false;
    const correlationId = typeof b.query_id === 'string' ? b.query_id : '';
    if (correlationId === '') return false;
    const reservations = deps.reservationRepo ?? getReservationRepository();
    const runs = deps.runRepo ?? getRunRepository();
    if (reservations === null || runs === null) return false;
    const raw = b.result;
    const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;

    // (A) ACTION-COMPLETION branch (§6.3) — correlated by the STABLE delegation id
    // (`deleg-<delegationId>`), NOT a reservation. Verify the signed result at the
    // trust boundary; `ingestCompletion` additionally binds it to the stored
    // message + dedups. A verified completion advances the action's outcome; a
    // forged/mismatched one is rejected (the action reconciles at drain).
    if (correlationId.startsWith(DELEGATION_CORRELATION_PREFIX)) {
      const delegationId = correlationId.slice(DELEGATION_CORRELATION_PREFIX.length);
      if (r === null) {
        log({ evt: 'run_plane.completion_rejected', reason: 'no_result', delegation_id: delegationId });
        return true;
      }
      // The wire run_id is untrusted until verified; look up the run by it and let
      // `verifyRunResult` bind run_id + provider + service back to that run.
      const run = runs.getById(typeof r.run_id === 'string' ? r.run_id : '');
      if (run === null) {
        log({ evt: 'run_plane.completion_rejected', reason: 'unknown_run', delegation_id: delegationId });
        return true;
      }
      const resolve = await resolveKeyFor(r, senderDID);
      const verified = verifyRunResult(
        r as unknown as SignedRunResultWire,
        {
          run_id: run.run_id,
          provider_did: run.provider_did,
          service_uri: run.service_uri,
          delegation_id: delegationId,
        },
        resolve,
        now(),
      );
      if (!verified.ok) {
        log({ evt: 'run_plane.completion_rejected', reason: verified.reason, run_id: run.run_id });
        return true;
      }
      // 81B-04 — the RESULT-CARD is a payload just like a pull message (§5.1/§13):
      // the signature proved the provider SIGNED `result_card_digest`; now prove the
      // serialized card bytes actually HASH to it + are a valid bounded CardSpec, then
      // Core envelope-encrypts + persists them under its OWN content-addressed ref
      // (crypto-shredded with the run). NEVER trust a provider-supplied ref string:
      // the outcome (completed/failed) is independently signed + always advances, but
      // an absent/mismatched/invalid/lock-raced card is dropped (ref stays null) so
      // Core never stores an unverified card. Result-card bytes ride the wire as
      // `r.result_card` (hex), parallel to a message's `r.payload`.
      let resultCardRef: string | null = null;
      if (typeof r.result_card === 'string' && r.result_card !== '') {
        let cardBytes: Uint8Array | null = null;
        try {
          cardBytes = hexToBytes(r.result_card);
        } catch {
          cardBytes = null;
        }
        const parsed =
          cardBytes === null
            ? ({ ok: false, reason: 'malformed' } as const)
            : parseResultCardPayload(cardBytes, verified.verified.result_card_digest);
        if (!parsed.ok) {
          log({ evt: 'run_plane.result_card_rejected', reason: parsed.reason, run_id: run.run_id });
        } else {
          try {
            const ref = plane.payloads.putPayload({
              payloadId: `result-${verified.verified.delegation_id}`,
              runId: run.run_id,
              persona: run.persona,
              plaintext: cardBytes as Uint8Array,
            });
            resultCardRef = ref.content_id;
          } catch (err) {
            // Persona locked at completion (§13): the card is not retained (the outcome
            // still advances); a re-sent completion on unlock re-stores it. Any other
            // store fault is likewise non-fatal to outcome advancement.
            if (!(err instanceof PersonaLockedError)) throw err;
            log({ evt: 'run_plane.result_card_deferred', reason: 'persona_locked', run_id: run.run_id });
          }
        }
      }
      const outcome = plane.ingestCompletion({
        delegation_id: verified.verified.delegation_id,
        message_id: verified.verified.message_id,
        run_id: verified.verified.run_id,
        status: verified.verified.status,
        result_card_ref: resultCardRef,
        issued_at: verified.verified.issued_at,
      });
      log({ evt: 'run_plane.completion_ingested', run_id: run.run_id, outcome });
      return true;
    }

    // (B)/(C) RESERVATION-correlated: recover the reserved slot the pacer stamped.
    // Absent ⇒ not a live run response (already handled / unknown / a plain
    // requester service.response) → let the caller's normal path handle it.
    const res = reservations.getByCorrelation(correlationId);
    if (res === null) return false;
    const run = runs.getById(res.run_id);
    if (run === null) return false;
    // From here it IS a run-correlated response: handle it (verify or reject) and
    // NEVER fall through to the workflow-task requester path.
    if (r === null) {
      log({ evt: 'run_plane.response_rejected', reason: 'no_result', run_id: run.run_id });
      return true;
    }
    const resolve = await resolveKeyFor(r, senderDID);

    // (C) EXHAUSTED-marker branch (§7.1, pull only) — a result carrying a `cursor`
    // and NO `message_id`. Verify + set the (permissive) exhaustion barrier — this
    // is what terminates a `stop_on_exhaustion` run when a finite stream ends.
    const hasMessageId = typeof r.message_id === 'string' && r.message_id !== '';
    if (!hasMessageId && typeof r.cursor === 'number') {
      const verified = verifyRunExhausted(
        r as unknown as SignedRunExhaustedWire,
        {
          run_id: run.run_id,
          provider_did: run.provider_did,
          service_uri: run.service_uri,
          expected_cursor: res.cursor,
        },
        resolve,
        now(),
      );
      if (!verified.ok) {
        log({ evt: 'run_plane.exhausted_rejected', reason: verified.reason, run_id: run.run_id });
        return true;
      }
      const outcome = plane.ingestExhausted(correlationId);
      log({ evt: 'run_plane.exhausted_ingested', run_id: run.run_id, outcome: outcome.outcome });
      return true;
    }

    // (B) MESSAGE/proposal branch — the default pull response. A wrongly-typed
    // field just yields a different projection string → the signature fails; the
    // verifier's own shape checks catch the rest (fail-closed cast).
    let payload: Uint8Array;
    try {
      payload = typeof r.payload === 'string' ? hexToBytes(r.payload) : new Uint8Array();
    } catch {
      log({ evt: 'run_plane.response_rejected', reason: 'bad_payload', run_id: run.run_id });
      return true;
    }
    const wire = { ...r, payload } as unknown as SignedRunMessageWire;
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
    // E76-05 — the signature proved the provider SIGNED these digests; now prove
    // the plaintext actually HASHES to them + is a valid bounded CardSpec, before
    // Core envelope-encrypts + persists it. A card/params-digest mismatch or an
    // invalid/oversized card is rejected (never stored under a signed-but-unrelated
    // digest). `r.card_digest`/`r.params_digest` are authenticated by the signature.
    const parsedPayload = parseRunMessagePayload(
      verified.verified.payload,
      typeof r.card_digest === 'string' ? r.card_digest : '',
      typeof r.params_digest === 'string' ? r.params_digest : '',
    );
    if (!parsedPayload.ok) {
      log({ evt: 'run_plane.response_rejected', reason: parsedPayload.reason, run_id: run.run_id });
      return true;
    }
    const outcome = plane.ingestPullResponse(correlationId, verified.verified);
    log({ evt: 'run_plane.response_ingested', run_id: run.run_id, outcome: outcome.outcome });
    return true;
  };

  return { plane, handleServiceResponse, start: plane.start, stop: plane.stop };
}
