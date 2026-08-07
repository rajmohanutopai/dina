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

import { getCommerceRuntime } from '../commerce/runtime';
import { parsePluginEnvelope } from '../workflow/plugin_envelope';


import { buildPluginEnvelope } from './dispatch';
import { getPluginInstallRepository } from './registry';

import type { PluginTaskEnvelope } from '../workflow/plugin_envelope';
import type { WorkflowService } from '../workflow/service';
import type { ServiceCapabilityConfig } from '@dina/protocol';

export type ProviderIngressResult =
  | { ok: true; taskId: string }
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
        | 'order_subject_denied';
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
const SELF_AUTHORIZING_BY_PAYLOAD: ReadonlySet<string> = new Set([
  'order_reconcile',
  'com.dinakernel.commerce.order_reconcile',
]);

/**
 * ONE non-disclosing answer for every denial reason. A missing
 * purchase_order_id, an unknown order, and an order belonging to a
 * different buyer are indistinguishable to the caller — otherwise the
 * error itself becomes an oracle a stranger can use to enumerate which
 * order ids this supplier holds.
 */
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
function authorizeOrderSubject(query: ProviderIngressQuery): ProviderIngressResult | null {
  const needsOrder = REQUIRES_EXISTING_ORDER.has(query.capability);
  const selfAuthorizing = SELF_AUTHORIZING_BY_PAYLOAD.has(query.capability);
  if (!needsOrder && !selfAuthorizing) return null;

  const params = query.params;
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : null;
  const purchaseOrderId = record?.purchase_order_id;
  if (typeof purchaseOrderId !== 'string' || purchaseOrderId === '') {
    return ORDER_SUBJECT_DENIED;
  }

  if (selfAuthorizing) {
    // Authorization WITHOUT existence. The payload must name the
    // authenticated sender as the buyer; whether a reference exists is the
    // handler's answer, not this gate's business.
    return record?.buyer_did === query.fromDid ? null : ORDER_SUBJECT_DENIED;
  }

  // Through the composition root, so ingress holds an aggregate store and
  // cannot reach the raw order-reference mutators.
  const orders = getCommerceRuntime()?.orders ?? null;
  if (orders === null) return ORDER_SUBJECT_DENIED;

  // Entitlement by possession: `load` is keyed on (buyerDid, purchaseOrderId),
  // so a hit proves the sender is the buyer and every miss — absent, unknown,
  // or someone else's — collapses to one non-disclosing answer.
  const order = orders.load(query.fromDid, purchaseOrderId);
  if (order === null) return ORDER_SUBJECT_DENIED;
  return null;
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
  // §11.2 subject authorization runs BEFORE the binding checks so an
  // unauthorized sender cannot probe install state through the typed
  // unavailable codes either.
  const subjectDenial = authorizeOrderSubject(query);
  if (subjectDenial !== null) return subjectDenial;
  const installId = capabilityConfig.pluginInstallId ?? '';
  const boundCid = capabilityConfig.pluginManifestCid ?? '';
  const pluginCapabilityId = capabilityConfig.pluginCapabilityId ?? '';
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
  const capability = install.manifest.capabilities.find((c) => c.id === pluginCapabilityId);
  if (capability === undefined || !(capability.kinds ?? []).includes('provider')) {
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
  const ingressKey = bytesToHex(
    sha256(new TextEncoder().encode(`${query.fromDid}\n${query.queryId}\n${installId}`)),
  ).slice(0, 32);
  const scopedId = `svcq:${ingressKey}`;

  let envelope: PluginTaskEnvelope;
  try {
    envelope = buildPluginEnvelope({
      install,
      capabilityId: pluginCapabilityId,
      params: query.params,
      // Ingress tasks carry NO owner context: the runner answers from
      // its own data plane; vault projection never rides a peer query.
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
