/**
 * Supplier-side order admission engine — the §9.9 contract, executed:
 *
 *   1. REPLAY LOOKUP FIRST, by BOTH unique keys. Key aliasing and
 *      digest mismatch return typed conflicts BEFORE any quote-use
 *      check; a decided replay returns the recorded acknowledgement
 *      regardless of later expiry or supersession; a reserved replay
 *      returns `processing`.
 *   2. ADMISSION, in ONE transaction: quote binding + expiry +
 *      projection-extends verification, capacity check-and-hold, and
 *      the reserved order-reference record (the recoverable work
 *      item). Every admission REJECTION is itself a durable decided
 *      record — an answer, once given, is frozen.
 *   3. RECOVERY is phase-scoped: only `pre_effect` reservations may
 *      hit the decision deadline and become rejected(decision_timeout)
 *      WITH the hold refunded; `effect_started` reservations are never
 *      timed out, refunded, or re-dispatched (§12.7 returns
 *      received_unresolved for them until the real outcome resolves).
 *
 * Use holds settle per terminal outcome in the SAME transaction as
 * the acknowledgement: accepted commits; every rejection and a
 * counterproposal refund. "Signed acknowledgement" means the record
 * travels in the supplier Core's authenticated D2D envelope (§9.12);
 * this engine produces the canonical record + digest and persists it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  validateOrderAcknowledgement,
  verifyQuoteRevisionExtends,
  checkProtocolVersion,
  commerceRecordDigest,
  validateSignedQuote,
  verifyOrderAgainstQuote,
  type OrderAcknowledgement,
  type PurchaseOrderProposal,
  type QuoteRequest,
  type Sha256Fn,
  type SignedQuote,
  readPurchaseOrderProposal,
} from '@dina/commerce-protocol';

import { type CommerceOrderStore } from './commerce_order';
import {
  CommerceIntegrityError,
  type QuoteFamily,
  type QuoteFamilyStore,
  type QuoteRefusal,
} from './quote_family';
import { receivedFrom } from './receipt_evidence';
import {
  rehydrateAcknowledgement,
  rehydratePurchaseOrder,
  rehydrateQuoteRequest,
  rehydrateSignedQuote,
} from './rehydrate';

import type { CommerceReceiptRepository } from './receipts';

const hash: Sha256Fn = (data) => sha256(data);

export type AdmissionOutcome =
  | { kind: 'replay'; acknowledgement: OrderAcknowledgement }
  | { kind: 'processing'; retryAfterSeconds: number }
  | { kind: 'conflict'; error: string }
  | {
      kind: 'rejected';
      acknowledgement: OrderAcknowledgement;
      /**
       * OPERATOR-FACING, and never sent (§14.2).
       *
       * The wire `reason_code` is deliberately non-disclosing: `quote_unknown`
       * covers an expired quote, a quote this node never held, and a retained
       * record it could not read back, because telling a stranger which one
       * would let them probe the supplier's ledger. That is right for the
       * counterparty and wrong for the node's OWN operator, who otherwise
       * debugs a live refusal with no more information than an attacker has.
       *
       * Writing the disaster-recovery scenario cost an hour to exactly this:
       * a clock sitting on the quote's `valid_until` answered `quote_unknown`,
       * which reads as "no such quote" and sends you looking in the wrong
       * place. The bridge sends the CODE; this stays home.
       */
      detail: string;
    }
  | { kind: 'reserved' };

/**
 * Why the recovery sweeper could not decide an expired reservation.
 *
 * Reported rather than skipped: a sweep that answers "0 timed out" must not
 * read the same as one where every row is unreachable. A silent skip leaves
 * the reservation in the expired set for ever, its capacity held and the
 * buyer's reconcile answering `received_processing` with nobody watching.
 */
export type AdmissionRecoveryReason = 'reference_unloadable';

export interface AdmissionRecoverySkip {
  purchaseOrderId: string;
  reason: AdmissionRecoveryReason;
}

export interface AdmissionRecoverySweep {
  /** Orders decided `rejected(decision_timeout)` with their holds refunded. */
  timedOut: string[];
  /** Expired reservations this sweep could NOT resolve. Should be empty. */
  stuck: AdmissionRecoverySkip[];
}

export type SupplierDecision =
  | { kind: 'accepted'; supplierOrderId: string; externalRef?: string }
  | { kind: 'rejected'; reasonCode: string; currentQuoteDigest?: string }
  | { kind: 'counterproposal'; replacementQuote: SignedQuote };

export interface AdmissionEngineDeps {
  /**
   * Order state as an aggregate store. The raw reference repository is
   * deliberately not a dependency — `CommerceOrder.decide()` is worthless
   * while `refs.decide()` stays reachable from here.
   */
  orders: CommerceOrderStore;
  /**
   * Quote state, reached ONLY as aggregates. The raw ledger repository is
   * deliberately not a dependency here: `QuoteFamily.hold()` is worthless
   * if `holdUse()` stays reachable from this engine.
   */
  families: QuoteFamilyStore;
  receipts: CommerceReceiptRepository;
  /**
   * Acting supplier Business DID (acknowledgement identity), read per use.
   *
   * A thunk rather than a captured string, for the same reason
   * `QuoteFamilyStore` takes one: identity resolves AFTER storage, so an
   * engine built at storage-init time would capture whatever was there —
   * nothing. Reading it at each use also makes the failure the right one:
   * with no established identity the thunk throws and the operation fails
   * closed, instead of signing an acknowledgement under an empty DID.
   */
  supplierDid: () => string;
  /** Injected clock, epoch ms. */
  now: () => number;
  /** Bounded decision deadline for pre_effect reservations (§9.9 step 3). */
  decisionTimeoutMs: number;
  /** Supplier policy: honor an order against a superseded (unexpired,
   *  unvoided) revision instead of rejecting quote_superseded (§9.8). */
  honorSupersededRevisions?: boolean;
  /** Retry-after returned for reserved replays (seconds). */
  processingRetryAfterSeconds?: number;
  /**
   * §12.8 — create the accepted order's status genesis INSIDE the decision
   * transaction. Acceptance and its genesis were two transactions, so a
   * cancellation arriving between them saw a decided order with no chain and
   * answered `refused_policy`, while the same cancellation a moment later
   * could cancel. The reason code depended on timing rather than on the
   * order.
   *
   * Supplied by the composition root (it closes over the lifecycle engine),
   * because Core must not make the order aggregate know about status chains.
   * Returning an error rolls the whole decision back: an accepted order
   * without a chain is exactly the state this closes.
   */
  createAcceptedGenesisInTx?: (
    buyerDid: string,
    purchaseOrderId: string,
    /** The state the chain opens at — see the engine's own note. */
    openAt: 'accepted' | 'rejected',
  ) => { error: string } | null;
}

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * Deterministic, length-bounded suffix for an acknowledgement id.
 * Never derive an id by concatenating another id: both are bounded by
 * MAX_ID_LENGTH, so any prefix can overflow the result.
 */
export function ackIdSuffix(purchaseOrderId: string): string {
  return bytesToHex(hash(new TextEncoder().encode(purchaseOrderId))).slice(0, 32);
}

/**
 * Fallback text for a registration refusal that carries no detail of its
 * own. Typed as a total Record so adding a QuoteRefusal without handling
 * it here fails to compile rather than reaching an operator as a generic
 * message.
 */
const REGISTRATION_REFUSAL: Record<QuoteRefusal, string> = {
  quote_unknown: 'revision for an unknown quote_id',
  quote_voided: 'family voided by restore — sign a fresh quote_id (§16.2)',
  quote_expired: 'quote has expired',
  quote_consumed: 'capacity exhausted',
  quote_superseded: 'not the current head',
  stale_epoch: 'family belongs to a pre-restore epoch — capacity is never resurrected (§16.2)',
  future_epoch:
    'quote declares an epoch ahead of this Core — re-sign at the live epoch (§9.12/§16.2)',
  foreign_supplier: 'quote is signed by a different supplier — Core signs only its own (§9.12)',
  foreign_audience: 'quote is addressed to a different buyer than this path expects (§9.8)',
  duplicate_use: 'a use already exists for this order',
  revision_rejected: 'revision does not extend the current head (§9.8)',
};

/** Prefer the aggregate's precise reason; fall back to the refusal name. */
function registrationError(outcome: { refusal: QuoteRefusal; detail?: string }): string {
  return `quote ledger: ${outcome.detail ?? REGISTRATION_REFUSAL[outcome.refusal]}`;
}

/**
 * QuoteRefusal -> §9.9 wire reason_code. Total, so a new refusal cannot
 * reach the buyer as an unhandled case. `stale_epoch` reports as
 * `quote_voided` because that is what it means to the buyer: this family
 * belongs to a generation that no longer exists — request a new quote.
 * `revision_rejected` cannot arise on the admission path (no revision is
 * signed there); it maps to the non-disclosing code rather than being
 * left to fall through.
 */
const ADMISSION_REASON: Record<QuoteRefusal, string> = {
  quote_unknown: 'quote_unknown',
  quote_voided: 'quote_voided',
  quote_expired: 'quote_expired',
  quote_consumed: 'quote_consumed',
  quote_superseded: 'quote_superseded',
  stale_epoch: 'quote_voided',
  // Neither can reach a buyer: both are refused at registration, long
  // before any order names the family. Mapped non-disclosingly so a future
  // path cannot leak the supplier's signing state.
  future_epoch: 'quote_unknown',
  foreign_supplier: 'quote_unknown',
  foreign_audience: 'quote_unknown',
  duplicate_use: 'quote_consumed',
  revision_rejected: 'quote_unknown',
};

export class CommerceAdmissionEngine {
  constructor(private readonly deps: AdmissionEngineDeps) {}

  // -------------------------------------------------------------------------
  // Quote signing hooks (the ledger side of §9.8's CAS-at-signing)
  // -------------------------------------------------------------------------

  /**
   * Record a quote THIS supplier just signed: revision "1" registers
   * the head; revision N+1 must extend the stored head (the only
   * place a valid revision can be born). Persists the quote receipt.
   */
  registerSignedQuoteForOwnBuyer(quote: SignedQuote): string | null {
    // The ordinary signing path has no third party to compare against — the
    // supplier is signing a quote it composed for a buyer it chose. Stating
    // `quote.buyer_did` is a no-op TODAY and is deliberate: it is the seam
    // where the still-open request-receipt binding will supply a real
    // expectation (the buyer named on the retained quote request), and it
    // forces every future caller to answer the question.
    return this.registerSignedQuoteInTx(quote, quote.buyer_did);
  }

  /**
   * The registration primitive, WITHOUT opening a transaction. Callers
   * that are already inside deps.tx (counterproposal decisions, §16.2
   * replacement registration) must use this: op-sqlite implements
   * transactions with a raw BEGIN and cannot nest, so calling a wrapper that
   * opens one from inside a transaction fails on mobile even though the
   * reentrant test runner hides it on the server.
   *
   * PUBLIC because `CommerceAdmissionService` decides where transactions
   * begin — that is the whole point of ARCH-0b. Every other `…InTx` method on
   * this engine is public for the same reason; this one stayed private only
   * because its callers were all internal until the §16.2 replacement path
   * moved out to the service.
   */
  registerSignedQuoteInTx(quote: SignedQuote, expectedBuyerDid: string): string | null {
    const structural = validateSignedQuote(quote, hash);
    if (structural) return structural;
    const nowMs = this.deps.now();

    // §9.8 — Core is the quote-BIRTH gate, but the RULES belong to the
    // family, not to this method. Epoch monotonicity, immutable max_uses,
    // permanent voiding, revision extension and "valid_until moves with
    // the head" are all enforced inside QuoteFamily; adding copies here is
    // what scattered them in the first place.
    if (quote.quote_revision === '1') {
      const born = this.deps.families.register(quote, expectedBuyerDid);
      if (!born.ok) return registrationError(born);
    } else {
      const family = this.deps.families.load(quote.quote_id);
      if (family === null) return 'quote ledger: revision for an unknown quote_id';
      // The family needs the record its head digest names; this method
      // owns the receipt lookup because the aggregate does no I/O of its
      // own beyond the ledger.
      const heldQuote = this.loadRetainedQuote(family.headDigest);
      if (heldQuote === null) {
        return 'quote ledger: retained head quote is missing — cannot verify the revision (§9.8)';
      }
      if (heldQuote.supplier_did !== this.deps.supplierDid()) {
        return 'quote ledger: retained head was signed by a different supplier (§9.8)';
      }
      const advanced = family.advance(quote, heldQuote, verifyQuoteRevisionExtends);
      if (!advanced.ok) return registrationError(advanced);
    }
    this.deps.receipts.put({
      recordDigest: quote.quote_digest,
      domain: 'quote',
      buyerDid: quote.buyer_did,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(quote),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
    return null;
  }

  /**
   * §9.8/§9.9 — retain the buyer's REQUEST, without which a later order
   * cannot be checked.
   *
   * `admitInTx` looks this receipt up by `quote.request_digest` and uses the
   * retained request's delivery projection as the yardstick for the §9.9
   * projection-extends rule. Nothing wrote it: the domain existed, the reader
   * existed, and the writer was only ever a test fixture — so on a real node
   * every inbound order was refused `quote_unknown` with the operator detail
   * "retained request receipt missing".
   *
   * WHY THE RECEIPT AND NOT A COPY INSIDE THE QUOTE. The request is the
   * buyer's document, digested by the buyer; keeping the original bytes is
   * what lets `verifyCommerceRecordDigest` re-derive `request_digest` later
   * and prove the quote answers THIS question. A field copied into the quote
   * would be the supplier's account of what was asked.
   *
   * First-writer-wins on the digest, so a replayed request is a no-op rather
   * than a conflict — the same document has the same digest.
   */
  retainQuoteRequestInTx(request: QuoteRequest, authenticatedBuyerDid: string): void {
    this.deps.receipts.put({
      recordDigest: request.request_digest,
      domain: 'request',
      buyerDid: request.buyer_did,
      quoteId: '',
      purchaseOrderId: '',
      recordJson: JSON.stringify(request),
      // §9.12 — who actually handed this node the document, which is the
      // authenticated sender and never a field the document chose.
      evidenceJson: receivedFrom({
        fromDid: authenticatedBuyerDid,
        observedAt: this.deps.now(),
      }),
      createdAt: this.deps.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Admission (§9.9 precedence)
  // -------------------------------------------------------------------------

  /**
   * Admit an arriving proposal from the transport-authenticated
   * buyer. `authenticatedBuyerDid` comes from the D2D envelope — the
   * body value is checked against it, never trusted (§9.7).
   */
  /**
   * `context.servingManifestCid` is the plugin manifest CID serving this
   * supplier at admission (§9.13). Optional because a supplier need not be
   * plugin-backed at all; when absent the order records `''` and no
   * prior-manifest lifecycle routing is possible for it — which is correct,
   * since nothing served it under a contract that could later be superseded.
   *
   * Supplied by the CALLER rather than read from a node-wide setting: a node
   * may run several supplier plugins, and stamping an order with the wrong
   * one would route its lifecycle requests to another plugin's schemas.
   */
  admitOrderInTx(
    proposal: unknown,
    authenticatedBuyerDid: string,
    context?: { servingManifestCid?: string; servingInstallId?: string },
  ): AdmissionOutcome {
    // Validate and TYPE in one step (WS-0.7): the reader returns the order
    // itself, so there is no cast for a later reader to mistake for an
    // unchecked one.
    const read = readPurchaseOrderProposal(proposal, hash);
    if (!read.ok) return { kind: 'conflict', error: read.error };
    const order = read.order;

    if (order.buyer_did !== authenticatedBuyerDid) {
      return {
        kind: 'conflict',
        error: 'admission: body buyer_did does not match the authenticated sender (§9.7)',
      };
    }
    if (order.supplier_did !== this.deps.supplierDid()) {
      return { kind: 'conflict', error: 'admission: order addresses a different supplier' };
    }
    const version = checkProtocolVersion(order.protocol_version);
    if (version) {
      return {
        kind: 'conflict',
        error: `admission: unsupported_version (supported: ${version.supported_versions.join(', ')})`,
      };
    }

    return this.admitInTx(
      order,
      {
        manifestCid: context?.servingManifestCid ?? '',
        installId: context?.servingInstallId ?? '',
      },
      authenticatedBuyerDid,
    );
  }

  admitInTx(
    order: PurchaseOrderProposal,
    /**
     * WHO served this order, as ONE value rather than two positional strings.
     * The manifest CID and the install id are both plain strings and mean
     * opposite things to §9.13 (route under the contract the order opened
     * against) and §16.4 (is this INSTALL still on the hook) — side by side
     * they are a transposition waiting to happen, and the compiler would have
     * had nothing to say about it.
     */
    serving: { manifestCid: string; installId: string },
    /**
     * §9.12 — who actually handed this node the document, for the arrival
     * evidence. The gate above has already bound it to `order.buyer_did`, so
     * reading the order's own field here would give the same answer today —
     * and would be a second read that could drift if that gate ever changed.
     * One value, passed down.
     */
    authenticatedBuyerDid: string,
  ): AdmissionOutcome {
    const { orders } = this.deps;

    // STEP 1 — replay lookup by BOTH keys, conflicts before any use check.
    const byOrderId = orders.load(order.buyer_did, order.purchase_order_id)?.ref ?? null;
    const byKey = orders.byIdempotencyKey(order.buyer_did, order.idempotency_key);
    if (byOrderId || byKey) {
      if (!byOrderId || !byKey || byOrderId.purchaseOrderId !== byKey.purchaseOrderId) {
        return {
          kind: 'conflict',
          error:
            'admission: idempotency_key/purchase_order_id alias a different order — keys cannot alias (§15.5)',
        };
      }
      if (byOrderId.orderDigest !== order.order_digest) {
        return {
          kind: 'conflict',
          error:
            'admission: same keys with a DIFFERENT order_digest — never a second order, never silent adoption (§15.5)',
        };
      }
      if (byOrderId.state === 'decided') {
        // WS-2.2 — the stored answer is re-validated, not cast. A replayed
        // submission receives this verbatim as the supplier's commitment, so
        // an unreadable one must be a REFUSAL rather than a null handed back
        // as "here is what we agreed". `JSON.parse('null') as
        // OrderAcknowledgement` did exactly that, and a corrupt column threw.
        const stored = rehydrateAcknowledgement(byOrderId.acknowledgementJson, hash);
        if (!stored.ok) {
          return {
            kind: 'conflict',
            error: `admission: stored acknowledgement unreadable — store integrity failure (${stored.error})`,
          };
        }
        return { kind: 'replay', acknowledgement: stored.value };
      }
      return {
        kind: 'processing',
        retryAfterSeconds: this.deps.processingRetryAfterSeconds ?? 30,
      };
    }

    // STEP 2 — fresh admission: quote binding, expiry, capacity, reserve.
    // The quote-side precedence lives in QuoteFamily, so this method can
    // no longer put the checks in a different order than the signing path
    // does, nor forget one.
    const family = this.deps.families.load(order.quote_id);
    if (family === null) {
      return this.recordAdmissionRejection(
        order,
        serving,
        'quote_unknown',
        undefined,
        `no quote family for quote_id "${order.quote_id}"`,
      );
    }
    const verdict = family.admits(
      order,
      (digest) => this.loadRetainedQuote(digest),
      isoNow(this.deps.now()),
      this.deps.honorSupersededRevisions ?? false,
    );
    if (!verdict.ok) {
      // Two refusals carry more than a reason code, so they are named
      // here rather than flattened through the table.
      if (verdict.refusal === 'quote_voided' || verdict.refusal === 'stale_epoch') {
        return this.rejectVoidedFamily(order, serving);
      }
      if (verdict.refusal === 'quote_superseded') {
        return this.recordAdmissionRejection(order, serving, 'quote_superseded', family.headDigest);
      }
      return this.recordAdmissionRejection(
        order,
        serving,
        ADMISSION_REASON[verdict.refusal],
        undefined,
        // The family's OWN refusal, which the wire code flattens. `expired`
        // and `unknown` both leave as `quote_unknown`, and only one of them
        // means what an operator reads it to mean.
        `quote family refused: ${verdict.refusal}`,
      );
    }
    const quote = verdict.value;

    // Projection-extends needs the priced projection: the supplier
    // retained the quote REQUEST receipt (its digest is the quote's
    // requestDigest, and it carries the delivery projection).
    const requestReceipt = this.deps.receipts.get(quote.request_digest);
    if (!requestReceipt || requestReceipt.domain !== 'request') {
      return this.recordAdmissionRejection(
        order,
        serving,
        'quote_unknown',
        undefined,
        // NOT "no such quote". The quote is right there; what is missing is
        // the retained REQUEST this node needs to check the order's delivery
        // projection against the priced one. An operator told `quote_unknown`
        // looks at the quote ledger and finds everything in order.
        `retained request receipt missing for request_digest "${quote.request_digest}"`,
      );
    }
    // WS-2.2 — through the ingress validator, not a cast.
    //
    // This record is the YARDSTICK: the order's delivery is checked against
    // the priced projection it carries. `JSON.parse(…) as {delivery: …}` made
    // a projection edited in the store after writing into the standard the
    // order had to match, and a mismatched order would have passed.
    // `validateQuoteRequest` re-derives the request digest, which is the one
    // corruption a shape check cannot see. It also removes a throw from inside
    // the transaction, on the inbound path, where everything else returns a
    // typed refusal.
    const rehydrated = rehydrateQuoteRequest(requestReceipt.recordJson, hash);
    if (!rehydrated.ok) {
      return this.recordAdmissionRejection(
        order,
        serving,
        'quote_unknown',
        undefined,
        `retained request receipt unreadable: ${rehydrated.error}`,
      );
    }
    const binding = verifyOrderAgainstQuote(
      order,
      quote,
      rehydrated.value.delivery.projection as unknown as Record<string, unknown>,
    );
    if (binding) {
      // §9.9 reserves projection_mismatch for projection changes; other
      // quote-binding violations (total, terms, all-or-none lines) get
      // their own open-vocabulary code so the buyer sees WHICH contract
      // the proposal broke.
      const reason = binding.includes('projection')
        ? 'projection_mismatch'
        : 'order_binding_mismatch';
      return this.recordAdmissionRejection(order, serving, reason);
    }

    // Capacity check-and-hold — one call, so the count and the hold
    // cannot drift apart (atomic within the surrounding tx).
    const held = family.hold(order.purchase_order_id);
    if (!held.ok) {
      return this.recordAdmissionRejection(order, serving, ADMISSION_REASON[held.refusal]);
    }
    const nowMs = this.deps.now();
    const created = this.deps.orders.createReserved({
      buyerDid: order.buyer_did,
      purchaseOrderId: order.purchase_order_id,
      idempotencyKey: order.idempotency_key,
      orderDigest: order.order_digest,
      quoteId: order.quote_id,
      quoteDigest: order.quote_digest,
      // §9.13 — pin the EXACT version the buyer opened with, so every
      // continuation record for this order is emitted at it. A major alone
      // let a 1.1 order receive 1.0 records.
      pinnedVersion: order.protocol_version,
      // §9.13 — which manifest's contract this order was opened against.
      servingManifestCid: serving.manifestCid,
      servingInstallId: serving.installId,
      // §16.2 — stamped at admission so chain CREATION can later ask
      // whether this order predates a restore. At genesis there is no head
      // to ask, so the order reference is the only thing that knows.
      admittedEpoch: this.deps.families.currentEpoch(),
      reconciliationRequired: false,
      decisionDeadlineAt: nowMs + this.deps.decisionTimeoutMs,
      createdAt: nowMs,
    });
    if (!created) {
      // Raced by a concurrent identical submission inside another tx.
      throw new Error('admission: concurrent reservation race — transaction retries');
    }
    this.deps.receipts.put({
      recordDigest: order.order_digest,
      domain: 'order',
      buyerDid: order.buyer_did,
      quoteId: order.quote_id,
      purchaseOrderId: order.purchase_order_id,
      recordJson: JSON.stringify(order),
      // §9.12 (WS-2.8) — the proposal ARRIVED. The buyer is the authenticated
      // sender, never a field the proposal chose, so this records who actually
      // handed this node the document rather than who the document says.
      evidenceJson: receivedFrom({ fromDid: authenticatedBuyerDid, observedAt: nowMs }),
      createdAt: nowMs,
    });
    return { kind: 'reserved' };
  }

  /**
   * Durable admission rejection (§9.9): decided record + receipt in
   * the same transaction — a later refund elsewhere can never flip
   * this replay to an acceptance.
   */
  private recordAdmissionRejection(
    order: PurchaseOrderProposal,
    serving: { manifestCid: string; installId: string },
    reasonCode: string,
    currentQuoteDigest?: string,
    /**
     * What the OPERATOR is told, when the wire code hides it. Defaults to the
     * wire code, so a refusal that has nothing extra to say does not have to
     * invent something.
     */
    detail?: string,
  ): AdmissionOutcome {
    const nowMs = this.deps.now();
    const acknowledgement = this.buildAcknowledgement(
      order,
      {
        kind: 'rejected',
        reason_code: reasonCode,
        ...(currentQuoteDigest !== undefined ? { current_quote_digest: currentQuoteDigest } : {}),
      },
      // The order has not been admitted yet, so there is no pinned row; the
      // proposal itself names the conversation's version.
      order.protocol_version,
    );
    const created = this.deps.orders.createReserved({
      buyerDid: order.buyer_did,
      purchaseOrderId: order.purchase_order_id,
      idempotencyKey: order.idempotency_key,
      orderDigest: order.order_digest,
      quoteId: order.quote_id,
      quoteDigest: order.quote_digest,
      // §9.13 — pin the EXACT version the buyer opened with, so every
      // continuation record for this order is emitted at it. A major alone
      // let a 1.1 order receive 1.0 records.
      pinnedVersion: order.protocol_version,
      // §9.13 — which manifest's contract this order was opened against.
      servingManifestCid: serving.manifestCid,
      servingInstallId: serving.installId,
      // §16.2 — stamped at admission so chain CREATION can later ask
      // whether this order predates a restore. At genesis there is no head
      // to ask, so the order reference is the only thing that knows.
      admittedEpoch: this.deps.families.currentEpoch(),
      reconciliationRequired: false,
      decisionDeadlineAt: null,
      createdAt: nowMs,
    });
    if (!created) {
      throw new Error('admission: concurrent reservation race — transaction retries');
    }
    // Through the aggregate: an immediate rejection is still a decision and
    // must cross the same legality check as any other.
    const rejected = this.deps.orders.load(order.buyer_did, order.purchase_order_id);
    if (rejected === null) {
      throw new CommerceIntegrityError('rejection lost its own reservation');
    }
    const recorded = rejected.decide({
      acknowledgementJson: JSON.stringify(acknowledgement),
      decidedAt: nowMs,
    });
    if (!recorded.ok) {
      throw new CommerceIntegrityError(`rejection could not be recorded: ${recorded.refusal}`);
    }
    this.persistAcknowledgement(order, acknowledgement, nowMs, order.quote_id);
    return { kind: 'rejected', acknowledgement, detail: detail ?? reasonCode };
  }

  // -------------------------------------------------------------------------
  // Terminal decision + effect phase (§9.9 step 3, §15.5)
  // -------------------------------------------------------------------------

  /** Durably record that the external boundary is about to be touched. */
  markEffectStartedInTx(buyerDid: string, purchaseOrderId: string): boolean {
    const order = this.deps.orders.load(buyerDid, purchaseOrderId);
    return order !== null && order.markEffectStarted().ok;
  }

  /**
   * Record the supplier's terminal decision: acknowledgement, decided
   * state, and hold settlement land in ONE transaction (a crash can
   * never separate the answer from its capacity effect).
   */
  decideOrderInTx(
    buyerDid: string,
    purchaseOrderId: string,
    decision: SupplierDecision,
  ): { acknowledgement: OrderAcknowledgement } | { error: string } {
    let result: { acknowledgement: OrderAcknowledgement } | { error: string } = {
      error: 'admission: unknown order',
    };
    // The body is kept as an IIFE rather than flattened: it uses early
    // `return` in a dozen places to mean "this is the answer", and rewriting
    // those into assignments is where a refactor of decision code loses a
    // branch. The shape is unchanged; only the transaction moved out.
    ((): void => {
      const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
      if (refOrder === null) {
        result = { error: 'admission: unknown order' };
        return;
      }
      const ref = refOrder.ref;
      if (ref.state === 'decided') {
        // Same rule on the decision path: a decided order whose stored answer
        // cannot be read is an integrity failure, not an answer.
        const stored = rehydrateAcknowledgement(ref.acknowledgementJson, hash);
        result = stored.ok
          ? { acknowledgement: stored.value }
          : {
              error: `admission: stored acknowledgement unreadable — store integrity failure (${stored.error})`,
            };
        return;
      }
      const orderReceipt = this.deps.receipts.get(ref.orderDigest);
      if (!orderReceipt) {
        result = { error: 'admission: order receipt missing — store integrity failure' };
        return;
      }
      // Rehydrate through the INGRESS validator, not a cast (WS-0.7). A
      // receipt this engine cannot re-validate is store corruption, and the
      // decision path was written assuming ingress already checked it.
      const rehydrated = rehydratePurchaseOrder(orderReceipt.recordJson, hash);
      if (!rehydrated.ok) {
        result = { error: `admission: ${rehydrated.error}` };
        return;
      }
      const order = rehydrated.value;

      if (decision.kind === 'counterproposal') {
        const replacement = decision.replacementQuote;
        if (replacement.replaces_quote_digest !== ref.quoteDigest) {
          result = { error: 'admission: counter lineage must point at the countered quote (§9.9)' };
          return;
        }
        if (replacement.quote_id === ref.quoteId) {
          result = { error: 'admission: counter must start a fresh quote_id (§9.9)' };
          return;
        }
        // §9.8 audience binding is stated as an EXPECTATION here and
        // enforced inside QuoteFamily.register, so it cannot be forgotten
        // by a future registration path.
        // Already inside deps.tx — use the primitive, never the
        // transaction-opening wrapper (§9.9 counterproposal; op-sqlite
        // cannot nest BEGIN).
        const registration = this.registerSignedQuoteInTx(replacement, order.buyer_did);
        if (registration) {
          result = { error: registration };
          return;
        }
      }

      const nowMs = this.deps.now();
      const acknowledgement = this.buildAcknowledgement(
        order,
        decision.kind === 'accepted'
          ? {
              kind: 'accepted',
              supplier_order_id: decision.supplierOrderId,
              accepted_quote_digest: ref.quoteDigest,
              accepted_at: isoNow(nowMs),
            }
          : decision.kind === 'rejected'
            ? {
                kind: 'rejected',
                reason_code: decision.reasonCode,
                ...(decision.currentQuoteDigest !== undefined
                  ? { current_quote_digest: decision.currentQuoteDigest }
                  : {}),
              }
            : { kind: 'counterproposal', replacement_quote: decision.replacementQuote },
        ref.pinnedVersion,
      );
      const outcome = refOrder.decide({
        acknowledgementJson: JSON.stringify(acknowledgement),
        externalRef: decision.kind === 'accepted' ? (decision.externalRef ?? null) : null,
        decidedAt: nowMs,
      });
      const decided = outcome.ok;
      if (!decided) {
        result = { error: 'admission: decision CAS lost — already decided' };
        return;
      }
      // Hold settlement (§9.9): accepted commits; everything else refunds.
      // settle() THROWS if the CAS fails — the decision above already
      // succeeded, so a hold that will not settle means the order refs and
      // the quote ledger disagree. Throwing rolls this transaction back
      // rather than committing a decision whose capacity stays held forever
      // (the old code discarded the boolean).
      this.familyFor(ref.quoteId).settle(
        purchaseOrderId,
        decision.kind === 'accepted' ? 'committed' : 'refunded',
      );
      this.persistAcknowledgement(order, acknowledgement, nowMs, order.quote_id);

      // §12.8 — the genesis commits WITH THE DECISION or not at all.
      //
      // EVERY RESOLVING DECISION OPENS A CHAIN, not only an acceptance. This
      // ran for `accepted` alone, so a rejected or countered order had no head
      // — and a missing head reads as UNFINISHED to
      // `countUnfinishedByServingManifest`, which meant every declined order
      // held a prior manifest's lifecycle authority open and blocked plugin
      // uninstall for ever. The buyer also had nothing to verify: §9.11's
      // chain is where a rejection becomes a record rather than a claim
      // carried inside an acknowledgement.
      //
      // `accepted` opens a chain that will run on. `rejected` opens and closes
      // in one record — and a COUNTERPROPOSAL is a rejection of THIS order:
      // the terms move to a fresh quote family, and the order that was
      // countered is over.
      if (this.deps.createAcceptedGenesisInTx) {
        const genesisError = this.deps.createAcceptedGenesisInTx(
          buyerDid,
          purchaseOrderId,
          decision.kind === 'accepted' ? 'accepted' : 'rejected',
        );
        if (genesisError) {
          // Roll the decision back rather than leave a decided order whose
          // chain does not exist — the window a cancellation would misread.
          throw new CommerceIntegrityError(
            `decided order could not open its status chain: ${genesisError.error}`,
          );
        }
      }
      result = { acknowledgement };
    })();
    return result;
  }

  /**
   * Restart/deadline recovery (§9.9 step 3). Returns the orders it
   * timed out. `pre_effect` stragglers become rejected(decision_timeout)
   * with the hold refunded in the same transaction; `effect_started`
   * rows are NEVER touched here.
   */
  recoverAdmissionsInTx(): AdmissionRecoverySweep {
    const timedOut: string[] = [];
    const stuck: AdmissionRecoverySkip[] = [];
    ((): void => {
      const nowMs = this.deps.now();
      for (const ref of this.deps.orders.listExpiredPreEffect(nowMs)) {
        // THE ACKNOWLEDGEMENT COMES FROM THE REFERENCE, NOT THE RECEIPT.
        //
        // This used to load and re-validate the order proposal first, and
        // `continue` if either step failed. That looked like prudence and was
        // a leak: the row stays in `listExpiredPreEffect` forever, so it is
        // reconsidered and skipped on every future sweep, the quote capacity
        // it holds is never refunded, and the buyer's `order_reconcile` keeps
        // answering `received_processing` for an order nobody will ever
        // decide. Silently, with no count and no signal.
        //
        // Nothing about a `rejected(decision_timeout)` needs the proposal.
        // The three fields the record carries — order id, order digest, buyer
        // — are all on the reference, and the digest got there from admission,
        // so the acknowledgement is still bound to the right order. The
        // outcome is also the most conservative one available: it commits to
        // nothing, releases the hold, and replaces silence with an answer.
        const acknowledgement = this.buildAcknowledgement(
          {
            purchase_order_id: ref.purchaseOrderId,
            order_digest: ref.orderDigest,
            buyer_did: ref.buyerDid,
          },
          { kind: 'rejected', reason_code: 'decision_timeout' },
          ref.pinnedVersion,
        );
        const sweptOrder = this.deps.orders.load(ref.buyerDid, ref.purchaseOrderId);
        if (sweptOrder === null) {
          // Listed a moment ago and unloadable now: the reference store
          // disagrees with itself. Reported rather than skipped, because a
          // sweep that returns "0 timed out" must not read the same as one
          // where every row is unreachable.
          stuck.push({ purchaseOrderId: ref.purchaseOrderId, reason: 'reference_unloadable' });
          continue;
        }
        // requirePreEffect: a decision_timeout may NEVER decide an
        // effect_started row — the external effect may have happened.
        const decided = sweptOrder.decide({
          acknowledgementJson: JSON.stringify(acknowledgement),
          decidedAt: nowMs,
          requirePreEffect: true,
        });
        // NOT reported. A concurrent writer decided this order inside another
        // transaction, which is the CAS working: the row leaves the expired
        // set on its own and needs no attention.
        if (!decided.ok) continue;
        this.familyFor(ref.quoteId).settle(ref.purchaseOrderId, 'refunded');
        this.persistAcknowledgement(
          { purchase_order_id: ref.purchaseOrderId, buyer_did: ref.buyerDid },
          acknowledgement,
          nowMs,
          ref.quoteId,
        );
        timedOut.push(ref.purchaseOrderId);
      }
    })();
    return { timedOut, stuck };
  }

  // -------------------------------------------------------------------------
  // Retained-record access (the only I/O the quote aggregate delegates out)
  // -------------------------------------------------------------------------

  /** The signed quote a digest names, or null when it was never retained. */
  private loadRetainedQuote(digest: string): SignedQuote | null {
    const receipt = this.deps.receipts.get(digest);
    if (!receipt || receipt.domain !== 'quote') return null;
    const rehydrated = rehydrateSignedQuote(receipt.recordJson, hash);
    // A retained quote that no longer validates is treated as NOT retained:
    // this reader's contract is "the quote a digest names, or null", and
    // handing back a record we cannot vouch for would be worse than absence.
    return rehydrated.ok ? rehydrated.value : null;
  }

  /**
   * The family an existing order reference points at. A missing head here
   * is corruption, not a business outcome: the reference was only created
   * because the family admitted it.
   */
  private familyFor(quoteId: string): QuoteFamily {
    const family = this.deps.families.load(quoteId);
    if (family === null) {
      throw new CommerceIntegrityError(
        `order reference points at a missing quote family ${quoteId}`,
      );
    }
    return family;
  }

  /**
   * §16.2 restore voiding. OWNER DECISION: Core does not synthesize a
   * replacement quote. The spec's literal wording asks for
   * `quote_superseded` carrying "a freshly signed head at the new epoch",
   * but a replacement carries COMMERCIAL terms — price, validity, and
   * above all how much capacity it grants. Core holds no commercial
   * authority (Kernel-not-Platform), and it cannot know how much of the
   * original allowance was really consumed: the backup's use counter is
   * exactly the number a stale restore makes untrustworthy. Signing a
   * fresh ledger would let a buyer spend capacity already spent, which is
   * what "capacity is never resurrected from a backup" exists to prevent.
   *
   * So the supplier side owns the re-offer — and it owns it OUTSIDE this
   * call, which is the part that changed.
   *
   * THIS METHOD USED TO ASK FOR THE RE-OFFER INLINE, and that was a live
   * defect I introduced. `admitOrder` runs inside a write transaction, so a
   * seam implemented by a supplier plugin or an ERP connector would have done
   * plugin dispatch or network I/O while SQLite held the write lock — on
   * mobile, on one connection, for as long as the counterparty took to
   * answer. Nothing in production wired it, so the cost was latent rather
   * than observed; the shape was wrong either way.
   *
   * The re-offer is now three steps that cannot overlap: admission refuses
   * here in a short transaction that performs no I/O; the supplier obtains a
   * fresh quote with no transaction open; and
   * `CommerceAdmissionService.registerReplacementQuote` validates and
   * registers it in a second short transaction.
   *
   * The buyer is told `quote_voided` WITHOUT a currentQuoteDigest, which is
   * what this method's fall-through already said and is now the only answer.
   * Naming the voided head would point them at a digest that can never become
   * live again (the family refuses further revisions), so they would
   * re-approve against it for ever. `quote_voided` says the true thing: this
   * family is gone, request a new quote.
   */
  private rejectVoidedFamily(
    order: PurchaseOrderProposal,
    serving: { manifestCid: string; installId: string },
  ): AdmissionOutcome {
    return this.recordAdmissionRejection(order, serving, 'quote_voided');
  }

  // -------------------------------------------------------------------------
  // Acknowledgement construction
  // -------------------------------------------------------------------------

  private buildAcknowledgement(
    // Narrowed from `PurchaseOrderProposal` to the three fields actually
    // read. The wider type was what made the recovery sweeper believe it
    // needed the whole proposal — and skip, leaking the hold, when it could
    // not rehydrate one. A parameter type that overstates its needs teaches
    // callers to fetch more than they must.
    order: Pick<PurchaseOrderProposal, 'purchase_order_id' | 'order_digest' | 'buyer_did'>,
    variant:
      | {
          kind: 'accepted';
          supplier_order_id: string;
          accepted_quote_digest: string;
          accepted_at: string;
        }
      | { kind: 'rejected'; reason_code: string; current_quote_digest?: string }
      | { kind: 'counterproposal'; replacement_quote: SignedQuote },
    pinnedVersion: string,
  ): OrderAcknowledgement {
    const draft = {
      // §9.13 — emitted at the version the BUYER opened the conversation
      // with, not at this build's. A node that has moved on must still
      // answer an in-flight order in the language it was asked in.
      protocol_version: pinnedVersion,
      // Deterministic per order: a replayed decision produces the same
      // record bytes and digest.
      // Bounded AND deterministic. `ack:${purchase_order_id}` overflowed:
      // purchase_order_id may itself be MAX_ID_LENGTH (128), so the
      // prefix pushed the acknowledgement id to 132 and every conforming
      // buyer rejected the record — while Core had already decided the
      // order. Digest-derived keeps replay-identical bytes (a replayed
      // decision must produce the same record and digest) inside a fixed
      // 36-character envelope.
      acknowledgement_id: `ack:${ackIdSuffix(order.purchase_order_id)}`,
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      buyer_did: order.buyer_did,
      supplier_did: this.deps.supplierDid(),
      issued_at: isoNow(this.deps.now()),
      ...variant,
    };
    const acknowledgement = {
      ...draft,
      acknowledgement_digest: commerceRecordDigest(
        'acknowledgement',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    } as OrderAcknowledgement;
    // Validate our OWN output before it can be persisted. Core is the
    // decision authority: emitting a structurally invalid acknowledgement
    // decides the order permanently while leaving every conforming buyer
    // unable to accept the answer, and reconciliation cannot resolve it.
    const invalid = validateOrderAcknowledgement(acknowledgement, hash);
    if (invalid !== null) {
      throw new Error(`admission: refusing to emit an invalid acknowledgement — ${invalid}`);
    }
    return acknowledgement;
  }

  private persistAcknowledgement(
    order: Pick<PurchaseOrderProposal, 'purchase_order_id' | 'buyer_did'>,
    acknowledgement: OrderAcknowledgement,
    nowMs: number,
    // Explicit, because the recovery path has the quote id on the ORDER
    // REFERENCE and no proposal to read it from.
    quoteId: string,
  ): void {
    this.deps.receipts.put({
      recordDigest: acknowledgement.acknowledgement_digest,
      domain: 'acknowledgement',
      buyerDid: order.buyer_did,
      quoteId,
      purchaseOrderId: order.purchase_order_id,
      recordJson: JSON.stringify(acknowledgement),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
  }
}
