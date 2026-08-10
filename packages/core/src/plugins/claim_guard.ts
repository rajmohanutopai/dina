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
import { getDrainAuthorizationRepository } from './drain_authorizations';
import { getCommerceRuntime } from '../commerce/runtime';
import { getPluginGrantRepository, invocationDigest } from './grants';
import {
  LIFECYCLE_CAPABILITIES,
  bareCapabilityName,
  releaseMajorOf,
} from './update_rebind';
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
/**
 * Is the order a continuity claim names still one this lane may serve?
 *
 * FAIL CLOSED on every uncertainty. No order named, no commerce runtime, no
 * such order, or a terminal one — all refuse. The lane was retained to let
 * live orders finish; none of those is a live order.
 *
 * Reads the order store rather than trusting the envelope beyond the id,
 * which is the same shape as every other check here: the envelope says WHICH
 * order, the store says whether it is still open.
 */
function continuedOrderIsLive(
  orderId: string | undefined,
  buyerDid: string | undefined,
  nowMs: number,
): boolean {
  if (orderId === undefined || orderId === '') return false;
  const orders = getCommerceRuntime()?.orders;
  if (orders === undefined || orders === null) return false;
  // The BUYER comes from the ingress envelope's authenticated sender, which
  // the ingress gate bound before the task was created — never from params.
  // A continuity task with no ingress has no buyer to check against and is
  // refused, which is right: only the lifecycle lane has orders.
  if (buyerDid === undefined || buyerDid === '') return false;
  return orders.isUnfinished(buyerDid, orderId, nowMs);
}

/**
 * Does the envelope's declared prior RELEASE major match the row's?
 *
 * THE PLUGIN RELEASE MAJOR, not the commerce protocol major. Both values come
 * from `PluginInstall.currentVersion` — the manifest's own `version` — by way
 * of the drain row's `priorVersion` and the envelope field
 * `buildContinuityEnvelope` stamps from it. See `releaseMajorOf`.
 *
 * WHY COMPARE MAJORS AT ALL, then. Not because §9.13 says minors are additive
 * — that is a rule about the commerce wire version and it does not reach plugin
 * semver. The reason is narrower and is the plugin author's own declaration: a
 * release that keeps its major is the author saying this capability's contract
 * did not break, so a continuation built under 0.1.0 may be claimed on a lane
 * retained for 0.1.x. A major bump is the author saying the opposite, and the
 * two must not be interchangeable on one lane.
 *
 * WHAT THIS DOES NOT ENFORCE, stated because the previous comment implied it
 * did: nothing on the claim path compares the commerce `protocol_version`. That
 * is enforced where the record is built and read — `versionMatches` against
 * `ref.pinnedVersion` in the lifecycle engine. Cross-major PROTOCOL continuity
 * is a separate, currently unimplemented question; see implementation-notes.html.
 *
 * Both sides may be SILENT, and silence has to agree with silence. A row
 * written before `prior_version` existed records an empty string, and
 * `buildContinuityEnvelope` omits the field when the row has none — so
 * "neither says" is a legitimate pairing and stays admissible, which keeps
 * pre-existing lanes working. What is refused is a DISAGREEMENT, including
 * one side claiming a version while the other cannot.
 */
/**
 * A stored schema column, or `undefined` when the row cannot be believed.
 *
 * `null` is a LEGITIMATE stored value — `update_rebind` writes
 * `JSON.stringify(cap.result_schema ?? null)` for a capability that declares
 * none — so the unreadable case has to be distinguishable from it. Hence
 * `undefined` for "could not parse" and `null` for "parsed, and it is null".
 */
function parseStoredSchema(json: string): unknown | undefined {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function majorsAgree(rowVersion: string, envelopeVersion: string | undefined): boolean {
  const rowMajor = rowVersion === '' ? '' : releaseMajorOf(rowVersion);
  const envelopeMajor =
    envelopeVersion === undefined || envelopeVersion === '' ? '' : releaseMajorOf(envelopeVersion);
  return rowMajor === envelopeMajor;
}

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
    // §9.13 drain lane: a prior-CID envelope may be admitted ONLY
    // through a live drain authorization for exactly this
    // (install, previous CID, capability). The entry pins the
    // AUTHORIZED prior values; checks 3c–3f/5/6 then validate against
    // THOSE — the current manifest cannot vouch for a manifest it
    // replaced. Entry creation (rebind flow / lifecycle continuity)
    // happens from consented state, which is what makes the entry's
    // existence the consent proof.
    // ALL live entries are considered, and the task is admitted if ANY
    // of them admits it: after a rebind a 'drain' entry (covering
    // in-flight work) and a 'lifecycle_continuity' entry (admitting NEW
    // prior-major lifecycle tasks, §9.13) are both normally live, and
    // picking just one would let the drain entry's pre-rebind rule
    // terminalize exactly the continuity tasks the spec protects.
    const liveEntries =
      envelope.manifest_cid !== install.currentCid
        ? (getDrainAuthorizationRepository()?.listLive(
            install.installId,
            envelope.manifest_cid,
            envelope.capability_id,
            nowMs,
          ) ?? [])
        : [];
    // §11.2a — the kind this envelope needs, computed once and applied on
    // BOTH lanes. The ordinary lane checks it in check 3b below; the drained
    // lane skips that whole block (the capability may be gone from the
    // current manifest, so the entry is the consent proof) and therefore has
    // to carry the check itself. Without it a continuity lane opened for a
    // provider capability admitted a tool envelope, and the reverse.
    const requiredKind = envelope.service_ingress !== undefined ? 'provider' : 'tool';
    const admits = (entry: (typeof liveEntries)[number]): boolean => {
      // A row written before `authorized_kinds_json` existed says nothing
      // about kinds. That reads as "cannot tell", and cannot-tell is a
      // refusal: the alternative is admitting an envelope onto a consent no
      // row can show covered it.
      if (!entry.authorizedKinds.includes(requiredKind)) return false;
      // WHICH PLUGIN RELEASE this continuation speaks for must be the one the
      // row authorized. Both sides already carried the fact and nothing
      // compared them: `buildContinuityEnvelope` stamps `prior_version` from
      // the row, and the row records `priorVersion` from the manifest the
      // install stopped running. Unchecked, a lane retained for release 1
      // admitted an envelope claiming release 2, and the runner would answer
      // under a manifest contract the lane never covered.
      //
      // CONTINUITY ONLY, and the asymmetry is the point. A `drain` entry
      // covers work that ALREADY EXISTED at the rebind: those envelopes were
      // built by the ordinary builder under the prior manifest and carry no
      // `prior_version` at all, so requiring one would terminalize exactly
      // the in-flight tasks a drain exists to let finish. A continuity task
      // is created AFTER the rebind by a builder that always stamps it, so
      // there the field's absence is a fact about the envelope rather than
      // about when it was made.
      //
      // Compared by MAJOR, not by exact version, and on the RELEASE version:
      // a lane is retained per plugin release major, and a same-major release
      // is the author's own declaration that the capability contract held.
      // (An earlier version of this comment borrowed §9.13's additive-minor
      // rule, which is about the commerce wire version and says nothing about
      // plugin semver. See `majorsAgree`.)
      if (
        entry.kind === 'lifecycle_continuity' &&
        !majorsAgree(entry.priorVersion, envelope.prior_version)
      ) {
        return false;
      }
      // §9.13 — WHICH ORDER, and is it still live.
      //
      // A continuity lane is retained so a specific set of in-flight orders
      // can finish under the contract they were opened in. Checking only that
      // the lane exists admitted ANY newly created task on the prior CID for
      // that capability — including one for an order that had already gone
      // terminal, which is a runner answering for a closed order under a
      // manifest the install no longer runs.
      //
      // Only for the LIFECYCLE capabilities: they are the ones an order
      // belongs to, and they are exactly the set the rebind coordinator opens
      // continuity lanes for. A continuity task for one of them that names no
      // order is refused rather than treated as unscoped — the envelope
      // builder always stamps it, so its absence is a fact about the envelope.
      if (
        entry.kind === 'lifecycle_continuity' &&
        LIFECYCLE_CAPABILITIES.has(bareCapabilityName(entry.capabilityId)) &&
        !continuedOrderIsLive(
          envelope.continuity_order_id,
          envelope.service_ingress?.from_did,
          nowMs,
        )
      ) {
        return false;
      }
      // 'drain' covers only tasks that existed at the rebind moment;
      // 'lifecycle_continuity' also admits newly created tasks.
      return entry.kind === 'lifecycle_continuity' || task.created_at < entry.createdAt;
    };
    const drained =
      envelope.manifest_cid !== install.currentCid ? (liveEntries.find(admits) ?? null) : null;
    if (envelope.manifest_cid !== install.currentCid && drained === null) {
      failStale(
        liveEntries.length === 0
          ? 'envelope manifest CID diverged from the install'
          : `no live drain entry admits this task as a ${requiredKind}`,
      );
      continue;
    }
    // Check 3 — capability consented (the capability-hash map IS the
    // consent record: what the owner approved at install/update). A
    // drained task's consent proof is the drain entry instead — the
    // capability may have left the CURRENT manifest entirely.
    const currentHash = install.capabilityHashes[envelope.capability_id];
    if (drained === null && currentHash === undefined) {
      failStale('capability no longer consented');
      continue;
    }
    const cap = install.manifest.capabilities.find((c) => c.id === envelope.capability_id);
    if (drained === null) {
      // Check 3b — the capability must exist in the stored manifest and
      // be consented for the required kind. The capability-hash map
      // covers ALL declared capabilities, including provider-/ingest-only
      // ones; presence there is NOT proof the owner consented to serve
      // this capability under this kind on the install lane.
      if (cap === undefined) {
        failStale('capability is not in the stored manifest');
        continue;
      }
      // §11.2a: the REQUIRED kind is keyed off the envelope. An ingress
      // task (service_ingress present) may dispatch only a capability the
      // owner consented as `provider`; every other plugin task requires
      // `tool`. A provider task can never ride a tool consent, nor the
      // reverse.
      if (!(cap.kinds ?? []).includes(requiredKind)) {
        failStale(`capability not consented as a ${requiredKind}`);
        continue;
      }
    }
    // Checks 3c–3f — the pinned AUTHORITY fields are re-derived from the
    // stored manifest (or the drain entry's authorized prior values),
    // never trusted from the envelope. The envelope is built Core-side,
    // but a stale or incorrect producer must not be able to point at a
    // different manifest CID, mislabel the action class, change the
    // retry contract, or pin a permissive result schema; each divergence
    // terminalizes here, independently of how the envelope was assembled
    // (defence-in-depth against a compromised producer).
    const expectedActionClass = drained !== null ? drained.actionClass : cap?.action_class;
    if (envelope.action_class !== expectedActionClass) {
      failStale('envelope action_class diverged from the manifest');
      continue;
    }
    const expectedIdem =
      drained !== null
        ? drained.effectsIdempotency
        : cap?.effects?.idempotency === 'supported'
          ? 'supported'
          : 'unsupported';
    if (envelope.effects_idempotency !== expectedIdem) {
      failStale('envelope effects idempotency diverged from the manifest');
      continue;
    }
    // A DRAINED ROW THAT CANNOT BE READ TERMINALIZES THE TASK, it does not
    // throw. `readKinds` a few files over already treats an unparseable
    // authorization column as authorizing nothing, and this is the same
    // discipline: a corrupt or half-written `plugin_drain_authorizations` row
    // used to throw out of the claim loop, so the lane wedged and the drain
    // never finished — exactly the "dead oldest row starves valid work"
    // failure this guard's own comment says it exists to avoid.
    const drainedResultSchema = drained === null ? undefined : parseStoredSchema(drained.resultSchemaJson);
    if (drained !== null && drainedResultSchema === undefined) {
      failStale('retained result schema is unreadable');
      continue;
    }
    const expectedSchemaJson =
      drained !== null
        ? canonicalJson(drainedResultSchema ?? null)
        : canonicalJson(cap?.result_schema ?? null);
    if (canonicalJson(envelope.schema_snapshot ?? null) !== expectedSchemaJson) {
      failStale('envelope result schema diverged from the manifest');
      continue;
    }
    // Check 3g (P1-3) — the pinned params must satisfy the CONSENTED
    // params_schema. buildPluginEnvelope validates this at enqueue; re-checking
    // here means a producer that skipped it still can't dispatch off-contract
    // params (missing required fields, extra properties, wrong types) to the
    // runner. Defence-in-depth on both produce and claim sides. Drained
    // tasks were validated against the PRIOR params_schema at enqueue;
    // the current schema cannot judge them (inspectability limits below
    // still apply).
    const drainedParamsSchema = drained === null ? undefined : parseStoredSchema(drained.paramsSchemaJson);
    if (drained !== null && drainedParamsSchema === undefined) {
      failStale('retained params schema is unreadable');
      continue;
    }
    const consentedParamsSchema = drained !== null ? drainedParamsSchema : cap?.params_schema;
    if (consentedParamsSchema !== undefined && consentedParamsSchema !== null) {
      const paramsCheck = validateAgainstSchema(envelope.params, consentedParamsSchema);
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
    const ctxViolation = contextScopeViolation(
      envelope.context,
      drained !== null
        ? (drained.maxContextItems ?? undefined)
        : cap?.data_scope?.max_context_items,
    );
    if (ctxViolation !== null) {
      failStale(`context violates the consented data_scope: ${ctxViolation}`);
      continue;
    }
    // Check 5 — pinned scope hash equals the CURRENT approved hash
    // (or, for a drained task, the hash AUTHORIZED for the prior CID).
    const expectedScopeHash = drained !== null ? drained.approvedScopeHash : currentHash;
    if (envelope.approved_scope_hash !== expectedScopeHash) {
      failStale('consent changed after this was queued');
      continue;
    }
    // Check 6 — pinned config revision equals the CURRENT one (or the
    // drained task's authorized prior revision).
    const expectedConfigRevision =
      drained !== null ? drained.configRevision : install.configRevision;
    if (envelope.config_revision !== expectedConfigRevision) {
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
