/**
 * Provider-ingress bridge (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md
 * §11.2a) — the generic platform lane that turns an inbound D2D
 * service query into a plugin task on the backing install's lane:
 *
 *   1. the receive pipeline has already validated sender, service URI,
 *      listing state, schema hash, and access policy;
 *   2. THIS module resolves the listing's plugin binding to the exact
 *      (install_id, manifest CID, capability id) recorded at
 *      publication — a paused, revoked, or missing install answers
 *      with a TYPED UNAVAILABLE error, never a stale cache; a CID
 *      that no longer matches the install answers unavailable too
 *      (the §9.13 rebind story routes NEW dispatches to the rebound
 *      install by updating the binding, not by ignoring the pin);
 *   3. the plugin task rides the install's `plugin:<install_id>` lane
 *      with the SAME claim-token, lease, retry, and schema discipline
 *      as tool tasks (claim guard requires the `provider` consent for
 *      ingress envelopes);
 *   4. on completion, the workflow response bridge recognizes the
 *      envelope's `service_ingress` block and sends the D2D
 *      `service.response` as the Business DID.
 *
 * Deterministic idempotency: the task id, execution id, and
 * idempotency key all derive from the query id, so a replayed query
 * dedups at workflow-create instead of dispatching twice.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { pluginLane } from '@dina/protocol';

import { isCommerceCapability } from '../commerce/capability_names';
import { quoteAdmissibility } from '../commerce/commerce_settings';
import { getQuoteAttemptLedger } from '../commerce/probing_ledger';
import { admitQuoteRequest, type CounterpartyStanding } from '../commerce/probing_resistance';
import { getCommerceRuntime } from '../commerce/runtime';
import { getContact } from '../contacts/directory';
import { parsePluginEnvelope } from '../workflow/plugin_envelope';

import { buildContinuityEnvelope, buildPluginEnvelope } from './dispatch';
import { getDrainAuthorizationRepository } from './drain_authorizations';
import { getPluginInstallRepository } from './registry';

import type { PluginTaskEnvelope } from '../workflow/plugin_envelope';
import type { WorkflowService } from '../workflow/service';
import type { ServiceCapabilityConfig } from '@dina/protocol';

export type ProviderIngressResult =
  | { ok: true; taskId: string }
  /**
   * §12.7 / §16.2 (WS-4.6) — Core answered, and no runner was asked.
   *
   * A deliberate second success shape rather than a `taskId` with a
   * pre-completed task: the caller must SEND this answer now, not wait for a
   * workflow event that will never arrive. Making it a distinct variant means
   * every consumer's `outcome.taskId` stops compiling until it decides what
   * to do here, which is the point.
   */
  | { ok: true; coreAnswerJson: string }
  | {
      ok: false;
      /** Typed unavailable classes (§11.2a step 2). */
      code:
        | 'no_plugin_binding'
        | 'install_unavailable'
        | 'binding_stale'
        | 'capability_not_provider'
        | 'envelope_rejected'
        | 'ingress_key_conflict'
        | 'order_subject_denied'
        /** §9.13 — the order predates a plugin update whose lifecycle lane
         *  was not retained, so no contract exists to answer it under. */
        | 'lifecycle_continuity_unavailable'
        /** §9.9 — this node cannot admit orders at all (no commerce runtime,
         *  or commerce is fenced), so no order may be dispatched. */
        | 'commerce_unavailable'
        /** §9.9 — Core settled the submission itself: a replay returning its
         *  original acknowledgement, or a refusal Core owns. No dispatch. */
        | 'order_settled_by_core'
        /** §9.9 step 3 — an earlier submission of this order is still being
         *  decided; the buyer re-polls rather than submitting again. */
        | 'order_processing'
        /** §9.9 — the proposal contradicts what Core holds (aliased keys,
         *  buyer mismatch, malformed proposal). */
        | 'order_conflict'
        /** §14.3/§20.10 — this node will not answer a pricing question from
         *  this counterparty right now. ONE code for every reason: a prober
         *  who can tell "budget spent" from "we don't quote you" learns the
         *  catalog by watching which requests get a different shape of no. */
        | 'probing_refused';
      error: string;
    };

/**
 * The seam Brain's `ServiceHandler` calls to answer a query whose capability
 * is bound to a provider plugin (§11.2a).
 *
 * Injected rather than imported, for the same reason
 * `ServiceReasoningSubmitter` is: the handler decides WHICH plane answers a
 * query, and Core owns what that plane does. Brain never learns about plugin
 * installs, workflow tasks, or manifest CIDs — it hands over an authenticated
 * query and receives a typed outcome.
 */
export type ProviderIngressSubmitter = (args: {
  capabilityConfig: Pick<
    ServiceCapabilityConfig,
    'pluginInstallId' | 'pluginManifestCid' | 'pluginCapabilityId'
  >;
  query: ProviderIngressQuery;
}) => ProviderIngressResult;

export interface ProviderIngressQuery {
  /** Transport-authenticated requester DID. */
  fromDid: string;
  queryId: string;
  /** The SERVICE capability name being queried (wire name). */
  capability: string;
  /** Listing rkey the receive pipeline resolved. */
  serviceRkey: string;
  /** Validated, undeclared-param-stripped query params. */
  params: unknown;
  ttlSeconds?: number;
  serviceName?: string;
  /** Published schema snapshot the requester saw (bridge re-validates
   *  the runner result against its `result` half). */
  schemaSnapshot?: {
    params: Record<string, unknown>;
    result: Record<string, unknown>;
    schema_hash: string;
  };
}

/**
 * §11.2: the three ORDER-SCOPED commerce capabilities. A query naming
 * one of these speaks about an existing purchase order, so the sender
 * must be that order's buyer. Matched on the bare wire name and on the
 * canonical NSID, because the service lane carries the short form while
 * the manifest and spec use the NSID.
 */
/**
 * §11.2 order-scoped capabilities, split by what AUTHORIZES the caller.
 *
 * These two are entitlement-by-possession: you may ask about an order you
 * already own, so an existing reference under the authenticated sender IS
 * the ownership proof. No reference, no answer.
 */
const REQUIRES_EXISTING_ORDER: ReadonlySet<string> = new Set([
  // Both spellings: a capability config may carry the short id or the NSID.
  'order_status',
  'cancel_order',
  'com.dinakernel.commerce.order_status',
  'com.dinakernel.commerce.cancel_order',
]);

/**
 * `order_reconcile` is entitlement-by-EVIDENCE, and the difference is not a
 * nicety — it is §12.7/§16.2 disaster recovery.
 *
 * Reconcile exists to resolve `outcome_unknown`: the buyer submitted an
 * order and never learned whether it landed. The most important case is the
 * one where this supplier holds NO reference — it crashed before the durable
 * write, or restored a backup taken before the order arrived. Requiring an
 * existing reference makes exactly that case unanswerable, which is how an
 * earlier version of this gate silently disabled the recovery path it was
 * meant to protect.
 *
 * So absence of a reference is the ANSWER (`never_received`), never the
 * denial. Authorization instead comes from the request payload, which is
 * buyer-bound: the caller must name itself as the buyer. That leaks nothing,
 * because a reconcile for an order belonging to someone else is keyed on the
 * authenticated sender and also answers `never_received` — the two are
 * indistinguishable, so the endpoint is not an existence oracle.
 */
const SELF_AUTHORIZING_BY_PAYLOAD: ReadonlySet<string> = new Set(['order_reconcile']);

/**
 * §9.9 — the capability that CREATES an order.
 *
 * Unlike the three order-scoped ones, this arrives with no order to authorize
 * against; the order is the thing being made. Core admits it in compiled code
 * BEFORE any runner is asked, because idempotency, quote capacity, and the
 * reservation record are Core's authority — a plugin that accepted twice, or
 * accepted against spent capacity, would be committing the owner to something
 * Core never reserved.
 */
const CREATES_ORDER: ReadonlySet<string> = new Set(['submit_order']);

/**
 * ONE non-disclosing answer for every denial reason. A missing
 * purchase_order_id, an unknown order, and an order belonging to a
 * different buyer are indistinguishable to the caller — otherwise the
 * error itself becomes an oracle a stranger can use to enumerate which
 * order ids this supplier holds.
 */
/**
 * What the subject gate decided, plus the manifest the order was opened
 * against (§9.13). `''` means "no order in play, or none that a plugin
 * served" — the request is answered by the install's current manifest.
 */
type SubjectAuthorization =
  | { denied: ProviderIngressResult }
  | {
      denied: null;
      servingManifestCid: string;
      /**
       * The buyer this gate AUTHORIZED, for the capabilities Core answers
       * itself. Handed over rather than re-read downstream: a second read of
       * `query.fromDid` is a second chance to read the wrong thing, and the
       * one field a caller must never be answered under is a `buyer_did` it
       * chose. One value, produced where the authorization decision is made.
       */
      authorizedBuyerDid?: string;
    };

/**
 * The commerce capability a call refers to, in ONE spelling.
 *
 * THE GAP THIS CLOSES. The gates below used to match the wire name against
 * hand-listed spellings — the bare form and the UNDERSCORE NSID. The reference
 * manifests spell their capability ids with HYPHENS
 * (`com.dinakernel.commerce.submit-order`), which is also the natural key for a
 * supplier to publish a listing under, and a listing key is free-form. So a
 * conforming supplier could publish under the manifest's own id and fall
 * outside every set: an order created with no §9.9 admission (no idempotency
 * lookup, no capacity hold, no reservation), and an `order_status` or
 * `cancel_order` reaching the runner with NO subject authorization, which is
 * any peer reading or cancelling another buyer's order.
 *
 * BOTH IDENTITIES ARE CONSIDERED, and a match on EITHER gates the call. The
 * wire name is a label the supplier chose; the bound `pluginCapabilityId` is
 * what the owner consented to. Gating on either is the fail-closed direction —
 * over-gating costs a needless check, under-gating is the defect above.
 */
/** A capability that names no order: nothing to route by. */
const ALLOWED_NO_ORDER: SubjectAuthorization = { denied: null, servingManifestCid: '' };

const ORDER_SUBJECT_DENIED = {
  ok: false,
  code: 'order_subject_denied',
  error: 'provider ingress: no such order for this sender',
} as const;

/**
 * Compiled-Core subject authorization (§11.2), run BEFORE any runner
 * dispatch. The order-ref store is keyed by (buyerDid, purchaseOrderId),
 * so looking the order up under the AUTHENTICATED sender is itself the
 * ownership test: a hit proves the sender is the buyer, and every miss —
 * absent, unknown, or someone else's — collapses to one answer.
 *
 * Fails closed: with no order store wired, an order-scoped query is
 * denied rather than dispatched unchecked.
 */
function authorizeOrderSubject(
  query: ProviderIngressQuery,
  /** The manifest capability this listing is BOUND to; see `commerceNames`. */
  pluginCapabilityId: string,
): SubjectAuthorization {
  const needsOrder = isCommerceCapability(REQUIRES_EXISTING_ORDER, query.capability, pluginCapabilityId);
  const selfAuthorizing = isCommerceCapability(
    SELF_AUTHORIZING_BY_PAYLOAD,
    query.capability,
    pluginCapabilityId,
  );
  if (!needsOrder && !selfAuthorizing) return ALLOWED_NO_ORDER;

  const params = query.params;
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : null;
  const purchaseOrderId = record?.purchase_order_id;
  if (typeof purchaseOrderId !== 'string' || purchaseOrderId === '') {
    return { denied: ORDER_SUBJECT_DENIED };
  }

  if (selfAuthorizing) {
    // Authorization WITHOUT existence: whether a reference exists is the
    // handler's answer, not this gate's business.
    //
    // THE SENDER IS THE BUYER, BY TRANSPORT. `OrderReconcileRequest` carries
    // no `buyer_did` — the protocol type has none and the poller sends none —
    // so requiring one denied EVERY conforming reconcile, and the ingress test
    // that "covered" it invented the field. Worse than a bug: had a body field
    // existed it would have been the wrong thing to trust, because a
    // sender-signed inner body is not authority. `query.fromDid` is the
    // relay-authenticated identity, and it is what flows on as
    // `authorizedBuyerDid`.
    //
    // A payload that DOES name a buyer must still agree — a mismatch is a
    // caller asking about somebody else's order, whatever its reason.
    if (record?.buyer_did !== undefined && record.buyer_did !== query.fromDid) {
      return { denied: ORDER_SUBJECT_DENIED };
    }
    // §9.13 — a reconcile MAY have no reference at all (that absence is the
    // answer, `never_received`). When one exists, its serving manifest still
    // decides which contract answers, so read it opportunistically.
    const existing = getCommerceRuntime()?.orders?.load(query.fromDid, purchaseOrderId) ?? null;
    return {
      denied: null,
      servingManifestCid: existing?.ref.servingManifestCid ?? '',
      authorizedBuyerDid: query.fromDid,
    };
  }

  // Through the composition root, so ingress holds an aggregate store and
  // cannot reach the raw order-reference mutators.
  const orders = getCommerceRuntime()?.orders ?? null;
  if (orders === null) return { denied: ORDER_SUBJECT_DENIED };

  // Entitlement by possession: `load` is keyed on (buyerDid, purchaseOrderId),
  // so a hit proves the sender is the buyer and every miss — absent, unknown,
  // or someone else's — collapses to one non-disclosing answer.
  const order = orders.load(query.fromDid, purchaseOrderId);
  if (order === null) return { denied: ORDER_SUBJECT_DENIED };
  // §9.13 — the manifest this order was opened against. When it is not the
  // one the install runs now, the lifecycle request must be answered under
  // the OLD contract, not the current one.
  return { denied: null, servingManifestCid: order.ref.servingManifestCid };
}

/**
 * §12.7 / §16.2 — capabilities Core answers itself, with no dispatch.
 *
 * Distinct from `SELF_AUTHORIZING_BY_PAYLOAD`, which is about how the SENDER
 * is authorized. This set is about who KNOWS the answer. They happen to hold
 * the same member today, and keeping them separate is what stops the next
 * self-authorizing capability from silently inheriting "Core answers it".
 */
const ANSWERED_BY_CORE: ReadonlySet<string> = new Set(['order_reconcile']);

/**
 * §14.3 / §20.10 — capabilities that answer a PRICING question, and so spend
 * probing budget before a runner is asked (WS-2.11).
 *
 * A competitor does not need to breach anything to draw a supplier's price
 * curve: they need only ask, a hundred times, at varying quantities. Every
 * individual answer is legitimate and the harm is in the aggregate, which is
 * why the check lives here — where the count across requests is visible —
 * rather than inside any one answer.
 *
 * `availability` is in the set with `request_quote`. It reveals what a
 * supplier can source, which is half the curve, and leaving it out would make
 * it the cheaper way to ask the same question.
 */
const SPENDS_PROBING_BUDGET: ReadonlySet<string> = new Set(['request_quote', 'availability']);

/**
 * Answer a reconcile from Core's own records (§12.7).
 *
 * The buyer is the AUTHENTICATED sender, never a field in the payload — the
 * subject gate already required the payload's `buyer_did` to match, and this
 * passes the authenticated one so the two can never drift.
 *
 * A refusal is non-disclosing for the same reason the subject gate is: the
 * engine collapses unknown order, another buyer's order, and a malformed
 * request into one answer, and re-classifying them here would rebuild the
 * oracle it exists to prevent.
 */
function answerReconcileInCore(
  query: ProviderIngressQuery,
  authorizedBuyerDid: string,
): ProviderIngressResult {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    // Fail closed rather than dispatching. With no runtime there is no record
    // to answer from, and the one answer a runner might invent —
    // `never_received` — is the one that authorizes resubmission.
    return {
      ok: false,
      code: 'commerce_unavailable',
      error: 'provider ingress: this node cannot answer a reconcile (§12.7)',
    };
  }
  const answered = runtime.lifecycle.reconcile(query.params, authorizedBuyerDid);
  if ('error' in answered) {
    return { ok: false, code: 'order_subject_denied', error: answered.error };
  }
  return { ok: true, coreAnswerJson: JSON.stringify(answered) };
}

/**
 * Admit an inbound order in compiled Core (§9.9), before any runner sees it.
 *
 * Returns `null` when the order is reserved and the runner should now be asked
 * for the accept/reject DECISION; returns a typed result when Core has already
 * settled the matter and no dispatch should happen.
 *
 * The split is the point. Idempotency, quote capacity, and the reservation are
 * Core's authority: a replayed submission must return the SAME acknowledgement
 * rather than reach the plugin twice, and an order against spent capacity must
 * be refused by Core rather than accepted by a plugin that cannot see the
 * ledger. What the plugin decides is whether this supplier wants the business.
 */
function admitInboundOrder(
  query: ProviderIngressQuery,
  servingManifestCid: string,
  /** §16.4 — which install is serving, so an uninstall can scope its
   *  obligation count to the pack the owner is actually removing. */
  servingInstallId: string,
): ProviderIngressResult | null {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    // Fail closed. Dispatching to the runner with no admission would let a
    // plugin accept an order Core never reserved — the owner would be
    // committed to something with no durable record behind it.
    return {
      ok: false,
      code: 'commerce_unavailable',
      error: 'provider ingress: this node cannot admit orders (§9.9)',
    };
  }
  const outcome = runtime.admission.admitOrder(query.params, query.fromDid, {
    servingManifestCid,
    servingInstallId,
  });
  switch (outcome.kind) {
    case 'reserved':
      // The only path that reaches the runner.
      return null;
    case 'replay':
      // THE ACKNOWLEDGEMENT, not an error. The comment here already said "a
      // replayed submission gets its original acknowledgement" while the code
      // returned `ok:false` and threw the record away — so the buyer heard
      // `unavailable` and had to reconcile to learn an answer this node was
      // holding in its hand.
      //
      // A replay is a SUCCESS: §9.9's idempotency guarantee is that asking
      // twice yields the same signed answer, and returning it is what makes
      // that true rather than merely intended. No runner is asked, so a retry
      // storm still cannot become a dispatch storm.
      return { ok: true, coreAnswerJson: JSON.stringify(outcome.acknowledgement) };
    case 'rejected':
      // ALSO A SIGNED RECORD, and also a success at this layer. "Rejected" is
      // a commercial outcome the buyer is owed evidence of — the same reading
      // `settleInboundOrderDecision` already applies to a runner's rejection.
      // Discarding it here made the two paths disagree about what a refusal
      // is, and left the buyer unable to tell "declined" from "this node is
      // broken", which are opposite next steps.
      //
      // `outcome.detail` stays OPERATOR-ONLY (§14.2): the wire carries the
      // non-disclosing `reason_code` inside the acknowledgement, because
      // `quote_unknown` covers three situations and telling a stranger which
      // one is a disclosure. It is dropped here rather than sent, which is
      // where it was always meant to stop.
      return { ok: true, coreAnswerJson: JSON.stringify(outcome.acknowledgement) };
    case 'processing':
      return {
        ok: false,
        code: 'order_processing',
        error: `admission in progress; retry after ${String(outcome.retryAfterSeconds)}s`,
      };
    case 'conflict':
      return { ok: false, code: 'order_conflict', error: outcome.error };
  }
}

/**
 * Create the ingress task for a service query whose capability config
 * carries a plugin binding. The caller (Brain's ServiceHandler via the
 * injected submitter, or a Core route) has already run the generic
 * ingress checks.
 */
export function createProviderIngressTask(args: {
  workflow: WorkflowService;
  capabilityConfig: Pick<
    ServiceCapabilityConfig,
    'pluginInstallId' | 'pluginManifestCid' | 'pluginCapabilityId'
  >;
  query: ProviderIngressQuery;
  nowMs: number;
}): ProviderIngressResult {
  const { workflow, capabilityConfig, query, nowMs } = args;
  const boundCapabilityId = capabilityConfig.pluginCapabilityId ?? '';
  // §11.2 subject authorization runs BEFORE the binding checks so an
  // unauthorized sender cannot probe install state through the typed
  // unavailable codes either.
  const subject = authorizeOrderSubject(query, boundCapabilityId);
  if (subject.denied !== null) return subject.denied;

  // §12.7 / §16.2 (WS-4.6) — RECONCILE IS CORE'S, AND NO RUNNER IS ASKED.
  //
  // A reconcile asks "do you have my order?". Every input to that answer is
  // Core's own durable record: the order reference, the receipt store, and
  // this supplier's signature. A runner holds none of them, so a runner's
  // answer could only be a guess — and the specific guess that matters is
  // `never_received`, which §16.2 makes ILLEGAL against a held
  // supplier-signed acknowledgement and which alone authorizes the buyer to
  // resubmit. A plugin able to say it could make a supplier repudiate an
  // order it signed, and then be billed for the buyer's honest resubmission.
  //
  // It runs BEFORE the binding checks, deliberately. Reconcile is the
  // disaster-recovery path; a supplier whose plugin was updated, paused, or
  // uninstalled must still be able to answer for orders it holds. Gating it
  // behind an install would mean the lane goes dark exactly when it is
  // needed, and `lifecycle_continuity_unavailable` would be the answer to a
  // question Core could have answered from its own records.
  // §20.10 — spend probing budget BEFORE the runner is asked. A refusal that
  // reached the plugin would already have cost the supplier the answer.
  if (isCommerceCapability(SPENDS_PROBING_BUDGET, query.capability, boundCapabilityId)) {
    const refused = refuseProbing(query);
    if (refused !== null) return refused;
  }

  if (isCommerceCapability(ANSWERED_BY_CORE, query.capability, boundCapabilityId)) {
    // The buyer comes from the GATE, not from a second read of the query.
    // `authorizedBuyerDid` is set only on the self-authorizing branch, so a
    // capability added to this set without a matching gate branch answers
    // nobody rather than answering under an unauthorized DID.
    if (subject.authorizedBuyerDid === undefined) return ORDER_SUBJECT_DENIED;
    return answerReconcileInCore(query, subject.authorizedBuyerDid);
  }

  const installId = capabilityConfig.pluginInstallId ?? '';
  const boundCid = capabilityConfig.pluginManifestCid ?? '';
  const pluginCapabilityId = boundCapabilityId;
  if (installId === '' || boundCid === '' || pluginCapabilityId === '') {
    return {
      ok: false,
      code: 'no_plugin_binding',
      error: 'provider ingress: capability carries no complete plugin binding',
    };
  }

  const installs = getPluginInstallRepository();
  const install = installs?.getById(installId) ?? null;
  if (install === null || install.status !== 'active') {
    return {
      ok: false,
      code: 'install_unavailable',
      error: 'provider ingress: backing install is paused, revoked, or missing (§11.2a)',
    };
  }
  if (install.currentCid !== boundCid) {
    // The listing pinned a manifest this install no longer runs. The
    // §9.13 rebind flow updates the BINDING; until it does, answering
    // from a stale pin would violate the exact-manifest contract.
    return {
      ok: false,
      code: 'binding_stale',
      error: 'provider ingress: listing binding pins a manifest CID the install no longer runs',
    };
  }
  // §9.13 — routing is pinned by the ORDER, not the listing. An order opened
  // against an earlier manifest keeps being answered under THAT contract until
  // it is terminal, so when the two differ the current manifest is not
  // consulted at all: its version of this capability may take different
  // params, return a different shape, or be gone.
  const priorCid = subject.servingManifestCid;
  // Named once: the two uses below must never disagree about whether this
  // request is a prior-manifest one.
  const needsPriorManifest = priorCid !== '' && priorCid !== install.currentCid;
  const continuity = needsPriorManifest
    ? (getDrainAuthorizationRepository()
        ?.listLive(installId, priorCid, pluginCapabilityId, nowMs)
        // Only `lifecycle_continuity` admits a NEW request; a `drain` entry
        // covers work already claimed when the rebind happened.
        .find((entry) => entry.kind === 'lifecycle_continuity') ?? null)
    : null;
  if (needsPriorManifest && continuity === null) {
    // The order predates a plugin update and no continuity lane was retained
    // for it. Refusing is the only honest answer: answering under the current
    // manifest would parse the buyer's request against a contract their order
    // was never opened under.
    return {
      ok: false,
      code: 'lifecycle_continuity_unavailable',
      error:
        'provider ingress: this order was opened under a manifest this install no longer retains (§9.13)',
    };
  }

  // §9.9 — Core admits the order BEFORE the runner is asked. This is the seam
  // that gives §9.13 its meaning in production: the reservation records which
  // manifest was serving, so a later lifecycle request can be routed back to
  // this contract even after the install has moved on.
  if (isCommerceCapability(CREATES_ORDER, query.capability, boundCapabilityId)) {
    const admitted = admitInboundOrder(query, install.currentCid, install.installId);
    if (admitted !== null) return admitted;
  }

  const capability = install.manifest.capabilities.find((c) => c.id === pluginCapabilityId);
  if (
    continuity === null &&
    (capability === undefined || !(capability.kinds ?? []).includes('provider'))
  ) {
    return {
      ok: false,
      code: 'capability_not_provider',
      error: 'provider ingress: bound capability is not consented as a provider',
    };
  }

  const serviceIngress: PluginTaskEnvelope['service_ingress'] = {
    from_did: query.fromDid,
    query_id: query.queryId,
    capability: query.capability,
    service_rkey: query.serviceRkey,
    ...(query.ttlSeconds !== undefined ? { ttl_seconds: query.ttlSeconds } : {}),
    ...(query.serviceName !== undefined ? { service_name: query.serviceName } : {}),
    ...(query.schemaSnapshot !== undefined ? { schema_snapshot: query.schemaSnapshot } : {}),
  };

  // Dedup identity is scoped by the AUTHENTICATED sender and the install,
  // never by the peer-supplied `query_id` alone. `query_id` is a body
  // field the requester chooses: two peers (or one peer probing) can pick
  // the same value, and an unscoped key would let the second query
  // collide with the first — silently dropped, answered to the wrong
  // `from_did`, or pre-registered by a hostile peer to deny service to a
  // competitor on the same supplier node. Every other layer already
  // scopes this value per sender (setProviderWindow(from, query_id, …),
  // findServiceQueryTask(query_id, from, …)); this matches.
  //
  // AND BY CAPABILITY, which was missing and broke a whole lane. Commerce
  // uses the purchase order id as the correlation id on EVERY lane, and
  // deliberately: two dispatches about one order must not look like two
  // different questions. But "will you take this order" and "where has it
  // got to" ARE two different questions, and with the capability out of the
  // key the second collided with the first — so a buyer's very first
  // `order_status` query after submitting was refused `ingress_key_conflict`,
  // permanently, and the status lane could never run at all.
  //
  // AND BY WHAT WAS ASKED. An idempotency key that ignores the request body
  // says "you already asked this" to a question nobody asked before. Status
  // is the case that exposed it: a buyer polls the same order repeatedly with
  // a rising `since_sequence`, and without the params in the key the second
  // poll deduped onto the first COMPLETED task — so it was answered once and
  // then silently never again.
  //
  // A resend still dedups, which is the property that matters: §12.7's one
  // authorized resubmission carries the identical order, so its params hash
  // identically and the second submission collapses onto the first exactly as
  // before.
  //
  // Adding a dimension only ever makes a dedup key MORE specific: a genuine
  // repeat of one question still dedups, and only distinct questions stop
  // colliding. There is no direction in which this weakens the guard.
  const ingressKey = bytesToHex(
    sha256(
      new TextEncoder().encode(
        [
          query.fromDid,
          query.queryId,
          installId,
          query.capability,
          // Stable ordering, so two identical requests hash identically
          // whatever order their fields arrived in.
          canonicalJson(query.params),
        ].join('\n'),
      ),
    ),
  ).slice(0, 32);
  const scopedId = `svcq:${ingressKey}`;

  let envelope: PluginTaskEnvelope;
  try {
    // Ingress tasks carry NO owner context: the runner answers from its own
    // data plane; vault projection never rides a peer query.
    envelope =
      continuity === null
        ? buildPluginEnvelope({
            install,
            capabilityId: pluginCapabilityId,
            params: query.params,
            context: [],
            executionId: scopedId,
            idempotencyKey: scopedId,
            serviceIngress,
          })
        : buildContinuityEnvelope({
            install,
            authorization: continuity,
            params: query.params,
            context: [],
            executionId: scopedId,
            idempotencyKey: scopedId,
            serviceIngress,
          });
  } catch (error) {
    return {
      ok: false,
      code: 'envelope_rejected',
      error: `provider ingress: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const ttlSeconds = query.ttlSeconds ?? 60;
  try {
    const task = workflow.create({
      id: scopedId,
      kind: 'delegation',
      description: `service query ${query.capability} via plugin install ${installId}`,
      payload: JSON.stringify(envelope),
      expiresAtSec: Math.floor(nowMs / 1000) + ttlSeconds,
      correlationId: query.queryId,
      origin: 'd2d',
      idempotencyKey: envelope.idempotency_key,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(install.installId),
    });
    return { ok: true, taskId: task.id };
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowConflictError') {
      // A conflict on a sender-scoped key is the SAME peer replaying the
      // same query — the dedup working; the original task answers via the
      // bridge. Re-verify the existing task's correlation anyway: if the
      // id scheme ever loosens, a cross-peer collision must surface as a
      // typed conflict rather than a silent drop.
      const existing = workflow.store().getById(scopedId);
      const existingIngress =
        existing === null ? undefined : parsePluginEnvelope(existing.payload)?.service_ingress;
      if (
        existingIngress === undefined ||
        existingIngress.from_did !== query.fromDid ||
        existingIngress.query_id !== query.queryId ||
        existingIngress.capability !== query.capability
      ) {
        return {
          ok: false,
          code: 'ingress_key_conflict',
          error:
            'provider ingress: dedup key collided with a different query — refusing to drop it',
        };
      }
      return { ok: true, taskId: scopedId };
    }
    throw error;
  }
}

/**
 * Build the submitter Brain's `ServiceHandler` is given at composition.
 *
 * `nowMs` is a parameter for the same reason it is everywhere else in this
 * subsystem: dedup keys and task deadlines must be reproducible in a test
 * without waiting for a clock.
 */
export function createProviderIngressSubmitter(deps: {
  workflow: WorkflowService;
  nowMs?: () => number;
}): ProviderIngressSubmitter {
  const now = deps.nowMs ?? (() => Date.now());
  return ({ capabilityConfig, query }) =>
    createProviderIngressTask({
      workflow: deps.workflow,
      capabilityConfig,
      query,
      nowMs: now(),
    });
}

/**
 * §14.3 / §20.10 — decide whether to answer a pricing question at all.
 *
 * Returns a refusal, or null to proceed. The refusal CODE is the same for
 * every reason (`probing_refused`), because a prober who can tell "budget
 * spent" from "we don't quote you" learns the catalog by watching which
 * requests get a different shape of no. The operator's reason stays in the
 * message, which §14.2 already reserves for logs.
 *
 * FAIL CLOSED when the ledger is unwired. An unwired probing defence that
 * silently permits is exactly the state this item exists to leave behind, and
 * it would be invisible: every request would succeed, which is what success
 * looks like.
 */
function refuseProbing(query: ProviderIngressQuery): ProviderIngressResult | null {
  const ledger = getQuoteAttemptLedger();
  if (ledger === null) {
    return {
      ok: false,
      code: 'probing_refused',
      error: 'provider ingress: quote-attempt ledger not wired (§20.10)',
    };
  }
  const contact = getContact(query.fromDid);
  // Absent contact reads as `unknown`, which is the small budget rather than
  // none: §20.10's concern is the curve, and a stranger must still be able to
  // become a customer by asking once.
  const standing: CounterpartyStanding =
    contact === null
      ? 'unknown'
      : contact.trustLevel === 'blocked'
        ? 'blocked'
        : contact.trustLevel === 'unknown'
          ? 'unknown'
          : 'known';

  // §18.3/§19 — the OWNER'S LISTING POLICY, before any budget is spent. A
  // paused listing that still answered would be a supplier ignoring their
  // customers rather than one who is closed, and spending a peer's probing
  // budget on a question this node was never going to answer would penalise
  // them for the owner's decision.
  const runtime = getCommerceRuntime();
  const configured = runtime === null ? null : runtime.settings.readSupplier();
  // AN UNREADABLE POLICY IS NOT AN ABSENT ONE, and this gate used to treat
  // them alike. `settings_store.ts` states the invariant — "a row that no
  // longer validates is REFUSED rather than partially believed, and the caller
  // fails closed" — and the order path obeys it; this one fell through to
  // `admitQuoteRequest` and answered.
  //
  // Widening the validator made that worse rather than exposing it: a stored
  // `{listingState:'withdrawn', …}` row used to validate and have its
  // withdrawal honoured, and now an unrelated fault in the SAME row (an
  // unknown enum, an `http://` connector endpoint, a `review` acceptance
  // policy) invalidates the record and the withdrawal is silently ignored.
  // The owner closed their shop and the node kept quoting.
  //
  // ABSENT stays permissive, and the distinction is the whole point: a node
  // that never configured a supplier has no listing to close, while a node
  // whose listing policy cannot be read has one it can no longer honour.
  if (configured !== null && !configured.ok && !configured.absent) {
    return {
      ok: false,
      code: 'probing_refused',
      error:
        'provider ingress: this supplier’s listing policy cannot be read, so quoting is closed until it is corrected (§18.3)',
    };
  }
  if (configured !== null && configured.ok) {
    const admissible = quoteAdmissibility(
      configured.settings,
      standing === 'known' ? 'known' : 'unknown',
    );
    if (!admissible.admits) {
      return {
        ok: false,
        code: 'probing_refused',
        // The SAME code as a budget refusal. §14.3: one refusal for every
        // reason, or a prober learns the catalog by reading which "no" they
        // got. The operator-facing text carries the real reason.
        error: `provider ingress: ${admissible.reason} (§18.3)`,
      };
    }
  }

  const nowMs = Date.now();
  const verdict = admitQuoteRequest({
    fromDid: query.fromDid,
    standing,
    recentAttempts: ledger.recent(query.fromDid, nowMs),
    nowMs,
  });
  if (!verdict.quote) {
    return {
      ok: false,
      code: 'probing_refused',
      // The peer sees the CODE; this names the reason for an operator.
      error: `provider ingress: ${verdict.reason} (§20.10)`,
    };
  }
  // Only an ADMITTED request spends budget. Charging a refusal would mean a
  // peer past their limit could never recover — each refusal would extend the
  // window that caused it.
  ledger.record(query.fromDid, nowMs);
  return null;
}

/**
 * A stable string for a request body, for the dedup key only.
 *
 * Key-sorted at every level, because `{a,b}` and `{b,a}` are the same request
 * and must not produce two tasks. NOT the commerce canonicaliser: this hashes
 * arbitrary plugin params, nothing is signed over it, and coupling the plugin
 * substrate to a commerce module would invert the dependency.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
