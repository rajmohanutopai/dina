/**
 * Commerce owner surface (§16.2 WS-4.3, §13.2-§13.6 WS-5/WS-7).
 *
 *   GET  /v1/commerce/reconciliation → the post-restore census
 *   GET  /v1/commerce/orders/unsettled  → what the buyer is still waiting on
 *   POST /v1/commerce/orders/submit     → send an order the owner approved
 *   GET/PUT /v1/commerce/settings/{buyer,supplier} → §18.2 / §18.3 policy
 *   GET  /v1/commerce/inbox            → §18.6 what needs the supplier
 *   POST /v1/commerce/install/plan     → §18.1 turn a choice into installs
 *   POST /v1/commerce/procurement/plan   → who to ask for a quote, and who not
 *   POST /v1/commerce/procurement/choose → filter, rank, and explain the winner
 *   POST /v1/commerce/catalog/import     → read a CSV into catalog items
 *   POST /v1/commerce/catalog/load       → read a catalog through a connector
 *   POST /v1/commerce/catalog/publish    → build the next snapshot + pointer
 *   POST /v1/commerce/catalog/withdraw   → extend the chain with a withdrawal
 *   GET  /v1/commerce/catalog/published  → what this node has published
 *   POST /v1/commerce/catalog/adopt      → adopt the live head after divergence
 *   GET  /v1/commerce/credentials        → §18.3 connector credential status
 *   PUT  /v1/commerce/credentials/:resource    → rotate the material
 *   DELETE /v1/commerce/credentials/:resource  → forget it
 *   POST /v1/commerce/connector/change   → §6.5 edit, or re-consent event?
 *   GET  /v1/commerce/idempotency        → §15.5 what each connector proved
 *   PUT  /v1/commerce/idempotency/:r/:op → record a probe
 *   POST /v1/commerce/orders/effect      → cross the external boundary, once
 *   POST /v1/commerce/orders/fulfilment  → reconcile one external report
 *   POST /v1/commerce/orders/fulfilment/sweep → reconcile every open order
 *   POST /v1/commerce/relationships/resolve → §10.7 plural AppView answers
 *   POST /v1/commerce/capabilities/promote  → §11.3 promotion gate
 *   POST /v1/commerce/capabilities/resolve  → an id through its aliases
 *
 * ONE ROUTE, AND A READ. The census reports which orders a restore left
 * frozen; it cannot clear them. The ceremony that clears one checks the
 * BUYER's held order proposal against the digest this supplier signed, and a
 * re-adopted order has no lines, no quote context and no external state to
 * check against — so a "reconcile all" button here would have to invent the
 * terms, which is the thing the post-restore quote seam exists to forbid.
 *
 * The census is what closes the real gap: without it the owner learns about a
 * frozen order when a buyer complains.
 *
 * OWNER-PRIVATE. This is a list of counterparties and the orders this node
 * cannot answer for — a map of exactly where the supplier is vulnerable. Its
 * authz prefix denies every signed caller, matching /v1/run and /v1/watch.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
// Base64 via @scure/base, the same pure-JS decode D2D uses — `Buffer` is a
// Node global that does not exist on Hermes, so the previous
// `Buffer.from(page, 'base64')` threw ReferenceError on the PHONE and the
// catch mislabeled every photo "not valid base64". First device run found it.
import { base64 } from '@scure/base';

import {
  commerceRecordDigest,
  computeProjectionDigest,
  conversationSnapshotDigest,
  extractionCommitmentDigest,
  verifyOrderAgainstQuote,
  validateApprovalSourceBinding,
  validateCatalogItem,
  validateCatalogPointer,
  validateDeliveryProjection,
  validateExtractionCommitment,
  validatePurchaseOrderProposal,
  type CatalogExtractionBinding,
  type CatalogItem,
  type CatalogPointer,
  type CommerceOrderStatus,
  type DeliveryProjection,
  type ExtractionCommitment,
  type OrderState,
  type PurchaseOrderProposal,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { resolveActingInstall } from '../../commerce/acting_install';
import {
  buildBuyerApprovalPayload,
  BUYER_ORDER_AUTHORITY_DOMAIN,
  SUPPLIER_ORDER_AUTHORITY_DOMAIN,
  type ApprovingPrincipal,
  type BuyerApprovalContext,
} from '../../commerce/approval_payload';
import { buildSupplierApprovalPayload } from '../../commerce/approval_payload';
import { enumerateV1Records } from '../../commerce/attribution_boundary';
import { getBuyerOrderSender, submitApprovedOrder } from '../../commerce/buyer_executor';
import { requestQuote } from '../../commerce/buyer_quote_request';
import { describeOrderForOwner } from '../../commerce/buyer_reconciliation';
import { getCommerceServiceQueryDispatch } from '../../commerce/buyer_sender';
import {
  makeServiceQueryStatusAsk,
  type BuyerStatusRepository,
} from '../../commerce/buyer_status';
import {
  applyPromotion,
  evaluatePromotion,
  resolveCapabilityId,
  type OfficialCapability,
} from '../../commerce/capability_promotion';
import {
  type DraftIngressDeps,
  assembleFromRows,
  createCatalogDraft,
} from '../../commerce/catalog_draft_ingest';
import { publishHeldDraft } from '../../commerce/catalog_draft_publisher';
import {
  CatalogDraftService,
  unconfirmedFields,
  type DraftRefusalOutcome,
} from '../../commerce/catalog_draft_service';
import {
  type CatalogRowSource,
  catalogRowsFromRecords,
  importCatalogCsv,
  parseCatalogCsv,
} from '../../commerce/catalog_import';
import { getCatalogFeedTransport, ingestCatalog } from '../../commerce/catalog_ingest';
import { describeCatalogForOwner } from '../../commerce/catalog_pointer_store';
import { buildCatalogSnapshot, buildCatalogWithdrawal } from '../../commerce/catalog_publisher';
import {
  CATALOG_POINTER_NSID,
  catalogPointerRkey,
  getCatalogRecordReader,
  publishCatalogRecords,
} from '../../commerce/catalog_record_writer';
import { effectiveFanoutCeiling } from '../../commerce/commerce_settings';
import { buildComparisonCard } from '../../commerce/comparison_card';
import {
  classifyConnectorChange,
  loadCatalogThroughConnector,
  type ConnectorKind,
} from '../../commerce/connectors';
import { performOrderEffect } from '../../commerce/effect_executor';
import {
  reconcileFulfilment,
  sweepFulfilment,
  type ExternalFulfilment,
} from '../../commerce/fulfilment_reconciler';
import {
  DEFAULT_RETENTION_REQUIREMENT,
  evaluateIdempotencyEvidence,
  resubmissionPolicy,
  type IdempotencyProbe,
  type RetentionRequirement,
} from '../../commerce/idempotency_evidence';
import {
  ingestCommerceImage,
  imageReencoderInstalled,
  MAX_AGGREGATE_IMAGE_BYTES,
  MAX_IMAGE_PAGES,
} from '../../commerce/image_artifacts';
import {
  extractRowsThroughGate,
  IMAGE_EGRESS_AUTHORIZATION_TTL_MS,
  installedEgressProvider,
  newEgressAuthorizationId,
} from '../../commerce/image_egress';
import { planCommerceInstall, roleIsInstalled } from '../../commerce/install_plan';
import { getInviteService } from '../../commerce/invite_compose';
import { recordCommerceEvent } from '../../commerce/observability';
import {
  newApprovalId,
  ORDER_APPROVAL_TTL_MS,
} from '../../commerce/order_approvals';
import {
  TRADE_INVITE_CAPABILITIES,
  settleInboundOrderDecision,
} from '../../commerce/order_decision';
import {
  classifyDispatchAnswer,
  dispatchUnderRetainedApproval,
  readAnswerableApproval,
  resolveAuthority,
  unanswerableStatus,
} from '../../commerce/order_dispatch';
import { OrderDraftService } from '../../commerce/order_draft_service';
import { deriveOrderDraftState, type OrderDraft } from '../../commerce/order_draft_store';
import {
  clearStaffPresence,
  OWNER_PRESENCE_TTL_MS,
  ownerPresenceCanBeEstablished,
  ownerPresentNow,
  proveOwnerPresence,
  proveStaffPresence,
  staffPresenceCanBeEstablished,
  staffPresentNow,
} from '../../commerce/owner_presence';
import { checkPriceDivergence } from '../../commerce/price_divergence';
import { chooseOffer, planProcurement } from '../../commerce/procurement_service';
import { describeQuoteForOwner } from '../../commerce/quote_read_model';
import { askReconcilePolls } from '../../commerce/reconcile_poller';
import { makeServiceQueryReconcileSend } from '../../commerce/reconcile_sweeper';
import { buildReconciliationCensus } from '../../commerce/reconciliation_census';
import { beginReferenceInstall } from '../../commerce/reference_install';
import { BUYER_REFERENCE_MANIFEST } from '../../commerce/reference_manifests';
import { rehydrateQuoteRequest } from '../../commerce/rehydrate';
import {
  describeDisagreement,
  mayAuthorizeSubstitution,
  mayInheritStanding,
  mayShowAsRelated,
  resolveRelationships,
  type AppViewAnswer,
} from '../../commerce/relationship_resolver';
import { RevshareService } from '../../commerce/revshare_service';
import { commerceAvailability, getCommerceRuntime } from '../../commerce/runtime';
import { resolveServiceBinding } from '../../commerce/service_binding';
import { applySkuMint } from '../../commerce/sku_mint';
import { escalateStaffOperation } from '../../commerce/staff_escalation';
import {
  checkStaffOperation,
  STAFF_INSTALL_SCOPES,
  STAFF_SCOPES,
  validateStaffGrantInput,
  type StaffInstallScope,
  type StaffScope,
} from '../../commerce/staff_grants';
import { setStaffPin } from '../../commerce/staff_pins';
import { buildSupplierInbox } from '../../commerce/supplier_inbox';
import { collectTallyVouchers, renderTallyXml } from '../../commerce/tally_export';
import { compareTender, createTender } from '../../commerce/tender';
import { buildTradeInbox } from '../../commerce/trade_inbox';
import { rehydrateTradeDocument } from '../../commerce/trade_ledger';
import { TradeLedgerService } from '../../commerce/trade_ledger_service';
import { tradeRelationshipReaders, tradeOrientations } from '../../commerce/trade_readers';
import { revokeDeviceByDidDurable } from '../../devices/registry';
import { getNodeDID } from '../../pairing/ceremony';
import { confirmConsent, uninstall } from '../../plugins/install_service';
import { getPluginInstallRepository } from '../../plugins/registry';

import { getD2DSender } from './d2d_msg';
import { makeOwnerGuard, type OwnerGuard } from './owner_guard';

import type {
  CatalogDraftRepository,
  ProvenanceClass,
} from '../../commerce/catalog_draft_store';
import type { CoreRouter, CoreResponse, CoreRequest } from '../router';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * The slot a page-URL template must carry. Named rather than inlined so the
 * refusal message and the substitution cannot disagree about it.
 */
const PAGE_INDEX_TOKEN = '{index}';

/**
 * The point in the chain this node will extend, and the swap value the
 * publication must present (§10.2).
 *
 * THE NODE'S OWN RECORD WINS. Before the pointer store existed, both the
 * predecessor and the compare-and-swap came out of the request body, which made
 * the CALLER the authority on this node's publication history — a fact the node
 * is the only one that actually knows. A caller that got it wrong lost a race
 * it had no way to understand, and a caller that omitted it published a GENESIS
 * over a live chain.
 *
 * A supplied predecessor that names a DIFFERENT point is refused rather than
 * ignored. Ignoring it would let a client that believes the chain is at
 * sequence 4 watch this node publish sequence 9 and report success; the client
 * would then show its user a catalog nobody published. The refusal is the
 * signal to re-read the head.
 *
 * A node with NO record has published nothing through this route, so the body's
 * predecessor is taken as given — that is the operator who publishes by hand,
 * or a node whose repo writer is not installed. It cannot lose a race because
 * it never held a head to lose.
 */
function resolvePredecessor(
  catalogId: string,
  supplied: CatalogPointer | null,
):
  | {
      ok: true;
      previous: { pointer: CatalogPointer; snapshotDigest: string } | null;
      expectedPointerCid: string | null;
    }
  | { ok: false; response: CoreResponse } {
  const pointers = getCommerceRuntime()?.catalogPointers ?? null;
  const stored = pointers?.get(catalogId) ?? null;
  if (stored === null && pointers !== null && pointers.has(catalogId)) {
    // A ROW IS THERE AND THIS BUILD CANNOT READ IT. Treating that as "nothing
    // published" is the one reading that does real damage: it authorizes a
    // GENESIS at sequence 1 over a chain buyers are following. The honest
    // answer is to stop and let an operator re-read the repo and adopt the
    // live head (`POST /v1/commerce/catalog/adopt`).
    return {
      ok: false,
      response: {
        status: 409,
        body: {
          error: 'published_head_unreadable',
          detail:
            'this node has a record of publishing this catalog but cannot read it; re-read the live pointer from the repo and adopt it before publishing again',
        },
      },
    };
  }
  if (stored === null) {
    return {
      ok: true,
      previous:
        supplied === null
          ? null
          : { pointer: supplied, snapshotDigest: supplied.snapshot_digest ?? '' },
      expectedPointerCid: null,
    };
  }
  if (
    supplied !== null &&
    (supplied.snapshot_sequence !== stored.pointer.snapshot_sequence ||
      (supplied.snapshot_digest ?? '') !== stored.snapshotDigest)
  ) {
    return {
      ok: false,
      response: {
        status: 409,
        body: {
          error: 'stale_predecessor',
          detail:
            'this node has already published past the pointer you supplied; re-read the head and try again',
          published_sequence: stored.pointer.snapshot_sequence,
        },
      },
    };
  }
  return {
    ok: true,
    previous: { pointer: stored.pointer, snapshotDigest: stored.snapshotDigest },
    expectedPointerCid: stored.pointerCid,
  };
}

/**
 * §16.2 — may this node write to the repo RIGHT NOW?
 *
 * Checked again immediately before the pointer CAS, not only at the start of
 * the request. A snapshot write is an awaited network round trip, and a node
 * superseded during it would still advance the head afterwards — the fence
 * would have been consulted at the one moment it could not yet have failed.
 *
 * The build half stays unfenced. Constructing records is not publishing, and a
 * superseded operator still needs to see what their catalog WOULD say.
 */
function publicationFence(): CoreResponse | null {
  const availability = commerceAvailability();
  return availability.available
    ? null
    : {
        status: 503,
        body: {
          error: 'commerce_unavailable',
          reason: availability.reason,
          detail: availability.detail,
        },
      };
}

/**
 * Is a person here RIGHT NOW?
 *
 * Read by the draft service's `userPresent`. Both questions this file asks
 * about presence come from `owner_presence.ts` so they cannot drift, but they
 * are DIFFERENT questions and were once one function returning a constant:
 * this one is an instant, and `ownerPresenceCanBeEstablished` below is a
 * capability. Conflating them meant the retired item-list route stayed open
 * whenever nobody happened to be at the keyboard.
 */
function ownerPresentNowForRoutes(): boolean {
  return ownerPresentNow(Date.now());
}

/**
 * Remember what this node just published.
 *
 * Written only after the repo accepted the pointer, because the row's job is to
 * carry the CAS the NEXT publication needs and a CAS for a write that did not
 * land is worse than none.
 */
function recordPublication(catalogId: string, pointer: CatalogPointer, pointerCid: string): void {
  const runtime = getCommerceRuntime();
  if (runtime === null) return;
  // The chain's own timestamp, not the wall clock: this is the moment buyers
  // see beside the record, and an owner card that disagreed with it would be
  // reporting a second, private publication history.
  const claimed = Date.parse(pointer.published_at);
  runtime.catalogPointers.put({
    catalogId,
    pointer,
    pointerCid,
    snapshotDigest: pointer.snapshot_digest ?? '',
    withdrawn: pointer.withdrawn === true,
    publishedAtMs: Number.isFinite(claimed) ? claimed : Date.now(),
  });
}

/**
 * This node's own DID, or null when it does not have one yet.
 *
 * The empty string is rejected as well as null. `setNodeDID` refuses anything
 * that does not start with `did:` today, so `''` cannot currently be reached —
 * but a route that publishes the value under a supplier's name should not
 * depend on a setter three modules away keeping that promise, and the same
 * empty-string hole was live once already on the procurement fan-out, where a
 * present-but-empty buyer DID silently disabled self-exclusion.
 */
function ownerDid(): string | null {
  const did = getNodeDID();
  return did === null || did === '' ? null : did;
}

/**
 * Read an optional listing rkey off a request body (§10.5, DR-5).
 *
 * Returns `null` for "not stated" and `false` for "stated and unusable" — the
 * two are different answers and collapsing them would let a malformed value
 * read as an omission. The character set matches what `parseAtUri` accepts
 * inside a segment, because that is the parser on the other end of this value.
 */
const MAX_LISTING_RKEY_LENGTH = 512;
function readListingRkey(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') return false;
  if (value.length > MAX_LISTING_RKEY_LENGTH) return false;
  return /[?#/%\s]/.test(value) ? false : value;
}

// `unanswerableStatus`, `resolveAuthority` and `readAnswerableApproval`
// moved to `commerce/order_dispatch.ts` (PC-7) so the submit route, the
// §5.1 orchestrator and the dispatch-intent sweeper share one path.

/**
 * Complete an owner-typed delivery projection: when the digest is absent,
 * Core — which builds the request — seals what it built, so a surface
 * carries no crypto. A PRESENT digest is never recomputed: a caller that
 * claims one is checked against it downstream, not silently corrected.
 */
function completeProjection(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.projection_digest === 'string' && value.projection_digest !== '') return value;
  const { projection_digest: _absent, ...fields } = value;
  return {
    ...fields,
    projection_digest: computeProjectionDigest(fields as never, (data) => sha256(data)),
  };
}

/**
 * A caller a staff-operable commerce route may act for: the owner, or a
 * staff device whose grant the route will check (§6.2). NEVER widens
 * beyond those two — every other caller gets the owner guard's own
 * refusal, so the refusal shape stays identical across the surface.
 */
type CommerceRouteCaller = { kind: 'owner' } | { kind: 'staff'; deviceDid: string };

function staffOrOwnerCaller(
  req: CoreRequest,
  ownerGuard: OwnerGuard,
): CommerceRouteCaller | CoreResponse {
  const denied = ownerGuard(req);
  if (denied === null) return { kind: 'owner' };
  if (req.callerType === 'staff' && typeof req.callerDID === 'string' && req.callerDID !== '') {
    return { kind: 'staff', deviceDid: req.callerDID };
  }
  return denied;
}

export function registerCommerceRoutes(router: CoreRouter, ownerCapability?: string): void {
  // Same boot-minted-capability guard as /v1/run and /v1/watch, and the same
  // fail-closed posture: a router registered without a capability rejects
  // every owner call rather than falling back to something weaker.
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may read the reconciliation census',
  );

  registerProcurementRoutes(router, ownerCapability);
  registerBuyerOrderRoutes(router, ownerCapability);
  registerSettingsRoutes(router, ownerCapability);
  registerCatalogRoutes(router, ownerCapability);
  registerCredentialRoutes(router, ownerCapability);
  registerEffectRoutes(router, ownerCapability);
  registerTrustRoutes(router, ownerCapability);

  router.get('/v1/commerce/reconciliation', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) {
      // Distinguishable from "nothing is frozen" on purpose. An owner reading
      // an empty list must be able to tell "this node has no commerce" from
      // "this node has commerce and everything is fine" — the second is a
      // reassurance the first has not earned.
      return { status: 503, body: { error: 'commerce_unavailable' } };
    }

    return {
      status: 200,
      body: buildReconciliationCensus(runtime.orders.listAwaitingReconciliation()),
    };
  });

  /**
   * §16.2 — THE CEREMONY ITSELF, not just the census of what needs one.
   *
   * `signRestoreFence`, `reconcileRestoredOrder` and `registerReplacementQuote`
   * were reachable only from tests: every engine, every transaction boundary
   * and every refusal was built and exercised, and no production caller
   * existed. So a restored supplier could LIST its frozen orders and do
   * nothing about them — the read that names the problem shipped, the writes
   * that solve it did not, and a boundary test allowlisted the gap as "no
   * operator surface" rather than reporting it.
   *
   * WHOSE AUTHORITY. On the D2D lane the buyer DID is transport-authenticated
   * and the engines take it as such. Here the OWNER is the authority — the
   * guard above has already established that — and `buyer_did` is a lookup
   * key naming which counterparty's order is being recovered. That is the
   * right shape for a ceremony the owner performs on their own node, and it
   * is written down because the same engine argument means something stronger
   * one lane over.
   */
  router.post('/v1/commerce/reconciliation/order', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as { buyer_did?: unknown; proposal?: unknown };
    const buyerDid = typeof body.buyer_did === 'string' ? body.buyer_did : '';
    if (buyerDid === '' || body.proposal === undefined) {
      return { status: 400, body: { error: 'buyer_did and proposal are required' } };
    }

    // The proposal is validated INSIDE the engine, through the same reader the
    // D2D lane uses. Re-checking its shape here would be a second copy of a
    // rule that has to stay byte-exact.
    const done = runtime.lifecycle.reconcileRestoredOrder(body.proposal, buyerDid);
    if ('error' in done) return { status: 409, body: { error: done.error } };
    return { status: 200, body: { ok: true } };
  });

  router.post('/v1/commerce/reconciliation/fence', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as {
      buyer_did?: unknown;
      purchase_order_id?: unknown;
      held_status_receipts?: unknown;
    };
    const buyerDid = typeof body.buyer_did === 'string' ? body.buyer_did : '';
    const purchaseOrderId =
      typeof body.purchase_order_id === 'string' ? body.purchase_order_id : '';
    if (buyerDid === '' || purchaseOrderId === '') {
      return { status: 400, body: { error: 'buyer_did and purchase_order_id are required' } };
    }
    if (!Array.isArray(body.held_status_receipts) || body.held_status_receipts.length === 0) {
      // A fence over nothing is the one call that must not be possible: the
      // whole point is to fast-forward onto evidence, and an empty list would
      // ask the engine to move the chain on the owner's say-so.
      return { status: 400, body: { error: 'held_status_receipts must be a non-empty array' } };
    }

    // Every receipt is verified against this node's OWN signature inside the
    // engine's transaction. Nothing here decides what is authentic.
    const fenced = runtime.lifecycle.signRestoreFence(
      buyerDid,
      purchaseOrderId,
      body.held_status_receipts as Parameters<typeof runtime.lifecycle.signRestoreFence>[2],
    );
    if ('error' in fenced) return { status: 409, body: { error: fenced.error } };
    return { status: 200, body: { ok: true, status: fenced } };
  });

  router.post('/v1/commerce/quotes/replacement', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as { buyer_did?: unknown; quote?: unknown };
    const buyerDid = typeof body.buyer_did === 'string' ? body.buyer_did : '';
    if (buyerDid === '' || body.quote === undefined) {
      return { status: 400, body: { error: 'buyer_did and quote are required' } };
    }

    // §16.2 X-10: after a restore this node refuses to invent terms, so the
    // way back to a live quote is a REPLACEMENT the supplier signed. The
    // engine validates the signature, the buyer binding and the chain before
    // anything becomes a head; a refusal writes nothing at all.
    const refusal = runtime.admission.registerReplacementQuote(
      body.quote as Parameters<typeof runtime.admission.registerReplacementQuote>[0],
      buyerDid,
    );
    if (refusal !== null) return { status: 409, body: { error: refusal } };
    return { status: 200, body: { ok: true } };
  });
}

/**
 * The buyer's VERIFIED fulfilment view (§9.11).
 *
 * Read from the chain this node checked, never from the display fields a
 * supplier sent alongside it. That is the whole point of the receiver-side
 * check: a supplier saying `dispatched` in a free-text field and a supplier
 * PROVING `dispatched` with a signed successor are different claims, and only
 * the second one may reach an owner as fact.
 *
 * Absent when there is no chain yet, which is the honest answer for an order
 * whose supplier has signed nothing.
 */
/**
 * The sequence this node's verified chain ends at, as a `since_sequence`.
 *
 * Absent when nothing is held or the chain cannot be read: both mean "send
 * everything", which is the safe direction — too much is verifiable, too
 * little is not.
 */
function heldSequence(
  runtime: { buyerStatus: BuyerStatusRepository },
  supplierDid: string,
  purchaseOrderId: string,
): { sinceSequence?: string } {
  try {
    const chain = runtime.buyerStatus.chain(supplierDid, purchaseOrderId);
    const head = chain[chain.length - 1];
    return head === undefined ? {} : { sinceSequence: head.sequence };
  } catch {
    return {};
  }
}

function fulfilmentOf(
  runtime: { buyerStatus: BuyerStatusRepository },
  supplierDid: string,
  purchaseOrderId: string,
): { fulfilment?: { state: string; sequence: string; updatedAt: string } } {
  let chain: CommerceOrderStatus[];
  try {
    chain = runtime.buyerStatus.chain(supplierDid, purchaseOrderId);
  } catch {
    // A stored record that no longer describes itself. Reported as "no
    // verified chain" rather than as a state, because the alternative is
    // presenting a row we just failed to authenticate as evidence.
    return {};
  }
  const head = chain[chain.length - 1];
  if (head === undefined) return {};
  return {
    fulfilment: { state: head.state, sequence: head.sequence, updatedAt: head.updated_at },
  };
}

/**
 * What the buyer is still waiting on (§12.7, WS-7.7 / WS-7.8).
 *
 * ONE PROJECTION, SHARED. Mobile and web read `describeOrderForOwner`'s output
 * rather than each deriving a headline from a state name — two renderers would
 * eventually disagree about whether `outcome_unknown` means "failed", and one
 * of those readings invites the owner to press send again while an effect may
 * already have fired. FR-P10 asks for one command/projection contract; this is
 * the read half of it.
 *
 * AND THE COMMAND HALF (WS-7.8). `POST /v1/commerce/orders/command` performs
 * exactly the actions the projection OFFERED, and it decides that by asking the
 * projection — not by re-reading the state name. Two readings of "may the owner
 * resend this" is one reading too many: the divergence that matters runs in the
 * direction where the command allows what the card never offered.
 *
 * OWNER-ONLY. An order this node cannot account for is a list of exactly where
 * its money might already be.
 */
/**
 * The retained card, or the refusal that says why it cannot be answered.
 *
 * ONE READER for submit and resend. Two copies of "is this card still good"
 * would eventually disagree, and the direction that matters is the one where
 * the send accepts a card the other path would have refused.
 */
function registerBuyerOrderRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may read outstanding orders',
  );

  /**
   * Show a card, and REMEMBER what it said (§15.2).
   *
   * The half of the binding that was missing. `verifyApprovalBinding` compares
   * what is about to execute against what was approved, and that comparison is
   * worth having only when the two sides come from different places. Submit
   * used to carry the order, the context and the approved payload in one body,
   * rebuild the payload from that body's order, and compare it to that body's
   * payload — so a caller that re-planned the order rebuilt both halves and
   * passed. Core now mints the payload here and keeps it; the send names it.
   */
  router.post('/v1/commerce/orders/prepare', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    // §5.4 stage 4 — the CONDITIONAL presence gate this design adds: on a
    // presence-capable node, a hand-built order refuses without a live
    // proof; on a convenience-mode node behaviour is unchanged, so
    // convenience-mode ordering survives. The named software path this
    // closes: a program holding only the boot-minted owner capability can
    // no longer mint a commercial approval on a node whose owner has a
    // passphrase nobody typed.
    if (ownerPresenceCanBeEstablished() && !ownerPresentNow(Date.now())) {
      return {
        status: 403,
        body: { error: 'no_user_presence', detail: 'approving an order needs a person present' },
      };
    }

    const body = (req.body ?? {}) as {
      order?: unknown;
      context?: unknown;
      service_rkey?: unknown;
    };
    for (const field of ['order', 'context'] as const) {
      if (body[field] === null || typeof body[field] !== 'object') {
        return { status: 400, body: { error: `${field} is required` } };
      }
    }

    const order = body.order as PurchaseOrderProposal;
    const claimedContext = body.context as BuyerApprovalContext;
    // The order is validated HERE, before anything is retained. A card built
    // over an order that does not describe itself would be a retained approval
    // for a document the store then refuses to hydrate — a pending decision
    // that can never be answered.
    const invalid = validatePurchaseOrderProposal(order, hash);
    if (invalid !== null) {
      return { status: 400, body: { error: 'invalid_order', detail: invalid } };
    }

    // §15.2 (DR-2) — THE BUSINESS BEING COMMITTED IS THIS NODE, and the node
    // knows which node it is. Taking `actingBusinessDid` from the body meant
    // the approval bound whichever business the caller named, which is no
    // binding at all: the §15.2 check later compares the send against the card
    // and both halves came from the same claim.
    const self = ownerDid();
    if (self === null) {
      return { status: 503, body: { error: 'node_identity_unavailable' } };
    }
    if (claimedContext.actingBusinessDid !== self) {
      return {
        status: 403,
        body: {
          error: 'acting_business_mismatch',
          detail: 'context.actingBusinessDid is not this node',
        },
      };
    }
    // §15.2 (NEW-3) — WHO APPROVED is also this node's to say.
    //
    // DR-2 fixed the acting business and the install and left the principal,
    // which §7.2 lists in the same breath: "caller-supplied body fields do not
    // establish any of those identities", and authority domain and policy
    // revision are two of the six it names. `chainGaps` only checks that the
    // domain is NON-EMPTY, which any string satisfies, and nothing compares
    // the retained principal to the one `singleOwnerAuthority` substitutes
    // into the chain — so the card could say a human approved under a domain
    // nobody holds while the authority evaluation used the owner.
    //
    // The supplier half of this file already does the right thing one function
    // away: it names `owner` and a Core-side domain constant. This is that,
    // for the buy side. A node with no staff directory can still say who its
    // owner is and what act this is.
    const principal: ApprovingPrincipal = {
      principalDid: self,
      authorityDomain: BUYER_ORDER_AUTHORITY_DOMAIN,
      // A PERSON tapped this card. §15.2b's rule holds on both sides: a
      // payload approved by a human must never be presentable as
      // policy-approved, so the policy slot stays empty rather than echoing
      // whatever the body sent.
      policyRevision: null,
    };
    const statedPrincipal = claimedContext.principal;
    if (
      statedPrincipal !== undefined &&
      ((typeof statedPrincipal.principalDid === 'string' &&
        statedPrincipal.principalDid !== '' &&
        statedPrincipal.principalDid !== principal.principalDid) ||
        (typeof statedPrincipal.authorityDomain === 'string' &&
          statedPrincipal.authorityDomain !== '' &&
          statedPrincipal.authorityDomain !== principal.authorityDomain) ||
        (statedPrincipal.policyRevision !== undefined &&
          statedPrincipal.policyRevision !== null))
    ) {
      // Refused rather than overwritten, for the same reason the install facts
      // are: the surface showed the owner an accountability story, and if it
      // is not the one that would be recorded then they approved a different
      // act.
      return {
        status: 403,
        body: {
          error: 'principal_mismatch',
          detail: 'context.principal is not the principal this node would record',
        },
      };
    }

    // Same argument for the install: the caller SELECTS one, this node says
    // what it is. Disagreement refuses rather than overwriting — see
    // `resolveActingInstall`.
    // BUILT FROM NAMED FIELDS, never spread from the body (NEW-13). A spread
    // carries whatever else the caller put inside `context` into the retained
    // row and into `context_json`, where the approval digest — which covers
    // only the fields §15.2 names — does not bind it. A field that is
    // accepted, stored, and neither bound nor read is the shape this review
    // keeps finding; the fix is to stop accepting it rather than to remember
    // not to trust it.
    // §2.1 — the source binding, VALIDATED at the door when present: a
    // partial binding is refused here rather than stored, because a stored
    // partial would be exactly the corrupted row the fail-closed hydration
    // exists to refuse later.
    if (claimedContext.source !== undefined) {
      const badBinding = validateApprovalSourceBinding(claimedContext.source);
      if (badBinding !== null) {
        return { status: 400, body: { error: 'invalid_source_binding', detail: badBinding } };
      }
    }
    const namedContext: BuyerApprovalContext = {
      actingBusinessDid: self,
      principal,
      serviceUri: claimedContext.serviceUri,
      displayedLabels: claimedContext.displayedLabels,
      productKeys: claimedContext.productKeys,
      linePrices: claimedContext.linePrices,
      charges: claimedContext.charges,
      quoteRevision: claimedContext.quoteRevision,
      quoteExpiresAt: claimedContext.quoteExpiresAt,
      install: claimedContext.install,
      ...(claimedContext.source === undefined ? {} : { source: claimedContext.source }),
      // §6.4 — past the attribution boundary every minted approval names
      // WHO vouched, inside the integrity digest. The owner, on this
      // owner-guarded route; the staff surface threads its device DID.
      ...(runtime.attributionBoundary.crossedAt() === null
        ? {}
        : { attribution: { version: 2 as const, vouchedBy: self } }),
    };
    const resolved = resolveActingInstall(namedContext, BUYER_REFERENCE_MANIFEST.plugin_id);
    if (!resolved.ok) {
      return {
        status: resolved.refusal === 'install_registry_unavailable' ? 503 : 403,
        body: { error: resolved.refusal, detail: resolved.detail },
      };
    }
    const context = resolved.context;

    const built = buildBuyerApprovalPayload(order, context);
    if (!built.ok) {
      // §15.2 names these fields; a payload built with them missing binds a
      // constant and protects nothing.
      return {
        status: 400,
        body: { error: 'approval_incomplete', missing: built.missing },
      };
    }

    // §15.2 (DR-3) — the listing is named ONCE, by the URI the card bound.
    // `service_rkey` used to arrive beside it and default to 'self', so the
    // card could show one listing while the authority check ran against
    // another.
    const listing = resolveServiceBinding({
      serviceUri: context.serviceUri,
      supplierDid: order.supplier_did,
      statedRkey: body.service_rkey,
    });
    if (!listing.ok) {
      return { status: 400, body: { error: listing.refusal, detail: listing.detail } };
    }

    const now = Date.now();
    const approvalId = newApprovalId();
    const retained = runtime.orderApprovals.put({
      approvalId,
      order,
      context,
      serviceRkey: listing.serviceRkey,
      createdAt: now,
      expiresAt: now + ORDER_APPROVAL_TTL_MS,
    });
    if (!retained) {
      // A minted id that already exists is not a retry, it is a collision in
      // 128 bits of randomness. Refusing beats overwriting a live card.
      return { status: 409, body: { error: 'approval_not_retained' } };
    }
    return {
      status: 200,
      body: {
        approval_id: approvalId,
        // The payload travels so the surface can render exactly what is bound,
        // and so an operator can recompute the digest by hand. It is the
        // owner's own data on the owner's own route.
        approved: built.payload,
        expires_at: now + ORDER_APPROVAL_TTL_MS,
      },
    };
  });

  router.post('/v1/commerce/orders/submit', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as { approval_id?: unknown };
    const approvalId = typeof body.approval_id === 'string' ? body.approval_id : '';
    if (approvalId === '') {
      return { status: 400, body: { error: 'approval_id is required' } };
    }

    // The whole path — card read, §5.4 source-binding enforcement, §7.2
    // authority, send, consume-on-send, status mapping — lives in
    // `dispatchUnderRetainedApproval` so this route, the §5.1 orchestrator
    // and the dispatch-intent sweeper cannot drift apart.
    return dispatchUnderRetainedApproval(runtime, approvalId, Date.now());
  });

  /**
   * §5.4 stage 1 — the draft-scoped SEND. Core loads the conversation,
   * verifies every carried line and requirement against its current vouch
   * entry (the send-gate row), builds the `QuoteRequest` ITSELF through
   * the existing composer (retain-first, validated, dispatched over the
   * D2D lane), and snapshots the conversation — immutable from here, so
   * later repairs create new generations rather than rewriting what this
   * request meant. ONE identity is minted and written to `request_id` AND
   * `idempotency_key`; supplier-side absorption is the shipped
   * request_digest derivation, not new work.
   */
  router.post(
    '/v1/commerce/orders/drafts/request-quote',
    async (req): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';
      const supplierDid = typeof body.supplier_did === 'string' ? body.supplier_did : '';
      const serviceRkey = typeof body.service_rkey === 'string' ? body.service_rkey : 'self';
      if (draftId === '') return { status: 400, body: { error: 'draft_id_required' } };
      if (supplierDid === '') return { status: 400, body: { error: 'supplier_did is required' } };
      // The projection is the BUYER'S OWN configured delivery place — not
      // machine-read, so it arrives from the surface like any setting, and
      // Core completes its digest when the surface sent only the fields:
      // Core builds the request, so Core seals what it built.
      if (body.projection === null || typeof body.projection !== 'object') {
        return { status: 400, body: { error: 'projection is required' } };
      }
      body.projection = completeProjection(body.projection as Record<string, unknown>);

      const draft = runtime.orderDrafts.get(draftId);
      if (draft === null) return { status: 404, body: { error: 'no_such_draft' } };
      if (draft.abandoned) return { status: 409, body: { error: 'abandoned' } };

      // ONE LIVE CONVERSATION PER SUPPLIER (§5.0): a line resolving to a
      // supplier whose live conversation has already SENT waits and joins
      // that supplier's next conversation.
      const live = draft.conversations.find(
        (c) =>
          c.supplierDid === supplierDid &&
          c.state !== 'draft' &&
          !['submitted', 'timed_out', 'rejected', 'superseded', 'quote_expired', 'dispatch_refused', 'closed'].includes(c.state),
      );
      if (live !== undefined) {
        return { status: 409, body: { error: 'conversation_in_flight', conversation_id: live.conversationId } };
      }

      // THE SEND GATE (§5.1): every carried line's vouch entry current at
      // its generation with NO model-derived field still proposed, and
      // every requirement decided at its current generation — including
      // draft-local ones, which are never transmitted but must not sit
      // unreviewed while the screen calls the page checked.
      const carried = draft.lines.filter(
        (line) =>
          line.resolution.kind === 'resolved' &&
          line.resolution.supplierDid === supplierDid &&
          line.submittedIn === null,
      );
      if (carried.length === 0) {
        return { status: 409, body: { error: 'no_lines_for_supplier' } };
      }
      const unvouched = carried.filter(
        (line) => line.vouch === null || line.vouch.generation !== line.generation,
      );
      if (unvouched.length > 0) {
        return {
          status: 409,
          body: { error: 'unvouched_lines', lines: unvouched.map((l) => l.lineId) },
        };
      }
      for (const line of carried) {
        const proposed = Object.entries(line.provenance)
          .filter(([, state]) => state === 'proposed')
          .map(([field]) => field);
        if (proposed.length > 0) {
          return {
            status: 409,
            body: { error: 'unvouched_lines', lines: [line.lineId], fields: proposed },
          };
        }
      }
      for (const requirement of draft.requirements) {
        const current =
          requirement.vouch !== null && requirement.vouch.generation === requirement.generation;
        if (!current && !requirement.omitted) {
          return {
            status: 409,
            body: { error: 'unvouched_requirement', key: requirement.key },
          };
        }
      }

      // Core mints ONE identity with the intent, durable on the
      // conversation, scoped to the buyer↔supplier pair.
      const conversationId = `conv_${bytesToHex(randomBytes(8))}`;
      const requestId = `qreq_${bytesToHex(randomBytes(12))}`;
      const requiredByReq = draft.requirements.find(
        (r) => r.key === 'required_by' && !r.omitted && r.value !== null,
      );

      const outcome = await requestQuote({
        supplierDid,
        serviceRkey,
        requestId,
        idempotencyKey: requestId,
        lines: carried.map((line) => {
          const resolution = line.resolution as Extract<
            (typeof line)['resolution'],
            { kind: 'resolved' }
          >;
          return {
            lineId: line.lineId,
            product: resolution.product,
            quantity: { value: line.fields.quantity ?? '1', unit_code: 'each' },
          };
        }),
        projection: body.projection as DeliveryProjection,
        ...(requiredByReq?.value != null ? { requiredBy: requiredByReq.value } : {}),
        nowMs: Date.now(),
      });
      if (outcome.kind === 'refused') {
        return {
          status: outcome.reason === 'commerce_unavailable' || outcome.reason === 'no_dispatch' ? 503 : 409,
          body: { error: outcome.reason },
        };
      }

      // SNAPSHOT the conversation — what this request MEANT, immutable.
      const snapshot = {
        draft_id: draft.draftId,
        conversation_id: conversationId,
        supplier_did: supplierDid,
        request_digest: outcome.request.request_digest,
        lines: carried.map((line) => ({
          line_id: line.lineId,
          generation: line.generation,
          vouch_receipt_digest: line.vouch?.receiptDigest ?? '',
        })),
        requirements: draft.requirements.map((r) => ({
          key: r.key,
          omitted: r.omitted,
          value: r.omitted ? null : r.value,
          generation: r.generation,
        })),
      };
      const snapshotDigest = conversationSnapshotDigest(snapshot, (data) => sha256(data));
      draft.conversations.push({
        conversationId,
        supplierDid,
        state: 'sent',
        lineIds: carried.map((l) => l.lineId),
        snapshot,
        snapshotDigest,
        requestDigest: outcome.request.request_digest,
        requestId,
        quoteDigest: null,
        quoteId: null,
        quoteValidUntil: null,
        approvalId: null,
        purchaseOrderId: null,
        dispatchIntent: null,
        outcome: outcome.kind === 'ambiguous' ? 'send_ambiguous' : null,
      });
      draft.updatedAtMs = Date.now();
      runtime.orderDrafts.put(draft);
      recordCommerceEvent({
        event: 'send',
        lane: 'order',
        draftId: draft.draftId,
        conversationId,
        supplierDid,
        count: carried.length,
        atMs: Date.now(),
      });
      return {
        status: 200,
        body: {
          ok: true,
          conversation_id: conversationId,
          request_id: requestId,
          request_digest: outcome.request.request_digest,
          snapshot_digest: snapshotDigest,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // §5.0 — the buyer's photographed order: capture, extract, read, and the
  // §5.1 matrix rows as owner routes. The screens are RN; every rule is here.
  // -------------------------------------------------------------------------

  /** One §5.1 outcome → one wire answer, mapped identically on every row. */
  const orderDraftAnswer = (outcome: ReturnType<OrderDraftService['confirm']>): CoreResponse => {
    if (outcome.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          draft: outcome.draft,
          state: deriveOrderDraftState(outcome.draft),
        },
      };
    }
    const missing =
      outcome.refusal === 'no_such_draft' ||
      outcome.refusal === 'no_such_line' ||
      outcome.refusal === 'no_such_conversation' ||
      outcome.refusal === 'no_such_requirement';
    return {
      status: missing ? 404 : outcome.refusal === 'no_user_presence' ? 403 : 409,
      body: { error: outcome.refusal, detail: outcome.detail },
    };
  };

  const orderDraftService = (
    runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
    caller: CommerceRouteCaller = { kind: 'owner' },
  ): OrderDraftService =>
    new OrderDraftService({
      drafts: runtime.orderDrafts,
      now: () => Date.now(),
      sha256: hash,
      // WHO is present and WHO vouches follow the caller: the owner's
      // stamp and DID on the owner path, the staff device's on the §6
      // staff path — attribution is the whole point of §6.4.
      userPresent: () =>
        caller.kind === 'staff'
          ? staffPresentNow(caller.deviceDid, Date.now())
          : ownerPresentNow(Date.now()),
      attributionBoundary: runtime.attributionBoundary,
      vouchedBy: () => (caller.kind === 'staff' ? caller.deviceDid : getNodeDID()),
    });

  /**
   * §6 capture, order lane — the same trusted artifact-ingest boundary the
   * catalog lane runs: page count, byte ceilings, MIME allowlist, two-phase
   * decode, EXIF strip. All pages or none, and the single-use §3 egress
   * authorization is minted here with the ORDER purpose, so the schema is
   * derived from the lane and never chosen by a caller.
   */
  router.post('/v1/commerce/orders/drafts/photo_capture', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    if (!imageReencoderInstalled()) {
      return { status: 503, body: { error: 'no_reencoder: this node cannot ingest photographs' } };
    }
    const provider = installedEgressProvider();
    if (provider === null) {
      return { status: 503, body: { error: 'no_egress_broker: no vision provider is configured' } };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.pages) || body.pages.length === 0) {
      return { status: 400, body: { error: 'pages must be a non-empty array of base64 images' } };
    }
    if (body.pages.length > MAX_IMAGE_PAGES) {
      return { status: 400, body: { error: 'too_many_pages' } };
    }

    const draftId = `odr_${bytesToHex(randomBytes(16))}`;
    const manifest: { artifact_id: string; content_hash: string; page_index: number }[] = [];
    for (const [index, page] of body.pages.entries()) {
      if (typeof page !== 'string' || page === '') {
        runtime.imageArtifacts.eraseDraft(draftId);
        return { status: 400, body: { error: `pages[${String(index)}] must be base64 bytes` } };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64.decode(page);
      } catch {
        runtime.imageArtifacts.eraseDraft(draftId);
        return { status: 400, body: { error: `pages[${String(index)}] is not valid base64` } };
      }
      const ingested = await ingestCommerceImage({
        repository: runtime.imageArtifacts,
        ownerDraftId: draftId,
        lane: 'order',
        pageIndex: index,
        bytes,
        nowMs: runtime.now(),
      });
      if (!ingested.ok) {
        runtime.imageArtifacts.eraseDraft(draftId);
        // §8b — the refusal KEY and the page count; never the bytes.
        recordCommerceEvent({
          event: 'ingest_refusal',
          lane: 'order',
          draftId,
          refusal: ingested.refusal.split(':')[0] ?? ingested.refusal,
          count: index,
          atMs: runtime.now(),
        });
        return { status: 422, body: { error: ingested.refusal, page_index: index } };
      }
      manifest.push({
        artifact_id: ingested.artifact.artifactId,
        content_hash: ingested.artifact.contentHash,
        page_index: index,
      });
    }

    const authorizationId = newEgressAuthorizationId();
    const at = runtime.now();
    runtime.egressAuthorizations.put({
      authorizationId,
      purpose: 'order_extraction',
      provider,
      contentHashes: manifest.map((m) => m.content_hash),
      maxBytes: MAX_AGGREGATE_IMAGE_BYTES,
      createdAtMs: at,
      expiresAtMs: at + IMAGE_EGRESS_AUTHORIZATION_TTL_MS,
      consumedAtMs: null,
    });
    recordCommerceEvent({ event: 'photo_capture', lane: 'order', draftId, count: manifest.length, atMs: at });
    recordCommerceEvent({ event: 'egress_authorization', lane: 'order', draftId, atMs: at });
    return {
      status: 200,
      body: { ok: true, draft_id: draftId, manifest, authorization_id: authorizationId, provider },
    };
  });

  /**
   * §3 + §5.0 — EXTRACT through the gate, then create the ORDER draft with
   * its §2.1 chain: extraction commitment (draft_id in the preimage, ORDER
   * lane separation in the digest) and the manifest. Every extracted field
   * arrives `proposed` — nothing machine-read is treated as decided — and
   * the two draft-level requirement keys the schema may produce become
   * requirements rather than line fields: `required_by` (transmitted) and
   * `instruction` (draft-local, reviewed but never sent).
   */
  router.post('/v1/commerce/orders/drafts/photo_extract', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || body.draft_id === '') {
      return { status: 400, body: { error: 'draft_id is required (from photo_capture)' } };
    }
    if (typeof body.authorization_id !== 'string' || body.authorization_id === '') {
      return { status: 400, body: { error: 'authorization_id is required (from photo_capture)' } };
    }
    if (runtime.orderDrafts.get(body.draft_id) !== null) {
      return { status: 409, body: { error: 'draft_exists: extraction already created this draft' } };
    }
    const artifacts = runtime.imageArtifacts.listByDraft(body.draft_id);
    if (artifacts.length === 0) {
      return { status: 404, body: { error: 'no_captured_pages' } };
    }
    const extracted = await extractRowsThroughGate({
      authorizations: runtime.egressAuthorizations,
      readImage: (artifactId) => runtime.imageArtifacts.getBytes(artifactId),
      authorizationId: body.authorization_id,
      artifactIds: artifacts.map((a) => a.artifactId),
      nowMs: runtime.now(),
    });
    if (!extracted.ok) {
      return { status: 422, body: { error: extracted.refusal } };
    }

    const orderedRows = [...extracted.rows].sort((a, b) => a.page_index - b.page_index);
    const commitment: ExtractionCommitment = {
      draft_id: body.draft_id,
      manifest: artifacts.map((a) => ({
        artifact_id: a.artifactId,
        content_hash: a.contentHash,
        page_index: a.pageIndex,
      })),
      schema_id: extracted.schemaId,
      model: extracted.model,
      rows: orderedRows.map((row, i) => ({
        page_index: row.page_index,
        row: i + 2,
        content: row.cells,
      })),
    };
    const commitmentShape = validateExtractionCommitment(commitment);
    if (commitmentShape !== null) {
      return { status: 422, body: { error: `extraction_invalid: ${commitmentShape}` } };
    }
    const extractionDigest = extractionCommitmentDigest('order', commitment, (data) => sha256(data));

    const REQUIREMENT_KEYS: Record<string, 'transmitted' | 'draft_local'> = {
      required_by: 'transmitted',
      instruction: 'draft_local',
    };
    const requirements: OrderDraft['requirements'] = [];
    const lines: OrderDraft['lines'] = [];
    for (const [index, row] of orderedRows.entries()) {
      const fields: Record<string, string> = {};
      const provenance: Record<string, 'proposed'> = {};
      for (const [key, value] of Object.entries(row.cells)) {
        if (key === 'text') continue;
        const requirementKind = REQUIREMENT_KEYS[key];
        if (requirementKind !== undefined) {
          // Draft-level, first occurrence wins; a page repeating the date
          // is one date, not two decisions.
          if (!requirements.some((r) => r.key === key) && value !== '') {
            requirements.push({
              key,
              kind: requirementKind,
              value,
              omitted: false,
              provenance: 'proposed',
              generation: 1,
              vouch: null,
            });
          }
          continue;
        }
        if (value !== '') {
          fields[key] = value;
          provenance[key] = 'proposed';
        }
      }
      const text = typeof row.cells.text === 'string' ? row.cells.text : '';
      if (text === '' && Object.keys(fields).length === 0) continue;
      lines.push({
        lineId: `line_${String(index + 1)}`,
        text,
        pageIndex: row.page_index,
        fields,
        provenance,
        resolution: { kind: 'unresolved' },
        generation: 1,
        assignmentGeneration: 0,
        vouch: null,
        deferred: false,
        evidence: null,
        submittedIn: null,
      });
    }
    if (lines.length === 0) {
      return { status: 422, body: { error: 'nothing_extracted: no order lines were read' } };
    }

    const at = runtime.now();
    const draft: OrderDraft = {
      draftId: body.draft_id,
      manifest: commitment.manifest,
      extraction: { model: extracted.model, schemaVersion: extracted.schemaId },
      extractionDigest,
      lines,
      requirements,
      conversations: [],
      ceremonyCounter: 0,
      abandoned: false,
      createdAtMs: at,
      updatedAtMs: at,
    };
    runtime.orderDrafts.put(draft);
    recordCommerceEvent({
      event: 'extraction',
      lane: 'order',
      draftId: draft.draftId,
      count: lines.length,
      atMs: at,
    });
    return { status: 200, body: { ok: true, draft, state: deriveOrderDraftState(draft) } };
  });

  /** The read seam the buyer screens live on. Owner-only, whole rows. */
  router.get('/v1/commerce/orders/drafts', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    return {
      status: 200,
      body: {
        drafts: runtime.orderDrafts.list().map((draft) => ({
          draft_id: draft.draftId,
          state: deriveOrderDraftState(draft),
          lines: draft.lines.length,
          conversations: draft.conversations.length,
          created_at_ms: draft.createdAtMs,
          updated_at_ms: draft.updatedAtMs,
        })),
      },
    };
  });

  router.get('/v1/commerce/orders/drafts/get', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const draftId = String(req.query.draft_id ?? '');
    if (draftId === '') return { status: 400, body: { error: 'draft_id is required' } };
    const draft = runtime.orderDrafts.get(draftId);
    if (draft === null) return { status: 404, body: { error: 'no_such_draft' } };
    return { status: 200, body: { ok: true, draft, state: deriveOrderDraftState(draft) } };
  });

  /** §5.1 matrix rows, one route per row — the service enforces every rule. */
  router.post('/v1/commerce/orders/drafts/line/repair', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.draft_id !== 'string' ||
      typeof body.line_id !== 'string' ||
      typeof body.field !== 'string' ||
      typeof body.value !== 'string'
    ) {
      return { status: 400, body: { error: 'draft_id, line_id, field and value are required' } };
    }
    return orderDraftAnswer(
      orderDraftService(runtime).repairLine(body.draft_id, {
        lineId: body.line_id,
        field: body.field,
        value: body.value,
      }),
    );
  });

  router.post('/v1/commerce/orders/drafts/line/resolve', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || typeof body.line_id !== 'string') {
      return { status: 400, body: { error: 'draft_id and line_id are required' } };
    }
    const resolution = body.resolution as Record<string, unknown> | undefined;
    if (
      resolution === undefined ||
      resolution === null ||
      typeof resolution !== 'object' ||
      typeof resolution.kind !== 'string'
    ) {
      return { status: 400, body: { error: 'resolution with a kind is required' } };
    }
    if (resolution.kind === 'resolved') {
      const product = resolution.product as Record<string, unknown> | undefined;
      if (
        product === undefined ||
        typeof product.scheme !== 'string' ||
        typeof product.value !== 'string' ||
        typeof resolution.supplierDid !== 'string' ||
        typeof resolution.flaggedNewSupplier !== 'boolean'
      ) {
        return {
          status: 400,
          body: { error: 'a resolved line names product, supplierDid and flaggedNewSupplier' },
        };
      }
    }
    return orderDraftAnswer(
      orderDraftService(runtime).resolveLine(body.draft_id, {
        lineId: body.line_id,
        resolution: resolution as unknown as OrderDraft['lines'][number]['resolution'],
        ...(body.evidence !== undefined
          ? { evidence: body.evidence as OrderDraft['lines'][number]['evidence'] }
          : {}),
      }),
    );
  });

  router.post('/v1/commerce/orders/drafts/line/defer', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || typeof body.line_id !== 'string') {
      return { status: 400, body: { error: 'draft_id and line_id are required' } };
    }
    return orderDraftAnswer(orderDraftService(runtime).deferLine(body.draft_id, body.line_id));
  });

  router.post('/v1/commerce/orders/drafts/accept_fields', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || !Array.isArray(body.refs)) {
      return { status: 400, body: { error: 'draft_id and refs are required' } };
    }
    const refs: { lineId: string; field: string }[] = [];
    for (const ref of body.refs) {
      const named = ref as Record<string, unknown>;
      if (typeof named.line_id !== 'string' || typeof named.field !== 'string') {
        return { status: 400, body: { error: 'every ref names line_id and field' } };
      }
      refs.push({ lineId: named.line_id, field: named.field });
    }
    return orderDraftAnswer(orderDraftService(runtime).acceptLineFields(body.draft_id, refs));
  });

  router.post('/v1/commerce/orders/drafts/requirement', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    if (
      typeof body.draft_id !== 'string' ||
      typeof body.key !== 'string' ||
      !['edit', 'accept', 'omit', 'reinstate'].includes(action)
    ) {
      return {
        status: 400,
        body: { error: 'draft_id, key and an action of edit|accept|omit|reinstate are required' },
      };
    }
    return orderDraftAnswer(
      orderDraftService(runtime).editRequirement(body.draft_id, {
        key: body.key,
        action: action as 'edit' | 'accept' | 'omit' | 'reinstate',
        ...(typeof body.value === 'string' ? { value: body.value } : {}),
      }),
    );
  });

  /**
   * CONFIRM (§5.3) — the ceremony, presence UNCONDITIONAL: this lane is
   * photo-derived by its aggregate, and a batch tap cannot vouch a
   * quantity nobody looked at. A no-presence deployment cannot confirm a
   * photographed order at all, and says so — the same posture as approve.
   */
  router.post('/v1/commerce/orders/drafts/confirm', async (req): Promise<CoreResponse> => {
    const caller = staffOrOwnerCaller(req, ownerOnlyGuard);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    if (caller.kind === 'owner' && !ownerPresenceCanBeEstablished()) {
      return {
        status: 503,
        body: { error: 'presence_unavailable', detail: 'photographed orders cannot be vouched on this deployment' },
      };
    }
    if (caller.kind === 'staff') {
      // §6.5 — commerce_confirm carries no cap: scope + install-role
      // check only. Money control lives at submit. Presence is checked
      // by the service itself (staff stamp via the caller-aware deps).
      if (!staffPresenceCanBeEstablished()) {
        return { status: 503, body: { error: 'staff_presence_unavailable' } };
      }
      const gate = checkStaffOperation({
        repository: runtime.staffGrants,
        deviceDid: caller.deviceDid,
        scope: 'commerce_confirm',
        installRole: 'buyer',
      });
      if (gate.verdict !== 'allow') {
        return { status: 403, body: { error: 'access_denied', reason: gate.verdict === 'refuse' ? gate.reason : 'escalation is not a confirm outcome' } };
      }
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || body.draft_id === '') {
      return { status: 400, body: { error: 'draft_id_required' } };
    }
    const outcome = orderDraftService(runtime, caller).confirm(body.draft_id);
    if (outcome.ok) {
      recordCommerceEvent({
        event: 'confirm',
        lane: 'order',
        draftId: outcome.draft.draftId,
        count: outcome.draft.lines.filter((line) => line.vouch !== null).length,
        atMs: Date.now(),
      });
    }
    return orderDraftAnswer(outcome);
  });

  router.post('/v1/commerce/orders/drafts/reopen', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || typeof body.conversation_id !== 'string') {
      return { status: 400, body: { error: 'draft_id and conversation_id are required' } };
    }
    return orderDraftAnswer(
      orderDraftService(runtime).reopenLines(body.draft_id, body.conversation_id),
    );
  });

  /**
   * Abandon — and §6's erasure follows the draft: the photographs leave
   * with it, transactionally, except while an order may be on its way.
   */
  router.post('/v1/commerce/orders/drafts/abandon', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.draft_id !== 'string' || body.draft_id === '') {
      return { status: 400, body: { error: 'draft_id_required' } };
    }
    const outcome = orderDraftService(runtime).abandon(body.draft_id);
    if (outcome.ok) {
      runtime.runInTransaction(() => {
        runtime.imageArtifacts.eraseDraft(body.draft_id as string);
      });
    }
    return orderDraftAnswer(outcome);
  });

  /**
   * §5.4 stage 4 — the draft-scoped APPROVE. Core loads the conversation,
   * BUILDS the `PurchaseOrderProposal` ITSELF from the accepted quote
   * revision and the snapshotted vouch entries — the caller supplies no
   * order, the same shape as catalog publish taking a draft id and no
   * item list — runs `verifyOrderAgainstQuote`, and mints the
   * SOURCE-BOUND retained approval through the shared machinery.
   * Provenance is Core's own fact: this path is UNCONDITIONALLY
   * presence-gated and fails closed; on a no-presence deployment a
   * photo-derived order is unapprovable and the app says so.
   */
  router.post('/v1/commerce/orders/drafts/approve', async (req): Promise<CoreResponse> => {
    const caller = staffOrOwnerCaller(req, ownerOnlyGuard);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // UNCONDITIONAL: no verifier means no approval on this path, full
    // stop — for the caller's OWN presence kind (§6.4: attributed).
    if (caller.kind === 'owner') {
      if (!ownerPresenceCanBeEstablished()) {
        return { status: 503, body: { error: 'presence_unavailable', detail: 'photo-derived orders are unapprovable on this deployment' } };
      }
      if (!ownerPresentNow(Date.now())) {
        return { status: 403, body: { error: 'no_user_presence' } };
      }
    } else {
      if (!staffPresenceCanBeEstablished()) {
        return { status: 503, body: { error: 'staff_presence_unavailable' } };
      }
      if (!staffPresentNow(caller.deviceDid, Date.now())) {
        return { status: 403, body: { error: 'no_user_presence' } };
      }
      // Grant EXISTENCE before any draft/quote state is read: an
      // ungranted device gets the same 403 whatever exists (§6.5's
      // value gate still runs below, at the bound quote total).
      const live = runtime.staffGrants.get(caller.deviceDid, 'commerce_submit');
      if (live === null || live.revokedAt !== null) {
        return { status: 403, body: { error: 'access_denied', reason: 'no live staff grant for this scope' } };
      }
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : '';
    if (draftId === '') return { status: 400, body: { error: 'draft_id_required' } };
    if (conversationId === '') return { status: 400, body: { error: 'conversation_id is required' } };

    const draft = runtime.orderDrafts.get(draftId);
    if (draft === null) return { status: 404, body: { error: 'no_such_draft' } };
    const conversation = draft.conversations.find((c) => c.conversationId === conversationId);
    if (conversation === undefined) {
      return { status: 404, body: { error: 'no_such_conversation' } };
    }
    if (conversation.quoteDigest === null) {
      return { status: 409, body: { error: 'no_accepted_quote' } };
    }
    // The quote id the SETTLE retained beside the digest; a caller may still
    // name one, and a named one wins so a test can address a revision family
    // directly, but the surface never has to carry it.
    const quoteId =
      typeof body.quote_id === 'string' && body.quote_id !== ''
        ? body.quote_id
        : (conversation.quoteId ?? '');
    if (quoteId === '') return { status: 409, body: { error: 'quote_not_held' } };
    // The EXACT accepted revision, from Core's own verified store — never
    // a quote the caller carried in.
    const revisions = runtime.buyerQuotes.chain(conversation.supplierDid, quoteId);
    const quote = revisions.find((q) => q.quote_digest === conversation.quoteDigest);
    if (quote === undefined) {
      return { status: 409, body: { error: 'quote_not_held', detail: 'the accepted revision is not in the verified store' } };
    }
    // The quote must answer THIS conversation's request — a held quote for
    // some other exchange, even from the same supplier, prices different
    // terms than what this conversation's snapshot means.
    if (quote.request_id !== conversation.requestId) {
      return { status: 409, body: { error: 'quote_answers_foreign_request' } };
    }

    if (caller.kind === 'staff') {
      // §6.5 — commerce_submit gates the buyer approve at the BOUND
      // quote total. Over the cap or off-currency: an owner card, the
      // approved-value read-back letting the retry through.
      const gate = checkStaffOperation({
        repository: runtime.staffGrants,
        deviceDid: caller.deviceDid,
        scope: 'commerce_submit',
        installRole: 'buyer',
        value: quote.total,
      });
      if (gate.verdict === 'refuse') {
        return { status: 403, body: { error: 'access_denied', reason: gate.reason } };
      }
      if (gate.verdict === 'escalate') {
        const escalated = escalateStaffOperation({
          deviceDid: caller.deviceDid,
          scope: 'commerce_submit',
          subject: `${draftId}:${conversationId}`,
          value: quote.total,
          reason: gate.reason,
          nowMs: Date.now(),
        });
        if (escalated.kind === 'unavailable') {
          return { status: 403, body: { error: 'access_denied', reason: 'approval subsystem unavailable' } };
        }
        if (escalated.kind === 'escalated') {
          return { status: 202, body: { status: 'pending_approval', task_id: escalated.taskId } };
        }
      }
    }

    const self = ownerDid();
    if (self === null) return { status: 503, body: { error: 'node_identity_unavailable' } };

    // CORE BUILDS THE ORDER — deterministic construction over the quote's
    // own lines, quantities and total; the §9.1 arithmetic was verified
    // when the quote was accepted, and `verifyOrderAgainstQuote` re-binds
    // this order to that one exact revision below.
    const projection =
      body.projection !== null && typeof body.projection === 'object'
        ? completeProjection(body.projection as Record<string, unknown>)
        : body.projection;
    if (projection === null || typeof projection !== 'object') {
      return { status: 400, body: { error: 'projection is required' } };
    }
    const invalidProjection = validateDeliveryProjection(projection, hash);
    if (invalidProjection !== null) {
      return { status: 400, body: { error: 'invalid_projection', detail: invalidProjection } };
    }
    // §9.9 — the order projection may only EXTEND the projection the quote
    // priced, and the yardstick is the request THIS NODE retained when it
    // asked. On the draft path Core sent that request itself, so a missing
    // retained row is a broken node, not a documented skip: fail closed.
    const retainedRequest = runtime.buyerQuoteRequests.get(quote.request_id);
    if (retainedRequest === null) {
      return { status: 409, body: { error: 'request_not_retained' } };
    }
    const purchaseOrderId = `po_${bytesToHex(randomBytes(12))}`;
    const orderDraftBody = {
      protocol_version: '1.0',
      purchase_order_id: purchaseOrderId,
      buyer_did: quote.buyer_did,
      supplier_did: quote.supplier_did,
      quote_id: quote.quote_id,
      quote_digest: quote.quote_digest,
      accepted_lines: quote.lines.map((line) => ({
        line_id: line.line_id,
        product: line.offered_product,
        quantity: line.quantity,
      })),
      delivery: projection as Record<string, unknown>,
      approved_total: quote.total,
      accepted_terms_digest: quote.terms_digest,
      idempotency_key: purchaseOrderId,
      submitted_at: new Date(Date.now()).toISOString(),
    };
    const order = {
      ...orderDraftBody,
      order_digest: commerceRecordDigest('order', orderDraftBody as Record<string, unknown>, hash),
    } as unknown as PurchaseOrderProposal;
    const invalidOrder = validatePurchaseOrderProposal(order, hash);
    if (invalidOrder !== null) {
      return { status: 422, body: { error: 'order_build_failed', detail: invalidOrder } };
    }
    const against = verifyOrderAgainstQuote(
      order,
      quote,
      retainedRequest.delivery.projection as unknown as Record<string, unknown>,
    );
    if (against !== null) {
      return { status: 409, body: { error: 'order_quote_mismatch', detail: against } };
    }

    // §5.5 — THE DIVERGENCE WARNING, computed here because this response IS
    // the approval card's content: the buyer sees it exactly where they
    // decide. Deterministic two-tier arithmetic against the resolved
    // candidate's own evidence; a pair with no comparable basis or no
    // reference price gets its badge STATED, never guessed. Approvable
    // either way — Law 1: no order can dispatch without the owner reviewing
    // this very card, so silence causes no harm.
    const buyerSettings = runtime.settings.readBuyer();
    const thresholdPct =
      buyerSettings.ok && buyerSettings.settings.divergenceThresholdPct !== undefined
        ? buyerSettings.settings.divergenceThresholdPct
        : undefined;
    const divergence = quote.lines.map((line) => {
      const draftLine = draft.lines.find((l) => l.lineId === line.line_id);
      const resolution = draftLine?.resolution;
      if (resolution?.kind !== 'resolved') {
        return { line_id: line.line_id, verdict: { kind: 'no_reference_price' as const } };
      }
      // Page items are `unknown[]` on the wire type; each candidate is
      // re-validated before it becomes a reference anything is measured by.
      const item = (draftLine?.evidence?.page.items ?? [])
        .filter((candidate): candidate is CatalogItem => validateCatalogItem(candidate) === null)
        .find(
          (i) =>
            i.product.scheme === resolution.product.scheme &&
            i.product.value === resolution.product.value &&
            i.product.issuer_did === resolution.product.issuer_did,
        );
      if (item === undefined) {
        return { line_id: line.line_id, verdict: { kind: 'no_reference_price' as const } };
      }
      return {
        line_id: line.line_id,
        verdict: checkPriceDivergence({
          quoted: { unitPrice: line.unit_price, priceBasis: line.price_basis },
          item,
          resolvedProduct: resolution.product,
          ...(thresholdPct !== undefined ? { thresholdPct } : {}),
        }),
      };
    });

    // The SOURCE BINDING, Core-derived at mint from the draft's CURRENT
    // state — the submit-time check then verifies these same generations.
    const source = {
      origin: 'photo_order_draft' as const,
      binding_version: 1 as const,
      draft_id: draft.draftId,
      conversation_id: conversation.conversationId,
      assignment_generations: conversation.lineIds.map((lineId) => ({
        line_id: lineId,
        generation: draft.lines.find((l) => l.lineId === lineId)?.assignmentGeneration ?? -1,
      })),
      requirement_generations: draft.requirements.map((r) => ({
        key: r.key,
        generation: r.generation,
      })),
      snapshot_digest: conversation.snapshotDigest ?? '0'.repeat(64),
    };

    // The ACTING INSTALL is discovered from THIS NODE's registry — on the
    // draft path the caller supplies no install claim, so Core names the
    // active buyer pack itself and `resolveActingInstall` then verifies
    // that discovery through the same gate every claimed install passes.
    const installRepo = getPluginInstallRepository();
    if (installRepo === null) {
      return { status: 503, body: { error: 'install_registry_unavailable' } };
    }
    const activeBuyerInstall = installRepo
      .list()
      .find((i) => i.pluginId === BUYER_REFERENCE_MANIFEST.plugin_id && i.status === 'active');
    if (activeBuyerInstall === undefined) {
      return { status: 403, body: { error: 'buyer_pack_not_installed' } };
    }

    // The retained-approval machinery, invoked INTERNALLY — Core derives
    // the card's context from the quote it verified.
    const context: BuyerApprovalContext = {
      actingBusinessDid: self,
      principal: {
        principalDid: self,
        authorityDomain: BUYER_ORDER_AUTHORITY_DOMAIN,
        policyRevision: null,
      },
      serviceUri: `at://${quote.supplier_did}/com.dinakernel.service.profile/self`,
      displayedLabels: Object.fromEntries(
        quote.lines.map((line) => [line.line_id, line.offered_product.value]),
      ),
      productKeys: Object.fromEntries(
        quote.lines.map((line) => [
          line.line_id,
          `${line.offered_product.scheme}:${line.offered_product.value}`,
        ]),
      ),
      linePrices: Object.fromEntries(quote.lines.map((line) => [line.line_id, line.unit_price])),
      charges: [],
      quoteRevision: Number(quote.quote_revision),
      quoteExpiresAt: quote.valid_until,
      // Core's own discovery, re-verified below — never a caller's claim.
      install: {
        installId: activeBuyerInstall.installId,
        capabilityId: 'com.dinakernel.commerce.place-order',
        manifestCid: activeBuyerInstall.currentCid,
        installScopeHash: activeBuyerInstall.installScopeHash,
        configRevision: String(activeBuyerInstall.configRevision),
      },
      source,
      // §6.4 — WHO vouched: the staff device DID on the staff path, the
      // owner otherwise. Authority stays the owner's (the grant IS the
      // owner's standing authorization); attribution names the human.
      ...(runtime.attributionBoundary.crossedAt() === null
        ? {}
        : {
            attribution: {
              version: 2 as const,
              vouchedBy: caller.kind === 'staff' ? caller.deviceDid : self,
            },
          }),
    };
    const resolvedInstall = resolveActingInstall(context, BUYER_REFERENCE_MANIFEST.plugin_id);
    if (!resolvedInstall.ok) {
      return {
        status: resolvedInstall.refusal === 'install_registry_unavailable' ? 503 : 403,
        body: { error: resolvedInstall.refusal, detail: resolvedInstall.detail },
      };
    }
    const built = buildBuyerApprovalPayload(order, resolvedInstall.context);
    if (!built.ok) {
      return { status: 422, body: { error: 'approval_incomplete', missing: built.missing } };
    }
    const listing = resolveServiceBinding({
      serviceUri: resolvedInstall.context.serviceUri,
      supplierDid: order.supplier_did,
    });
    if (!listing.ok) {
      return { status: 400, body: { error: listing.refusal, detail: listing.detail } };
    }
    const now = Date.now();
    const approvalId = newApprovalId();
    if (
      !runtime.orderApprovals.put({
        approvalId,
        order,
        context: resolvedInstall.context,
        serviceRkey: listing.serviceRkey,
        createdAt: now,
        expiresAt: now + ORDER_APPROVAL_TTL_MS,
      })
    ) {
      return { status: 409, body: { error: 'approval_not_retained' } };
    }
    conversation.approvalId = approvalId;
    conversation.state = 'approved';
    draft.updatedAtMs = now;
    runtime.orderDrafts.put(draft);
    recordCommerceEvent({
      event: 'approval',
      lane: 'order',
      draftId: draft.draftId,
      conversationId: conversation.conversationId,
      supplierDid: conversation.supplierDid,
      atMs: now,
    });
    return {
      status: 200,
      body: {
        ok: true,
        approval_id: approvalId,
        approved: built.payload,
        purchase_order_id: purchaseOrderId,
        expires_at: now + ORDER_APPROVAL_TTL_MS,
        // §5.5 — per-line, beside the decision it informs.
        divergence,
      },
    };
  });

  /**
   * §5.1's submission protocol — the NAMED ORCHESTRATOR, the submit sibling
   * of the draft-scoped approve route, and necessarily so: only step 1
   * creates the dispatch intent that the source-binding check verifies, so
   * an app calling `/orders/submit` directly with a photo-minted approval
   * fails closed BY DESIGN. The steps:
   *
   *   (1) persist, in ONE draft-store transaction, the approval RESERVED
   *       (referenced, not consumed), the competing assignments closed
   *       (their approvals revoked — the courtesy), and a durable dispatch
   *       intent carrying the purchase-order id;
   *   (2) dispatch through the single path `/orders/submit` uses;
   *   (3) record which of the FOUR outcome classes step 2 landed in.
   *
   * A crash between (1) and (3) replays from the intent row — the
   * `DispatchIntentSweeper`'s duty, record-first.
   */
  router.post('/v1/commerce/orders/drafts/submit', async (req): Promise<CoreResponse> => {
    const caller = staffOrOwnerCaller(req, ownerOnlyGuard);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // §6.5 — presence and grant EXISTENCE before any draft state is
    // read (same posture as approve/decide: an ungranted device learns
    // nothing; the value gate still runs below at the approved total).
    if (caller.kind === 'staff') {
      if (!staffPresentNow(caller.deviceDid, Date.now())) {
        return { status: 403, body: { error: 'access_denied', reason: 'staff presence required' } };
      }
      const live = runtime.staffGrants.get(caller.deviceDid, 'commerce_submit');
      if (live === null || live.revokedAt !== null) {
        return { status: 403, body: { error: 'access_denied', reason: 'no live staff grant for this scope' } };
      }
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : '';
    if (draftId === '') return { status: 400, body: { error: 'draft_id_required' } };
    if (conversationId === '') {
      return { status: 400, body: { error: 'conversation_id is required' } };
    }

    const draft = runtime.orderDrafts.get(draftId);
    if (draft === null) return { status: 404, body: { error: 'no_such_draft' } };
    const conversation = draft.conversations.find((c) => c.conversationId === conversationId);
    if (conversation === undefined) {
      return { status: 404, body: { error: 'no_such_conversation' } };
    }
    if (conversation.state === 'submitting') {
      // A live intent already exists and the sweeper owns its replay; a
      // second begin here is a double-tap, not a second order.
      return { status: 409, body: { error: 'submit_in_flight' } };
    }
    if (conversation.state !== 'approved' || conversation.approvalId === null) {
      return { status: 409, body: { error: 'not_approvable', state: conversation.state } };
    }
    const approvalId = conversation.approvalId;
    // The intent must carry the purchase-order id so crash replay can
    // resolve RECORD-FIRST even after the approval row is gone; the
    // retained card is where that id lives.
    const approval = runtime.orderApprovals.get(approvalId);
    if (approval === null) {
      return { status: 404, body: { error: 'unknown_approval' } };
    }

    if (caller.kind === 'staff') {
      // §6.5 — commerce_submit also gates the SEND: "every confirmed
      // draft must still pass" submit, and the cap compares the retained
      // approval's own bound total, never a caller value.
      const gate = checkStaffOperation({
        repository: runtime.staffGrants,
        deviceDid: caller.deviceDid,
        scope: 'commerce_submit',
        installRole: 'buyer',
        value: approval.payload.approvedTotal,
      });
      if (gate.verdict === 'refuse') {
        return { status: 403, body: { error: 'access_denied', reason: gate.reason } };
      }
      if (gate.verdict === 'escalate') {
        const escalated = escalateStaffOperation({
          deviceDid: caller.deviceDid,
          scope: 'commerce_submit',
          subject: `${draftId}:${conversationId}`,
          value: approval.payload.approvedTotal,
          reason: gate.reason,
          nowMs: Date.now(),
        });
        if (escalated.kind === 'unavailable') {
          return { status: 403, body: { error: 'access_denied', reason: 'approval subsystem unavailable' } };
        }
        if (escalated.kind === 'escalated') {
          return { status: 202, body: { status: 'pending_approval', task_id: escalated.taskId } };
        }
      }
    }

    const service = new OrderDraftService({
      drafts: runtime.orderDrafts,
      now: () => Date.now(),
      sha256: hash,
      userPresent: () =>
        caller.kind === 'staff'
          ? staffPresentNow(caller.deviceDid, Date.now())
          : ownerPresentNow(Date.now()),
      attributionBoundary: runtime.attributionBoundary,
      vouchedBy: () => (caller.kind === 'staff' ? caller.deviceDid : getNodeDID()),
    });
    const intentId = `odi_${bytesToHex(randomBytes(12))}`;

    // STEP 1 — the one transaction §5.1 names, competitor approvals
    // revoked inside it (the courtesy; submit-time staleness is the
    // enforcement).
    let begun: ReturnType<OrderDraftService['beginSubmit']> = {
      ok: false,
      refusal: 'transaction_not_run',
      detail: 'the draft-store transaction never executed',
    };
    runtime.runInTransaction(() => {
      begun = service.beginSubmit(draftId, {
        conversationId,
        intentId,
        purchaseOrderId: approval.order.purchase_order_id,
      });
      if (begun.ok) {
        for (const revoked of begun.revokedApprovalIds ?? []) {
          runtime.orderApprovals.consume(revoked, Date.now());
        }
      }
    });
    if (!begun.ok) {
      return { status: 409, body: { error: begun.refusal, detail: begun.detail } };
    }

    // STEP 2 — the single dispatch path.
    const answer = await dispatchUnderRetainedApproval(runtime, approvalId, Date.now());

    // STEP 3 — record the outcome class. A pre-send refusal never consumed
    // the card and it bound a quote context that is now dead: invalidated
    // here, competitors reopened by the service's refused arm.
    const klass = classifyDispatchAnswer(answer);
    runtime.runInTransaction(() => {
      service.recordSubmitOutcome(draftId, {
        conversationId,
        ...(klass.kind === 'refused'
          ? { kind: 'refused' as const, reason: klass.reason }
          : klass.kind === 'transient'
            ? { kind: 'transient' as const, reason: klass.reason }
            : { kind: klass.kind }),
      });
      if (klass.kind === 'refused') runtime.orderApprovals.consume(approvalId, Date.now());
    });
    recordCommerceEvent({
      event: 'dispatch_outcome',
      lane: 'order',
      draftId,
      conversationId,
      state: klass.kind,
      ...(klass.kind === 'refused' || klass.kind === 'transient' ? { refusal: klass.reason } : {}),
      atMs: Date.now(),
    });
    return {
      status: answer.status,
      body: { ...answer.body, dispatch_class: klass.kind, intent_id: intentId },
    };
  });

  router.post('/v1/commerce/orders/command', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as {
      supplier_did?: unknown;
      purchase_order_id?: unknown;
      action?: unknown;
      approval_id?: unknown;
    };
    const supplierDid = typeof body.supplier_did === 'string' ? body.supplier_did : '';
    const purchaseOrderId =
      typeof body.purchase_order_id === 'string' ? body.purchase_order_id : '';
    const action = typeof body.action === 'string' ? body.action : '';
    if (supplierDid === '' || purchaseOrderId === '') {
      return { status: 400, body: { error: 'supplier_did and purchase_order_id are required' } };
    }

    const record = runtime.buyerOrders.get(supplierDid, purchaseOrderId);
    if (record === null) return { status: 404, body: { error: 'unknown_order' } };

    // THE AUTHORIZATION IS THE PROJECTION. `describeOrderForOwner` decides what
    // an owner may do with an order; asking it here means the card and the
    // command can never disagree, and in particular means `resend` can only be
    // performed where the card offered it. Re-deriving the rule from the state
    // name is exactly how the two drift.
    const view = describeOrderForOwner(record);
    if (!(view.actions as string[]).includes(action)) {
      return {
        status: 409,
        // The projection travels WITH the refusal so a stale card can re-render
        // from the same answer rather than fetching again to find out why. The
        // error fields come last: the view carries its own owner-facing
        // `detail`, and letting the spread win would replace the reason with an
        // unrelated sentence.
        body: {
          ...view,
          error: 'action_not_offered',
          offered: view.actions,
        },
      };
    }

    if (action === 'reconcile_now') {
      const dispatch = getCommerceServiceQueryDispatch();
      if (dispatch === null) {
        return { status: 503, body: { error: 'no_outbound_transport' } };
      }
      const result = await askReconcilePolls({
        send: makeServiceQueryReconcileSend({ dispatch }),
        nowMs: Date.now(),
        only: { supplierDid, purchaseOrderId },
      });
      // The ANSWER does not arrive here — it comes back later on the response
      // lane. Reporting "asked" rather than an outcome is the honest shape, and
      // it is the same shape the sweep reports.
      const asked = result.asked === 1;
      return {
        status: asked ? 200 : 409,
        body: {
          ok: asked,
          asked,
          ...(asked ? {} : { error: result.undescribable === 1 ? 'undescribable' : 'not_sent' }),
          ...describeOrderForOwner(runtime.buyerOrders.get(supplierDid, purchaseOrderId) ?? record),
        },
      };
    }

    if (action === 'check_status') {
      const dispatch = getCommerceServiceQueryDispatch();
      if (dispatch === null) {
        return { status: 503, body: { error: 'no_outbound_transport' } };
      }
      if (record.serviceRkey === '') {
        // A record written before the listing was stored. Refused rather than
        // guessed at: a query with no service_uri is checked against the
        // supplier's DEFAULT listing, so guessing would ask the wrong one and
        // be refused by exactly the suppliers who run more than one.
        return { status: 409, body: { ...view, error: 'undescribable' } };
      }
      const ask = makeServiceQueryStatusAsk({ dispatch });
      const asked = await ask({
        supplierDid,
        serviceRkey: record.serviceRkey,
        purchaseOrderId,
        // Where this node's VERIFIED chain ends — read from the store, never
        // from the display state. Asking from a position we have not actually
        // verified would leave a gap the succession check cannot cross.
        ...heldSequence(runtime, supplierDid, purchaseOrderId),
      });
      // The ANSWER arrives later on the response lane and is verified there
      // against the held chain. Reporting only whether the question left is
      // the same honest shape `reconcile_now` uses.
      return {
        status: asked.sent ? 200 : 409,
        body: {
          ok: asked.sent,
          asked: asked.sent,
          ...(asked.sent ? {} : { error: 'not_sent' }),
          ...view,
          ...fulfilmentOf(runtime, supplierDid, purchaseOrderId),
        },
      };
    }

    if (action === 'resend') {
      const send = getBuyerOrderSender();
      if (send === null) return { status: 503, body: { error: 'buyer_sender_unavailable' } };
      // A RESEND NEEDS ITS OWN CARD. The approval is rebuilt and re-verified
      // rather than carried over from the first attempt: the order is
      // unchanged, but which install, which capability, which manifest CID and
      // which config revision are about to send it may not be — and §15.2 says
      // a swap of any of those is a different act by a different actor. So the
      // owner prepares again and names the new card here.
      const approvalId = typeof body.approval_id === 'string' ? body.approval_id : '';
      if (approvalId === '') {
        return { status: 400, body: { error: 'approval_id is required to resend' } };
      }
      const held = readAnswerableApproval(runtime, approvalId, Date.now());
      if (!held.ok) return held.response;
      // The card must name the order being resent. Without this a card
      // prepared for one purchase could send another, which is precisely the
      // substitution §15.2 exists to stop.
      if (
        held.approval.order.supplier_did !== supplierDid ||
        held.approval.order.purchase_order_id !== purchaseOrderId
      ) {
        return { status: 409, body: { error: 'approval_is_for_another_order' } };
      }
      const authorised = resolveAuthority(
        held.approval.order,
        held.approval.context,
        held.approval.serviceRkey,
      );
      if (!authorised.ok) return authorised.response;
      const result = await submitApprovedOrder({
        authority: authorised.authority,
        order: held.approval.order,
        approved: held.approval.payload,
        context: held.approval.context,
        serviceRkey: held.approval.serviceRkey,
        send,
        nowMs: Date.now(),
        resend: true,
      });
      if (result.ok) runtime.orderApprovals.consume(approvalId, Date.now());
      if (!result.ok) {
        return {
          // A resend is a send: same three answers. See `unanswerableStatus`.
          status: unanswerableStatus(result.refusal),
          body: { ok: false, refusal: result.refusal, error: result.error, record: result.record },
        };
      }
      return { status: 200, body: { ok: true, ...describeOrderForOwner(result.record) } };
    }

    // `wait` and `view_acknowledgement` are not commands. The first is the
    // absence of one and the second is a read the projection already answers;
    // performing either would be inventing a side effect for a button that has
    // none.
    return { status: 400, body: { error: 'action_is_not_a_command', action } };
  });

  router.get('/v1/commerce/quotes', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) {
      // Distinguishable from "you have issued no quotes", for the same reason
      // the census is: an empty list from a node with no commerce has not
      // earned the reassurance an empty list from a working one carries.
      return { status: 503, body: { error: 'commerce_unavailable' } };
    }

    const now = Date.now();
    return {
      status: 200,
      body: {
        quotes: runtime.families
          .listForOwner()
          .map(({ head, usesSpent }) => describeQuoteForOwner(head, usesSpent, now)),
      },
    };
  });

  router.get('/v1/commerce/orders/unsettled', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) {
      // Distinguishable from "nothing is outstanding", for the same reason the
      // census is: an empty list from a node with no commerce has not earned
      // the reassurance an empty list from a working one carries.
      return { status: 503, body: { error: 'commerce_unavailable' } };
    }

    return {
      status: 200,
      body: {
        orders: runtime.buyerOrders.listUnsettled().map((entry) => ({
          supplierDid: entry.supplierDid,
          ...describeOrderForOwner(entry.record),
        })),
      },
    };
  });
}

/**
 * The buyer's decision surface (§13.2–§13.6).
 *
 * TWO CALLS RATHER THAN ONE, because they happen at different times with a
 * network round trip between them: plan who to ask, send the queries through
 * the service-query lane that already owns egress, then rank what came back.
 * Collapsing them into one endpoint would force this route to send — putting a
 * second egress path beside the one the four gates guard.
 *
 * OWNER-ONLY. A shortlist names which suppliers this buyer is about to
 * approach and a ranking names what they charge; both are the owner's
 * commercial position and neither belongs to a plugin or a paired agent.
 */
function registerProcurementRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may plan or choose procurement',
  );

  router.post('/v1/commerce/procurement/plan', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as { candidates?: unknown; policy?: unknown };
    if (!Array.isArray(body.candidates)) {
      return { status: 400, body: { error: 'candidates must be an array' } };
    }
    const policy = body.policy;
    if (policy === null || typeof policy !== 'object') {
      return { status: 400, body: { error: 'policy is required' } };
    }
    const buyerDid = (policy as { buyer_did?: unknown }).buyer_did;
    if (typeof buyerDid !== 'string' || buyerDid === '') {
      // The buyer's own DID is what stops a fan-out quoting itself, so it is
      // required rather than defaulted — a default would be this route
      // guessing whose money is at stake.
      return { status: 400, body: { error: 'policy.buyer_did is required' } };
    }
    // §18.2 — the OWNER's settings decide the ceiling and who is blocked, not
    // the request body. A client-supplied ceiling above the owner's would be a
    // client overriding policy, and a blocked-supplier list that only the UI
    // knows is a list nothing enforces.
    const runtime = getCommerceRuntime();
    const configured = runtime === null ? null : runtime.settings.readBuyer();
    const settings = configured !== null && configured.ok ? configured.settings : null;

    const requested = (policy as { max_suppliers?: unknown }).max_suppliers;
    const ceiling =
      settings === null
        ? typeof requested === 'number'
          ? requested
          : undefined
        : // The owner's ceiling is a maximum, so a smaller request is honoured
          // and a larger one is not. Silently raising it would let a client
          // spend the owner's fan-out budget for them.
          Math.min(
            effectiveFanoutCeiling(settings),
            typeof requested === 'number' ? requested : Number.MAX_SAFE_INTEGER,
          );

    const blocked = new Set(settings?.blockedSuppliers ?? []);
    const candidates = (body.candidates as { supplierDid?: unknown }[]).filter(
      (candidate) => !blocked.has(String(candidate.supplierDid)),
    );

    return {
      status: 200,
      body: planProcurement(candidates as never, {
        buyerDid,
        ...(ceiling === undefined ? {} : { maxSuppliers: ceiling }),
      }),
    };
  });

  router.post('/v1/commerce/procurement/choose', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as { offers?: unknown; requirements?: unknown; at?: unknown };
    if (!Array.isArray(body.offers)) {
      return { status: 400, body: { error: 'offers must be an array' } };
    }
    const requirements = body.requirements;
    if (requirements === null || typeof requirements !== 'object') {
      return { status: 400, body: { error: 'requirements is required' } };
    }
    // The evaluation instant is supplied, not read from the clock: expiry is
    // one of the hard filters, so an owner reviewing a stored shortlist must
    // get the same answer they got when it was fetched.
    const at = typeof body.at === 'string' ? body.at : new Date().toISOString();
    // A malformed offer or requirement makes the ranking THROW — quantities
    // are parsed, currencies compared, instants read. On an owner route a
    // throw is a 500, which says "this node is broken" about a request that
    // was merely wrong. Answer 400 and name nothing beyond the fact: the body
    // is the caller's own, so there is nothing to disclose, but there is also
    // no reason to hand back a stack.
    try {
      const chosen = chooseOffer({
        offers: body.offers as never,
        requirements: requirements as never,
        atIso: at,
      });
      // §18.4 — the CARD travels with the decision. Building it here rather
      // than leaving each client to render from the raw ranking is what makes
      // "useful on the generic CardSpec fallback" true on every surface at
      // once; two renderers deriving their own headline is how one of them
      // ends up offering "Buy now".
      return {
        status: 200,
        body: {
          ...chosen,
          card: buildComparisonCard({
            request: {
              label:
                typeof (requirements as { label?: unknown }).label === 'string'
                  ? (requirements as { label: string }).label
                  : 'requested item',
              quantity: (requirements as { quantity: never }).quantity,
            },
            ranking: chosen.ranking,
          }),
        },
      };
    } catch (error) {
      return {
        status: 400,
        body: {
          error: 'offers or requirements are malformed',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

/**
 * Buyer and supplier settings (§18.2, §18.3, WS-7.2 / WS-7.3).
 *
 * OWNER-ONLY, and not merely because it is a settings screen. These records
 * are what a fan-out ceiling, a blocked-supplier list and a paused listing
 * MEAN — a plugin that could write them could quietly re-open a listing its
 * owner closed.
 *
 * A refusal is a 400 carrying every finding, not the first one: an owner
 * fixing a settings screen one refusal at a time is an owner who gives up on
 * the third round trip.
 */
function registerSettingsRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may read or change settings',
  );

  router.post('/v1/commerce/install/plan', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const choice = (req.body as { choice?: unknown } | null)?.choice;
    if (choice !== 'buy' && choice !== 'sell' && choice !== 'both') {
      // Not defaulted. Guessing between buying and selling would install
      // authority the owner never chose, and "both" is the guess that installs
      // the most.
      return { status: 400, body: { error: "choice must be 'buy' | 'sell' | 'both'" } };
    }
    const plan = planCommerceInstall(choice);
    // A plan is a PROPOSAL. Nothing is installed here — the install machinery
    // owns repo proofs, pending expiry and activation, and a route that both
    // planned and installed would put a consent decision behind one tap.
    return plan.ok
      ? {
          status: 200,
          body: {
            ok: true,
            installs: plan.installs.map((install) => ({
              role: install.role,
              plugin_id: install.manifest.plugin_id,
              consent_label: install.consentLabel,
            })),
          },
        }
      : { status: 409, body: { ok: false, findings: plan.findings } };
  });

  /**
   * §18.1 — the plan's execution, one role at a time. Three separate owner
   * calls (begin / bind_device / confirm) because that is the §14 shape the
   * install machinery enforces: begin creates a PENDING row, the pairing
   * ceremony binds the runner device, and confirm is the consent decision.
   * Collapsing them would put consent behind one tap — the exact thing the
   * plan route's comment refuses.
   *
   * FIRST-PARTY ONLY. The body names a role; the manifest comes from the
   * compiled-in table inside `beginReferenceInstall`. No caller-supplied
   * manifest can reach the install machinery through this surface.
   */
  router.post('/v1/commerce/install/begin', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const role = (req.body as { role?: unknown } | null)?.role;
    if (role !== 'buyer' && role !== 'supplier') {
      return { status: 400, body: { error: "role must be 'buyer' | 'supplier'" } };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
    // Idempotent against a finished ceremony: an ACTIVE install for the role
    // is an answer, not an error — re-running the flow must not stack a
    // second consent for authority the owner already granted.
    const plan = planCommerceInstall(role === 'buyer' ? 'buy' : 'sell');
    if (!plan.ok) return { status: 409, body: { ok: false, findings: plan.findings } };
    const pluginId = plan.installs[0]?.manifest.plugin_id ?? '';
    const existing = getPluginInstallRepository()
      ?.list()
      .find((install) => install.pluginId === pluginId && install.status === 'active');
    if (existing !== undefined) {
      return {
        status: 200,
        body: { ok: true, install_id: existing.installId, plugin_id: pluginId, status: 'active' },
      };
    }
    const begun = beginReferenceInstall({ role, publisherDid: owner, nowMs: Date.now() });
    if (!begun.ok) {
      return { status: 409, body: { ok: false, error: begun.code, detail: begun.message } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        install_id: begun.installId,
        plugin_id: pluginId,
        status: 'pending',
        consent: begun.consent,
      },
    };
  });

  router.post('/v1/commerce/install/bind_device', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.install_id !== 'string' || typeof body.device_did !== 'string') {
      return { status: 400, body: { error: 'install_id and device_did are required' } };
    }
    const installs = getPluginInstallRepository();
    if (installs === null) return { status: 503, body: { error: 'plugin_registry_unavailable' } };
    const bound = installs.bindPendingDevice(body.install_id, body.device_did, Date.now());
    return bound
      ? { status: 200, body: { ok: true } }
      : { status: 409, body: { error: 'bind_refused' } };
  });

  router.post('/v1/commerce/install/confirm', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.install_id !== 'string' || body.install_id === '') {
      return { status: 400, body: { error: 'install_id_required' } };
    }
    const deviceDid = typeof body.device_did === 'string' ? body.device_did : undefined;
    const activated = confirmConsent(body.install_id, deviceDid, Date.now());
    return activated
      ? { status: 200, body: { ok: true, status: 'active' } }
      : { status: 409, body: { error: 'consent_refused' } };
  });

  /**
   * Retire an install — the owner's teardown, through the EXISTING
   * `uninstall` machinery: refused while obligations are open (§16.4), the
   * paired runner device durably revoked before the row is deleted, and a
   * retained row on revoke failure so the abandoned-install sweeper can
   * finish the job. Needed the day the compiled reference manifest changes:
   * the active install pins the old bytes, and replacing it is retire +
   * a fresh begin/consent ceremony.
   */
  router.post('/v1/commerce/install/retire', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.install_id !== 'string' || body.install_id === '') {
      return { status: 400, body: { error: 'install_id_required' } };
    }
    let outcome;
    try {
      // A device the registry no longer knows has nothing left to revoke —
      // treating not-found as not-durable would leave the install stuck as a
      // retry anchor for a revoke that can never happen.
      outcome = await uninstall(body.install_id, Date.now(), async (deviceDid) => {
        const revoked = await revokeDeviceByDidDurable(deviceDid);
        return { durable: revoked.durable || !revoked.found };
      });
    } catch (err) {
      // §16.4 — open obligations refuse the teardown; the operator resolves
      // them first. Surfaced as a refusal, not a crash.
      return {
        status: 409,
        body: { error: 'obligations_open', detail: err instanceof Error ? err.message : String(err) },
      };
    }
    if (outcome === null) return { status: 404, body: { error: 'no_such_install' } };
    return outcome.removed
      ? { status: 200, body: { ok: true, removed: true } }
      : { status: 409, body: { error: 'retire_incomplete', detail: 'device revoke not durable; row retained for the sweeper' } };
  });

  router.get('/v1/commerce/inbox', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    // §18.1/FR-P1 — asked PER ROLE, never "is any commerce install present".
    // That shortcut is exactly what a superset install would have made
    // correct, and answering an empty inbox to a node that never installed
    // the supplier side would read as "nothing needs you" when the truth is
    // "you are not selling".
    const installs = getPluginInstallRepository()?.list() ?? [];
    if (installs.length > 0 && !roleIsInstalled(installs, 'supplier')) {
      return { status: 409, body: { error: 'supplier_not_installed' } };
    }

    const settings = runtime.settings.readSupplier();
    // READ ONCE. The projection and the cancellation scan must describe the
    // same set of orders; two reads could disagree and offer an action for an
    // order the card no longer shows.
    const reserved = runtime.orders.listReserved();
    return {
      status: 200,
      body: buildSupplierInbox({
        undecided: reserved,
        // Settings that do not validate are treated as ABSENT here rather than
        // failing the whole inbox: an operator with a broken settings row still
        // needs to see the orders waiting on them, and the settings route is
        // where that fault is reported.
        settings: settings.ok ? settings.settings : null,
        // §18.3 — the broker's own record of whether each credential's last
        // call worked, which outranks whatever the settings row declares.
        credentials: runtime.broker.statuses(),
        // §12.5 — which of those orders has a cancellation parked for a
        // human. Scanned per order rather than by a global index, because
        // the record of a parked cancellation IS the receipt store and a
        // second index could disagree with the evidence. The list is the
        // undecided orders, which is short by construction.
        cancellationsAwaitingReview: pendingReviewOrders(runtime, reserved),
        nowMs: Date.now(),
      }),
    };
  });

  /**
   * §12.5 — settle a cancellation this node parked for a human review.
   *
   * THE ONE WAY OUT OF `pending_review`. `resolveCancellation` deliberately
   * refuses to leave that state, because the review closes when the OWNER
   * decides and never because a buyer resent the request — so without this
   * route the engine's finalization was written, tested, and unreachable, and
   * an order whose external effect had fired stayed non-terminal for ever.
   *
   * OWNER-ONLY, and the `result` is required rather than defaulted. A default
   * here would be this node deciding a commercial outcome on the operator's
   * behalf at exactly the moment it has told them it cannot.
   */
  router.post('/v1/commerce/cancellations/finalize', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as {
      buyer_did?: unknown;
      purchase_order_id?: unknown;
      cancellation_id?: unknown;
      result?: unknown;
    };
    const buyerDid = typeof body.buyer_did === 'string' ? body.buyer_did : '';
    const purchaseOrderId =
      typeof body.purchase_order_id === 'string' ? body.purchase_order_id : '';
    const cancellationId = typeof body.cancellation_id === 'string' ? body.cancellation_id : '';
    if (buyerDid === '' || purchaseOrderId === '' || cancellationId === '') {
      return {
        status: 400,
        body: { error: 'buyer_did, purchase_order_id and cancellation_id are required' },
      };
    }
    // The exact set §12.5 allows a review to close with. Checked against a
    // named list rather than "not pending_review", so a future kind added to
    // the protocol cannot become an owner decision nobody designed a card for.
    const FINALIZABLE = ['cancelled', 'refused_already_dispatched', 'refused_policy'] as const;
    const result = FINALIZABLE.find((kind) => kind === body.result);
    if (result === undefined) {
      return { status: 400, body: { error: 'unknown_result', allowed: FINALIZABLE } };
    }

    const settled = runtime.lifecycle.finalizePendingCancellation(
      buyerDid,
      purchaseOrderId,
      cancellationId,
      result,
    );
    if ('error' in settled) return { status: 409, body: { error: settled.error } };
    // The terminal result, verbatim. A replay of an already-decided
    // cancellation returns the SAME record with 200 rather than a conflict:
    // the finalization is idempotent, and an operator whose tap was retried
    // by a flaky connection must see the outcome, not an error.
    return { status: 200, body: { ok: true, result: settled } };
  });

  /**
   * §12.5 — which of these orders is waiting on a human for a cancellation.
   *
   * A read that touches no vault and discloses nothing beyond the order ids
   * the caller already handed in.
   */
  function pendingReviewOrders(
    commerce: NonNullable<ReturnType<typeof getCommerceRuntime>>,
    orders: readonly { buyerDid: string; purchaseOrderId: string }[],
  ): ReadonlySet<string> {
    const awaiting = new Set<string>();
    for (const ref of orders) {
      // One unreadable order must not cost the operator the whole inbox.
      try {
        const pending = commerce.lifecycle.listPendingReviewCancellations(
          ref.buyerDid,
          ref.purchaseOrderId,
        );
        if (pending.length > 0) awaiting.add(ref.purchaseOrderId);
      } catch {
        continue;
      }
    }
    return awaiting;
  }

  for (const kind of ['buyer', 'supplier'] as const) {
    router.get(`/v1/commerce/settings/${kind}`, async (req): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
      const read =
        kind === 'buyer' ? runtime.settings.readBuyer() : runtime.settings.readSupplier();
      if (read.ok) return { status: 200, body: { configured: true, settings: read.settings } };
      // ABSENT and INVALID are different answers. "Not configured yet" is a
      // starting point; "stored settings no longer validate" is a fault an
      // owner has to see, because the node is failing closed on their policy.
      return read.absent
        ? { status: 200, body: { configured: false } }
        : {
            status: 409,
            body: { configured: true, error: 'settings_invalid', findings: read.findings },
          };
    });

    router.put(`/v1/commerce/settings/${kind}`, async (req): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
      const body = req.body;
      if (body === null || typeof body !== 'object') {
        return { status: 400, body: { error: 'settings body is required' } };
      }
      const written =
        kind === 'buyer'
          ? runtime.settings.writeBuyer(body as never)
          : runtime.settings.writeSupplier(body as never);
      return written.ok
        ? { status: 200, body: { ok: true } }
        : { status: 400, body: { ok: false, findings: written.findings } };
    });
  }
}

/**
 * The credential surface (§8.3, §18.3, §6.5 — WS-9.3).
 *
 * WHAT AN OWNER CAN DO HERE: see which connectors have material, when they
 * last replaced it, and whether the last call worked; replace it; remove it;
 * and ask whether changing backend needs their consent again.
 *
 * WHAT NOBODY CAN DO HERE, INCLUDING THE OWNER: read a credential back.
 * §8.3 forbids a generic secret read API, and "the owner is allowed" is how
 * that becomes a route a compromised client calls. The material has exactly
 * one exit — a brokered operation — and this file never touches it. Rotation
 * takes a new value and answers `{ok: true}`; it does not echo, confirm by
 * prefix, or return a fingerprint.
 *
 * OWNER-ONLY, and here that is the strongest form of the guard in this file:
 * these routes decide which install may spend a credential, so a plugin able
 * to write them could grant itself an operation the owner never approved.
 */
function registerCredentialRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may manage connector credentials',
  );

  router.get('/v1/commerce/credentials', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // `statuses()` and not the store: the broker is the read side, and a route
    // that reached the store directly would be one refactor away from reading
    // the column beside it.
    return {
      status: 200,
      body: {
        credentials: runtime.broker.statuses().map((status) => ({
          resource: status.resource,
          install_id: status.installId,
          operations: status.operations,
          rotated_at_ms: status.rotatedAtMs,
          last_result: status.lastResult,
          last_checked_at_ms: status.lastCheckedAtMs,
        })),
      },
    };
  });

  router.put('/v1/commerce/credentials/:resource', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const resource = req.params.resource ?? '';
    const body = (req.body ?? {}) as {
      material?: unknown;
      install_id?: unknown;
      operations?: unknown;
    };
    if (typeof body.material !== 'string') {
      return { status: 400, body: { error: 'material is required' } };
    }
    if (typeof body.install_id !== 'string') {
      return { status: 400, body: { error: 'install_id is required' } };
    }
    if (!Array.isArray(body.operations) || body.operations.some((op) => typeof op !== 'string')) {
      return { status: 400, body: { error: 'operations must be an array of strings' } };
    }

    const written = runtime.credentials.rotate({
      resource,
      installId: body.install_id,
      operations: body.operations,
      material: body.material,
      nowMs: Date.now(),
    });
    // NOTHING about the material comes back — not its length, not a prefix,
    // not a hash. Each of those narrows a guess for anything that can read a
    // response, and none of them helps an owner decide anything.
    return written.ok
      ? { status: 200, body: { ok: true, resource } }
      : { status: 400, body: { ok: false, refusal: written.refusal, error: written.error } };
  });

  router.delete('/v1/commerce/credentials/:resource', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const resource = req.params.resource ?? '';
    // "There was nothing to remove" is a 200 with `removed: false`, not a 404.
    // An owner clearing a credential twice has got what they asked for both
    // times, and a 404 would send a client into an error path over a success.
    return {
      status: 200,
      body: { ok: true, resource, removed: runtime.credentials.forget(resource) },
    };
  });

  router.post('/v1/commerce/connector/change', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as { previous?: unknown; next?: unknown };
    const read = (
      value: unknown,
    ): { domains: string[]; credentialResources: string[]; operations: string[] } | null => {
      if (value === null || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      const strings = (field: unknown): string[] =>
        Array.isArray(field)
          ? field.filter((entry): entry is string => typeof entry === 'string')
          : [];
      return {
        domains: strings(record.domains),
        credentialResources: strings(record.credential_resources),
        operations: strings(record.operations),
      };
    };
    const previous = read(body.previous);
    const next = read(body.next);
    if (previous === null || next === null) {
      // Not defaulted to empty. An absent `previous` read as "declared
      // nothing" would make every field look newly widened, and an absent
      // `next` would make a widening look like an ordinary edit — the
      // dangerous direction of the same mistake.
      return { status: 400, body: { error: 'previous and next declarations are required' } };
    }
    const verdict = classifyConnectorChange(previous, next);
    return {
      status: 200,
      body:
        verdict.kind === 'ordinary_edit'
          ? { requires_reconsent: false }
          : {
              requires_reconsent: true,
              widened: {
                domains: verdict.widened.domains,
                credential_resources: verdict.widened.credentialResources,
                operations: verdict.widened.operations,
              },
            },
    };
  });
}

/**
 * The external order boundary and its evidence (§15.5, §12.7 — WS-9.4 / 9.5).
 *
 *   GET  /v1/commerce/idempotency            → what each connector has proven
 *   PUT  /v1/commerce/idempotency/{r}/{op}   → record a probe
 *   POST /v1/commerce/orders/effect          → cross the boundary, once
 *   POST /v1/commerce/orders/fulfilment      → reconcile external state
 *
 * THE EVIDENCE ROUTE IS NOT A SWITCH. An owner cannot say "retries are fine";
 * they record an OBSERVATION and the verdict follows from it. That distinction
 * is §15.5's whole point — a connector is idempotent because it was shown to
 * be, not because someone ticked a box — and it is why the read route returns
 * the verdict beside the evidence rather than a stored boolean.
 *
 * OWNER-ONLY. Crossing the external boundary spends money; recording evidence
 * decides whether it may be spent twice.
 */
function registerEffectRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may cross or account for the external order boundary',
  );

  /** §15.5's required window, from the node's own configured periods. */
  const requirement = (): RetentionRequirement => DEFAULT_RETENTION_REQUIREMENT;

  router.get('/v1/commerce/idempotency', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const now = Date.now();
    return {
      status: 200,
      body: {
        connectors: runtime.idempotencyEvidence.list().map((evidence) => {
          const verdict = evaluateIdempotencyEvidence({
            evidence,
            requirement: requirement(),
            nowMs: now,
          });
          return {
            resource: evidence.resource,
            operation: evidence.operation,
            declared_retention_ms: evidence.declaredRetentionMs,
            observed: evidence.probe !== null,
            recorded_at_ms: evidence.recordedAtMs,
            // DERIVED on every read. A stored verdict would keep saying
            // "proven" after the observation aged out.
            resubmission: resubmissionPolicy(verdict),
            ...(verdict.proven ? {} : { refusal: verdict.refusal, detail: verdict.detail }),
          };
        }),
      },
    };
  });

  router.put(
    '/v1/commerce/idempotency/:resource/:operation',
    async (req): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

      const body = (req.body ?? {}) as { declared_retention_ms?: unknown; probe?: unknown };
      if (typeof body.declared_retention_ms !== 'number' || body.declared_retention_ms < 0) {
        return {
          status: 400,
          body: { error: 'declared_retention_ms must be a non-negative number' },
        };
      }
      const probe = readProbe(body.probe);
      if (probe === undefined) {
        // MALFORMED is refused; ABSENT is accepted and simply is not evidence.
        // Collapsing them would let a typo read as "declared only" and quietly
        // turn off a retry policy the owner had proven.
        return { status: 400, body: { error: 'probe is malformed' } };
      }

      const evidence = {
        resource: req.params.resource ?? '',
        operation: req.params.operation ?? '',
        declaredRetentionMs: body.declared_retention_ms,
        probe,
        recordedAtMs: Date.now(),
      };
      runtime.idempotencyEvidence.record(evidence);
      const verdict = evaluateIdempotencyEvidence({
        evidence,
        requirement: requirement(),
        nowMs: Date.now(),
      });
      // The verdict comes back with the write, because an owner who ran a probe
      // needs to know whether it counted — and the answer is usually no on the
      // first attempt.
      return {
        status: 200,
        body: {
          ok: true,
          resubmission: resubmissionPolicy(verdict),
          ...(verdict.proven ? {} : { refusal: verdict.refusal, detail: verdict.detail }),
        },
      };
    },
  );

  /**
   * §15.2b — THE OWNER'S HALF. Answer an order the pack decided and a human
   * has not yet agreed to.
   *
   * This route is the reason the whole §15.2b apparatus was unreachable: the
   * approval payload, the binding verifier and the policy gate were all built
   * and correct, and nothing could supply a `SupplierDecisionApproval`. So
   * `orderAcceptance: 'review'` had exactly one outcome — rejection at the
   * decision deadline, without asking anyone.
   *
   * THE OWNER APPROVES THE PACK'S ANSWER, not a re-derived one. Settlement
   * replays the runner's bytes verbatim from the held card, so a pack that
   * revised its proposal after the card was raised cannot have the new answer
   * signed under the old consent.
   */
  router.post('/v1/commerce/orders/decide', async (req): Promise<CoreResponse> => {
    const caller = staffOrOwnerCaller(req, ownerOnlyGuard);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as {
      buyer_did?: unknown;
      purchase_order_id?: unknown;
      approve?: unknown;
    };
    if (typeof body.buyer_did !== 'string' || body.buyer_did === '') {
      return { status: 400, body: { error: 'buyer_did is required' } };
    }
    if (typeof body.purchase_order_id !== 'string' || body.purchase_order_id === '') {
      return { status: 400, body: { error: 'purchase_order_id is required' } };
    }
    // EXPLICIT, both ways. A missing `approve` is not consent, and it is not a
    // refusal either — it is a malformed request, and guessing either way
    // decides an order on the owner's behalf.
    if (typeof body.approve !== 'boolean') {
      return { status: 400, body: { error: 'approve must be true or false' } };
    }
    const buyerDid = body.buyer_did;
    const purchaseOrderId = body.purchase_order_id;

    // §6.5 — presence and grant EXISTENCE first, so an ungranted staff
    // device learns nothing about which decisions are pending (a 404
    // before the 403 leaked exactly that, and made the refusal arm
    // untestable without supplier machinery).
    if (caller.kind === 'staff') {
      if (!staffPresentNow(caller.deviceDid, Date.now())) {
        return { status: 403, body: { error: 'access_denied', reason: 'staff presence required' } };
      }
      const live = runtime.staffGrants.get(caller.deviceDid, 'commerce_submit');
      if (live === null || live.revokedAt !== null) {
        return { status: 403, body: { error: 'access_denied', reason: 'no live staff grant for this scope' } };
      }
    }

    const pending = runtime.pendingDecisions.get(buyerDid, purchaseOrderId);
    if (pending === null) return { status: 404, body: { error: 'no_pending_decision' } };

    if (caller.kind === 'staff') {
      // §6.5 — commerce_submit gates the supplier order-accept at the
      // ORDER total, read from this node's own retained proposal, never
      // a caller value. Declines are gated identically: refusing an
      // order is as much a commercial act as accepting one.
      const retained = tradeRelationshipReaders(runtime).readOrder(buyerDid, purchaseOrderId);
      const gate = checkStaffOperation({
        repository: runtime.staffGrants,
        deviceDid: caller.deviceDid,
        scope: 'commerce_submit',
        installRole: 'supplier',
        ...(retained === null ? {} : { value: retained.approved_total }),
      });
      if (gate.verdict === 'refuse') {
        return { status: 403, body: { error: 'access_denied', reason: gate.reason } };
      }
      if (gate.verdict === 'escalate') {
        const escalated = escalateStaffOperation({
          deviceDid: caller.deviceDid,
          scope: 'commerce_submit',
          // The domain operation is keyed (buyer, order) and the PO id is
          // BUYER-chosen — a subject of the id alone let an approved card
          // for buyer A's order authorize buyer B's same-numbered one.
          subject: `${buyerDid}:${purchaseOrderId}`,
          value: retained === null ? null : retained.approved_total,
          reason: gate.reason,
          nowMs: Date.now(),
        });
        if (escalated.kind === 'unavailable') {
          return { status: 403, body: { error: 'access_denied', reason: 'approval subsystem unavailable' } };
        }
        if (escalated.kind === 'escalated') {
          return { status: 202, body: { status: 'pending_approval', task_id: escalated.taskId } };
        }
      }
    }

    // DECLINED: the card goes, the order does not move. It will lapse at its
    // decision deadline like any undecided order, which is the honest outcome
    // — the owner refused to commit the business, and Core must not invent a
    // rejection they did not word.
    if (!body.approve) {
      runtime.pendingDecisions.clear(buyerDid, purchaseOrderId);
      return { status: 200, body: { ok: true, decided: false } };
    }

    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
    const order = runtime.orders.load(buyerDid, purchaseOrderId);
    if (order === null) return { status: 404, body: { error: 'unknown_order' } };

    // THE REAL INSTALL FIELDS, OR NO APPROVAL AT ALL.
    //
    // §15.2's binding exists so a swap of WHICH install is about to act — a
    // different scope hash, a different config revision — is a different act
    // by a different actor and fails the comparison. The first version of this
    // route passed `installScopeHash: ''` and `configRevision: ''`, and the
    // approval-payload module documents exactly what that costs: "when the
    // card supplies neither side of a comparison, the field is bound to a
    // CONSTANT and carries no information — the payload looks §15.2-compliant
    // and binds nothing."
    //
    // The buyer-side builder returns a union and REFUSES a card missing its
    // fields. The supplier-side builder does not, so the refusal has to happen
    // here: an install that has been uninstalled since the card was raised
    // cannot be approved, because there is nothing left to bind the approval
    // to.
    const install = getPluginInstallRepository()?.getById(order.ref.servingInstallId) ?? null;
    if (install === null) {
      return {
        status: 409,
        body: {
          error: 'serving_install_gone',
          detail:
            'the install that took this order is no longer present, so an approval cannot be bound to it',
        },
      };
    }
    const actingInstall = {
      installId: order.ref.servingInstallId,
      capabilityId: pending.capability,
      manifestCid: order.ref.servingManifestCid,
      installScopeHash: install.installScopeHash,
      configRevision: String(install.configRevision),
    };

    const settings = runtime.settings.readSupplier();
    // §7.1 / §15.2b (NEW-6) — THE SAME RULE THE BUYER HALF ENFORCES. The
    // buyer path refuses an `actingBusinessDid` that is not this node with
    // `acting_business_mismatch`; this path took whatever the settings row
    // said, and the settings validator checks that field only for
    // non-emptiness. A node would then sign an acknowledgement bound to a
    // business it cannot act for. An asymmetric rule is a rule with a hole in
    // it, and nothing about the code revealed which half was which.
    const actingBusinessDid = settings.ok ? settings.settings.actingBusinessDid : owner;
    if (actingBusinessDid !== owner) {
      return {
        status: 403,
        body: {
          error: 'acting_business_mismatch',
          detail: 'the configured acting business is not this node',
        },
      };
    }
    const settled = settleInboundOrderDecision({
      buyerDid,
      purchaseOrderId,
      // VERBATIM from the card. See the note above.
      runnerResultJson: pending.runnerResultJson,
      approval: {
        approved: buildSupplierApprovalPayload({
          actingBusinessDid,
          principal: {
            // A PERSON approved this, so the policy-revision slot stays empty:
            // §15.2b binds both, and a payload approved by a human must never
            // be presentable as policy-approved.
            principalDid: owner,
            authorityDomain: SUPPLIER_ORDER_AUTHORITY_DOMAIN,
            policyRevision: null,
          },
          buyerDid,
          purchaseOrderId,
          orderDigest: order.ref.orderDigest,
          quoteDigest: order.ref.quoteDigest,
          acknowledgementKind: 'accepted',
          install: actingInstall,
          ...(runtime.attributionBoundary.crossedAt() === null
            ? {}
            : {
                attribution: {
                  version: 2 as const,
                  vouchedBy: caller.kind === 'staff' ? caller.deviceDid : owner,
                },
              }),
        }),
        actingBusinessDid,
        principal: {
          principalDid: owner,
          authorityDomain: SUPPLIER_ORDER_AUTHORITY_DOMAIN,
          policyRevision: null,
        },
        install: actingInstall,
        ...(runtime.attributionBoundary.crossedAt() === null
          ? {}
          : {
              attribution: {
                version: 2 as const,
                vouchedBy: caller.kind === 'staff' ? caller.deviceDid : owner,
              },
            }),
      },
    });

    if (!settled.ok) {
      // THE CARD SURVIVES A FAILED SETTLEMENT. Clearing it here would lose the
      // runner's answer and leave the owner with nothing to approve on a
      // retry, on an order that is still reserved.
      return { status: 409, body: { ok: false, refusal: settled.refusal, error: settled.error } };
    }
    runtime.pendingDecisions.clear(buyerDid, purchaseOrderId);
    // The buyer learns the outcome through §12.7 reconcile: their submission
    // was withheld, and the order is now decided, so the recorded
    // acknowledgement is what a reconcile returns.
    return { status: 200, body: { ok: true, decided: true } };
  });

  /** §15.2b — what is waiting on a human, for the owner's surface. */
  router.get('/v1/commerce/orders/pending-decisions', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    return {
      status: 200,
      body: {
        pending: runtime.pendingDecisions.list().map((p) => ({
          buyerDid: p.buyerDid,
          purchaseOrderId: p.purchaseOrderId,
          capability: p.capability,
          createdAt: p.createdAt,
          // The runner's raw answer is NOT projected: it is an unsigned
          // proposal, and a surface that rendered it would invite an owner to
          // read it as the decision.
        })),
      },
    };
  });

  router.post('/v1/commerce/orders/effect', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as {
      buyer_did?: unknown;
      purchase_order_id?: unknown;
      resource?: unknown;
      operation?: unknown;
    };
    for (const field of ['buyer_did', 'purchase_order_id', 'resource', 'operation'] as const) {
      if (typeof body[field] !== 'string' || body[field] === '') {
        return { status: 400, body: { error: `${field} is required` } };
      }
    }
    const buyerDid = body.buyer_did as string;
    const purchaseOrderId = body.purchase_order_id as string;
    const resource = body.resource as string;

    const order = runtime.orders.load(buyerDid, purchaseOrderId);
    if (order === null) return { status: 404, body: { error: 'unknown_order' } };

    // The install and the idempotency key come from RECORDS, never the body:
    // the key is what the order was admitted under (§15.5), and the install is
    // the credential's own. A caller supplying either would be choosing which
    // grant to spend and which external order to touch.
    const credential = runtime.credentials.describe(resource);
    if (credential === null) return { status: 409, body: { error: 'no_such_credential' } };

    const outcome = await performOrderEffect(
      {
        buyerDid,
        purchaseOrderId,
        idempotencyKey: order.ref.idempotencyKey,
        resource,
        operation: body.operation as string,
        installId: credential.installId,
        params: { purchase_order_id: purchaseOrderId, order_digest: order.ref.orderDigest },
      },
      {
        broker: runtime.broker,
        markEffectStarted: (b, p) => runtime.admission.markEffectStarted(b, p),
        effectAlreadyStarted: (b, p) => runtime.orders.load(b, p)?.effectStarted === true,
        readEvidence: (r, op) => runtime.idempotencyEvidence.read(r, op),
        requirement: requirement(),
        now: () => Date.now(),
      },
    );

    // 200 for a crossed boundary (succeeded OR ambiguous — both are outcomes
    // the owner must act on), 409 for a refusal that never left the node.
    return outcome.kind === 'refused_before_sending'
      ? { status: 409, body: { ok: false, ...outcome } }
      : { status: 200, body: { ok: outcome.kind === 'succeeded', ...outcome } };
  });

  router.post('/v1/commerce/orders/fulfilment/sweep', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as { resource?: unknown; operation?: unknown };
    if (typeof body.resource !== 'string' || typeof body.operation !== 'string') {
      return { status: 400, body: { error: 'resource and operation are required' } };
    }
    const credential = runtime.credentials.describe(body.resource);
    if (credential === null) return { status: 409, body: { error: 'no_such_credential' } };
    const resource = body.resource;
    const operation = body.operation;
    const installId = credential.installId;

    // The list comes from the ORDER RECORDS, never from the request: a caller
    // choosing which orders to reconcile could quietly leave one out, and the
    // one left out is the one nobody looks at again.
    const open = runtime.orders.listWithExternalRef().map((ref) => ({
      buyerDid: ref.buyerDid,
      purchaseOrderId: ref.purchaseOrderId,
      externalRef: ref.externalRef ?? '',
      // The chain's head state, or null when no chain exists. A missing chain
      // is a real answer — an order that was never accepted has nothing to
      // advance — so it is passed through rather than skipped.
      current: chainState(runtime, ref.buyerDid, ref.purchaseOrderId),
    }));

    const results = await sweepFulfilment({
      open,
      readExternal: async (item) => {
        const performed = await runtime.broker.perform({
          installId,
          resource,
          operation,
          params: { external_ref: item.externalRef },
        });
        // A FAILED READ IS NOT A DECISION. `sweepFulfilment` drops it, which
        // keeps "the connector is down" distinguishable from "nothing
        // changed" — only one of those is reassuring.
        return performed.ok ? readExternalFulfilment(performed.result, item.externalRef) : null;
      },
    });

    // THE CALLER THAT SIGNS. `FulfilmentDecision`'s own docstring says of
    // `advance`: "The caller signs; this does not." Nothing did. So the sweep
    // read every open order from the external system, worked out exactly how
    // each chain should move, returned that as JSON — and left the chain
    // where it was. An accepted order could never authoritatively reach
    // `dispatched` or `delivered`, which is the whole second half of §9.11,
    // and `signStatusUpdate` had no production caller at all.
    //
    // Signed HERE, one order at a time, each in its own transaction. Not one
    // transaction for the sweep: these are independent orders, and a single
    // bad successor must not roll back every good one alongside it.
    const advanced: {
      buyerDid: string;
      purchaseOrderId: string;
      to: OrderState;
      /** String on the wire, per `CommerceOrderStatus` — not a JS number. */
      sequence: string;
    }[] = [];
    const refused: { buyerDid: string; purchaseOrderId: string; error: string }[] = [];
    for (const result of results) {
      if (result.decision.kind !== 'advance') continue;
      const lines = result.decision.lines?.map((line) => ({
        lineId: line.line_id,
        fulfilledQuantity: { value: line.fulfilled_quantity.value, unitCode: line.fulfilled_quantity.unit_code },
      }));
      const signed = runtime.lifecycle.signStatusUpdate(result.buyerDid, result.purchaseOrderId, {
        state: result.decision.to,
        ...(lines === undefined ? {} : { lines }),
      });
      if ('error' in signed) {
        // REPORTED, NOT THROWN. The engine refuses a successor the chain will
        // not take (a fork, a backwards move, a terminal head), and that is a
        // fact about ONE order. Aborting the sweep would let the first
        // disagreement hide every later order's progress.
        refused.push({
          buyerDid: result.buyerDid,
          purchaseOrderId: result.purchaseOrderId,
          error: signed.error,
        });
        continue;
      }
      advanced.push({
        buyerDid: result.buyerDid,
        purchaseOrderId: result.purchaseOrderId,
        to: signed.state,
        sequence: signed.sequence,
      });
    }

    return {
      status: 200,
      body: {
        checked: open.length,
        // What the sweep could not reach, stated rather than implied by a
        // shorter list.
        unreachable: open.length - results.length,
        // What actually MOVED, separate from what was merely decided. The two
        // were the same number for as long as nothing signed, which is exactly
        // how "the sweep works" survived being untrue.
        advanced,
        refused,
        results,
      },
    };
  });

  router.post('/v1/commerce/orders/fulfilment', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as {
      current?: unknown;
      expected_external_ref?: unknown;
      external?: unknown;
    };
    const external = body.external;
    if (external === null || typeof external !== 'object') {
      return { status: 400, body: { error: 'external is required' } };
    }
    if (typeof body.expected_external_ref !== 'string') {
      return { status: 400, body: { error: 'expected_external_ref is required' } };
    }
    // `current` may legitimately be null — an order with no chain yet — so the
    // absent case is distinguished from a wrong type rather than defaulted.
    if (body.current !== null && typeof body.current !== 'string') {
      return { status: 400, body: { error: 'current must be a state name or null' } };
    }

    return {
      status: 200,
      body: reconcileFulfilment({
        current: body.current as never,
        external: external as never,
        expectedExternalRef: body.expected_external_ref,
      }),
    };
  });
}

/**
 * Trust and interoperability (§10.7, §11.3 — WS-10.3 / WS-10.6).
 *
 *   POST /v1/commerce/relationships/resolve → what plural AppViews agree on
 *   POST /v1/commerce/capabilities/promote  → §11.3's seven proofs, checked
 *   POST /v1/commerce/capabilities/resolve  → an id through its aliases
 *
 * BOTH ARE PURE DECISIONS over answers the caller already has. Core does not
 * query AppViews — that is an outbound read the discovery lane owns — and it
 * does not publish an official catalog. What it owns is the JUDGEMENT: which
 * relationship a buyer may act on, and whether a capability has earned an
 * official id. Putting the fetch here would give the same module both the
 * evidence and the verdict, and an index that could influence the verdict is
 * an index that decides substitutions.
 *
 * OWNER-ONLY, because both answers change what this node will do with somebody
 * else's money: a substitution the resolver permits changes what arrives, and
 * a promotion changes which contract a capability id means.
 */
function registerTrustRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may resolve relationships or promote a capability',
  );

  router.post('/v1/commerce/relationships/resolve', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const answers = (req.body as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(answers)) {
      return { status: 400, body: { error: 'answers must be an array of AppView responses' } };
    }
    const parsed = readAnswers(answers);
    if (parsed === null) {
      return { status: 400, body: { error: 'an AppView answer is malformed' } };
    }

    const resolved = resolveRelationships(parsed);
    return {
      status: 200,
      body: {
        edges: resolved.edges.map((edge) => ({
          subject_key: edge.subjectKey,
          relationship: edge.relationship,
          object_key: edge.objectKey,
          confidence_bp: edge.confidenceBp,
          supporting_views: edge.supportingViews,
          consulted_views: edge.consultedViews,
          contested: edge.contested,
          // The three verdicts travel WITH the edge, so a client never
          // re-derives them from the number. Two renderers comparing a
          // confidence against their own constant is how a substitution gets
          // authorised by whichever screen was edited last.
          may_show_as_related: mayShowAsRelated(edge),
          may_inherit_standing: mayInheritStanding(edge),
          may_authorize_substitution: mayAuthorizeSubstitution(edge),
        })),
        disagreements: resolved.disagreements.map((d) => ({
          kind: d.kind,
          subject_key: d.subjectKey,
          relationship: d.relationship,
          positions: d.positions.map((p) => ({
            appview_did: p.appViewDid,
            object_key: p.objectKey,
            confidence_bp: p.confidenceBp,
          })),
          // §10.7 asks for material disagreement to be EXPOSED, so the owner's
          // sentence is built here rather than left to each surface.
          headline: describeDisagreement(d),
        })),
      },
    };
  });

  router.post('/v1/commerce/capabilities/promote', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as { evidence?: unknown; official?: unknown };
    if (body.evidence === null || typeof body.evidence !== 'object') {
      return { status: 400, body: { error: 'evidence is required' } };
    }
    if (!Array.isArray(body.official)) {
      // Not defaulted to empty. An absent catalog read as "nothing is official
      // yet" would make every additive check pass, which is the one check
      // §11.3 cares most about.
      return { status: 400, body: { error: 'official must be the current catalog' } };
    }

    const verdict = evaluatePromotion({
      evidence: body.evidence as never,
      official: body.official as OfficialCapability[],
      nowMs: Date.now(),
    });
    return verdict.eligible
      ? {
          status: 200,
          body: {
            eligible: true,
            official: verdict.official,
            // The catalog the owner would end up with, so the decision is
            // reviewable before anything is published.
            catalog: applyPromotion(body.official as OfficialCapability[], verdict.official),
          },
        }
      : { status: 409, body: { eligible: false, findings: verdict.findings } };
  });

  router.post('/v1/commerce/capabilities/resolve', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as { official?: unknown; capability_id?: unknown };
    if (!Array.isArray(body.official) || typeof body.capability_id !== 'string') {
      return { status: 400, body: { error: 'official and capability_id are required' } };
    }
    const resolved = resolveCapabilityId(body.official as OfficialCapability[], body.capability_id);
    // `via_alias` travels with the answer: §11.3's "never silently
    // reinterpreted" has a read side, and a caller must be able to SEE that
    // its id was translated rather than have the substitution hidden.
    return resolved === null
      ? { status: 404, body: { error: 'unknown_capability' } }
      : {
          status: 200,
          body: { capability_id: resolved.capabilityId, via_alias: resolved.viaAlias },
        };
  });
}

/** AppView answers from a request body, or null when one is malformed. */
function readAnswers(raw: unknown[]): AppViewAnswer[] | null {
  const answers: AppViewAnswer[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const a = entry as Record<string, unknown>;
    if (typeof a.appview_did !== 'string' || a.appview_did === '') return null;
    if (!Array.isArray(a.edges)) return null;
    const edges = [];
    for (const rawEdge of a.edges) {
      if (rawEdge === null || typeof rawEdge !== 'object') return null;
      const e = rawEdge as Record<string, unknown>;
      if (
        typeof e.subject_key !== 'string' ||
        typeof e.relationship !== 'string' ||
        typeof e.object_key !== 'string' ||
        typeof e.confidence_bp !== 'number'
      ) {
        return null;
      }
      edges.push({
        subjectKey: e.subject_key,
        relationship: e.relationship,
        objectKey: e.object_key,
        confidenceBp: e.confidence_bp,
        // A missing `disputed` reads as FALSE, which is what an AppView that
        // does not track disputes means. The resolver finds the conflict
        // itself from the objects, so nothing depends on the flag being right.
        disputed: e.disputed === true,
      });
    }
    answers.push({ appViewDid: a.appview_did, edges });
  }
  return answers;
}

/**
 * The chain's current head state, or null when it has no chain.
 *
 * Reading a head that does not exist throws by design (`StatusChain.head`), so
 * existence is checked rather than caught: a sweep that swallowed an integrity
 * error would report "no chain" for an order whose chain is corrupt, and those
 * are very different problems.
 */
function chainState(
  runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
  buyerDid: string,
  purchaseOrderId: string,
): OrderState | null {
  const chain = runtime.chains.load(buyerDid, purchaseOrderId);
  return chain.exists ? (chain.head.state as OrderState) : null;
}

/**
 * A fulfilment report from whatever a connector answered.
 *
 * The external reference is taken from the ORDER we asked about, not from the
 * answer: a connector that echoed the wrong one would otherwise defeat the
 * reconciler's own crossed-report check. What the answer supplies is the
 * STATE, which is the only thing the external system is the authority on.
 */
function readExternalFulfilment(result: unknown, externalRef: string): ExternalFulfilment | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (typeof r.state !== 'string' || !ORDER_STATES.has(r.state)) return null;
  return {
    externalRef,
    state: r.state as OrderState,
    ...(Array.isArray(r.lines) ? { lines: r.lines as ExternalFulfilment['lines'] } : {}),
    observedAtIso: typeof r.observed_at === 'string' ? r.observed_at : new Date().toISOString(),
  };
}

/**
 * The §9.11 vocabulary, as a set.
 *
 * A connector answering a state outside it is refused rather than passed to
 * the reconciler: `LEGAL_TRANSITIONS[unknown]` is `undefined`, and calling
 * `.includes` on it would throw inside a sweep that is meant to survive one
 * bad answer.
 */
const ORDER_STATES: ReadonlySet<string> = new Set([
  'submitted',
  'accepted',
  'rejected',
  'preparing',
  'partially_fulfilled',
  'dispatched',
  'delivered',
  'cancelled',
  'disputed',
]);

/**
 * A probe from a request body: the probe, `null` for none, `undefined` for
 * malformed.
 *
 * Three answers rather than two, because "the owner recorded no probe" and
 * "the owner recorded a probe this build cannot read" are different facts and
 * only one of them is their fault.
 */
function readProbe(value: unknown): IdempotencyProbe | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (
    typeof p.idempotency_key !== 'string' ||
    typeof p.first_external_ref !== 'string' ||
    typeof p.second_external_ref !== 'string' ||
    typeof p.second_created_new_order !== 'boolean' ||
    typeof p.first_at_ms !== 'number' ||
    typeof p.second_at_ms !== 'number'
  ) {
    return undefined;
  }
  return {
    idempotencyKey: p.idempotency_key,
    firstExternalRef: p.first_external_ref,
    secondExternalRef: p.second_external_ref,
    secondCreatedNewOrder: p.second_created_new_order,
    firstAtMs: p.first_at_ms,
    secondAtMs: p.second_at_ms,
  };
}

/**
 * The supplier's catalog surface (§10.2).
 *
 * ALL FOUR land here now. `ingestCatalog` took the longest, and the reason it
 * waited is the reason its wiring looks the way it does: it FETCHES, and Core
 * makes no outbound HTTP. A route that constructed a fetch would put egress
 * behind an owner endpoint where the gates cannot see it. So the transport is
 * INSTALLED by the composition root — the half that owns transport — and this
 * route only asks whether one exists. Core stays the thing that VERIFIES what
 * comes back: pointer advance, snapshot digest, per-page proof, page order,
 * and one shared byte/time budget across the whole ingest.
 *
 * OWNER-ONLY, like the rest of this file. A catalog is what this business
 * sells and at what terms; deciding to publish or withdraw one is the owner's
 * commercial act, not a plugin's.
 */
function registerCatalogRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may import or withdraw a catalog',
  );

  router.post('/v1/commerce/catalog/ingest', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const transport = getCatalogFeedTransport();
    if (transport === null) {
      // Fail closed and visibly. A node with no transport cannot ingest, and a
      // fallback to a global `fetch` would be the exact bypass this design
      // exists to prevent.
      return { status: 503, body: { error: 'no_catalog_feed_transport' } };
    }

    const body = (req.body ?? {}) as {
      pointer?: unknown;
      previous_pointer?: unknown;
      snapshot_url?: unknown;
      page_url_template?: unknown;
    };
    if (body.pointer === null || typeof body.pointer !== 'object') {
      return { status: 400, body: { error: 'pointer is required' } };
    }
    const snapshotUrl = typeof body.snapshot_url === 'string' ? body.snapshot_url : '';
    const template = typeof body.page_url_template === 'string' ? body.page_url_template : '';
    if (snapshotUrl === '' || template === '') {
      return { status: 400, body: { error: 'snapshot_url and page_url_template are required' } };
    }
    if (!template.includes(PAGE_INDEX_TOKEN)) {
      // A template with no slot would fetch page 0 for every index. The ingest
      // WOULD catch it (each page carries its own index and is checked), but
      // refusing here names the operator's actual mistake instead of reporting
      // it as a supplier serving the wrong page.
      return {
        status: 400,
        body: { error: `page_url_template must contain ${PAGE_INDEX_TOKEN}` },
      };
    }

    // `previous_pointer` is ABSENT vs NULL on purpose. Null means "this
    // consumer has accepted nothing from this supplier"; absent is the same
    // thing said by omission, and both are honest. What would not be honest is
    // defaulting a MISSING one to null when the caller meant to send one —
    // that turns a replayed old catalog into an acceptable first sighting.
    const previousPointer =
      body.previous_pointer === undefined || body.previous_pointer === null
        ? null
        : (body.previous_pointer as CatalogPointer);

    const result = await ingestCatalog({
      pointer: body.pointer as CatalogPointer,
      previousPointer,
      snapshotUrl,
      pageUrl: (index) => template.split(PAGE_INDEX_TOKEN).join(String(index)),
      transport,
      sha256: hash,
    });
    // A refusal is a 409: the request was well formed and the FEED disagreed
    // with it. Distinguishing that from a 400 is what tells an operator
    // whether to fix their request or ask their supplier.
    return { status: result.ok ? 200 : 409, body: result };
  });

  router.post('/v1/commerce/catalog/import', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as { csv?: unknown; default_scheme?: unknown };
    if (typeof body.csv !== 'string' || body.csv === '') {
      return { status: 400, body: { error: 'csv is required' } };
    }
    if (body.default_scheme !== 'gtin' && body.default_scheme !== 'sku') {
      // Not defaulted: the scheme decides how every bare identifier in the
      // file is READ, so guessing it would silently reinterpret the owner's
      // whole catalog.
      return { status: 400, body: { error: "default_scheme must be 'gtin' or 'sku'" } };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };

    const result = importCatalogCsv({
      csv: body.csv,
      defaultScheme: body.default_scheme,
      // The supplier is this node, never a field in the body: a
      // `manufacturer_sku` is only unambiguous scoped to whoever issued it,
      // and letting a caller name someone else would let them publish under
      // another supplier's scope.
      supplierDid: owner,
    });

    // A REFUSED import is still a 200. The findings are the answer an owner
    // needs to fix their spreadsheet, not an error about their request; an
    // import is all-or-nothing, and `ok: false` already says so.
    return { status: 200, body: result };
  });

  router.post('/v1/commerce/catalog/load', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as {
      kind?: unknown;
      credential_resource?: unknown;
      operation?: unknown;
      document?: unknown;
      default_scheme?: unknown;
    };
    const kinds: ConnectorKind[] = ['spreadsheet_upload', 'spreadsheet_url', 'rest'];
    if (!kinds.includes(body.kind as ConnectorKind)) {
      return { status: 400, body: { error: `kind must be one of ${kinds.join(' | ')}` } };
    }
    if (body.default_scheme !== 'gtin' && body.default_scheme !== 'sku') {
      // Same rule as `/catalog/import`, for the same reason: the scheme decides
      // how every bare identifier is READ, and guessing it reinterprets the
      // supplier's whole catalog.
      return { status: 400, body: { error: "default_scheme must be 'gtin' or 'sku'" } };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };

    const loaded = await loadCatalogThroughConnector({
      spec: {
        kind: body.kind as ConnectorKind,
        credentialResource:
          typeof body.credential_resource === 'string' ? body.credential_resource : null,
        operation: typeof body.operation === 'string' ? body.operation : 'read_catalog',
      },
      // The install is the credential's OWN record, never a body field: a
      // caller naming an install id would be choosing which grant to spend.
      installId:
        typeof body.credential_resource === 'string'
          ? (runtime.credentials.describe(body.credential_resource)?.installId ?? '')
          : '',
      ...(typeof body.document === 'string' ? { document: body.document } : {}),
      broker: runtime.broker,
      defaultScheme: body.default_scheme,
      supplierDid: owner,
    });

    // A CONNECTOR REFUSAL IS A 409, an import refusal a 200. The first says
    // the backend could not be read; the second says it was read and the rows
    // are wrong, which is a finding list the supplier fixes in their file.
    return loaded.ok
      ? { status: 200, body: loaded.import }
      : { status: 409, body: { ok: false, refusal: loaded.refusal, error: loaded.error } };
  });

  router.post('/v1/commerce/catalog/publish', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    // §16.2 IS CHECKED HERE AND NOT ON THE OTHER TWO. A snapshot is a public
    // commercial commitment that advances a chain buyers follow, and a
    // restored node's memory of "what I last published" is exactly the state a
    // backup can carry stale. Import reads a file and withdrawal only
    // tombstones, so neither can fork a chain forward; publication can.
    const availability = commerceAvailability();
    if (!availability.available) {
      return {
        status: 503,
        body: {
          error: 'commerce_unavailable',
          reason: availability.reason,
          detail: availability.detail,
        },
      };
    }

    const body = (req.body ?? {}) as {
      catalog_id?: unknown;
      protocol_version?: unknown;
      published_at?: unknown;
      items?: unknown;
      previous?: unknown;
      page_size?: unknown;
      /** §10.5 (DR-5) — which listing serves this catalog. */
      service_rkey?: unknown;
    };
    if (typeof body.catalog_id !== 'string' || body.catalog_id === '') {
      return { status: 400, body: { error: 'catalog_id is required' } };
    }
    // §6 RETIRES THIS BODY, AND THIS IS THE RETIREMENT — armed, not scheduled.
    //
    // The item list publishes with no content receipt, no snapshot approval
    // and no presence step, so while it exists the lane's safety property is a
    // convention: a client holding the owner capability can assemble items and
    // post them here instead of walking the draft. §6's own standard rejects
    // that — a rule the caller can decline to use is not an enforcement point.
    //
    // It stays open today for one reason, and it is not the one this route
    // used to give. The DRAFT LANE CANNOT PUBLISH AT ALL until §10 item 9's
    // presence primitive is wired, because `approve` requires presence on
    // every class; retiring the body now would take catalog publication to
    // zero rather than make it safe. So the guard is written against the thing
    // that actually gates it, and the day presence lands this refuses on its
    // own — no second decision to remember, and no window where both a working
    // draft lane and its bypass are open at once.
    if (ownerPresenceCanBeEstablished()) {
      return {
        status: 409,
        body: {
          error: 'item_list_retired',
          detail:
            'publish takes a draft id: create a draft, confirm, prepare, approve, publish (§6)',
        },
      };
    }
    if (!Array.isArray(body.items)) {
      // An empty array is legal and means "this supplier currently offers
      // nothing" — a valid, publishable state. A MISSING array is not the
      // same claim, and treating it as one would let a dropped field
      // silently empty a live catalog.
      return { status: 400, body: { error: 'items must be an array' } };
    }

    let supplied: CatalogPointer | null = null;
    if (body.previous !== undefined && body.previous !== null) {
      const shape = validateCatalogPointer(body.previous);
      if (shape !== null) {
        return { status: 400, body: { error: 'previous pointer is invalid', detail: shape } };
      }
      supplied = body.previous as CatalogPointer;
    }
    // The node's own record decides where the chain is; see `resolvePredecessor`.
    const chain = resolvePredecessor(body.catalog_id, supplied);
    if (!chain.ok) return chain.response;
    const previous = chain.previous;

    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };

    // Refused here rather than at the far end: this value lands inside an
    // AT-URI that buyers parse, and one carrying a separator makes the
    // supplier's own products unreadable with no explanation reaching either
    // party. AppView refuses the same shape on ingest.
    const stated = readListingRkey(body.service_rkey);
    if (stated === false) {
      return { status: 400, body: { error: 'service_rkey is not a usable record key' } };
    }
    // INHERITED FROM THE PREDECESSOR when the body does not restate it
    // (NEW-10). `service_rkey` is a published fact about where to send a quote
    // request, and a republication that omits it is not a supplier saying
    // "back to the primary listing" — it is a supplier republishing a catalog.
    // Without inheritance a routine reprice silently redirected every buyer,
    // with no error and nothing visible to look at. This route already refuses
    // a MISSING `items` array on exactly that reasoning; a dropped field must
    // not retire a published fact.
    const listing = stated ?? previous?.pointer.service_rkey ?? null;

    const built = buildCatalogSnapshot({
      supplierDid: owner,
      catalogId: body.catalog_id,
      protocolVersion: typeof body.protocol_version === 'string' ? body.protocol_version : '1.0',
      publishedAt:
        typeof body.published_at === 'string' ? body.published_at : new Date().toISOString(),
      items: body.items,
      previous,
      ...(typeof body.page_size === 'number' ? { pageSize: body.page_size } : {}),
      // §10.5 (DR-5) — WITHOUT THIS THE READ HALF IS DEAD. The pointer type
      // carries `service_rkey`, ingest stores it and discovery reads it, but
      // no Dina node could emit one: this route accepted no such field and
      // neither builder set it. So every catalog this implementation publishes
      // had a null listing and every candidate fell back to `self`, which is
      // the symptom the fix was for. A read path with no producer is the same
      // defect as a rule with no caller, one layer out.
      ...(listing === null ? {} : { serviceRkey: listing }),
      sha256: hash,
    });
    // A BUILD refusal keeps its existing 200-with-`ok:false` shape. It is the
    // caller's own input the builder disagreed with — a leaked credential
    // column, too many items — and callers already read `ok`. Changing it
    // here would be a contract change smuggled in with a publishing feature.
    // Only the PUBLISH outcome below introduces a new status.
    if (!built.ok) return { status: 200, body: built };

    // BUILDING IS NOT PUBLISHING, and the two answers must be tellable apart.
    // A node with no repo writer still gets the records — they are the useful
    // half for an operator publishing by hand — but it is never told they went
    // anywhere. `published` present and absent are the two states; a client
    // reading only the status code sees 200 for "built" and 409 for "the
    // publication failed", which is the difference that matters.
    const outcome = await publishCatalogRecords({
      pointer: built.pointer,
      ...(built.snapshot === undefined ? {} : { snapshot: built.snapshot }),
      // The builder paginates and digests these, and the snapshot's
      // `payload_root` commits to them. They were built and then left behind
      // here, so every catalog this node published committed to pages it never
      // wrote — which AppView refuses, correctly, as "pages missing".
      ...(built.pages === undefined ? {} : { pages: built.pages }),
      expectedPointerCid: chain.expectedPointerCid,
      // RE-CHECKED between the snapshot and the head. The snapshot write is an
      // awaited round trip, and §16.2 can supersede this node during it; a
      // fence consulted only at the start of the request is a fence consulted
      // at the one moment it could not yet have failed. The snapshot is
      // immutable and content-addressed, so abandoning the publication there
      // costs nothing a retry cannot redo.
      beforePointer: publicationFence,
    });
    if (!outcome.ok && outcome.refusal === 'no_record_writer') {
      return { status: 200, body: { ...built, published: null, reason: outcome.refusal } };
    }
    // Recorded only on the repo's acceptance. A head remembered for a write
    // that failed would hand the NEXT publication a swap value the repo never
    // issued, turning one lost race into a permanent one.
    if (outcome.ok) recordPublication(body.catalog_id, built.pointer, outcome.pointerCid);
    return {
      status: outcome.ok ? 200 : 409,
      body: { ...built, published: outcome },
    };
  });

  router.post('/v1/commerce/catalog/withdraw', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const body = (req.body ?? {}) as {
      catalog_id?: unknown;
      protocol_version?: unknown;
      published_at?: unknown;
      previous?: unknown;
    };
    if (typeof body.catalog_id !== 'string' || body.catalog_id === '') {
      return { status: 400, body: { error: 'catalog_id is required' } };
    }
    // A withdrawal EXTENDS a chain: it takes the previous sequence and adds
    // one, so without a legal predecessor there is nothing to withdraw and
    // inventing a sequence would fork the chain a buyer is following.
    //
    // OPTIONAL, exactly as on `publish`. When supplied it is validated by the
    // SAME validator a consumer runs against a pointer it fetched, before
    // anything reads a field off it, and `resolvePredecessor` still refuses a
    // supplied pointer that disagrees with the node's own head. When absent
    // the node's stored head is the predecessor.
    //
    // Demanding it here was a real defect rather than caution: the owner's
    // published projection carries no pointer or digest fields, so a client
    // could see the `withdraw` action offered and had no reachable way to
    // build the body for it. An owner who believes they have stopped selling
    // while the chain says otherwise is the exact gap this module exists to
    // close.
    let supplied: CatalogPointer | null = null;
    if (body.previous !== undefined && body.previous !== null) {
      const shape = validateCatalogPointer(body.previous);
      if (shape !== null) {
        return { status: 400, body: { error: 'previous pointer is invalid', detail: shape } };
      }
      supplied = body.previous as CatalogPointer;
    }
    const chain = resolvePredecessor(body.catalog_id, supplied);
    if (!chain.ok) return chain.response;
    // NOTHING TO WITHDRAW. `resolvePredecessor` returns a null predecessor
    // only when this node holds no head and the caller supplied none, which
    // for a withdrawal means the catalog was never published from here.
    //
    // A withdrawal extends a chain, so with no predecessor the only way to
    // proceed would be to write a GENESIS tombstone at sequence 1 — announcing
    // the end of a chain that never began, and forking any real chain that
    // does exist elsewhere. Refusing is the honest answer, and it points at
    // the route that fixes the recoverable version of this state.
    if (chain.previous === null) {
      return {
        status: 409,
        body: {
          error: 'nothing_published',
          detail:
            'this node holds no published head for this catalog, so there is nothing to withdraw; if it was published from another node, adopt the live pointer first (POST /v1/commerce/catalog/adopt)',
        },
      };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };

    const built = buildCatalogWithdrawal({
      supplierDid: owner,
      catalogId: body.catalog_id,
      // Carried from the head being withdrawn, so the tombstone stays
      // self-describing (NEW-10). The parameter existed with no caller that
      // ever supplied it, which is the same unreached-capability shape as the
      // defect this whole field was added to fix.
      ...(chain.previous.pointer.service_rkey === undefined
        ? {}
        : { serviceRkey: chain.previous.pointer.service_rkey }),
      protocolVersion: typeof body.protocol_version === 'string' ? body.protocol_version : '1.0',
      publishedAt:
        typeof body.published_at === 'string' ? body.published_at : new Date().toISOString(),
      // Derived, never a second field in the body: the chain check requires
      // it to equal the predecessor's own digest, so asking a caller to
      // repeat it only creates a way to disagree with the pointer they just
      // supplied. A withdrawn predecessor has none — it is refused by the
      // chain rule below, which is where that refusal belongs.
      //
      // Non-null: the `nothing_published` refusal above is the only way a null
      // predecessor reaches this point, and it returns.
      previous: chain.previous,
    });
    if (!built.ok) return { status: 200, body: built };

    // A TOMBSTONE THAT IS NEVER WRITTEN IS THE BUG §10.2 EXISTS TO PREVENT.
    // Building one and handing it back leaves the live catalog live: consumers
    // keep fetching the previous head, the owner believes they have stopped
    // selling, and the gap between those two beliefs is filled with orders.
    // Same shape as publication — `published: null` means "built, not written",
    // and 409 means the write was attempted and refused.
    // §16.2 NOW FENCES THE WITHDRAWAL TOO, and the earlier reasoning has to
    // be corrected rather than quietly kept. When withdrawal only BUILT a
    // tombstone, fencing it would have taken away an owner's ability to see
    // how to stop selling at the moment they most want to — so it was left
    // open. Withdrawal now WRITES, and a superseded node writing an
    // irreversible tombstone into a repo it no longer owns is exactly what the
    // fence is for. The build above stays unfenced; the publication does not.
    const fenced = publicationFence();
    if (fenced !== null) return fenced;

    const outcome = await publishCatalogRecords({
      pointer: built.pointer,
      expectedPointerCid: chain.expectedPointerCid,
      beforePointer: publicationFence,
    });
    if (!outcome.ok && outcome.refusal === 'no_record_writer') {
      return { status: 200, body: { ...built, published: null, reason: outcome.refusal } };
    }
    if (outcome.ok) recordPublication(body.catalog_id, built.pointer, outcome.pointerCid);
    return { status: outcome.ok ? 200 : 409, body: { ...built, published: outcome } };
  });

  /**
   * Adopt the LIVE head from the repo (§10.2 recovery).
   *
   * The pointer row is a cache of this node's own writes, and the store says so
   * — "a CAS that fails means this row is stale, and the honest response is to
   * re-read the repo, not to argue". Nothing implemented the re-read, so
   * divergence was terminal: publishing was refused whether the caller supplied
   * the true head (409 `stale_predecessor`) or omitted it (CAS on a value the
   * repo never issued). Divergence is reachable — a pointer write that lands
   * and whose response is lost, a crash between the write and the record, an
   * out-of-band publication.
   *
   * THE OPERATOR SUPPLIES WHAT THE REPO SAYS, and that is the one place a
   * caller may be the authority: this is an explicit recovery action, not the
   * silent default, and Core does no I/O of its own so it cannot read the repo
   * itself. The pointer is validated by the SAME validator a consumer runs
   * against a pointer it fetched, so a mistyped record is refused rather than
   * adopted as the head everything else is measured against.
   */
  router.post('/v1/commerce/catalog/adopt', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as { catalog_id?: unknown };
    if (typeof body.catalog_id !== 'string' || body.catalog_id === '') {
      return { status: 400, body: { error: 'catalog_id is required' } };
    }
    const reader = getCatalogRecordReader();
    if (reader === null) {
      // A node with no repo cannot be told what its repo says. Refusing is the
      // only honest answer — the alternative is the caller supplying it, which
      // is the defect this route was rewritten to remove.
      return { status: 503, body: { error: 'no_catalog_record_reader' } };
    }

    let live: { record: unknown; cid: string } | null;
    try {
      live = await reader({
        collection: CATALOG_POINTER_NSID,
        rkey: catalogPointerRkey(body.catalog_id),
      });
    } catch (err) {
      return {
        status: 503,
        body: {
          error: 'catalog_repo_unreachable',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (live === null) {
      // Nothing published under that id. Adopting "absent" as a head would
      // record a publication that never happened; the honest answer is that
      // the next publication is a genesis, which is already what an empty
      // store produces.
      return { status: 404, body: { error: 'no_published_pointer' } };
    }

    // Validated by the SAME validator a consumer runs against a pointer it
    // fetched. A repo can serve nonsense, and a head this node cannot read the
    // way a buyer would is not a head it may measure its next publication
    // against.
    const shape = validateCatalogPointer(live.record);
    if (shape !== null) {
      return { status: 409, body: { error: 'published_pointer_is_invalid', detail: shape } };
    }
    const pointer = live.record as CatalogPointer;
    if (pointer.catalog_id !== body.catalog_id) {
      // The repo answered about a different catalog. Refused rather than
      // adopted under the id that was asked for.
      return { status: 409, body: { error: 'published_pointer_names_another_catalog' } };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
    if (pointer.supplier_did !== owner) {
      // Somebody else's catalog, in a repo this node reached. Adopting it
      // would let this node publish successors under another supplier's name.
      return { status: 409, body: { error: 'published_pointer_names_another_supplier' } };
    }

    // The CID comes from the REPO's answer, never from the request. That
    // pairing is the whole point: a caller who could supply a live CID beside
    // a fabricated pointer would get a CAS that succeeds while publishing a
    // successor to a record that never existed.
    recordPublication(body.catalog_id, pointer, live.cid);
    const adopted = runtime.catalogPointers.get(body.catalog_id);
    if (adopted === null) return { status: 500, body: { error: 'adoption_did_not_record' } };
    return { status: 200, body: { ok: true, catalog: describeCatalogForOwner(adopted) } };
  });

  registerCatalogDraftRoutes(router, ownerOnlyGuard);

  /**
   * What this node has PUBLISHED (FR-P10, §10.2).
   *
   * The other half of the pointer store, and the reason it is a store rather
   * than a variable: a supplier who cannot see what they published cannot tell
   * a catalog they retired from one they only meant to. Rendered through ONE
   * projection for the same reason orders and quotes are — a client deriving
   * "withdrawn" from a stored flag would eventually offer to withdraw a
   * tombstone, which republishes it and tells every consumer the catalog was
   * retired twice.
   *
   * OWNER-ONLY. The list is every catalog this business sells under, which is
   * public in the repo — but the node's own publication history, sequence by
   * sequence, is not, and nothing on the wire asks for it.
   */
  router.get('/v1/commerce/catalog/published', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getCommerceRuntime();
    if (runtime === null) {
      // Distinguishable from "you have published nothing", for the same reason
      // the census is: an empty list from a node with no commerce has not
      // earned the reassurance an empty list from a working one carries.
      return { status: 503, body: { error: 'commerce_unavailable' } };
    }
    return {
      status: 200,
      body: { catalogs: runtime.catalogPointers.list().map(describeCatalogForOwner) },
    };
  });
}

/**
 * The photo-catalog lane's four operations, as owner-guarded routes (§6).
 *
 * ADDED BESIDE THE SHIPPED PUBLISH ROUTE, NOT INSTEAD OF IT. §6 of the design
 * argues the item-list body should be retired so every publication goes
 * through a draft — but that reaches every catalog publication in the commerce
 * vertical, not only photographs, and it collides with §8.3's catalog refresh
 * cadence and §17.3's scheduled refreshes. That is §10 item 14, an owner
 * decision, so this lane adds its own path and leaves the existing one alone.
 * Nothing here changes what `/v1/commerce/catalog/publish` does.
 *
 * EVERY ROUTE TAKES A DRAFT ID AND NO ITEM LIST. The items Core signs are the
 * items Core stored, which is what stops a caller substituting a set between
 * confirmation and publication.
 */
function registerCatalogDraftRoutes(router: CoreRouter, ownerOnlyGuard: OwnerGuard): void {
  const draftService = (): CatalogDraftService | null => {
    const runtime = getCommerceRuntime();
    if (runtime === null) return null;
    return new CatalogDraftService({
      drafts: runtime.catalogDrafts,
      pointers: runtime.catalogPointers,
      sha256: hash,
      now: () => Date.now(),
      newClaimToken: () => `pcl_${bytesToHex(randomBytes(16))}`,
      // NOT WIRED, AND FAILING CLOSED IS THE POINT. §10 item 9: the per-persona
      // Argon2id verifier exists but has no production caller, no persistence
      // and no mobile equivalent. Returning false makes every binding operation
      // refuse, which is honest — a receipt minted without presence would
      // record that the software asked itself.
      userPresent: ownerPresentNowForRoutes,
      publicationFence: () => publicationFence(),
      attributionBoundary: runtime.attributionBoundary,
      // The owner vouches on this surface; the staff confirm surface (§7)
      // threads the staff device DID here when it lands.
      vouchedBy: () => getNodeDID(),
      publish: async ({ draft }) =>
        // THE PUBLISHER IS A MODULE, not a closure in a route. As a closure it
        // could not be reached by any test — the route wires presence to false
        // and the suite installs no record writer — and three defects lived in
        // it: no fence before the pointer, no record of what was published,
        // and every failure reported as "not a lost swap".
        publishHeldDraft({ fence: () => publicationFence(), recordPublication }, draft),
    });
  };

  const withDraftService = (
    handler: (svc: CatalogDraftService, body: Record<string, unknown>) => Promise<CoreResponse> | CoreResponse,
  ) => {
    return async (req: CoreRequest): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const svc = draftService();
      if (svc === null) return { status: 503, body: { error: 'commerce_unavailable' } };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const draftId = body.draft_id;
      if (typeof draftId !== 'string' || draftId === '') {
        return { status: 400, body: { error: 'draft_id_required' } };
      }
      return handler(svc, body);
    };
  };

  const answer = (outcome: { ok: true; value: unknown } | DraftRefusalOutcome): CoreResponse =>
    outcome.ok
      ? { status: 200, body: { ok: true, draft: outcome.value } }
      : {
          // 409 rather than 400: the request is well formed and the DRAFT is
          // not in a state that admits it, which is a different thing for a
          // client to handle.
          status: outcome.refusal === 'no_such_draft' ? 404 : 409,
          body: { ok: false, error: outcome.refusal, detail: outcome.error },
        };

  /**
   * §10 item 9 — prove a person is here, so the next step can bind.
   *
   * SEPARATE FROM THE OPERATIONS, and deliberately. Folding the passphrase
   * into `confirm` and `approve` would put a secret in the body of every
   * request that touches a draft, and would make each of them a login attempt
   * — retried, logged by proxies, and repeated by any client that resends.
   * One short-lived proof covers the review, which is also how it reads to a
   * seller: unlock, then work.
   *
   * The passphrase is verified and dropped. It is never stored, never
   * returned, and never logged — the response says only whether a person is
   * now considered present and for how long.
   */
  router.post(
    '/v1/commerce/catalog/drafts/presence',
    async (req: CoreRequest): Promise<CoreResponse> => {
      // NOT `withDraftService`: presence is about the PERSON, not a draft, so
      // it carries no `draft_id` and that helper would refuse it for the lack.
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!ownerPresenceCanBeEstablished()) {
        return {
          status: 409,
          body: {
            error: 'presence_unavailable',
            detail: 'this node has no way to check the owner\u2019s passphrase (§10 item 9)',
          },
        };
      }
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
      const proven = await proveOwnerPresence(passphrase, Date.now());
      if (!proven) {
        // No detail about WHY. A wrong passphrase and a verifier that threw
        // are the same answer to anyone who is guessing.
        return { status: 401, body: { error: 'not_proven' } };
      }
      return { status: 200, body: { ok: true, expires_in_ms: OWNER_PRESENCE_TTL_MS } };
    },
  );

  router.post(
    '/v1/commerce/catalog/drafts/confirm',
    withDraftService((svc, body) => answer(svc.confirm(String(body.draft_id)))),
  );

  router.post(
    '/v1/commerce/catalog/drafts/prepare',
    withDraftService(async (svc, body) =>
      answer(
        await svc.prepare(String(body.draft_id), {
          protocolVersion: typeof body.protocol_version === 'string' ? body.protocol_version : '1.0',
          publishedAt:
            typeof body.published_at === 'string' ? body.published_at : new Date().toISOString(),
          ...(typeof body.service_rkey === 'string' ? { serviceRkey: body.service_rkey } : {}),
        }),
      ),
    ),
  );

  router.post(
    '/v1/commerce/catalog/drafts/approve',
    withDraftService((svc, body) => {
      // The digest is REQUIRED and is not a convenience: Core compares it with
      // the snapshot it is holding, so an owner approving without naming what
      // they approved is the shape this operation exists to refuse.
      const digest = body.approved_snapshot_digest;
      if (typeof digest !== 'string' || digest === '') {
        return { status: 400, body: { error: 'approved_snapshot_digest_required' } };
      }
      return answer(svc.approve(String(body.draft_id), digest));
    }),
  );

  router.post(
    '/v1/commerce/catalog/drafts/publish',
    withDraftService(async (svc, body) => {
      const outcome = await svc.publish(String(body.draft_id));
      if (outcome.ok) {
        // §4.2 claims lifecycle: something public now references these
        // identities, so their claims survive for ever — a later erase of
        // the draft row releases nothing.
        const runtime = getCommerceRuntime();
        runtime?.skuLedger.markPublished(String(body.draft_id));
      }
      return answer(outcome);
    }),
  );

  router.post(
    '/v1/commerce/catalog/drafts/erase',
    withDraftService((svc, body) => {
      // §4.2's claims lifecycle needs a death, and §6 ties the photographs
      // to it: erasing a draft removes the row, every page of its
      // photographs, and the claims held by assignments that were NEVER
      // published — the seller's give-up-and-re-photograph recovery. All
      // three in one transaction, so a crash leaves nothing half-erased.
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
      const draftId = String(body.draft_id);
      const draft = runtime.catalogDrafts.get(draftId);
      if (draft === null) return { status: 404, body: { error: 'no_such_draft' } };
      // Erasing mid-publication would race the two network writes the
      // claim protects; the seller releases or waits out the claim first.
      if (draft.publishClaim !== null) {
        return { status: 409, body: { error: 'publication_in_flight' } };
      }
      runtime.runInTransaction(() => {
        runtime.catalogDrafts.delete(draftId);
        runtime.imageArtifacts.eraseDraft(draftId);
        runtime.skuLedger.releaseUnpublished(draftId);
      });
      return { status: 200, body: { erased: draftId } };
    }),
  );

  router.post(
    '/v1/commerce/catalog/drafts/repair',
    withDraftService((svc, body) => {
      // §5 step 4. The seller names a ROW and a COLUMN — the two things the
      // repair screen shows them — and Core re-imports and re-assembles.
      const row = body.row;
      const column = body.column;
      const value = body.value;
      if (typeof row !== 'number' || !Number.isInteger(row)) {
        return { status: 400, body: { error: 'row must be the line number the seller sees' } };
      }
      // THREE REPAIRS, and the third is the one §8 asks for by name:
      //   {row, column, value}       set a cell
      //   {row, column, value: null} clear a cell, key and all
      //   {row, column: null}        remove the row the model invented
      if (column !== null && (typeof column !== 'string' || column === '')) {
        return { status: 400, body: { error: 'column must be a name, or null to remove the row' } };
      }
      if (value !== null && value !== undefined && typeof value !== 'string') {
        return { status: 400, body: { error: 'value must be text, or null to clear the cell' } };
      }
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
      const owner = ownerDid();
      if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
      const stored = runtime.settings.readSupplier();
      if (!stored.ok) {
        return stored.absent
          ? { status: 409, body: { error: 'supplier_settings_absent' } }
          : { status: 409, body: { error: 'supplier_settings_invalid', findings: stored.findings } };
      }
      const settings = stored.settings;
      if (settings.actingBusinessDid !== '' && settings.actingBusinessDid !== owner) {
        return { status: 403, body: { error: 'acting_business_mismatch' } };
      }

      // §4.2: the ledger claims and the draft mutation commit in ONE
      // transaction — a crash between them must be unobservable, which is
      // the property the crash-between-claim-and-persist test pins.
      let outcome: ReturnType<typeof svc.repairRow> | null = null;
      const rollBackRefusal = new Error('repair_refused_rolling_back_claims');
      try {
        runtime.runInTransaction(() => {
        outcome = svc.repairRow(
          String(body.draft_id),
          { row, column: column === null ? null : String(column), value: value === undefined ? null : (value as string | null) },
          (rows, draft) => {
            // The MINT PASS, photo-derived drafts only: identifier-less
            // rows mint, and every identifier claims the issuer ledger
            // under its row's immutable assignment id. Its findings land
            // beside the importer's own on the repair screen.
            const minted =
              draft.provenanceClass === 'model_derived'
                ? applySkuMint({
                    ledger: runtime.skuLedger,
                    issuerDid: owner,
                    catalogId: draft.catalogId,
                    draftId: draft.draftId,
                    defaultScheme: draft.defaultScheme,
                    rows,
                    nowMs: runtime.now(),
                  })
                : { rows: [...rows], findings: [], changed: false };
            const assembled = assembleFromRows({
              rows: minted.rows,
              defaultScheme: draft.defaultScheme,
              identity: { supplierDid: owner, catalogId: draft.catalogId },
              // CURRENT settings, not the ones ingress used: a seller who has
              // just set their trading currency is repairing exactly that.
              settings: {
                categoryIds: settings.catalogCategoryIds ?? [],
                fulfilmentRegions: settings.publicRegions,
                ...(settings.tradingCurrency === undefined
                  ? {}
                  : { tradingCurrency: settings.tradingCurrency }),
              },
              // The draft's OWN stamp. A repair is not a new draft, and
              // re-minting would move every item's revision and timestamp — and
              // with them the snapshot digest an owner may already have approved.
              stamp: { generatedAtIso: draft.generatedAtIso, itemRevision: draft.itemRevision },
            });
            return {
              items: assembled.items,
              findings: [...minted.findings, ...assembled.findings],
              rows: minted.rows,
            };
          },
        );
        // A claim refusal is a FINDING, not a failed operation — but a
        // refused draft operation (wrong state, unknown row) must not
        // leave stray claims behind, so the whole body rolls back with it.
        const decided: ReturnType<typeof svc.repairRow> | null = outcome;
        if (decided !== null && !decided.ok) {
          throw rollBackRefusal;
        }
        });
      } catch (err) {
        // Our own rollback marker carries the refusal in `outcome`;
        // anything else is a genuine failure and propagates.
        if (err !== rollBackRefusal) throw err;
      }
      if (outcome === null) return { status: 500, body: { error: 'repair_did_not_run' } };
      return answer(outcome);
    }),
  );

  router.post(
    '/v1/commerce/catalog/drafts/edit',
    withDraftService((svc, body) => {
      // ONE FIELD PER CALL. A batch would have to answer what happens when the
      // third edit is refused — publish two and keep a draft nobody asked for,
      // or discard two the seller meant. One field has one answer.
      const field = body.field;
      if (typeof field !== 'string' || field === '') {
        return { status: 400, body: { error: 'field is required, as "<index>.<field>"' } };
      }
      // `value` may legitimately be absent: that CLEARS an optional field the
      // model invented, which is a repair like any other.
      return answer(svc.editValue(String(body.draft_id), field, body.value));
    }),
  );

  router.post(
    '/v1/commerce/catalog/drafts/accept',
    withDraftService((svc, body) => {
      // Field names only. The provenance STATE is Core's to write — a body
      // that carried it could exempt every field from confirmation.
      if (!Array.isArray(body.fields) || body.fields.some((f) => typeof f !== 'string')) {
        return { status: 400, body: { error: 'fields must be an array of strings' } };
      }
      return answer(svc.accept(String(body.draft_id), body.fields as string[]));
    }),
  );

  /**
   * The rows-ingress seam (§10 item 8) — the only way a draft is born.
   *
   * TWO ROUTES OVER ONE CREATOR, and the split IS the mechanism: §5 says Core
   * assigns the provenance class from the entry point used and the caller
   * never states it, so the class is a constant at each call site and appears
   * in no request body. One route accepting a `provenance_class` field would
   * be the caller-asserted shape the design rejects.
   *
   * §10 item 11 records what this does not close: a client holding the owner
   * capability can serialise model-extracted rows as CSV and come in through
   * the file route. Core cannot tell that file from one the seller typed.
   */
  // Eight lowercase letters, no digits. The modulo bias is irrelevant here:
  // this is a uniqueness tail, not a secret.
  const mintLetterTail = (): string =>
    Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join('');

  const ingressDeps = (drafts: CatalogDraftRepository): DraftIngressDeps => ({
    drafts,
    now: () => Date.now(),
    newDraftId: () => `cdr_${bytesToHex(randomBytes(16))}`,
    // MINTED ONCE, HERE. `prepare` reads these back off the draft; nothing
    // re-derives them, because a rebuild that re-mints either moves
    // `snapshot_digest` out from under the owner's approval (§10 item 8).
    stamp: () => ({
      generatedAtIso: new Date().toISOString(),
      // A CLOCK ALONE IS NOT AN IDENTITY. `item_revision` is what a consumer
      // compares to decide whether a supplier's items changed, and two drafts
      // minted in the same millisecond would carry the same one — so a second
      // publication could read as "nothing moved". The random tail costs
      // nothing and removes the case.
      //
      // SHAPED SO §12.1 CANNOT TRIP ON IT — the same contract as the `P-`
      // assignment mint. Decimal epoch millis is 13 digits, and the phone
      // scanner found a valid 10-digit span inside it on the first live
      // photo-lane publish (model-derived drafts scan every field). Base36
      // millis plus a letters-only tail caps any digit run at 8, below every
      // personal-identifier pattern's minimum.
      itemRevision: `${Date.now().toString(36)}-${mintLetterTail()}`,
    }),
  });

  const ingest = (
    provenanceClass: ProvenanceClass,
    // WHERE THE VALUES CAME FROM, read at the entry point that knows. Only the
    // extraction lane has a model to name; the others infer nothing.
    readExtraction: (
      body: Record<string, unknown>,
    ) =>
      | { ok: true; extraction: { model: string; schemaVersion: string } | null }
      | { ok: false; response: CoreResponse },
    // A DISCRIMINATED result, not "a source or a response" told apart by
    // sniffing for a property. `'rows' in source` compiled and worked, and it
    // would have kept working right up until a refusal body happened to carry
    // a `rows` field.
    readSource: (
      body: Record<string, unknown>,
    ) => { ok: true; source: CatalogRowSource } | { ok: false; response: CoreResponse },
  ) => {
    return async (req: CoreRequest): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const runtime = getCommerceRuntime();
      if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.catalog_id !== 'string' || body.catalog_id === '') {
        return { status: 400, body: { error: 'catalog_id is required' } };
      }
      const scheme = body.default_scheme;
      if (scheme !== 'gtin' && scheme !== 'sku') {
        // Same rule as `/import`, for the same reason: the scheme decides how
        // every bare identifier is READ, so a default would silently
        // reinterpret the seller's whole catalog.
        return { status: 400, body: { error: "default_scheme must be 'gtin' or 'sku'" } };
      }
      const read = readSource(body);
      if (!read.ok) return read.response;
      const extraction = readExtraction(body);
      if (!extraction.ok) return extraction.response;
      const source = read.source;

      const owner = ownerDid();
      if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
      const stored = runtime.settings.readSupplier();
      if (!stored.ok) {
        // The seller's categories, regions and currency are REQUIRED inputs
        // the assembler will not invent. Refusing here names the settings;
        // continuing would produce a wall of per-row findings for one missing
        // page of setup.
        //
        // NEVER CONFIGURED AND CONFIGURED WRONG ARE DIFFERENT ANSWERS: the
        // first is every seller's first run and the fix is "fill this in";
        // the second means a stored row no longer validates and the findings
        // say which field. Collapsing them would send a first-run seller
        // looking for a corruption that is not there.
        return stored.absent
          ? { status: 409, body: { error: 'supplier_settings_absent' } }
          : {
              status: 409,
              body: { error: 'supplier_settings_invalid', findings: stored.findings },
            };
      }
      const settings = stored.settings;
      // THE SAME RULE THE ACKNOWLEDGEMENT PATH ENFORCES, and for the same
      // reason it gives: an asymmetric rule is a rule with a hole in it.
      // `validateSupplierSettings` checks `actingBusinessDid` only for
      // non-emptiness, so a settings row naming another business would have
      // put that DID on every item, on the snapshot and on the pointer — a
      // catalog published from this node under a supplier it cannot act for.
      if (settings.actingBusinessDid !== '' && settings.actingBusinessDid !== owner) {
        return {
          status: 403,
          body: {
            error: 'acting_business_mismatch',
            detail: 'the stored acting business is not this node',
          },
        };
      }

      const outcome = createCatalogDraft(ingressDeps(runtime.catalogDrafts), {
        catalogId: body.catalog_id,
        source,
        defaultScheme: scheme,
        identity: {
          // The supplier is this node, never a body field — a
          // `manufacturer_sku` is only unambiguous scoped to whoever issued
          // it, and naming someone else would publish under their scope.
          supplierDid: owner,
          catalogId: body.catalog_id,
        },
        settings: {
          categoryIds: settings.catalogCategoryIds ?? [],
          fulfilmentRegions: settings.publicRegions,
          ...(settings.tradingCurrency === undefined
            ? {}
            : { tradingCurrency: settings.tradingCurrency }),
        },
        provenanceClass,
        extraction: extraction.extraction,
      });

      // ALWAYS A DRAFT (§5 step 3). Rows that do not yet import are the normal
      // first state of a photographed price list, and the findings ride on the
      // draft so the repair screen has something to repair against. A draft
      // with findings cannot advance: `confirm` refuses one with no items.
      return { status: 200, body: { ok: true, draft: outcome.draft } };
    };
  };

  /**
   * Read the drafts back.
   *
   * §10 item 8 requires a draft to survive app restart and persona lock, and
   * surviving is worth nothing if the only copy an owner ever sees is the
   * response to the call that made it. Kill the app between `prepare` and
   * `approve` and, without this, the draft is on disk and unreachable — the
   * pause the review exists for is exactly when a client is most likely to be
   * closed.
   */
  router.get('/v1/commerce/catalog/drafts', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const catalogId = req.query.catalog_id;
    if (typeof catalogId !== 'string' || catalogId === '') {
      return { status: 400, body: { error: 'catalog_id is required' } };
    }
    const drafts = runtime.catalogDrafts.listByCatalog(catalogId);
    return {
      status: 200,
      body: {
        drafts,
        // What each draft is still waiting on, computed rather than stored:
        // it is a view of the provenance map, and a second copy could
        // disagree with the map `confirm` actually checks.
        outstanding: Object.fromEntries(drafts.map((d) => [d.draftId, unconfirmedFields(d)])),
      },
    };
  });

  router.post(
    '/v1/commerce/catalog/drafts/from_extraction',
    ingest(
      'model_derived',
      (body) => {
        // REQUIRED on this lane. §5 asks for the extraction's model and schema
        // version alongside the values, and a receipt that cannot say which
        // model produced them records less than the person was shown.
        const model = body.model;
        const schemaVersion = body.schema_version;
        if (typeof model !== 'string' || model === '') {
          return { ok: false, response: { status: 400, body: { error: 'model is required (§5)' } } };
        }
        if (typeof schemaVersion !== 'string' || schemaVersion === '') {
          return {
            ok: false,
            response: { status: 400, body: { error: 'schema_version is required (§5)' } },
          };
        }
        return { ok: true, extraction: { model, schemaVersion } };
      },
      (body) => {
      if (!Array.isArray(body.rows)) {
        return { ok: false, response: { status: 400, body: { error: 'rows must be an array' } } };
      }
      return { ok: true, source: catalogRowsFromRecords(body.rows as Record<string, unknown>[]) };
      },
    ),
  );

  /**
   * §4.1 CAPTURE — the photographs become bounded, stripped artifacts and
   * a single-use egress authorization, and NOTHING leaves the node here.
   *
   * The draft id is minted NOW, before any draft row exists, because the
   * artifacts are owned by it and §6 erasure follows that ownership. The
   * authorization pins the stored (post-strip) hashes, the installed
   * broker's provider, and the catalog purpose — the §3 consent shape.
   */
  router.post('/v1/commerce/catalog/drafts/photo_capture', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    if (!imageReencoderInstalled()) {
      return { status: 503, body: { error: 'no_reencoder: this node cannot ingest photographs' } };
    }
    const provider = installedEgressProvider();
    if (provider === null) {
      // Capture without an extraction path would strand the seller one
      // screen later; saying so now names the missing piece.
      return { status: 503, body: { error: 'no_egress_broker: no vision provider is configured' } };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.pages) || body.pages.length === 0) {
      return { status: 400, body: { error: 'pages must be a non-empty array of base64 images' } };
    }
    if (body.pages.length > MAX_IMAGE_PAGES) {
      return { status: 400, body: { error: 'too_many_pages' } };
    }

    const draftId = `cdr_${bytesToHex(randomBytes(16))}`;
    const manifest: { artifact_id: string; content_hash: string; page_index: number }[] = [];
    for (const [index, page] of body.pages.entries()) {
      if (typeof page !== 'string' || page === '') {
        runtime.imageArtifacts.eraseDraft(draftId);
        return { status: 400, body: { error: `pages[${String(index)}] must be base64 bytes` } };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64.decode(page);
      } catch {
        runtime.imageArtifacts.eraseDraft(draftId);
        return { status: 400, body: { error: `pages[${String(index)}] is not valid base64` } };
      }
      const ingested = await ingestCommerceImage({
        repository: runtime.imageArtifacts,
        ownerDraftId: draftId,
        lane: 'catalog',
        pageIndex: index,
        bytes,
        nowMs: runtime.now(),
      });
      if (!ingested.ok) {
        // ALL PAGES OR NONE: a capture that half-succeeded would leave a
        // manifest that disagrees with the store for ever.
        runtime.imageArtifacts.eraseDraft(draftId);
        return { status: 422, body: { error: ingested.refusal, page_index: index } };
      }
      manifest.push({
        artifact_id: ingested.artifact.artifactId,
        content_hash: ingested.artifact.contentHash,
        page_index: index,
      });
    }

    const authorizationId = newEgressAuthorizationId();
    const at = runtime.now();
    runtime.egressAuthorizations.put({
      authorizationId,
      purpose: 'catalog_extraction',
      provider,
      contentHashes: manifest.map((m) => m.content_hash),
      maxBytes: MAX_AGGREGATE_IMAGE_BYTES,
      createdAtMs: at,
      expiresAtMs: at + IMAGE_EGRESS_AUTHORIZATION_TTL_MS,
      consumedAtMs: null,
    });
    return {
      status: 200,
      body: { ok: true, draft_id: draftId, manifest, authorization_id: authorizationId, provider },
    };
  });

  /**
   * §6 — a stored page's bytes, for the OWNER'S OWN SCREENS. The repair
   * and review screens show the photograph beside the values — their whole
   * point — and these are the owner's own stored bytes, already stripped
   * at ingest. Owner-only, read-only, verified against the stored hash on
   * the way out (an edited blob reads as absent).
   */
  router.get('/v1/commerce/catalog/drafts/photo_page', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const artifactId = String(req.query.artifact_id ?? '');
    if (artifactId === '') return { status: 400, body: { error: 'artifact_id is required' } };
    const meta = runtime.imageArtifacts.getMeta(artifactId);
    const bytes = runtime.imageArtifacts.getBytes(artifactId);
    if (meta === null || bytes === null) return { status: 404, body: { error: 'unknown_artifact' } };
    return {
      status: 200,
      body: {
        artifact_id: artifactId,
        mime: meta.mime,
        bytes_base64: base64.encode(bytes),
      },
    };
  });

  /**
   * §3 + §5 — EXTRACT through the gate, then create the draft with its
   * §2.1 chain: extraction commitment (draft_id in the preimage), binding
   * record, and the manifest — all in the row the repair screen reads.
   */
  router.post('/v1/commerce/catalog/drafts/photo_extract', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.catalog_id !== 'string' || body.catalog_id === '') {
      return { status: 400, body: { error: 'catalog_id is required' } };
    }
    if (typeof body.draft_id !== 'string' || body.draft_id === '') {
      return { status: 400, body: { error: 'draft_id is required (from photo_capture)' } };
    }
    if (typeof body.authorization_id !== 'string' || body.authorization_id === '') {
      return { status: 400, body: { error: 'authorization_id is required (from photo_capture)' } };
    }
    if (runtime.catalogDrafts.get(body.draft_id) !== null) {
      return { status: 409, body: { error: 'draft_exists: extraction already created this draft' } };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
    const stored = runtime.settings.readSupplier();
    if (!stored.ok) {
      return stored.absent
        ? { status: 409, body: { error: 'supplier_settings_absent' } }
        : { status: 409, body: { error: 'supplier_settings_invalid', findings: stored.findings } };
    }
    const settings = stored.settings;
    if (settings.actingBusinessDid !== '' && settings.actingBusinessDid !== owner) {
      return { status: 403, body: { error: 'acting_business_mismatch' } };
    }

    const artifacts = runtime.imageArtifacts.listByDraft(body.draft_id);
    if (artifacts.length === 0) {
      return { status: 404, body: { error: 'no_captured_pages' } };
    }
    const extracted = await extractRowsThroughGate({
      authorizations: runtime.egressAuthorizations,
      readImage: (artifactId) => runtime.imageArtifacts.getBytes(artifactId),
      authorizationId: body.authorization_id,
      artifactIds: artifacts.map((a) => a.artifactId),
      nowMs: runtime.now(),
    });
    if (!extracted.ok) {
      return { status: 422, body: { error: extracted.refusal } };
    }

    // §4.1's numbering: continuous across pages in page order, data from
    // row 2 — the CSV convention the importer already speaks.
    const orderedRows = [...extracted.rows].sort((a, b) => a.page_index - b.page_index);
    const commitment: ExtractionCommitment = {
      draft_id: body.draft_id,
      manifest: artifacts.map((a) => ({
        artifact_id: a.artifactId,
        content_hash: a.contentHash,
        page_index: a.pageIndex,
      })),
      schema_id: extracted.schemaId,
      model: extracted.model,
      rows: orderedRows.map((row, i) => ({
        page_index: row.page_index,
        row: i + 2,
        content: row.cells,
      })),
    };
    const commitmentShape = validateExtractionCommitment(commitment);
    if (commitmentShape !== null) {
      return { status: 422, body: { error: `extraction_invalid: ${commitmentShape}` } };
    }
    const extractionDigest = extractionCommitmentDigest('catalog', commitment, (data) => sha256(data));
    const binding: CatalogExtractionBinding = {
      binding_version: 1,
      draft_id: body.draft_id,
      content_revision: 1,
      extraction_digest: extractionDigest,
    };

    const outcome = createCatalogDraft(
      {
        ...ingressDeps(runtime.catalogDrafts),
        // The id CAPTURE minted — the artifacts are owned by it, and §6
        // erasure follows that ownership.
        newDraftId: () => body.draft_id as string,
      },
      {
        catalogId: body.catalog_id,
        source: catalogRowsFromRecords(orderedRows.map((r) => r.cells)),
        defaultScheme: 'sku',
        identity: { supplierDid: owner, catalogId: body.catalog_id },
        settings: {
          categoryIds: settings.catalogCategoryIds ?? [],
          fulfilmentRegions: settings.publicRegions,
          ...(settings.tradingCurrency === undefined
            ? {}
            : { tradingCurrency: settings.tradingCurrency }),
        },
        provenanceClass: 'model_derived',
        extraction: { model: extracted.model, schemaVersion: extracted.schemaId },
        photoExtraction: {
          manifest: commitment.manifest,
          extractionDigest,
          binding,
        },
      },
    );
    return { status: 200, body: { ok: true, draft: outcome.draft } };
  });

  /**
   * The connector lane's draft, and the producer `source_parsed` never had.
   *
   * §10 item 14's decision is that a cadence-driven refresh may fetch,
   * assemble and build on a timer and then WAIT at `approve`. That sequence
   * needs a draft; without one the connector's only route to publication was
   * the item-list body, which `ownerPresenceAvailable()` is armed to retire —
   * so the retirement would have stranded every connector catalog rather than
   * routing it through a review.
   *
   * The class is `source_parsed`: a spreadsheet or an ERP read is a
   * deterministic parse of a source the owner configured, so nothing was
   * inferred and there is no model to name. §10 item 13 records what that
   * exemption does NOT cover — the values can still be wrong, they are simply
   * not machine-INVENTED — and §10 item 11's laundering hole widens by one
   * entry point here, which is why the class is fixed by the route and cannot
   * be asked for.
   */
  router.post('/v1/commerce/catalog/drafts/from_connector', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.catalog_id !== 'string' || body.catalog_id === '') {
      return { status: 400, body: { error: 'catalog_id is required' } };
    }
    const kinds: ConnectorKind[] = ['spreadsheet_upload', 'spreadsheet_url', 'rest'];
    if (!kinds.includes(body.kind as ConnectorKind)) {
      return { status: 400, body: { error: `kind must be one of ${kinds.join(' | ')}` } };
    }
    if (body.default_scheme !== 'gtin' && body.default_scheme !== 'sku') {
      return { status: 400, body: { error: "default_scheme must be 'gtin' or 'sku'" } };
    }
    const owner = ownerDid();
    if (owner === null) return { status: 503, body: { error: 'owner_identity_unavailable' } };
    const stored = runtime.settings.readSupplier();
    if (!stored.ok) {
      return stored.absent
        ? { status: 409, body: { error: 'supplier_settings_absent' } }
        : { status: 409, body: { error: 'supplier_settings_invalid', findings: stored.findings } };
    }
    const settings = stored.settings;
    // The same rule the acknowledgement path enforces: an asymmetric rule is a
    // rule with a hole in it.
    if (settings.actingBusinessDid !== '' && settings.actingBusinessDid !== owner) {
      return { status: 403, body: { error: 'acting_business_mismatch' } };
    }

    const loaded = await loadCatalogThroughConnector({
      spec: {
        kind: body.kind as ConnectorKind,
        credentialResource:
          typeof body.credential_resource === 'string' ? body.credential_resource : null,
        operation: typeof body.operation === 'string' ? body.operation : 'read_catalog',
      },
      // The install is the credential's OWN record, never a body field: a
      // caller naming an install id would be choosing which grant to spend.
      installId:
        typeof body.credential_resource === 'string'
          ? (runtime.credentials.describe(body.credential_resource)?.installId ?? '')
          : '',
      ...(typeof body.document === 'string' ? { document: body.document } : {}),
      broker: runtime.broker,
      defaultScheme: body.default_scheme,
      supplierDid: owner,
    });
    // A CONNECTOR REFUSAL IS A 409 — it says the source could not be read at
    // all, which is a different thing from rows that need repair.
    if (!loaded.ok) {
      return { status: 409, body: { ok: false, error: loaded.refusal, detail: loaded.error } };
    }

    const outcome = createCatalogDraft(ingressDeps(runtime.catalogDrafts), {
      catalogId: body.catalog_id,
      source: loaded.source,
      defaultScheme: body.default_scheme,
      identity: { supplierDid: owner, catalogId: body.catalog_id },
      settings: {
        categoryIds: settings.catalogCategoryIds ?? [],
        fulfilmentRegions: settings.publicRegions,
        ...(settings.tradingCurrency === undefined
          ? {}
          : { tradingCurrency: settings.tradingCurrency }),
      },
      provenanceClass: 'source_parsed',
      // A deterministic parse inferred nothing, so there is no model to name.
      extraction: null,
    });
    return { status: 200, body: { ok: true, draft: outcome.draft } };
  });

  router.post(
    '/v1/commerce/catalog/drafts/from_file',
    ingest(
      'owner_authored',
      // A file the seller wrote inferred nothing, so there is no model to name.
      () => ({ ok: true, extraction: null }),
      (body) => {
        if (typeof body.csv !== 'string' || body.csv === '') {
          return { ok: false, response: { status: 400, body: { error: 'csv is required' } } };
        }
        return { ok: true, source: parseCatalogCsv(body.csv) };
      },
    ),
  );

  // ==========================================================================
  // The khata (TRADE_FIRST_STRATEGY §4.2–§4.4) + the tender decline (§3.4).
  //
  // Owner routes over `TradeLedgerService`. The retained-order and
  // bound-quote readers resolve through the §16.2 receipts store, trying
  // Relationship readers live in `trade_readers.ts` — one definition
  // shared with the D2D trade ingress and the tender comparison.
  // ==========================================================================

  const tradeLedgerService = (
    runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
  ): TradeLedgerService =>
    new TradeLedgerService({
      documents: runtime.tradeDocuments,
      nodeDid: runtime.nodeDid,
      now: runtime.now,
      ...tradeRelationshipReaders(runtime),
    });

  const tradeAnswer = <T>(outcome: { ok: true; document: T } | { ok: false; refusal: string }): CoreResponse =>
    outcome.ok
      ? { status: 200, body: { ok: true, document: outcome.document } }
      : { status: 409, body: { error: outcome.refusal } };

  /**
   * §4.2/§4.3 — push an authored khata document to the counterparty as a
   * `commerce.trade` message. BEST-EFFORT BY DESIGN: the document is
   * already retained before this runs, both ledgers reconcile through the
   * unanswered sweeps, and a send failure must not un-author a document —
   * so the answer carries `dispatched` and the owner surface can re-send.
   */
  const dispatchTradeDocument = async (
    toDid: string,
    kind: string,
    document: unknown,
  ): Promise<boolean> => {
    const send = getD2DSender();
    if (send === null || toDid === '') return false;
    try {
      const outcome = await send(toDid, 'commerce.trade', { kind, document });
      // Delivered, buffered at the relay, or queued for retry all count as
      // dispatched — the outbox owns the retry from here. A void return is
      // a fire-and-forget sender that reported nothing to distrust.
      return outcome === undefined ? true : outcome.delivered || outcome.buffered || outcome.queued;
    } catch {
      return false;
    }
  };

  const tradeAnswerDispatched = async <T>(
    outcome: { ok: true; document: T } | { ok: false; refusal: string },
    toDid: string,
    kind: string,
  ): Promise<CoreResponse> => {
    if (!outcome.ok) return { status: 409, body: { error: outcome.refusal } };
    const dispatched = await dispatchTradeDocument(toDid, kind, outcome.document);
    return { status: 200, body: { ok: true, document: outcome.document, dispatched } };
  };

  router.post('/v1/commerce/trade/delivery-note', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.counterparty_did !== 'string' ||
      typeof body.purchase_order_id !== 'string' ||
      typeof body.supplier_order_id !== 'string' ||
      !Array.isArray(body.lines)
    ) {
      return {
        status: 400,
        body: { error: 'counterparty_did, purchase_order_id, supplier_order_id and lines are required' },
      };
    }
    return tradeAnswerDispatched(
      tradeLedgerService(runtime).issueDeliveryNote({
        counterpartyDid: body.counterparty_did,
        purchaseOrderId: body.purchase_order_id,
        supplierOrderId: body.supplier_order_id,
        lines: body.lines as never,
        ...(typeof body.expected_by === 'string' ? { expectedBy: body.expected_by } : {}),
      }),
      body.counterparty_did,
      'delivery_note',
    );
  });

  /**
   * A caller a trade route may act for: the owner, or a staff device
   * whose grant the route will check. NEVER widens beyond those two —
   * every other caller gets the owner guard's own refusal, so the
   * refusal shape stays identical to the rest of the commerce surface.
   */
  const tradeCallerFor = (req: CoreRequest): CommerceRouteCaller | CoreResponse =>
    staffOrOwnerCaller(req, ownerOnlyGuard);

  router.post('/v1/commerce/trade/delivery-receipt', async (req): Promise<CoreResponse> => {
    const caller = tradeCallerFor(req);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.delivery_note_digest !== 'string' || !Array.isArray(body.lines)) {
      return { status: 400, body: { error: 'delivery_note_digest and lines are required' } };
    }
    const service = tradeLedgerService(runtime);
    if (caller.kind === 'staff') {
      // §6.4/§6.5 — a person at THAT device, then the deterministic gate
      // against the receipt's value priced from the bound quote. The
      // pricing is fail-closed: an unpriceable receipt never reaches the
      // cap comparison, and never slips past it either.
      if (!staffPresentNow(caller.deviceDid, runtime.now())) {
        return { status: 403, body: { error: 'access_denied', reason: 'staff presence required' } };
      }
      const priced = service.priceDeliveryReceipt({
        deliveryNoteDigest: body.delivery_note_digest,
        lines: body.lines as never,
      });
      if (!priced.ok) return { status: 409, body: { error: priced.refusal } };
      const gate = checkStaffOperation({
        repository: runtime.staffGrants,
        deviceDid: caller.deviceDid,
        scope: 'commerce_receive_goods',
        // Receiving goods is the BUYER side of the relationship, and the
        // service itself re-verifies that this node is the order buyer.
        installRole: 'buyer',
        value: priced.value,
      });
      if (gate.verdict === 'refuse') {
        return { status: 403, body: { error: 'access_denied', reason: gate.reason } };
      }
      if (gate.verdict === 'escalate') {
        const escalated = escalateStaffOperation({
          deviceDid: caller.deviceDid,
          scope: 'commerce_receive_goods',
          subject: body.delivery_note_digest,
          value: priced.value,
          reason: gate.reason,
          nowMs: runtime.now(),
        });
        if (escalated.kind === 'unavailable') {
          return { status: 403, body: { error: 'access_denied', reason: 'approval subsystem unavailable' } };
        }
        if (escalated.kind === 'escalated') {
          return { status: 202, body: { status: 'pending_approval', task_id: escalated.taskId } };
        }
        // `approved` — the owner approved THIS note at THIS value; fall
        // through to issue. The note takes only one receipt ever (the
        // one-answer rule), so the standing card cannot authorize twice.
      }
    }
    return tradeAnswerDispatched(
      service.issueDeliveryReceipt({
        deliveryNoteDigest: body.delivery_note_digest,
        lines: body.lines as never,
      }),
      runtime.tradeDocuments.get(body.delivery_note_digest)?.counterpartyDid ?? '',
      'delivery_receipt',
    );
  });

  router.post('/v1/commerce/trade/payment-note', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.supplier_did !== 'string' ||
      body.amount === null ||
      typeof body.amount !== 'object' ||
      typeof body.method !== 'string'
    ) {
      return { status: 400, body: { error: 'supplier_did, amount and method are required' } };
    }
    return tradeAnswerDispatched(
      tradeLedgerService(runtime).issuePaymentNote({
        supplierDid: body.supplier_did,
        amount: body.amount as never,
        method: body.method as never,
        ...(typeof body.external_ref === 'string' ? { externalRef: body.external_ref } : {}),
        ...(Array.isArray(body.order_refs) ? { orderRefs: body.order_refs as string[] } : {}),
      }),
      body.supplier_did,
      'payment_note',
    );
  });

  router.post('/v1/commerce/trade/payment-ack', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.payment_note_digest !== 'string' ||
      (body.kind !== 'received' && body.kind !== 'disputed')
    ) {
      return {
        status: 400,
        body: { error: 'payment_note_digest and a kind of received | disputed are required' },
      };
    }
    return tradeAnswerDispatched(
      tradeLedgerService(runtime).acknowledgePayment({
        paymentNoteDigest: body.payment_note_digest,
        kind: body.kind,
        ...(body.amount_received !== undefined ? { amountReceived: body.amount_received as never } : {}),
      }),
      runtime.tradeDocuments.get(body.payment_note_digest)?.counterpartyDid ?? '',
      'payment_ack',
    );
  });

  router.post('/v1/commerce/trade/quote-decline', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.request_id !== 'string' ||
      typeof body.buyer_did !== 'string' ||
      typeof body.reason_code !== 'string'
    ) {
      return { status: 400, body: { error: 'request_id, buyer_did and reason_code are required' } };
    }
    // The RETAINED request — never one the caller supplies. An inbound
    // request is retained in the §16.2 receipts store under the
    // REQUESTING BUYER's key, which is why the route requires it.
    let retained = null;
    for (const receipt of runtime.receipts.listByBuyerAndDomain(body.buyer_did, 'request')) {
      const request = rehydrateQuoteRequest(receipt.recordJson, hash);
      if (request.ok && request.value.request_id === body.request_id) retained = request.value;
    }
    if (retained === null) {
      return { status: 404, body: { error: 'no retained request with that id' } };
    }
    return tradeAnswer(
      tradeLedgerService(runtime).declineQuote({
        request: retained,
        reasonCode: body.reason_code,
      }),
    );
  });

  router.get('/v1/commerce/trade/statement', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const counterparty = req.query?.counterparty_did;
    const currency = req.query?.currency;
    if (typeof counterparty !== 'string' || counterparty === '' || typeof currency !== 'string' || currency === '') {
      return { status: 400, body: { error: 'counterparty_did and currency are required' } };
    }
    // §4.4 — one fold per orientation. A statement is a claim retained
    // documents back: a stranger gets a refusal rather than a fabricated
    // "settled 0", and a dual-role pair (each supplies the other) is TWO
    // ledgers, so the caller must name the side when both exist.
    const sides = tradeOrientations(runtime, counterparty);
    if (!sides.supplier && !sides.buyer) {
      return { status: 404, body: { error: 'no_trade_relationship' } };
    }
    const roleParam = req.query?.role;
    if (roleParam !== undefined && roleParam !== 'buyer' && roleParam !== 'supplier') {
      return { status: 400, body: { error: 'role must be buyer or supplier' } };
    }
    if (roleParam === undefined && sides.supplier && sides.buyer) {
      return { status: 409, body: { error: 'role_required' } };
    }
    const role: 'buyer' | 'supplier' = roleParam ?? (sides.supplier ? 'supplier' : 'buyer');
    const service = tradeLedgerService(runtime);
    const fold = service.statement({ counterpartyDid: counterparty, currency, role });
    if (!fold.ok) return { status: 409, body: { error: fold.error } };
    // §4.5 — derived dues ride the statement, overdue FLAGGED and never
    // pushed: Silence First applies to money reminders too, so the flag
    // exists for the opened statement (Solicited) and the briefing
    // (Engagement), and this route interrupts nobody.
    const now = runtime.now();
    const dues = service.dues({ counterpartyDid: counterparty, currency, role }).dues.map((due) => ({
      ...due,
      overdue: Date.parse(due.due_at) <= now,
    }));
    return { status: 200, body: { ok: true, statement: fold, dues, role } };
  });

  /**
   * §4.3 — re-dispatch a retained OUTBOUND khata document. The authoring
   * routes are best-effort by design (a send failure must not un-author
   * a document), and the unanswered sweep surfaces what never got
   * through — this is the promised "the owner surface can re-send". The
   * document travels EXACTLY as retained: digest-sealed bytes, never
   * rebuilt, so a re-send cannot become a second document.
   */
  router.post('/v1/commerce/trade/resend', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const recordDigest = typeof body.record_digest === 'string' ? body.record_digest : '';
    // An ANSWER (a receipt, an ack) has no owner-visible digest of its
    // own — the surface knows the document it answered. `answers_to` +
    // `kind` addresses it that way: "re-send my receipt for THIS note".
    const answersTo = typeof body.answers_to === 'string' ? body.answers_to : '';
    const answerKind = typeof body.kind === 'string' ? body.kind : '';
    if (recordDigest === '' && (answersTo === '' || answerKind === '')) {
      return { status: 400, body: { error: 'record_digest, or answers_to + kind, is required' } };
    }
    const row =
      recordDigest !== ''
        ? runtime.tradeDocuments.get(recordDigest)
        : (runtime.tradeDocuments
            .answersTo(answersTo, answerKind as never)
            .find((r) => r.direction === 'outbound') ?? null);
    if (row === null) return { status: 404, body: { error: 'unknown_document' } };
    if (row.direction !== 'outbound') {
      // Re-sending a counterparty's own document back at them is never
      // this node's act.
      return { status: 409, body: { error: 'not_this_nodes_document' } };
    }
    const read = rehydrateTradeDocument(row);
    const dispatched = await dispatchTradeDocument(row.counterpartyDid, read.kind, read.document);
    return { status: 200, body: { ok: true, dispatched } };
  });

  router.get('/v1/commerce/trade/unanswered', (req): CoreResponse => {
    const caller = tradeCallerFor(req);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // §6.3 — the clerk's inbox feed: what this relationship is waiting
    // on. Readable by a staff device holding ANY live grant (a device
    // with none has no business here); the balance statement and the
    // tender comparison stay owner-only.
    if (
      caller.kind === 'staff' &&
      !runtime.staffGrants.listByDevice(caller.deviceDid).some((g) => g.revokedAt === null)
    ) {
      return { status: 403, body: { error: 'access_denied', reason: 'no live staff grant' } };
    }
    const counterparty = req.query?.counterparty_did;
    if (typeof counterparty !== 'string' || counterparty === '') {
      return { status: 400, body: { error: 'counterparty_did is required' } };
    }
    const olderThanMs = Number(req.query?.older_than_ms ?? '0');
    const pending = tradeLedgerService(runtime).unanswered({
      counterpartyDid: counterparty,
      olderThanMs: Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : 0,
    });
    return {
      status: 200,
      body: {
        ok: true,
        delivery_notes: pending.deliveryNotes.map((row) => ({
          record_digest: row.recordDigest,
          purchase_order_id: row.purchaseOrderId,
          direction: row.direction,
          created_at: row.createdAt,
        })),
        payment_notes: pending.paymentNotes.map((row) => ({
          record_digest: row.recordDigest,
          direction: row.direction,
          created_at: row.createdAt,
        })),
      },
    };
  });

  router.get('/v1/commerce/trade/books-export', (req): CoreResponse => {
    // OWNER-ONLY: the firm's books leave this node here, and §6.6 keeps
    // exports off the staff surface.
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const currency = req.query?.currency;
    if (typeof currency !== 'string' || currency === '') {
      return { status: 400, body: { error: 'currency is required' } };
    }
    // §10 — the Tally bridge's data contract: settled facts only, each
    // voucher naming the digest it derives from. The plugin on the
    // distributor's machine pulls this and feeds the firm's books; the
    // khata chain stays the shared truth.
    const vouchers = collectTallyVouchers(runtime, { currency }, hash);
    return {
      status: 200,
      body: { ok: true, voucher_count: vouchers.length, xml: renderTallyXml(vouchers) },
    };
  });

  router.get('/v1/commerce/trade/inbox', (req): CoreResponse => {
    const caller = tradeCallerFor(req);
    if (!('kind' in caller)) return caller;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // §6.3 — the staff surface IS the inbox, filtered to the grant's
    // install roles. Metadata only; a grantless staff device sees nothing.
    let items = buildTradeInbox(runtime, runtime.now()).items;
    if (caller.kind === 'staff') {
      const grants = runtime.staffGrants
        .listByDevice(caller.deviceDid)
        .filter((g) => g.revokedAt === null);
      if (grants.length === 0) {
        return { status: 403, body: { error: 'access_denied', reason: 'no live staff grant' } };
      }
      const roles = new Set(
        grants.flatMap((g) => (g.installs === 'both' ? ['buyer', 'supplier'] : [g.installs])),
      );
      items = items.filter((item) => roles.has(item.role));
    }
    return {
      status: 200,
      body: {
        ok: true,
        items: items.map((item) => ({
          kind: item.kind,
          role: item.role,
          subject: item.subject,
          counterparty_did: item.counterpartyDid,
          created_at: item.createdAt,
        })),
      },
    };
  });

  // ==========================================================================
  // The private tender (§3.2) — one question, N per-supplier requests,
  // one comparison card. Fan-out consent is the OWNER route call itself;
  // the route reports per-member dispatch outcomes so the surface can
  // show what actually left.
  // ==========================================================================

  router.post('/v1/commerce/trade/tender', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.suppliers) || !Array.isArray(body.lines) || body.projection === null || typeof body.projection !== 'object') {
      return { status: 400, body: { error: 'suppliers, lines and projection are required' } };
    }
    const suppliers: { supplierDid: string; serviceRkey: string }[] = [];
    for (const entry of body.suppliers) {
      const named = entry as Record<string, unknown>;
      if (typeof named.supplier_did !== 'string' || typeof named.service_rkey !== 'string') {
        return { status: 400, body: { error: 'every supplier names supplier_did and service_rkey' } };
      }
      suppliers.push({ supplierDid: named.supplier_did, serviceRkey: named.service_rkey });
    }
    const created = await createTender({
      suppliers,
      lines: body.lines as never,
      projection: completeProjection(body.projection as Record<string, unknown>) as never,
      ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
      ...(typeof body.required_by === 'string' ? { requiredBy: body.required_by } : {}),
      nowMs: runtime.now(),
    });
    return created.ok
      ? { status: 200, body: { ok: true, tender_id: created.tenderId, members: created.members } }
      : { status: 409, body: { error: created.refusal } };
  });

  router.get('/v1/commerce/trade/tender/comparison', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const tenderId = req.query?.tender_id;
    if (typeof tenderId !== 'string' || tenderId === '') {
      return { status: 400, body: { error: 'tender_id is required' } };
    }
    const buyerSettings = runtime.settings.readBuyer();
    const rateBps =
      buyerSettings.ok && buyerSettings.settings.workingCapitalRateBps !== undefined
        ? buyerSettings.settings.workingCapitalRateBps
        : undefined;
    const compared = compareTender({
      tenderId,
      deps: {
        ...(rateBps === undefined ? {} : { workingCapitalRateBps: rateBps }),
        ...tradeRelationshipReaders(runtime),
      },
      nowMs: runtime.now(),
    });
    return compared.ok
      ? { status: 200, body: { ok: true, members: compared.members } }
      : { status: 409, body: { error: compared.refusal } };
  });

  // ==========================================================================
  // Staff (TRADE_FIRST_STRATEGY §6) — attributed presence for a staff
  // device, and the owner's grant ceremony. The ceremony routes live
  // OUTSIDE the /v1/commerce/trade/ prefix on purpose: the authz matrix
  // itself then refuses a staff caller, so §6.6 ("staff can never create
  // or edit grants") holds at the door as well as in the handler.
  // ==========================================================================

  // ==========================================================================
  // The revenue-share chain (§5) — owner routes over the second document
  // chain. Same discipline as the khata: authoring runs the receiver's
  // rules on itself, the share is DERIVED, and dispatch is best-effort
  // over `commerce.trade` with the sweeps owning the follow-up.
  // ==========================================================================

  const revshareService = (
    runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
  ): RevshareService =>
    new RevshareService({
      documents: runtime.revshareDocuments,
      nodeDid: runtime.nodeDid,
      now: runtime.now,
    });

  const revshareAnswer = async <T>(
    outcome: { ok: true; document: T } | { ok: false; refusal: string },
    toDid: string,
    kind: string,
  ): Promise<CoreResponse> => {
    if (!outcome.ok) return { status: 409, body: { error: outcome.refusal } };
    const dispatched = await dispatchTradeDocument(toDid, kind, outcome.document);
    return { status: 200, body: { ok: true, document: outcome.document, dispatched } };
  };

  router.post('/v1/commerce/trade/revshare/propose', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.counterparty_did !== 'string' ||
      (body.self_role !== 'host' && body.self_role !== 'vendor') ||
      typeof body.share_bps !== 'number' ||
      typeof body.period !== 'string' ||
      (body.cash_handler !== 'host' && body.cash_handler !== 'vendor') ||
      typeof body.currency !== 'string' ||
      typeof body.effective_from !== 'string'
    ) {
      return {
        status: 400,
        body: { error: 'counterparty_did, self_role, share_bps, period, cash_handler, currency and effective_from are required' },
      };
    }
    return revshareAnswer(
      revshareService(runtime).propose({
        counterpartyDid: body.counterparty_did,
        selfRole: body.self_role,
        shareBps: body.share_bps,
        period: body.period as never,
        cashHandler: body.cash_handler,
        currency: body.currency,
        effectiveFrom: body.effective_from,
        ...(typeof body.replaces_proposal_digest === 'string'
          ? { replacesProposalDigest: body.replaces_proposal_digest }
          : {}),
      }),
      body.counterparty_did,
      'agreement_proposal',
    );
  });

  router.post('/v1/commerce/trade/revshare/decide', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.proposal_digest !== 'string' ||
      (body.kind !== 'accepted' && body.kind !== 'rejected')
    ) {
      return { status: 400, body: { error: 'proposal_digest and kind are required' } };
    }
    const counterparty = runtime.revshareDocuments.get(body.proposal_digest)?.counterpartyDid ?? '';
    return revshareAnswer(
      revshareService(runtime).decide({ proposalDigest: body.proposal_digest, kind: body.kind }),
      counterparty,
      'agreement_decision',
    );
  });

  router.post('/v1/commerce/trade/revshare/terminate', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.proposal_digest !== 'string') {
      return { status: 400, body: { error: 'proposal_digest is required' } };
    }
    const counterparty = runtime.revshareDocuments.get(body.proposal_digest)?.counterpartyDid ?? '';
    return revshareAnswer(
      revshareService(runtime).terminate({
        proposalDigest: body.proposal_digest,
        ...(typeof body.effective_at === 'string' ? { effectiveAt: body.effective_at } : {}),
      }),
      counterparty,
      'agreement_termination',
    );
  });

  router.post('/v1/commerce/trade/revshare/settle', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.proposal_digest !== 'string' ||
      typeof body.period_start !== 'string' ||
      typeof body.period_end !== 'string' ||
      typeof body.gross_minor_units !== 'string'
    ) {
      return {
        status: 400,
        body: { error: 'proposal_digest, period_start, period_end and gross_minor_units are required' },
      };
    }
    const counterparty = runtime.revshareDocuments.get(body.proposal_digest)?.counterpartyDid ?? '';
    return revshareAnswer(
      revshareService(runtime).issueSettlement({
        proposalDigest: body.proposal_digest,
        periodStart: body.period_start,
        periodEnd: body.period_end,
        grossMinor: body.gross_minor_units,
        ...(typeof body.replaces_settlement_digest === 'string'
          ? { replacesSettlementDigest: body.replaces_settlement_digest }
          : {}),
      }),
      counterparty,
      'settlement_note',
    );
  });

  router.post('/v1/commerce/trade/revshare/ack-settlement', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.settlement_digest !== 'string' ||
      (body.kind !== 'accepted' && body.kind !== 'disputed')
    ) {
      return { status: 400, body: { error: 'settlement_digest and kind are required' } };
    }
    const counterparty =
      runtime.revshareDocuments.get(body.settlement_digest)?.counterpartyDid ?? '';
    return revshareAnswer(
      revshareService(runtime).acknowledgeSettlement({
        settlementDigest: body.settlement_digest,
        kind: body.kind,
      }),
      counterparty,
      'settlement_ack',
    );
  });

  router.get('/v1/commerce/trade/revshare/statement', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const proposalDigest = req.query?.proposal_digest;
    if (typeof proposalDigest !== 'string' || proposalDigest === '') {
      return { status: 400, body: { error: 'proposal_digest is required' } };
    }
    const service = revshareService(runtime);
    const fold = service.statement(proposalDigest);
    const { status, unansweredSettlements } = service.status(proposalDigest);
    return fold.ok
      ? {
          status: 200,
          body: {
            ok: true,
            statement: fold,
            agreement_state: status.state,
            unanswered_settlements: unansweredSettlements,
          },
        }
      : { status: 409, body: { error: fold.error, agreement_state: status.state } };
  });

  router.post('/v1/commerce/trade/staff-presence', async (req): Promise<CoreResponse> => {
    // Staff callers only. The owner proves presence with the master
    // passphrase on its own route; accepting it here would blur which
    // principal a stamp belongs to.
    if (req.callerType !== 'staff' || typeof req.callerDID !== 'string' || req.callerDID === '') {
      return { status: 403, body: { error: 'access_denied', reason: 'staff callers only' } };
    }
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    if (!staffPresenceCanBeEstablished()) {
      return { status: 503, body: { error: 'staff_presence_unavailable' } };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.pin !== 'string') {
      return { status: 400, body: { error: 'pin is required' } };
    }
    const proven = await proveStaffPresence(req.callerDID, body.pin, runtime.now());
    // One bit out, same as the owner route: wrong PIN and broken
    // verifier are indistinguishable to the caller.
    return proven
      ? { status: 200, body: { ok: true, ttl_ms: OWNER_PRESENCE_TTL_MS } }
      : { status: 403, body: { error: 'access_denied', reason: 'presence not proven' } };
  });

  router.post('/v1/commerce/staff-grants', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // §6.2 — a PRESENCE-GATED ceremony: handing a clerk spending
    // authority is exactly the kind of act the five-minute window
    // exists for. Same fail-open rule as the vouch ceremony: a node
    // that cannot establish presence at all must not brick the grant
    // screen, because that node has no staff PINs either.
    if (ownerPresenceCanBeEstablished() && !ownerPresentNow(runtime.now())) {
      // Same error family as approve/publish: the mobile presence sheet
      // keys on 'no_user_presence' and retries after provePresence.
      return { status: 403, body: { error: 'no_user_presence' } };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.device_did !== 'string' ||
      body.device_did === '' ||
      !STAFF_SCOPES.includes(body.scope as StaffScope) ||
      !STAFF_INSTALL_SCOPES.includes(body.installs as StaffInstallScope)
    ) {
      return { status: 400, body: { error: 'device_did, scope and installs are required' } };
    }
    const scope = body.scope as StaffScope;
    const installs = body.installs as StaffInstallScope;
    const maxOrderMinorUnits =
      typeof body.max_order_minor_units === 'string' ? body.max_order_minor_units : undefined;
    const currency = typeof body.currency === 'string' ? body.currency : undefined;
    const invalid = validateStaffGrantInput({
      scope,
      installs,
      ...(maxOrderMinorUnits !== undefined ? { maxOrderMinorUnits } : {}),
      ...(currency !== undefined ? { currency } : {}),
    });
    if (invalid !== null) return { status: 400, body: { error: invalid } };
    // §6.4 — the ceremony SETS the per-device PIN. A device with no PIN
    // record cannot prove presence, so a grant without one would be dead
    // authority: the FIRST grant for a device requires a PIN; later
    // grants may rotate it or leave it standing.
    const pin = typeof body.pin === 'string' ? body.pin : undefined;
    if (pin === undefined && runtime.staffPins.get(body.device_did) === null) {
      return {
        status: 400,
        body: { error: 'pin_required', detail: 'the first grant for a device sets its presence PIN (§6.4)' },
      };
    }
    if (pin !== undefined) {
      const minted = await setStaffPin(runtime.staffPins, body.device_did, pin, runtime.now());
      if (!minted.ok) return { status: 400, body: { error: minted.refusal } };
    }
    const grant = {
      deviceDid: body.device_did,
      scope,
      maxOrderMinorUnits: maxOrderMinorUnits ?? '',
      currency: currency ?? '',
      installs,
      createdAt: runtime.now(),
      revokedAt: null,
    };
    // §6.4 — the node's FIRST staff grant crosses the attribution
    // boundary, and the two commit in ONE transaction: the grandfather
    // index of every v1 receipt/approval digest now in the store, then
    // the grant. A crash between them cannot leave a staff-capable node
    // that still accepts unattributed vouches.
    if (runtime.attributionBoundary.crossedAt() === null) {
      runtime.runInTransaction(() => {
        runtime.attributionBoundary.cross(
          runtime.now(),
          enumerateV1Records({
            catalogDrafts: runtime.catalogDrafts,
            orderDrafts: runtime.orderDrafts,
            orderApprovals: runtime.orderApprovals,
          }),
        );
        runtime.staffGrants.put(grant);
      });
    } else {
      runtime.staffGrants.put(grant);
    }
    return { status: 200, body: { ok: true } };
  });

  router.get('/v1/commerce/staff-grants', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const deviceDid = req.query?.device_did;
    if (typeof deviceDid !== 'string' || deviceDid === '') {
      return { status: 400, body: { error: 'device_did is required' } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        grants: runtime.staffGrants.listByDevice(deviceDid).map((g) => ({
          scope: g.scope,
          installs: g.installs,
          max_order_minor_units: g.maxOrderMinorUnits,
          currency: g.currency,
          created_at: g.createdAt,
          revoked_at: g.revokedAt,
        })),
      },
    };
  });

  // ==========================================================================
  // The invite (§8) — one owner tap mints a QR/paste code; redeeming it is
  // the counterparty's consent; the four relay messages settle in the
  // invite service (`commerce.invite` in the receive pipeline).
  // ==========================================================================

  router.post('/v1/commerce/invites', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const service = getInviteService();
    if (service === null) return { status: 503, body: { error: 'invite_unavailable' } };
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    // Minting an offer hands standing authority to whoever redeems it —
    // the staff-grant presence rule applies, fail-open only where no
    // verifier exists at all.
    if (ownerPresenceCanBeEstablished() && !ownerPresentNow(runtime.now())) {
      // Same error family as approve/publish: the mobile presence sheet
      // keys on 'no_user_presence' and retries after provePresence.
      return { status: 403, body: { error: 'no_user_presence' } };
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      (body.direction !== 'i_supply_you' && body.direction !== 'you_supply_me') ||
      !Array.isArray(body.service_rkeys) ||
      (body.capabilities !== undefined && !Array.isArray(body.capabilities))
    ) {
      return { status: 400, body: { error: 'direction and service_rkeys are required' } };
    }
    if (body.send_to_did !== undefined && typeof body.send_to_did !== 'string') {
      return { status: 400, body: { error: 'send_to_did must be a DID string' } };
    }
    const minted = service.mintOffer({
      direction: body.direction,
      serviceRkeys: body.service_rkeys as string[],
      // Absent means the standard trade pair — the ONE place that list lives.
      capabilities: (body.capabilities as string[] | undefined) ?? [...TRADE_INVITE_CAPABILITIES],
      ...(typeof body.ttl_ms === 'number' ? { ttlMs: body.ttl_ms } : {}),
    });
    if (!minted.ok) return { status: 409, body: { error: minted.refusal } };
    // §8 cold leg — the offer travels over the relay to a discovered DID
    // instead of a pasted code. Best-effort like every dispatch: the
    // offer is minted either way, and /invites/send re-sends it.
    let coldDispatched: boolean | undefined;
    if (typeof body.send_to_did === 'string' && body.send_to_did !== '') {
      const sent = await service.sendOffer({
        nonce: minted.value.offer.nonce,
        toDid: body.send_to_did,
      });
      coldDispatched = sent.ok ? sent.value.dispatched : false;
    }
    return {
      status: 200,
      body: {
        ok: true,
        offer: minted.value.offer,
        code: minted.value.code,
        ...(coldDispatched !== undefined ? { cold_dispatched: coldDispatched } : {}),
      },
    };
  });

  /**
   * §8 cold leg, standalone: (re)send a minted, still-open offer to a
   * DID. Owner-only, no fresh presence — the authority was minted at the
   * presence-gated mint; this only moves the same bytes.
   */
  router.post('/v1/commerce/invites/send', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const service = getInviteService();
    if (service === null) return { status: 503, body: { error: 'invite_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.nonce !== 'string' || body.nonce === '' || typeof body.to_did !== 'string' || body.to_did === '') {
      return { status: 400, body: { error: 'nonce and to_did are required' } };
    }
    const sent = await service.sendOffer({ nonce: body.nonce, toDid: body.to_did });
    return sent.ok
      ? { status: 200, body: { ok: true, dispatched: sent.value.dispatched } }
      : { status: 409, body: { error: sent.refusal } };
  });

  router.post('/v1/commerce/invites/redeem', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const service = getInviteService();
    if (service === null) return { status: 503, body: { error: 'invite_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.code !== 'string' || !Array.isArray(body.service_rkeys)) {
      return { status: 400, body: { error: 'code and service_rkeys are required' } };
    }
    const redeemed = await service.redeemCode({
      code: body.code,
      serviceRkeys: body.service_rkeys as string[],
    });
    return redeemed.ok
      ? {
          status: 200,
          body: {
            ok: true,
            redemption: redeemed.value.redemption,
            resent: redeemed.value.resent,
            // Best-effort dispatch, VISIBLE: a denied egress must not
            // read as a working ceremony (re-paste re-sends).
            dispatched: redeemed.value.dispatched,
          },
        }
      : { status: 409, body: { error: redeemed.refusal } };
  });

  router.post('/v1/commerce/invites/accept-held', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const service = getInviteService();
    if (service === null) return { status: 503, body: { error: 'invite_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.nonce !== 'string' || body.nonce === '' || !Array.isArray(body.service_rkeys)) {
      return { status: 400, body: { error: 'nonce and service_rkeys are required' } };
    }
    // The owner's consent tap on a held COLD offer — §8 continues at
    // step 2 exactly as if the code had been pasted.
    const accepted = await service.acceptHeldOffer({
      nonce: body.nonce,
      serviceRkeys: body.service_rkeys as string[],
    });
    return accepted.ok
      ? {
          status: 200,
          body: {
            ok: true,
            redemption: accepted.value.redemption,
            dispatched: accepted.value.dispatched,
          },
        }
      : { status: 409, body: { error: accepted.refusal } };
  });

  router.get('/v1/commerce/invites', (req): CoreResponse => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    return {
      status: 200,
      body: {
        ok: true,
        invites: runtime.invites.list().map((row) => ({
          role: row.role,
          state: row.state,
          direction: row.direction,
          counterparty_did: row.counterpartyDid,
          activation_proven: row.activationProvenAt !== null,
          expires_at: row.expiresAt,
          created_at: row.createdAt,
          // The nonce travels ONLY for held cold offers: the owner's own
          // consent surface needs the key to accept, and nothing else does.
          ...(row.state === 'held' ? { nonce: row.nonce } : {}),
        })),
      },
    };
  });

  router.post('/v1/commerce/staff-grants/revoke', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const runtime = getCommerceRuntime();
    if (runtime === null) return { status: 503, body: { error: 'commerce_unavailable' } };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.device_did !== 'string' || body.device_did === '') {
      return { status: 400, body: { error: 'device_did is required' } };
    }
    // Revocation needs no presence window — taking authority AWAY must
    // never wait on a passphrase. Stamp every grant and drop any
    // standing presence proof in the same breath.
    runtime.staffGrants.revokeDevice(body.device_did, runtime.now());
    clearStaffPresence(body.device_did);
    runtime.staffPins.remove(body.device_did);
    return { status: 200, body: { ok: true } };
  });
}
