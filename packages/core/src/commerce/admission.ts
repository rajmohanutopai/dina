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
  validatePurchaseOrderProposal,
  validateSignedQuote,
  verifyOrderAgainstQuote,
  type OrderAcknowledgement,
  type PurchaseOrderProposal,
  type Sha256Fn,
  type SignedQuote,
} from '@dina/commerce-protocol';

import { type CommerceOrderStore } from './commerce_order';
import { CommerceIntegrityError, type QuoteFamily, type QuoteFamilyStore, type QuoteRefusal } from './quote_family';

import type { CommerceReceiptRepository } from './receipts';
import type { TxRunner } from '../run/tx';

const hash: Sha256Fn = (data) => sha256(data);

export type AdmissionOutcome =
  | { kind: 'replay'; acknowledgement: OrderAcknowledgement }
  | { kind: 'processing'; retryAfterSeconds: number }
  | { kind: 'conflict'; error: string }
  | { kind: 'rejected'; acknowledgement: OrderAcknowledgement }
  | { kind: 'reserved' };

export type SupplierDecision =
  | { kind: 'accepted'; supplierOrderId: string; externalRef?: string }
  | { kind: 'rejected'; reasonCode: string; currentQuoteDigest?: string }
  | { kind: 'counterproposal'; replacementQuote: SignedQuote };

export interface AdmissionEngineDeps {
  tx: TxRunner;
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
   * §16.2 post-restore re-offer, supplied by the SUPPLIER side (a runner
   * plugin in a later phase), never by Core.
   *
   * After a restore voids a quote family, only the supplier's own records
   * can say what a replacement should offer. Returning null — or leaving
   * this unwired, as today — means no re-offer exists and admission
   * refuses rather than inventing terms.
   */
  resignVoidedQuote?: (voidedQuoteId: string, buyerDid: string) => SignedQuote | null;
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
  createAcceptedGenesisInTx?: (buyerDid: string, purchaseOrderId: string) => { error: string } | null;
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
  registerSignedQuote(quote: SignedQuote): string | null {
    let error: string | null = null;
    this.deps.tx(() => {
      // The ordinary signing path has no third party to compare against —
      // the supplier is signing a quote it composed for a buyer it chose.
      // Stating `quote.buyer_did` is a no-op TODAY and is deliberate: it is
      // the seam where the still-open request-receipt binding will supply a
      // real expectation (the buyer named on the retained quote request),
      // and it forces every future caller to answer the question.
      error = this.registerSignedQuoteInTx(quote, quote.buyer_did);
    });
    return error;
  }

  /**
   * The registration primitive, WITHOUT opening a transaction. Callers
   * that are already inside deps.tx (counterproposal decisions, §16.2
   * re-signing) must use this: op-sqlite implements transactions with a
   * raw BEGIN and cannot nest, so calling the public wrapper from inside
   * a transaction fails on mobile even though the reentrant test runner
   * hides it on the server.
   */
  private registerSignedQuoteInTx(quote: SignedQuote, expectedBuyerDid: string): string | null {
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

  // -------------------------------------------------------------------------
  // Admission (§9.9 precedence)
  // -------------------------------------------------------------------------

  /**
   * Admit an arriving proposal from the transport-authenticated
   * buyer. `authenticatedBuyerDid` comes from the D2D envelope — the
   * body value is checked against it, never trusted (§9.7).
   */
  admitOrder(proposal: unknown, authenticatedBuyerDid: string): AdmissionOutcome {
    const structural = validatePurchaseOrderProposal(proposal, hash);
    if (structural) return { kind: 'conflict', error: structural };
    const order = proposal as unknown as PurchaseOrderProposal;

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

    let outcome: AdmissionOutcome = { kind: 'reserved' };
    this.deps.tx(() => {
      outcome = this.admitInTx(order);
    });
    return outcome;
  }

  private admitInTx(order: PurchaseOrderProposal): AdmissionOutcome {
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
        return {
          kind: 'replay',
          acknowledgement: JSON.parse(
            byOrderId.acknowledgementJson ?? 'null',
          ) as OrderAcknowledgement,
        };
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
      return this.recordAdmissionRejection(order, 'quote_unknown');
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
        return this.rejectVoidedFamily(order, family);
      }
      if (verdict.refusal === 'quote_superseded') {
        return this.recordAdmissionRejection(order, 'quote_superseded', family.headDigest);
      }
      return this.recordAdmissionRejection(order, ADMISSION_REASON[verdict.refusal]);
    }
    const quote = verdict.value;

    // Projection-extends needs the priced projection: the supplier
    // retained the quote REQUEST receipt (its digest is the quote's
    // requestDigest, and it carries the delivery projection).
    const requestReceipt = this.deps.receipts.get(quote.request_digest);
    if (!requestReceipt || requestReceipt.domain !== 'request') {
      return this.recordAdmissionRejection(order, 'quote_unknown');
    }
    const request = JSON.parse(requestReceipt.recordJson) as {
      delivery: { projection: Record<string, unknown> };
    };
    const binding = verifyOrderAgainstQuote(order, quote, request.delivery.projection);
    if (binding) {
      // §9.9 reserves projection_mismatch for projection changes; other
      // quote-binding violations (total, terms, all-or-none lines) get
      // their own open-vocabulary code so the buyer sees WHICH contract
      // the proposal broke.
      const reason = binding.includes('projection')
        ? 'projection_mismatch'
        : 'order_binding_mismatch';
      return this.recordAdmissionRejection(order, reason);
    }

    // Capacity check-and-hold — one call, so the count and the hold
    // cannot drift apart (atomic within the surrounding tx).
    const held = family.hold(order.purchase_order_id);
    if (!held.ok) {
      return this.recordAdmissionRejection(order, ADMISSION_REASON[held.refusal]);
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
      evidenceJson: '{}',
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
    reasonCode: string,
    currentQuoteDigest?: string,
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
    this.persistAcknowledgement(order, acknowledgement, nowMs);
    return { kind: 'rejected', acknowledgement };
  }

  // -------------------------------------------------------------------------
  // Terminal decision + effect phase (§9.9 step 3, §15.5)
  // -------------------------------------------------------------------------

  /** Durably record that the external boundary is about to be touched. */
  markEffectStarted(buyerDid: string, purchaseOrderId: string): boolean {
    let marked = false;
    this.deps.tx(() => {
      const order = this.deps.orders.load(buyerDid, purchaseOrderId);
      marked = order !== null && order.markEffectStarted().ok;
    });
    return marked;
  }

  /**
   * Record the supplier's terminal decision: acknowledgement, decided
   * state, and hold settlement land in ONE transaction (a crash can
   * never separate the answer from its capacity effect).
   */
  decideOrder(
    buyerDid: string,
    purchaseOrderId: string,
    decision: SupplierDecision,
  ): { acknowledgement: OrderAcknowledgement } | { error: string } {
    let result: { acknowledgement: OrderAcknowledgement } | { error: string } = {
      error: 'admission: unknown order',
    };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
      if (refOrder === null) {
        result = { error: 'admission: unknown order' };
        return;
      }
      const ref = refOrder.ref;
      if (ref.state === 'decided') {
        result = {
          acknowledgement: JSON.parse(ref.acknowledgementJson ?? 'null') as OrderAcknowledgement,
        };
        return;
      }
      const orderReceipt = this.deps.receipts.get(ref.orderDigest);
      if (!orderReceipt) {
        result = { error: 'admission: order receipt missing — store integrity failure' };
        return;
      }
      const order = JSON.parse(orderReceipt.recordJson) as PurchaseOrderProposal;

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
      this.persistAcknowledgement(order, acknowledgement, nowMs);

      // §12.8 — the genesis commits WITH the acceptance or not at all.
      if (decision.kind === 'accepted' && this.deps.createAcceptedGenesisInTx) {
        const genesisError = this.deps.createAcceptedGenesisInTx(buyerDid, purchaseOrderId);
        if (genesisError) {
          // Roll the decision back rather than leave an accepted order whose
          // chain does not exist — the window a cancellation would misread.
          throw new CommerceIntegrityError(
            `accepted order could not open its status chain: ${genesisError.error}`,
          );
        }
      }
      result = { acknowledgement };
    });
    return result;
  }

  /**
   * Restart/deadline recovery (§9.9 step 3). Returns the orders it
   * timed out. `pre_effect` stragglers become rejected(decision_timeout)
   * with the hold refunded in the same transaction; `effect_started`
   * rows are NEVER touched here.
   */
  recoverAdmissions(): string[] {
    const timedOut: string[] = [];
    this.deps.tx(() => {
      const nowMs = this.deps.now();
      for (const ref of this.deps.orders.listExpiredPreEffect(nowMs)) {
        const orderReceipt = this.deps.receipts.get(ref.orderDigest);
        if (!orderReceipt) continue;
        const order = JSON.parse(orderReceipt.recordJson) as PurchaseOrderProposal;
        const acknowledgement = this.buildAcknowledgement(
          order,
          { kind: 'rejected', reason_code: 'decision_timeout' },
          ref.pinnedVersion,
        );
        const sweptOrder = this.deps.orders.load(ref.buyerDid, ref.purchaseOrderId);
        if (sweptOrder === null) continue;
        // requirePreEffect: a decision_timeout may NEVER decide an
        // effect_started row — the external effect may have happened.
        const decided = sweptOrder.decide({
          acknowledgementJson: JSON.stringify(acknowledgement),
          decidedAt: nowMs,
          requirePreEffect: true,
        });
        if (!decided.ok) continue;
        this.familyFor(ref.quoteId).settle(ref.purchaseOrderId, 'refunded');
        this.persistAcknowledgement(order, acknowledgement, nowMs);
        timedOut.push(ref.purchaseOrderId);
      }
    });
    return timedOut;
  }

  // -------------------------------------------------------------------------
  // Retained-record access (the only I/O the quote aggregate delegates out)
  // -------------------------------------------------------------------------

  /** The signed quote a digest names, or null when it was never retained. */
  private loadRetainedQuote(digest: string): SignedQuote | null {
    const receipt = this.deps.receipts.get(digest);
    if (!receipt || receipt.domain !== 'quote') return null;
    return JSON.parse(receipt.recordJson) as SignedQuote;
  }

  /**
   * The family an existing order reference points at. A missing head here
   * is corruption, not a business outcome: the reference was only created
   * because the family admitted it.
   */
  private familyFor(quoteId: string): QuoteFamily {
    const family = this.deps.families.load(quoteId);
    if (family === null) {
      throw new CommerceIntegrityError(`order reference points at a missing quote family ${quoteId}`);
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
   * So the supplier side owns the re-offer, through this seam. When it is
   * wired, we register its quote and answer `quote_superseded` pointing at
   * a head that is genuinely live.
   */
  private rejectVoidedFamily(order: PurchaseOrderProposal, family: QuoteFamily): AdmissionOutcome {
    const reoffer = this.deps.resignVoidedQuote?.(family.quoteId, order.buyer_did) ?? null;
    // The seam is ASKED for this buyer, but its answer is untrusted like
    // any other runner output. The expectation travels into register(),
    // which refuses a foreign audience — no inline comparison to forget.
    if (reoffer !== null) {
      const registerError = this.registerSignedQuoteInTx(reoffer, order.buyer_did);
      if (registerError === null) {
        return this.recordAdmissionRejection(order, 'quote_superseded', reoffer.quote_digest);
      }
      // A rejected re-offer must never be laundered into a live head;
      // fall through to the refusal below.
    }
    // No supplier re-offer available. Refuse WITHOUT a currentQuoteDigest:
    // naming the voided head would point the buyer at a digest that can
    // never become live again (the family refuses further revisions), so
    // they would re-approve against it forever. `quote_voided` says the
    // true thing — this family is gone, request a new quote.
    return this.recordAdmissionRejection(order, 'quote_voided');
  }

  // -------------------------------------------------------------------------
  // Acknowledgement construction
  // -------------------------------------------------------------------------

  private buildAcknowledgement(
    order: PurchaseOrderProposal,
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
    order: PurchaseOrderProposal,
    acknowledgement: OrderAcknowledgement,
    nowMs: number,
  ): void {
    this.deps.receipts.put({
      recordDigest: acknowledgement.acknowledgement_digest,
      domain: 'acknowledgement',
      buyerDid: order.buyer_did,
      quoteId: order.quote_id,
      purchaseOrderId: order.purchase_order_id,
      recordJson: JSON.stringify(acknowledgement),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
  }
}
