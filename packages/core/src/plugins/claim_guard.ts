/**
 * Plugin claim guard — the six claim-time checks, server-side
 * (PLUGIN_ARCHITECTURE.md §9.0/§9.1). This is a LAUNCH GATE enforced in
 * Core: SDK behavior is irrelevant to the invariant; a malicious runner
 * is assumed to speak raw RPC.
 *
 *   1. exact lane        — the server IGNORES the client-sent
 *                          runner_filter entirely and forces the lane
 *                          registered to this instance's install; the
 *                          repository additionally treats plugin lanes
 *                          as exact-match-only (no untagged pickup).
 *   2. install active    — pause/pending/revoked = no claims. Pause
 *                          needs no producer-side cooperation: queued
 *                          tasks wait, new claims stop HERE.
 *   3. kind consented    — the envelope's capability must be in the
 *                          install's consented capability set.
 *   4. device non-revoked — a revoked device never authenticates
 *                          (caller-type resolution drops it), and the
 *                          lane binding is re-checked against the
 *                          install row anyway.
 *   5. scope hash current — the task's pinned approved_scope_hash must
 *                          equal the install's CURRENT hash for that
 *                          capability (stale-authority hole).
 *   6. config revision current — the approve-then-reconfigure hole.
 *
 * Checks 5/6 TERMINALIZE, not merely reject (§9.1): the pins are
 * immutable and the install's current values are not coming back, so
 * the guard atomically fails the task with the typed reason
 * `stale_authority` — leaving it queued would let the claim loop
 * re-select the same dead oldest row forever, starving valid work.
 */

import { canonicalJson, pluginLane } from '@dina/protocol';

import { parsePluginEnvelope } from '../workflow/plugin_envelope';

import { contextScopeViolation, paramsExceedInspectableLimits } from './dispatch';
import { getPluginGrantRepository, invocationDigest } from './grants';
import { validateAgainstSchema } from './schema_validate';

import type { PluginInstall } from './registry';
import type { WorkflowTask } from '../workflow/domain';
import type { WorkflowRepository } from '../workflow/repository';

export const STALE_AUTHORITY = 'stale_authority';

/** Bounded drain: how many dead rows one claim call may terminalize
 * before giving up the tick (the sweeper catches the rest). */
const MAX_TERMINALIZE_PER_CLAIM = 8;

export interface PluginClaimResult {
  task: WorkflowTask | null;
  /** Tasks terminalized as stale_authority during this claim. */
  terminalized: string[];
}

/**
 * Claim the next valid task on this install's lane. Claims that surface
 * a stale-authority or malformed task terminalize it (atomically, via
 * the claim's own claim_id CAS) and keep drawing until a valid task,
 * an empty lane, or the drain bound.
 */
export function claimPluginTask(args: {
  repo: WorkflowRepository;
  install: PluginInstall;
  deviceDid: string;
  nowMs: number;
  leaseMs: number;
}): PluginClaimResult {
  const { repo, install, deviceDid, nowMs, leaseMs } = args;
  const nowSec = Math.floor(nowMs / 1000);
  const terminalized: string[] = [];

  // Check 2 — install active. Pause = lane removed from selection;
  // queued tasks wait (the distinction from revoke, §14).
  if (install.status !== 'active') return { task: null, terminalized };

  // Check 4 (belt half) — the lane binding belongs to THIS device. The
  // suspenders half is auth itself: a revoked device never resolves to
  // callerType 'plugin'.
  if (install.deviceDid !== deviceDid) return { task: null, terminalized };

  // Check 1 — the forced lane. Client-sent runner_filter never reaches
  // this function.
  const lane = pluginLane(install.installId);

  // Round-10 #24: `< MAX` (not `<=`) — the documented cap is MAX terminalizations
  // per claim; `<=` allowed MAX+1.
  for (let i = 0; i < MAX_TERMINALIZE_PER_CLAIM; i++) {
    const task = repo.claimDelegationTask(deviceDid, nowMs, leaseMs, lane);
    if (task === null) return { task: null, terminalized };

    const failStale = (reason: string): void => {
      // The claim just minted this claim_id; failing with it is the
      // atomic terminalize — no other claimer can race it. Round-10 #24: only
      // record it as terminalized if the fail actually landed (repo.fail returns
      // 0 on a CAS/state no-op), so the count doesn't over-report.
      const eventId = repo.fail(
        task.id,
        deviceDid,
        `${STALE_AUTHORITY}: ${reason}`,
        nowMs,
        task.claim_id,
      );
      if (eventId !== 0) terminalized.push(task.id);
    };

    const envelope = parsePluginEnvelope(task.payload);
    if (envelope === null) {
      // A task on a plugin lane without a valid envelope is an
      // integrity error — closed-default, never dispatched.
      failStale('malformed plugin envelope on a plugin lane');
      continue;
    }
    if (envelope.install_id !== install.installId) {
      failStale('envelope install does not match the lane');
      continue;
    }
    // Check 2b (Round-6 #8 + Round-7 #6) — the envelope's idempotency_key is
    // Core's dedup source of truth; a plugin task MUST carry the SAME value in
    // its workflow idempotency_key column. If they diverge — including a MISSING
    // column — Core and the runner would deduplicate DIFFERENTLY (collapsing
    // distinct executions or splitting identical ones). Require exact equality;
    // any mismatch is an integrity error and terminalizes.
    if (task.idempotency_key !== envelope.idempotency_key) {
      failStale('envelope idempotency key diverged from the task column');
      continue;
    }
    // Check 3 — capability consented (the capability-hash map IS the
    // consent record: what the owner approved at install/update).
    const currentHash = install.capabilityHashes[envelope.capability_id];
    if (currentHash === undefined) {
      failStale('capability no longer consented');
      continue;
    }
    // Check 3b — the capability must exist in the stored manifest and be
    // consented for the TOOL kind. The capability-hash map covers ALL
    // declared capabilities, including provider-/ingest-only ones;
    // presence there is NOT proof the owner consented to serve this
    // capability as a tool on the install lane.
    const cap = install.manifest.capabilities.find((c) => c.id === envelope.capability_id);
    if (cap === undefined) {
      failStale('capability is not in the stored manifest');
      continue;
    }
    if (!(cap.kinds ?? []).includes('tool')) {
      failStale('capability not consented as a tool');
      continue;
    }
    // Checks 3c–3f — the pinned AUTHORITY fields are re-derived from the
    // stored manifest, never trusted from the envelope. The envelope is
    // built Core-side, but a stale or incorrect producer must not be able
    // to point at a different manifest CID, mislabel the action class,
    // change the retry contract, or pin a permissive result schema; each
    // divergence terminalizes here, independently of how the envelope was
    // assembled (defence-in-depth against a compromised producer).
    if (envelope.manifest_cid !== install.currentCid) {
      failStale('envelope manifest CID diverged from the install');
      continue;
    }
    if (envelope.action_class !== cap.action_class) {
      failStale('envelope action_class diverged from the manifest');
      continue;
    }
    const expectedIdem = cap.effects?.idempotency === 'supported' ? 'supported' : 'unsupported';
    if (envelope.effects_idempotency !== expectedIdem) {
      failStale('envelope effects idempotency diverged from the manifest');
      continue;
    }
    if (
      canonicalJson(envelope.schema_snapshot ?? null) !== canonicalJson(cap.result_schema ?? null)
    ) {
      failStale('envelope result schema diverged from the manifest');
      continue;
    }
    // Check 3g (P1-3) — the pinned params must satisfy the CONSENTED
    // params_schema. buildPluginEnvelope validates this at enqueue; re-checking
    // here means a producer that skipped it still can't dispatch off-contract
    // params (missing required fields, extra properties, wrong types) to the
    // runner. Defence-in-depth on both produce and claim sides.
    if (cap.params_schema !== undefined && cap.params_schema !== null) {
      const paramsCheck = validateAgainstSchema(envelope.params, cap.params_schema);
      if (!paramsCheck.ok) {
        failStale(`params violate the consented params_schema: ${paramsCheck.error ?? 'unknown'}`);
        continue;
      }
    }
    // Round-11 #4: params too deep/large to fully render for approval are
    // rejected at the non-bypassable claim boundary too (buildPluginEnvelope
    // throws at produce) — never dispatch un-inspectable params to a runner.
    const paramsLimit = paramsExceedInspectableLimits(envelope.params);
    if (paramsLimit !== '') {
      failStale(`params cannot be fully inspected: ${paramsLimit}`);
      continue;
    }
    // Check 3h (P1-2) — the pinned `context` must be within the CONSENTED
    // data_scope. buildPluginEnvelope bounds this at enqueue; re-checking here
    // means a producer that skipped it still cannot flow unbounded or
    // unstructured context (raw vault data past the owner's ceiling) to the
    // runner. The non-bypassable execution boundary, not the producer, decides.
    const ctxViolation = contextScopeViolation(envelope.context, cap.data_scope?.max_context_items);
    if (ctxViolation !== null) {
      failStale(`context violates the consented data_scope: ${ctxViolation}`);
      continue;
    }
    // Check 5 — pinned scope hash equals the CURRENT approved hash.
    if (envelope.approved_scope_hash !== currentHash) {
      failStale('consent changed after this was queued');
      continue;
    }
    // Check 6 — pinned config revision equals the CURRENT one.
    if (envelope.config_revision !== install.configRevision) {
      failStale('settings changed after this was queued');
      continue;
    }
    // Check 7 (Round-11 #2, Round-12 #2/#3/#6) — the authorizing GRANT must
    // still be live, validated by the EXACT grant this task rode. The envelope
    // now carries its authorization PROVENANCE:
    //   - `authorization_kind === 'grant'`: a standing/once grant authorized
    //     this task. It can sit queued while the owner REVOKES that grant (or it
    //     EXPIRES); checks 5/6 re-derive install-level authority but a grant
    //     revocation touches neither. The grant repo MUST be present — an
    //     unavailable repo cannot verify liveness, so fail CLOSED (#3); the
    //     envelope MUST name its `grant_id`; and THAT grant must still be live
    //     AND match this scope (#2 — a task authorized by grant A must not ride
    //     a different live grant B for the same scope, which could carry
    //     different constraints).
    //   - anything else (`card` / absent): NOT grant-backed — check 7 does not
    //     apply (#6 — a card-approved task must never be terminalized merely
    //     because a tombstoned grant row exists for its scope).
    if (envelope.authorization_kind === 'grant') {
      const grantRepo = getPluginGrantRepository();
      if (grantRepo === null) {
        failStale('grant repository unavailable — cannot verify the authorizing grant');
        continue;
      }
      const grantId = envelope.grant_id ?? '';
      const grant = grantId === '' ? null : grantRepo.getById(grantId);
      const live =
        grant !== null &&
        grant.installId === install.installId &&
        grant.capability === envelope.capability_id &&
        grant.approvedScopeHash === envelope.approved_scope_hash &&
        grant.revokedAt === undefined &&
        // Round-14 #8: a grant whose stored constraints no longer parse is in a
        // fail-closed state — authorizeAndConsume denies it (`constraints_unparseable`).
        // Check 7 re-validates liveness at claim time via the same rowToGrant
        // projection, so honor the same corruption flag here; otherwise a task
        // riding a now-corrupt grant would pass the claim gate while its
        // resource/value/count constraints can no longer be enforced.
        grant.constraintsCorrupt !== true &&
        (grant.expiresAt === undefined || grant.expiresAt > nowSec);
      if (!live) {
        failStale('authorizing grant is missing, revoked, expired, scope-mismatched, or corrupt');
        continue;
      }
      // Check 7b (Round-13 #3/#4) — naming a live grant is NOT proof the grant
      // was CONSUMED. once/max_count/resource/value are only enforced at
      // authorizeAndConsume; a producer that stamped `grant_id` but skipped the
      // consume would otherwise bypass them all. Require the consumed-use row for
      // (grant_id, execution_id) to EXIST, and — since a grant task pins a digest
      // — require the envelope's `invocation_digest` to be present and EQUAL the
      // digest that was actually consumed. This binds the dispatched invocation
      // to the one charged against the grant.
      const use = grantRepo.getUse(grantId, envelope.execution_id);
      if (use === null) {
        failStale('authorizing grant was never consumed for this execution');
        continue;
      }
      // Check 7b (Round-13 #3/#4, hardened PLG-29 #4) — RECOMPUTE the invocation
      // digest from the envelope's OWN Core-owned fields (resource/value/params/
      // context — the ACTUAL invocation about to be dispatched) and require it to
      // equal the digest CHARGED to the grant at consume. Trusting the
      // producer-supplied `invocation_digest` alone let a faulty producer consume
      // invocation A (recording A's digest in the use row) then dispatch
      // invocation B carrying A's digest — the two matched, but the dispatched
      // params were B's. Binding to the recomputed digest ties the dispatched
      // invocation to the consumed one. The supplied `invocation_digest` is kept
      // as a coherence belt: it must be present and equal the recomputed value,
      // so a producer that stamps a digest inconsistent with its own params is
      // also caught.
      const recomputed = invocationDigest({
        resource: envelope.resource,
        value: envelope.value,
        params: envelope.params,
        context: envelope.context,
      });
      if (
        envelope.invocation_digest === undefined ||
        envelope.invocation_digest === '' ||
        envelope.invocation_digest !== recomputed ||
        recomputed !== use.invocationDigest
      ) {
        failStale(
          'invocation digest missing, disagrees with the dispatched invocation, or was not the one consumed',
        );
        continue;
      }
    }
    return { task, terminalized };
  }
  return { task: null, terminalized };
}
