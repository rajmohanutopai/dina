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

import {
  validateCatalogPointer,
  validatePurchaseOrderProposal,
  type CatalogPointer,
  type CommerceOrderStatus,
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
import { getBuyerAuthorityProvider } from '../../commerce/buyer_authority';
import {
  getBuyerOrderSender,
  submitApprovedOrder,
  type SubmitRefusal,
 SubmitAuthority } from '../../commerce/buyer_executor';
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
import { planCommerceInstall, roleIsInstalled } from '../../commerce/install_plan';
import {
  newApprovalId,
  ORDER_APPROVAL_TTL_MS,
  type RetainedOrderApproval,
} from '../../commerce/order_approvals';
import { settleInboundOrderDecision } from '../../commerce/order_decision';
import { chooseOffer, planProcurement } from '../../commerce/procurement_service';
import { describeQuoteForOwner } from '../../commerce/quote_read_model';
import { askReconcilePolls } from '../../commerce/reconcile_poller';
import { makeServiceQueryReconcileSend } from '../../commerce/reconcile_sweeper';
import { buildReconciliationCensus } from '../../commerce/reconciliation_census';
import { BUYER_REFERENCE_MANIFEST } from '../../commerce/reference_manifests';
import {
  describeDisagreement,
  mayAuthorizeSubstitution,
  mayInheritStanding,
  mayShowAsRelated,
  resolveRelationships,
  type AppViewAnswer,
} from '../../commerce/relationship_resolver';
import { commerceAvailability, getCommerceRuntime } from '../../commerce/runtime';
import { resolveServiceBinding } from '../../commerce/service_binding';
import { buildSupplierInbox } from '../../commerce/supplier_inbox';
import { getNodeDID } from '../../pairing/ceremony';
import { getPluginInstallRepository } from '../../plugins/registry';

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
 * Can this node establish that a person is present?
 *
 * ONE DEFINITION, read by two places that must not disagree: the draft
 * service's `userPresent`, and the guard on the shipped publish route.
 *
 * §10 item 9 records that the primitive exists — a per-persona Argon2id
 * verifier — with no production caller, no persistence and no mobile
 * equivalent. It returns false until that is wired, which is why the draft
 * lane cannot yet publish anything at all.
 */
function ownerPresenceAvailable(): boolean {
  return false;
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

/**
 * Which status a submit refusal deserves (NEW-17).
 *
 * The three are different answers to a client: 200 says the order is already
 * placed, 503 says this node cannot decide, 409 says it decided no. Mapping an
 * unreadable install registry to 409 told a client "the install changed since
 * approval, retry" about a node that will refuse identically for ever — and
 * every other not-configured condition on these routes already answers 503.
 */
function unanswerableStatus(refusal: SubmitRefusal): number {
  if (refusal === 'already_submitted') return 200;
  if (refusal === 'install_registry_unavailable') return 503;
  return 409;
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
/**
 * §7.2/§7.3 — who may commit this business, resolved by CORE (DR-1).
 *
 * FAIL CLOSED. A node whose composition root installed no authority provider
 * cannot say who is allowed to spend its money, so it does not spend it. The
 * previous shape passed nothing and `submitApprovedOrder` skipped the check
 * entirely, which meant every order on this node was committed with no
 * authority evaluation at all.
 */
function resolveAuthority(
  order: PurchaseOrderProposal,
  context: BuyerApprovalContext,
  serviceRkey: string,
): { ok: true; authority: SubmitAuthority } | { ok: false; response: CoreResponse } {
  const provider = getBuyerAuthorityProvider();
  if (provider === null) {
    return {
      ok: false,
      response: { status: 503, body: { error: 'authority_provider_unavailable' } },
    };
  }
  const authority = provider({ order, context, serviceRkey });
  if (authority === null) {
    // §7.3: an owner with no grant record is not an owner. A missing record is
    // a refusal, never a default.
    return { ok: false, response: { status: 403, body: { error: 'no_authority_record' } } };
  }
  return { ok: true, authority };
}


function readAnswerableApproval(
  runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
  approvalId: string,
  nowMs: number,
):
  | { ok: true; approval: RetainedOrderApproval }
  | { ok: false; response: CoreResponse } {
  const approval = runtime.orderApprovals.get(approvalId);
  if (approval === null) {
    // Absent, or held in a form this node can no longer reconstruct — a row
    // edited after writing reads as absent on purpose, because sending
    // against an approval we cannot rebuild is sending against nothing.
    return { ok: false, response: { status: 404, body: { error: 'unknown_approval' } } };
  }
  if (approval.consumedAt !== null) {
    return { ok: false, response: { status: 409, body: { error: 'approval_already_used' } } };
  }
  if (nowMs >= approval.expiresAt) {
    return { ok: false, response: { status: 409, body: { error: 'approval_expired' } } };
  }
  return { ok: true, approval };
}

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

    const send = getBuyerOrderSender();
    if (send === null) {
      // FAIL CLOSED, and visibly. There is no fallback worth having: a default
      // sender would either be a no-op that swallowed orders or a direct HTTP
      // call that skipped the four gates. A node whose composition root has not
      // supplied one cannot buy, and says so.
      return { status: 503, body: { error: 'buyer_sender_unavailable' } };
    }

    const body = (req.body ?? {}) as { approval_id?: unknown };
    const approvalId = typeof body.approval_id === 'string' ? body.approval_id : '';
    if (approvalId === '') {
      return { status: 400, body: { error: 'approval_id is required' } };
    }

    const held = readAnswerableApproval(runtime, approvalId, Date.now());
    if (!held.ok) return held.response;

    const authorised = resolveAuthority(
      held.approval.order,
      held.approval.context,
      held.approval.serviceRkey,
    );
    if (!authorised.ok) return authorised.response;

    const result = await submitApprovedOrder({
      authority: authorised.authority,
      // ALL THREE COME FROM THE RETAINED CARD. Taking any of them from the
      // request would restore the defect: the rebuild inside
      // `submitApprovedOrder` compares a payload derived from the order to the
      // approved payload, and a caller supplying both proves only that it was
      // self-consistent.
      order: held.approval.order,
      approved: held.approval.payload,
      context: held.approval.context,
      serviceRkey: held.approval.serviceRkey,
      send,
      nowMs: Date.now(),
    });
    // SPENT ONLY ON A SEND. A refusal leaves the card answerable, so a
    // transient `buyer_sender_unavailable` or a momentarily expired quote does
    // not burn a decision the owner would have to make again from scratch.
    if (result.ok) runtime.orderApprovals.consume(approvalId, Date.now());
    // A REFUSAL IS A 200 when it carries a tracked record: "already submitted"
    // is the correct answer to a repeated tap, and the caller needs the state
    // more than it needs an error code. A binding failure is a 409 — the
    // request was well formed and the world disagreed with it.
    if (!result.ok) {
      return {
        // 503 for a node that cannot answer, 200 for "already submitted"
        // (the right answer to a repeated tap), 409 for a well-formed request
        // the world disagreed with. See `install_registry_unavailable`.
        status: unanswerableStatus(result.refusal),
        body: { ok: false, refusal: result.refusal, error: result.error, record: result.record },
      };
    }
    return { status: 200, body: { ok: true, ...describeOrderForOwner(result.record) } };
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
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
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

    const pending = runtime.pendingDecisions.get(buyerDid, purchaseOrderId);
    if (pending === null) return { status: 404, body: { error: 'no_pending_decision' } };

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
        }),
        actingBusinessDid,
        principal: {
          principalDid: owner,
          authorityDomain: SUPPLIER_ORDER_AUTHORITY_DOMAIN,
          policyRevision: null,
        },
        install: actingInstall,
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
    if (ownerPresenceAvailable()) {
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
      userPresent: ownerPresenceAvailable,
      publicationFence: () => publicationFence(),
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

  router.post(
    '/v1/commerce/catalog/drafts/confirm',
    withDraftService((svc, body) => answer(svc.confirm(String(body.draft_id)))),
  );

  router.post(
    '/v1/commerce/catalog/drafts/prepare',
    withDraftService((svc, body) =>
      answer(
        svc.prepare(String(body.draft_id), {
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
    withDraftService(async (svc, body) => answer(await svc.publish(String(body.draft_id)))),
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

      return answer(
        svc.repairRow(
          String(body.draft_id),
          { row, column: column === null ? null : String(column), value: value === undefined ? null : (value as string | null) },
          (rows, draft) =>
          assembleFromRows({
            rows,
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
            // re-minting would move every item's revision and timestamp.
            // The draft's OWN stamp. A repair is not a new draft, and
            // re-minting would move every item's revision and timestamp — and
            // with them the snapshot digest an owner may already have approved.
            stamp: { generatedAtIso: draft.generatedAtIso, itemRevision: draft.itemRevision },
          }),
        ),
      );
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
      itemRevision: `${String(Date.now())}-${bytesToHex(randomBytes(4))}`,
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
}
