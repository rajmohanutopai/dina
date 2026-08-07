/**
 * Supplier-side order lifecycle engine (spec §9.11, §12.7, §12.8):
 *
 * - STATUS signing with CAS at the head (a conforming supplier cannot
 *   emit two valid successors), genesis-from-acknowledgement rules,
 *   and cumulative complete-snapshot line checks against the order.
 * - CANCELLATION resolved atomically against acceptance/dispatch —
 *   exactly one wins inside one transaction; a repeat cancellationId
 *   returns the recorded result; unknown or digest-mismatched orders
 *   get a NON-DISCLOSING rejection.
 * - RECONCILE answers from the durable order-reference store with the
 *   six-outcome §12.7 union; `never_received` is legal only when the
 *   buyer presented no supplier-signed evidence — against a verified
 *   held acknowledgement the engine RE-ADOPTS the order (§16.2).
 *
 * Order-scoped subject authorization (§11.2): every entry point takes
 * the transport-authenticated caller DID and answers non-disclosingly
 * when the caller is not the order's buyer.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  GENESIS_STATE_BY_EVENT,
  commerceRecordDigest,
  validateCancellationRequest,
  validateCommerceOrderStatus,
  validateOrderReconcileRequest,
  statusIsTerminal,
  validateOrderAcknowledgement,
  verifyStatusLines,
  type CancellationRequest,
  type CancellationResult,
  type CancellationResultKind,
  type CommerceOrderStatus,
  type GenesisEvent,
  type OrderAcknowledgement,
  type OrderReconcileRequest,
  type OrderReconcileResult,
  type OrderState,
  type PurchaseOrderProposal,
  type Sha256Fn,
 HeldEvidence } from '@dina/commerce-protocol';
import { canonicalJson } from '@dina/commerce-protocol';

import { ackIdSuffix } from './admission';
import { type CommerceOrderStore } from './commerce_order';
import { CommerceIntegrityError, type QuoteFamilyStore } from './quote_family';
import { type ChainRefusal, type StatusChainStore } from './status_chain';

import type { CommerceReceiptRepository } from './receipts';
import type { TxRunner } from '../run/tx';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * ChainRefusal -> operator-facing message. Total, so a refusal added to the
 * aggregate cannot reach a caller as an unhandled case.
 */
const CHAIN_ERROR: Record<ChainRefusal, string> = {
  no_chain: 'status: no chain for this order — sign the genesis first',
  chain_exists: 'status: genesis already signed — CAS at signing (§9.11)',
  order_awaiting_reconciliation:
    'status: order was re-adopted and is not reconciled — cannot sign a first status (§16.2)',
  order_predates_restore:
    'status: order predates a restore — reconcile it before signing a first status (§16.2)',
  chain_predates_restore:
    'status: chain predates a restore — sign the restore fence first (§16.2)',
  illegal_transition: 'status: illegal transition (§9.11)',
  lines_violation: 'status: cumulative line snapshot violation (§9.11)',
  fence_needs_higher_epoch: 'fence: requires a strictly higher epoch — restore first (§16.2)',
  cas_lost: 'status: CAS at signing — concurrent successor won (§9.11)',
};

/** Prefer the aggregate's precise detail; fall back to the refusal name. */
function chainError(outcome: { refusal: ChainRefusal; detail?: string }): string {
  const base = CHAIN_ERROR[outcome.refusal];
  return outcome.detail === undefined ? base : `${base}: ${outcome.detail}`;
}

/** Non-disclosing rejection: identical for "no such order", "not your
 *  order", and "digest mismatch" (§11.2). */
export const NON_DISCLOSING_ERROR = 'commerce: unknown order or unauthorized caller';

export interface LifecycleEngineDeps {
  tx: TxRunner;
  /**
   * Order state as an aggregate store. The raw reference repository is
   * deliberately not a dependency — `CommerceOrder.decide()` is worthless
   * while `refs.decide()` stays reachable from here.
   */
  orders: CommerceOrderStore;
  /**
   * Status-chain state as aggregates. The raw head repository is deliberately
   * NOT a dependency: `StatusChain.advance()` is worthless if `casAdvance()`
   * stays reachable, and `createGenesis()` is worthless if `initGenesis()` does.
   */
  chains: StatusChainStore;
  receipts: CommerceReceiptRepository;
  /** Quote state as aggregates; the raw ledger is not reachable here. */
  families: QuoteFamilyStore;
  /**
   * Acting supplier Business DID, read per use — a thunk for the same
   * reason `currentEpoch` below is one. Identity resolves after storage,
   * and an engine holding a captured DID would either be unbuildable at
   * boot or sign under an empty one. Reading it per use fails closed.
   */
  supplierDid: () => string;
  now: () => number;
  /** Current commerce epoch (§16.2); CMC-6 wires the live provider. */
  currentEpoch: () => string;
  /** Reconcile re-poll hints, seconds. */
  processingRetryAfterSeconds?: number;
  unresolvedRetryAfterSeconds?: number;
  /**
   * §9.12/§16.2: verify that a held record's retained envelope
   * evidence proves THIS supplier authenticated it — a content digest
   * alone is forgeable by anyone (it is a hash of the payload, not a
   * signature). The app wires the real verifier (Ed25519 over the
   * retained D2D envelope). FAIL CLOSED: when absent, held-evidence
   * re-adoption is refused non-disclosingly.
   */
  /**
   * §12.7/§16.2 authenticity check for buyer-held evidence.
   *
   * The callback now receives the SUPPLIER'S SIGNATURE over the record's
   * exact bytes, plus the DID whose key must have produced it. The old
   * shape passed only {recordJson, recordDigest} — a record and a hash of
   * that record, both computable by anyone holding or inventing the
   * record — so no implementation of this callback could actually
   * establish authenticity. Held evidence decides whether an order is
   * re-adopted or answered `never_received`, so it must be unforgeable.
   *
   * Fail closed: Core treats a missing verifier as "cannot verify".
   */
  verifyHeldEvidence?: (evidence: {
    recordJson: string;
    recordDigest: string;
    signature: string;
    signerKeyId?: string;
    supplierDid: string;
  }) => boolean;
}

export interface StatusUpdateFields {
  state: OrderState;
  lines?: { lineId: string; fulfilledQuantity: { value: string; unitCode: string } }[];
  disputeWindowEndsAt?: string;
  evidenceRefs?: string[];
  supplierOrderId?: string;
}

/** Cancellation policy hook: called only when a real choice exists
 *  (order accepted, fulfilment not yet dispatched). */
export type CancellationPolicy = (context: {
  order: PurchaseOrderProposal;
  headState: OrderState;
}) => Exclude<CancellationResultKind, 'refused_already_dispatched'>;

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * The mutable half of a status record a caller may set. Exported as a
 * named type so call sites can bind an explicit `const` to it: object
 * literals passed straight into a call — especially with conditional
 * spreads — are NOT excess-property checked, which lets a misspelt wire
 * key through.
 */
type StatusFields = Partial<CommerceOrderStatus> &
  Pick<CommerceOrderStatus, 'sequence' | 'state' | 'supplier_epoch' | 'updated_at'>;

export class CommerceLifecycleEngine {
  constructor(private readonly deps: LifecycleEngineDeps) {}

  // -------------------------------------------------------------------------
  // Status chain (§9.11)
  // -------------------------------------------------------------------------

  /**
   * Sign the GENESIS status once the order is decided. The genesis
   * state is DERIVED from the recorded acknowledgement — the caller
   * cannot claim a different resolving event than the one on record
   * (§9.11): accepted -> accepted; rejected -> terminal rejected;
   * counterproposal -> terminal rejected (the replacement is a new
   * family). The cancellation-won genesis is signed internally by
   * resolveCancellation.
   */
  signGenesis(buyerDid: string, purchaseOrderId: string): CommerceOrderStatus | { error: string } {
    let outcome: CommerceOrderStatus | { error: string } = { error: NON_DISCLOSING_ERROR };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
      const ref = refOrder?.ref ?? null;
      if (!ref || ref.state !== 'decided') {
        outcome = { error: 'status: genesis requires a decided order (§9.11)' };
        return;
      }
      const acknowledgement = JSON.parse(
        ref.acknowledgementJson ?? 'null',
      ) as OrderAcknowledgement | null;
      if (!acknowledgement) {
        outcome = { error: 'status: decided order has no recorded acknowledgement' };
        return;
      }
      const event: GenesisEvent =
        acknowledgement.kind === 'accepted'
          ? 'accepted'
          : acknowledgement.kind === 'counterproposal'
            ? 'counterproposal'
            : 'rejected';
      const nowMs = this.deps.now();
      const status = this.buildStatus(
        buyerDid,
        purchaseOrderId,
        {
          sequence: '0',
          state: GENESIS_STATE_BY_EVENT[event],
          supplier_epoch: this.deps.currentEpoch(),
          updated_at: isoNow(nowMs),
        },
        ref.pinnedVersion,
      );
      const structural = validateCommerceOrderStatus(status, hash);
      if (structural) {
        outcome = { error: structural };
        return;
      }
      // The chain decides whether it may be CREATED — including the §16.2
      // question the old code could not ask, because answering it needs the
      // epoch the ORDER was admitted under rather than a head that does not
      // exist yet.
      const created = this.deps.chains
        .load(buyerDid, purchaseOrderId)
        .createGenesis(status, ref);
      if (!created.ok) {
        outcome = { error: chainError(created) };
        return;
      }
      this.persistStatus(status, ref.quoteId, nowMs);
      outcome = status;
    });
    return outcome;
  }

  /**
   * Sign a successor status. CAS against the stored head; the legal
   * transition graph and the cumulative complete-snapshot line rules
   * are enforced BEFORE the head advances.
   */
  signStatusUpdate(
    buyerDid: string,
    purchaseOrderId: string,
    fields: StatusUpdateFields,
  ): CommerceOrderStatus | { error: string } {
    let outcome: CommerceOrderStatus | { error: string } = { error: NON_DISCLOSING_ERROR };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
      const ref = refOrder?.ref ?? null;
      const chain = this.deps.chains.load(buyerDid, purchaseOrderId);
      if (!ref || !chain.exists) {
        outcome = { error: 'status: no chain for this order — sign the genesis first' };
        return;
      }
      const head = chain.head;
      // The §16.2 restore prerequisite and transition legality moved into
      // StatusChain.advance (applied below), so this method can no longer
      // order them differently from the other signing path — or omit one.
      const fromState = head.state as OrderState;
      const nowMs = this.deps.now();
      // §9.11: delivered -> disputed is legal only before the
      // digest-bound disputeWindowEndsAt — enforced at SIGNING, not
      // only receiver-side.
      if (fromState === 'delivered' && fields.state === 'disputed') {
        // FAIL CLOSED. Previously a missing or malformed delivered
        // receipt made the window check evaporate — receipt loss,
        // corruption, or an inconsistent restore would let Core SIGN a
        // dispute the deadline forbids. The deadline is digest-bound to
        // the delivered head, so if we cannot read that head we cannot
        // know the deadline and must not sign.
        const loaded = this.loadHeadStatus(head.headDigest, 'delivered head');
        if ('error' in loaded) {
          outcome = loaded;
          return;
        }
        const delivered = loaded;
        if (delivered.dispute_window_ends_at === undefined) {
          outcome = {
            error: 'status: delivered head carries no dispute window — cannot sign disputed (§9.11)',
          };
          return;
        }
        if (nowMs > Date.parse(delivered.dispute_window_ends_at)) {
          outcome = {
            error: 'status: delivered -> disputed is legal only before dispute_window_ends_at (§9.11)',
          };
          return;
        }
      }
      const status = this.buildStatus(buyerDid, purchaseOrderId, {
        sequence: (BigInt(head.headSequence) + 1n).toString(10),
        previous_status_digest: head.headDigest,
        state: fields.state,
        // `satisfies` on each conditional spread: a spread is NOT
        // excess-property checked, so without it a misspelt wire key
        // compiles and is silently hashed into status_digest.
        ...(fields.lines !== undefined
          ? ({
              lines: fields.lines.map((line) => ({
                line_id: line.lineId,
                fulfilled_quantity: {
                  value: line.fulfilledQuantity.value,
                  unit_code: line.fulfilledQuantity.unitCode,
                },
              })),
            } satisfies Partial<CommerceOrderStatus>)
          : {}),
        ...(fields.disputeWindowEndsAt !== undefined
          ? ({
              dispute_window_ends_at: fields.disputeWindowEndsAt,
            } satisfies Partial<CommerceOrderStatus>)
          : {}),
        ...(fields.evidenceRefs !== undefined
          ? ({ evidence_refs: fields.evidenceRefs } satisfies Partial<CommerceOrderStatus>)
          : {}),
        ...(fields.supplierOrderId !== undefined
          ? ({ supplier_order_id: fields.supplierOrderId } satisfies Partial<CommerceOrderStatus>)
          : {}),
        supplier_epoch: this.deps.currentEpoch(),
        updated_at: isoNow(nowMs),
      }, ref.pinnedVersion);
      const structural = validateCommerceOrderStatus(status, hash);
      if (structural) {
        outcome = { error: structural };
        return;
      }
      // Cumulative complete-snapshot check against the ORDER lines and
      // the PREVIOUS status record (from the receipt store).
      const orderReceipt = this.deps.receipts.get(ref.orderDigest);
      if (!orderReceipt) {
        outcome = { error: 'status: order receipt missing — store integrity failure' };
        return;
      }
      const order = JSON.parse(orderReceipt.recordJson) as PurchaseOrderProposal;
      // FAIL CLOSED, same as the dispute deadline above. Passing
      // `undefined` here made verifyStatusLines skip the cumulative
      // comparison entirely, so a lost receipt let Core sign a REGRESSING
      // fulfilled_quantity and advance the head — §9.11 says a decrease is
      // an illegal update, rejected like any other graph violation.
      const loadedPrevious = this.loadHeadStatus(head.headDigest, 'previous head');
      if ('error' in loadedPrevious) {
        outcome = loadedPrevious;
        return;
      }
      const moved = chain.advance(status, loadedPrevious, () =>
        verifyStatusLines(status, order.accepted_lines, loadedPrevious),
      );
      if (!moved.ok) {
        outcome = { error: chainError(moved) };
        return;
      }
      this.persistStatus(status, ref.quoteId, nowMs);
      outcome = status;
    });
    return outcome;
  }

  /**
   * §16.2 restore takeover. After `establishAfterRestore()` raises the
   * epoch, this supplier's local head for an order may be BEHIND
   * signatures the buyer already holds — and the strict predecessor rule
   * (§9.11) would make any ordinary successor invalid, stranding the
   * order permanently. The fence is the sanctioned way out:
   *
   *   - the buyer presents its retained status receipts;
   *   - we verify OUR OWN signatures on them (injected verifier, fail
   *     closed — a content digest is a hash anyone can compute);
   *   - the newest verified receipt becomes the predecessor, so the
   *     store fast-forwards to what the buyer can actually prove;
   *   - we sign a `restoreFence: true` successor at the NEW epoch,
   *     sequence predecessor+1, restating the fenced state.
   *
   * The buyer accepts it when the named predecessor is its head or a
   * strict ancestor of it (`verifyRestoreFence`).
   */
  signRestoreFence(
    buyerDid: string,
    purchaseOrderId: string,
    heldStatusReceipts: readonly HeldEvidence<CommerceOrderStatus>[],
  ): CommerceOrderStatus | { error: string } {
    let outcome: CommerceOrderStatus | { error: string } = { error: NON_DISCLOSING_ERROR };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
      const ref = refOrder?.ref ?? null;
      if (!ref) {
        outcome = { error: NON_DISCLOSING_ERROR };
        return;
      }
      // Only OUR OWN, verifiable, on-order receipts may fast-forward the
      // chain. Fail closed without a verifier.
      const verified = heldStatusReceipts
        .filter((evidence) => {
          const receipt = evidence.record;
          return (
            validateCommerceOrderStatus(receipt, hash) === null &&
            receipt.supplier_did === this.deps.supplierDid() &&
            receipt.buyer_did === buyerDid &&
            receipt.purchase_order_id === purchaseOrderId &&
            this.deps.verifyHeldEvidence?.({
              // CANONICAL bytes, not JSON.stringify: the supplier signed
              // the record's canonical serialization, and stringify is
              // insertion-order dependent. A key-reordered but
              // digest-identical record would otherwise fail to verify —
              // and worse, "same record => same verifiable bytes" would
              // not hold across implementations.
              recordJson: canonicalJson(receipt),
              recordDigest: receipt.status_digest,
              signature: evidence.signature,
              ...(evidence.signer_key_id !== undefined
                ? { signerKeyId: evidence.signer_key_id }
                : {}),
              supplierDid: this.deps.supplierDid(),
            }) === true
          );
        })
        .map((evidence) => evidence.record);
      if (verified.length === 0) {
        outcome = { error: 'fence: no verifiable held status receipts to fence against (§16.2)' };
        return;
      }
      const predecessor = verified.reduce((newest, candidate) =>
        BigInt(candidate.sequence) > BigInt(newest.sequence) ? candidate : newest,
      );
      if (statusIsTerminal(predecessor, isoNow(this.deps.now()))) {
        outcome = { error: 'fence: the order is already terminal — nothing to resume' };
        return;
      }
      const chain = this.deps.chains.load(buyerDid, purchaseOrderId);
      if (!chain.exists) {
        outcome = { error: 'fence: no local chain for this order' };
        return;
      }
      const head = chain.head;
      // NO ROLLBACK. The fence exists to fast-forward a restored
      // supplier to what the buyer can prove — never to move it
      // BACKWARD. Choosing the highest presented receipt is not enough:
      // an authentic but OLDER receipt would rewind a supplier that is
      // already further along, destroying known fulfilment progress and
      // forking the chain (§16.2 "the supplier's best-known head";
      // §9.11 forbids rollback).
      const predecessorSeq = BigInt(predecessor.sequence);
      const headSeq = BigInt(head.headSequence);
      if (predecessorSeq < headSeq) {
        outcome = {
          error: 'fence: presented evidence is behind the local head — refusing to roll back (§16.2)',
        };
        return;
      }
      if (predecessorSeq === headSeq && predecessor.status_digest !== head.headDigest) {
        // Same height, different record: two distinct signatures at one
        // sequence is a fork, not a fast-forward.
        outcome = {
          error: 'fence: evidence forks the local head at the same sequence (§9.11)',
        };
        return;
      }
      const epoch = this.deps.currentEpoch();
      if (BigInt(epoch) <= BigInt(head.supplierEpoch)) {
        outcome = { error: 'fence: requires a strictly higher epoch — restore first (§16.2)' };
        return;
      }
      const nowMs = this.deps.now();
      // Typed as StatusFields FIRST. A conditional spread inside a call
      // argument gets NO excess-property check, which is how a camelCase
      // `disputeWindowEndsAt` reached the wire record here unnoticed —
      // buildStatus's `as CommerceOrderStatus` then hid it from tsc, and
      // the resulting delivered record failed validation, permanently
      // stranding the chain a fence exists to rescue. Binding to an
      // explicit type makes that misspelling a compile error.
      const fenceFields: StatusFields = {
        sequence: (BigInt(predecessor.sequence) + 1n).toString(10),
        previous_status_digest: predecessor.status_digest,
        state: predecessor.state,
        ...(predecessor.lines !== undefined
          ? ({ lines: predecessor.lines } satisfies Partial<CommerceOrderStatus>)
          : {}),
        ...(predecessor.dispute_window_ends_at !== undefined
          ? ({
              dispute_window_ends_at: predecessor.dispute_window_ends_at,
            } satisfies Partial<CommerceOrderStatus>)
          : {}),
        supplier_epoch: epoch,
        restore_fence: true,
        updated_at: isoNow(nowMs),
      };
      const status = this.buildStatus(buyerDid, purchaseOrderId, fenceFields, ref.pinnedVersion);
      const structural = validateCommerceOrderStatus(status, hash);
      if (structural) {
        outcome = { error: structural };
        return;
      }
      // The chain owns "a fence needs a strictly higher epoch" and performs
      // the write, so the fence path cannot drift from the other two.
      const fencedOutcome = chain.fence(status);
      if (!fencedOutcome.ok) {
        outcome = { error: 'fence: head CAS lost — retry after re-reading the chain' };
        return;
      }
      this.persistStatus(status, ref.quoteId, nowMs);
      outcome = status;
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Cancellation (§12.8)
  // -------------------------------------------------------------------------

  resolveCancellation(
    request: unknown,
    authenticatedBuyerDid: string,
    policy: CancellationPolicy,
  ): CancellationResult | { error: string } {
    const structural = validateCancellationRequest(request, hash);
    if (structural) return { error: structural };
    const cancellation = request as unknown as CancellationRequest;

    let outcome: CancellationResult | { error: string } = { error: NON_DISCLOSING_ERROR };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(
        authenticatedBuyerDid,
        cancellation.purchase_order_id,
      );
      const ref = refOrder?.ref ?? null;
      // Non-disclosing: unknown order, foreign order, and digest
      // mismatch are indistinguishable (§12.8).
      if (!ref || ref.orderDigest !== cancellation.order_digest) {
        outcome = { error: NON_DISCLOSING_ERROR };
        return;
      }
      // §9.13: a cancellation for a prior-major order is served by the
      // retained handler for that major, never re-parsed as v1.
      if (!this.versionMatches(cancellation.protocol_version, ref.pinnedVersion)) {
        outcome = { error: NON_DISCLOSING_ERROR };
        return;
      }
      // Idempotency on cancellationId: a repeat returns the recorded result.
      const recorded = this.findRecordedCancellation(
        authenticatedBuyerDid,
        cancellation.purchase_order_id,
        cancellation.cancellation_id,
      );
      // §12.8 idempotency: a repeat of the SAME cancellationId returns
      // the recorded result — including pending_review. Excluding it
      // made a resend re-run policy, so the repeated REQUEST could be
      // what closed the review; the spec requires a later RESULT to do
      // that. finalizePendingCancellation is the only way out of
      // pending_review.
      if (recorded) {
        outcome = recorded;
        return;
      }

      const nowMs = this.deps.now();
      this.deps.receipts.put({
        recordDigest: cancellation.cancellation_digest,
        domain: 'cancellation',
        buyerDid: authenticatedBuyerDid,
        quoteId: ref.quoteId,
        purchaseOrderId: cancellation.purchase_order_id,
        recordJson: JSON.stringify(cancellation),
        evidenceJson: '{}',
        createdAt: nowMs,
      });

      // RACE ARM 1: order still reserved — cancellation wins over
      // acceptance atomically (§12.8/§9.11 cancellation_won genesis).
      if (ref.state === 'reserved') {
        const ackDraft = {
          protocol_version: ref.pinnedVersion,
          // SAME bounded helper as the admission path. This second
          // construction site kept `ack:${purchase_order_id}` after the
          // first was fixed: a legal 128-character order id produced a
          // 132-character acknowledgement id that validateId rejects —
          // and this path has ALREADY refunded the hold and signed the
          // cancellation_won genesis by the time it answers, so the
          // buyer is left holding a record it must refuse against an
          // order Core considers closed.
          acknowledgement_id: `ack:${ackIdSuffix(cancellation.purchase_order_id)}`,
          purchase_order_id: cancellation.purchase_order_id,
          order_digest: ref.orderDigest,
          buyer_did: authenticatedBuyerDid,
          supplier_did: this.deps.supplierDid(),
          issued_at: isoNow(nowMs),
          kind: 'rejected' as const,
          reason_code: 'cancelled_by_buyer',
        };
        const acknowledgement = {
          ...ackDraft,
          acknowledgement_digest: commerceRecordDigest(
            'acknowledgement',
            ackDraft as unknown as Record<string, unknown>,
            hash,
          ),
        } as OrderAcknowledgement;
        // Validate before ANY state mutation on this path.
        const ackInvalid = validateOrderAcknowledgement(acknowledgement, hash);
        if (ackInvalid !== null) {
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        // §9.9/§12.8: cancellation may win the race ONLY against a
        // pre_effect reservation. Once effect_started is durable, the
        // external order may exist — cancelling here could let BOTH the
        // cancellation and the external order win. Such requests park
        // as pending_review until the real outcome resolves.
        if (ref.effectPhase === 'effect_started') {
          outcome = this.recordResult(
            cancellation,
            'pending_review',
            undefined,
            authenticatedBuyerDid,
            ref.quoteId,
            nowMs,
            ref.pinnedVersion,
          );
          return;
        }
        // requirePreEffect: a cancellation may not decide an order whose
        // external effect has already started.
        const cancelOrder = this.deps.orders.load(
          authenticatedBuyerDid,
          cancellation.purchase_order_id,
        );
        const decided =
          cancelOrder !== null &&
          cancelOrder.decide({
            acknowledgementJson: JSON.stringify(acknowledgement),
            decidedAt: nowMs,
            requirePreEffect: true,
          }).ok;
        if (!decided) {
          // Lost the race to a concurrent decision inside another tx.
          outcome = { error: 'cancellation: decision race lost — retry reconcile' };
          return;
        }
        // Throws on a failed CAS: the cancellation has already won the
        // decision race above, so a hold that will not refund means the
        // order refs and the quote ledger disagree. Rolling back beats
        // committing a cancellation whose capacity stays held.
        const family = this.deps.families.load(ref.quoteId);
        if (family === null) {
          throw new CommerceIntegrityError(
            `cancelled order references a missing quote family ${ref.quoteId}`,
          );
        }
        family.settle(cancellation.purchase_order_id, 'refunded');
        this.deps.receipts.put({
          recordDigest: acknowledgement.acknowledgement_digest,
          domain: 'acknowledgement',
          buyerDid: authenticatedBuyerDid,
          quoteId: ref.quoteId,
          purchaseOrderId: cancellation.purchase_order_id,
          recordJson: JSON.stringify(acknowledgement),
          evidenceJson: '{}',
          createdAt: nowMs,
        });
        const genesis = this.signGenesisInTx(
          authenticatedBuyerDid,
          cancellation.purchase_order_id,
          'cancellation_won',
          ref.quoteId,
          ref,
          nowMs,
        );
        if ('error' in genesis) {
          outcome = genesis;
          return;
        }
        outcome = this.recordResult(
          cancellation,
          'cancelled',
          genesis.status_digest,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }

      // Decided order: consult the chain head.
      const cancelChain = this.deps.chains.load(
        authenticatedBuyerDid,
        cancellation.purchase_order_id,
      );
      const head = cancelChain.exists ? cancelChain.head : null;
      if (!head) {
        // Decided but rejected/countered — nothing to cancel.
        outcome = this.recordResult(
          cancellation,
          'refused_policy',
          undefined,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }
      const headState = head.state as OrderState;
      if (headState === 'cancelled') {
        outcome = this.recordResult(
          cancellation,
          'cancelled',
          head.headDigest,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }
      if (headState === 'rejected') {
        // Nothing was ever dispatched — the supplier declined the order.
        // Answering refused_already_dispatched would assert a fulfilment
        // fact that is false, and would contradict the no-genesis path
        // above, which answers refused_policy for the same situation.
        outcome = this.recordResult(
          cancellation,
          'refused_policy',
          undefined,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }
      if (headState === 'dispatched' || headState === 'delivered' || headState === 'disputed') {
        // RACE ARM 2: dispatch already won — cancellation cannot undo it.
        outcome = this.recordResult(
          cancellation,
          'refused_already_dispatched',
          undefined,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }

      // A real choice exists: supplier policy decides.
      const orderReceipt = this.deps.receipts.get(ref.orderDigest);
      const order = orderReceipt
        ? (JSON.parse(orderReceipt.recordJson) as PurchaseOrderProposal)
        : null;
      if (!order) {
        outcome = { error: 'cancellation: order receipt missing — store integrity failure' };
        return;
      }
      const verdict = policy({ order, headState });
      if (verdict === 'cancelled') {
        // The head this ruling is CAS-bound to (§9.11): the head at
        // resolution time; the chain then transitions head -> cancelled
        // in this SAME transaction.
        const ruledOn = head.headDigest;
        const transition = this.signStatusUpdateInTx(
          authenticatedBuyerDid,
          cancellation.purchase_order_id,
          ref,
          head,
          { state: 'cancelled' },
        );
        if ('error' in transition) {
          outcome = transition;
          return;
        }
        outcome = this.recordResult(
          cancellation,
          'cancelled',
          ruledOn,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }
      outcome = this.recordResult(
        cancellation,
        verdict,
        undefined,
        authenticatedBuyerDid,
        ref.quoteId,
        nowMs,
        ref.pinnedVersion,
      );
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Reconcile (§12.7)
  // -------------------------------------------------------------------------

  reconcile(
    input: unknown,
    authenticatedBuyerDid: string,
  ): OrderReconcileResult | { error: string } {
    // Structural bounds FIRST, before any store or transaction work.
    // The typed parameter was a lie: this arrives from a peer, so a
    // malformed held_status_receipts array could throw inside Core
    // rather than answer a typed error (§9.13).
    const structural = validateOrderReconcileRequest(input, hash);
    if (structural !== null) return { error: NON_DISCLOSING_ERROR };
    const request = input as OrderReconcileRequest;

    let outcome: OrderReconcileResult | { error: string } = { error: NON_DISCLOSING_ERROR };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(authenticatedBuyerDid, request.purchase_order_id);
      const ref = refOrder?.ref ?? null;
      // §9.13 typed negotiation: route by the order's PINNED major. A
      // request naming another major must not be parsed and answered as
      // v1 — the retained prior-major handler owns those, and an unknown
      // major gets a typed refusal rather than a silent downgrade.
      if (ref && !this.versionMatches(request.protocol_version, ref.pinnedVersion)) {
        outcome = { error: NON_DISCLOSING_ERROR };
        return;
      }
      if (ref) {
        if (
          ref.orderDigest !== request.order_digest ||
          ref.idempotencyKey !== request.idempotency_key
        ) {
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        if (ref.state === 'reserved') {
          outcome =
            ref.effectPhase === 'effect_started'
              ? {
                  outcome: 'received_unresolved',
                  retry_after_seconds: this.deps.unresolvedRetryAfterSeconds ?? 300,
                }
              : {
                  outcome: 'received_processing',
                  retry_after_seconds: this.deps.processingRetryAfterSeconds ?? 30,
                };
          return;
        }
        const acknowledgement = JSON.parse(
          ref.acknowledgementJson ?? 'null',
        ) as OrderAcknowledgement;
        outcome = this.decisionOutcome(acknowledgement);
        return;
      }

      // No record. Held supplier-signed evidence forces RE-ADOPTION —
      // answering never_received against our own signature would
      // invite a duplicate order (§16.2).
      const held = request.held_acknowledgement;
      if (held !== undefined) {
        // Authenticity is the injected verifier's job: the content
        // digest inside the record is a HASH anyone can compute, never
        // a signature. Fail closed without a verifier.
        const heldRecord = held.record;
        const invalid = validateOrderAcknowledgement(heldRecord, hash);
        if (
          invalid ||
          heldRecord.supplier_did !== this.deps.supplierDid() ||
          heldRecord.buyer_did !== authenticatedBuyerDid ||
          heldRecord.purchase_order_id !== request.purchase_order_id ||
          heldRecord.order_digest !== request.order_digest ||
          this.deps.verifyHeldEvidence?.({
            // Canonical bytes — see the status path above.
            recordJson: canonicalJson(heldRecord),
            recordDigest: heldRecord.acknowledgement_digest,
            signature: held.signature,
            ...(held.signer_key_id !== undefined ? { signerKeyId: held.signer_key_id } : {}),
            supplierDid: this.deps.supplierDid(),
          }) !== true
        ) {
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        const nowMs = this.deps.now();
        // §15.5 dual-key check BEFORE writing. The store enforces two
        // unique identities — (buyer, purchase_order_id) and
        // (buyer, idempotency_key) — and re-adoption must respect both.
        const byOrderIdOrder = this.deps.orders.load(
          authenticatedBuyerDid,
          request.purchase_order_id,
        );
        const byOrderId = byOrderIdOrder?.ref ?? null;
        if (byOrderId) {
          // Already present: a replay is fine ONLY if it describes the
          // same order. A different digest under the same id is a
          // conflict, never silent adoption.
          if (byOrderId.orderDigest !== request.order_digest) {
            outcome = { error: NON_DISCLOSING_ERROR };
            return;
          }
          outcome = this.decisionOutcome(heldRecord);
          return;
        }
        const byKey = this.deps.orders.byIdempotencyKey(
          authenticatedBuyerDid,
          request.idempotency_key,
        );
        if (byKey && byKey.purchaseOrderId !== request.purchase_order_id) {
          // The idempotency key already belongs to a DIFFERENT order.
          // Keys cannot alias (§15.5): re-adopting here would tell the
          // buyer their order is durable while the supplier holds no
          // matching reference.
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }

        const created = this.deps.orders.createReserved({
          buyerDid: authenticatedBuyerDid,
          purchaseOrderId: request.purchase_order_id,
          idempotencyKey: request.idempotency_key,
          orderDigest: request.order_digest,
          quoteId: '',
          quoteDigest: heldRecord.kind === 'accepted' ? heldRecord.accepted_quote_digest : '',
          pinnedVersion: heldRecord.protocol_version,
          // §16.2 — a re-adopted order is stamped PRE-restore on purpose.
          //
          // Re-adoption rebuilds an order reference from a buyer's held
          // acknowledgement but NOT the order's lines, quote context or
          // external state (a recorded open finding). Until it does, this
          // node must not be free to sign a first status for an order it
          // cannot fully describe: the buyer may hold a chain this node knows
          // nothing about, and a fresh genesis would fork against it.
          //
          // Stamping the previous epoch makes chain CREATION refuse until the
          // per-order reconciliation ceremony runs. Failing closed costs a
          // refusal; failing open costs a second, conflicting supplier
          // signature that no fence can repair.
          admittedEpoch: this.deps.currentEpoch(),
          // The order is real but this node cannot yet describe it — bar
          // chain creation until reconciliation clears it.
          reconciliationRequired: true,
          decisionDeadlineAt: null,
          createdAt: nowMs,
        });
        if (!created) {
          // Lost a concurrent create. Do NOT claim re-adoption.
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        const adopted = this.deps.orders.load(
          authenticatedBuyerDid,
          request.purchase_order_id,
        );
        const decided =
          adopted !== null &&
          adopted.decide({
            acknowledgementJson: JSON.stringify(heldRecord),
            decidedAt: nowMs,
          }).ok;
        if (!decided) {
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        this.deps.receipts.put({
          recordDigest: heldRecord.acknowledgement_digest,
          domain: 'acknowledgement',
          buyerDid: authenticatedBuyerDid,
          quoteId: '',
          purchaseOrderId: request.purchase_order_id,
          recordJson: JSON.stringify(heldRecord),
          evidenceJson: JSON.stringify({ readopted: true }),
          createdAt: nowMs,
        });
        // Read back and prove BOTH identities and the order digest before
        // telling the buyer the order is durably re-adopted. A received_*
        // answer is a durability claim; it must be backed by a row that
        // actually exists and matches (§15.5, §16.2).
        const persistedOrder = this.deps.orders.load(
          authenticatedBuyerDid,
          request.purchase_order_id,
        );
        const persisted = persistedOrder?.ref ?? null;
        if (
          !persisted ||
          persisted.state !== 'decided' ||
          persisted.orderDigest !== request.order_digest ||
          persisted.idempotencyKey !== request.idempotency_key
        ) {
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        outcome = this.decisionOutcome(heldRecord);
        return;
      }

      // §12.7/§16.2: verified own-signed STATUS receipts also disqualify
      // never_received — they prove the order existed even when the
      // acknowledgement itself was lost. The buyer keeps re-polling
      // while the supplier reconstructs the decision externally.
      //
      // FAIL CLOSED, exactly like the heldAcknowledgement branch above:
      // once ANY status evidence is presented, never_received is off the
      // table. never_received is the ONLY outcome that authorizes
      // byte-identical resubmission (§12.7), so answering it against
      // evidence we merely could not verify would invite the duplicate
      // order §16.2's re-adoption rule exists to prevent. Unverifiable
      // evidence is refused non-disclosingly; verified evidence loops.
      const heldStatuses = request.held_status_receipts ?? [];
      if (heldStatuses.length > 0) {
        const provenStatus = heldStatuses.some((evidence) => {
          const receipt = evidence.record;
          return (
            validateCommerceOrderStatus(receipt, hash) === null &&
            receipt.supplier_did === this.deps.supplierDid() &&
            receipt.buyer_did === authenticatedBuyerDid &&
            receipt.purchase_order_id === request.purchase_order_id &&
            this.deps.verifyHeldEvidence?.({
              // CANONICAL bytes, not JSON.stringify: the supplier signed
              // the record's canonical serialization, and stringify is
              // insertion-order dependent. A key-reordered but
              // digest-identical record would otherwise fail to verify —
              // and worse, "same record => same verifiable bytes" would
              // not hold across implementations.
              recordJson: canonicalJson(receipt),
              recordDigest: receipt.status_digest,
              signature: evidence.signature,
              ...(evidence.signer_key_id !== undefined
                ? { signerKeyId: evidence.signer_key_id }
                : {}),
              supplierDid: this.deps.supplierDid(),
            }) === true
          );
        });
        outcome = provenStatus
          ? {
              outcome: 'received_unresolved',
              retry_after_seconds: this.deps.unresolvedRetryAfterSeconds ?? 300,
            }
          : { error: NON_DISCLOSING_ERROR };
        return;
      }
      outcome = { outcome: 'never_received' };
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private decisionOutcome(acknowledgement: OrderAcknowledgement): OrderReconcileResult {
    switch (acknowledgement.kind) {
      case 'accepted':
        return { outcome: 'received_accepted', acknowledgement };
      case 'rejected':
        return { outcome: 'received_rejected', acknowledgement };
      case 'counterproposal':
        return { outcome: 'received_countered', acknowledgement };
    }
  }

  /**
   * Load the status record a head digest names, FAIL CLOSED.
   *
   * Present, parseable, structurally valid, and digest-bound to the head
   * — anything less and we do not know the state we are about to extend,
   * so we must not sign. This exists once because it was written once
   * inline (for the dispute deadline) and omitted at the very next use
   * (the cumulative-lines predecessor), which silently disabled the
   * §9.11 monotonicity check whenever a receipt was lost.
   */
  private loadHeadStatus(headDigest: string, why: string): CommerceOrderStatus | { error: string } {
    const receipt = this.deps.receipts.get(headDigest);
    if (!receipt) {
      return { error: `status: ${why} receipt missing — store integrity failure (§9.11)` };
    }
    let record: CommerceOrderStatus;
    try {
      record = JSON.parse(receipt.recordJson) as CommerceOrderStatus;
    } catch {
      return { error: `status: ${why} receipt is unreadable — store integrity failure (§9.11)` };
    }
    if (validateCommerceOrderStatus(record, hash) !== null || record.status_digest !== headDigest) {
      return { error: `status: ${why} receipt does not match the head (§9.11)` };
    }
    return record;
  }

  private buildStatus(
    buyerDid: string,
    purchaseOrderId: string,
    fields: StatusFields,
    pinnedVersion: string,
  ): CommerceOrderStatus {
    const draft = {
      // §9.13 — the conversation's version, not this build's. A supplier
      // that has upgraded must still speak to an in-flight order in the
      // language it was opened in.
      protocol_version: pinnedVersion,
      purchase_order_id: purchaseOrderId,
      buyer_did: buyerDid,
      supplier_did: this.deps.supplierDid(),
      ...fields,
    };
    return {
      ...draft,
      status_digest: commerceRecordDigest(
        'status',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    } as CommerceOrderStatus;
  }

  private persistStatus(status: CommerceOrderStatus, quoteId: string, nowMs: number): void {
    this.deps.receipts.put({
      recordDigest: status.status_digest,
      domain: 'status',
      buyerDid: status.buyer_did,
      quoteId,
      purchaseOrderId: status.purchase_order_id,
      recordJson: JSON.stringify(status),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
  }

  /** Genesis signing already inside the cancellation transaction. */
  private signGenesisInTx(
    buyerDid: string,
    purchaseOrderId: string,
    event: GenesisEvent,
    quoteId: string,
    order: { admittedEpoch: string; reconciliationRequired: boolean; pinnedVersion: string },
    nowMs: number,
  ): CommerceOrderStatus | { error: string } {
    const status = this.buildStatus(
      buyerDid,
      purchaseOrderId,
      {
        sequence: '0',
        state: GENESIS_STATE_BY_EVENT[event],
        supplier_epoch: this.deps.currentEpoch(),
        updated_at: isoNow(nowMs),
      },
      order.pinnedVersion,
    );
    const created = this.deps.chains
      .load(buyerDid, purchaseOrderId)
      .createGenesis(status, order);
    if (!created.ok) return { error: chainError(created) };
    this.persistStatus(status, quoteId, nowMs);
    return status;
  }

  /**
   * §12.8 — open an accepted order's status chain from INSIDE another
   * engine's transaction. Exposed narrowly (no `tx` of its own) so the
   * composition root can make acceptance and genesis atomic without either
   * engine learning about the other's internals.
   */
  createAcceptedGenesisInTx(
    buyerDid: string,
    purchaseOrderId: string,
  ): { error: string } | null {
    const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
    const ref = refOrder?.ref ?? null;
    if (!ref || ref.state !== 'decided') {
      return { error: 'status: genesis requires a decided order (§9.11)' };
    }
    const signed = this.signGenesisInTx(
      buyerDid,
      purchaseOrderId,
      'accepted',
      ref.quoteId,
      ref,
      this.deps.now(),
    );
    return 'error' in signed ? signed : null;
  }

  /** Successor signing already inside the cancellation transaction. */
  private signStatusUpdateInTx(
    buyerDid: string,
    purchaseOrderId: string,
    ref: { orderDigest: string; quoteId: string; pinnedVersion: string },
    head: { headDigest: string; headSequence: string; state: string; supplierEpoch: string },
    fields: StatusUpdateFields,
  ): CommerceOrderStatus | { error: string } {
    const nowMs = this.deps.now();
    const status = this.buildStatus(buyerDid, purchaseOrderId, {
      sequence: (BigInt(head.headSequence) + 1n).toString(10),
      previous_status_digest: head.headDigest,
      state: fields.state,
      supplier_epoch: this.deps.currentEpoch(),
      updated_at: isoNow(nowMs),
    }, ref.pinnedVersion);
    // Fail-closed predecessor load, same contract as the public path: the
    // chain refuses to advance against a record it cannot verify. Cancellation
    // transitions carry no line snapshot, so line verification is a no-op.
    const loadedPrevious = this.loadHeadStatus(head.headDigest, 'previous head');
    if ('error' in loadedPrevious) return loadedPrevious;
    const moved = this.deps.chains
      .load(buyerDid, purchaseOrderId)
      .advance(status, loadedPrevious, () => null);
    if (!moved.ok) return { error: chainError(moved) };
    this.persistStatus(status, ref.quoteId, nowMs);
    return status;
  }

  /**
   * §12.8 finalization: emit the terminal result for a cancellation
   * that is parked in `pending_review`. This is deliberately a SEPARATE
   * operation from resolveCancellation — the review closes because the
   * owner (or policy) decided, never because the buyer resent the
   * request. Idempotent and CAS-like: it refuses unless the currently
   * recorded result is exactly `pending_review`, so two finalizations
   * cannot both win, and a replay after finalization returns the
   * already-terminal result.
   */
  finalizePendingCancellation(
    authenticatedBuyerDid: string,
    purchaseOrderId: string,
    cancellationId: string,
    result: Exclude<CancellationResultKind, 'pending_review'>,
    statusDigestAtResolution?: string,
  ): CancellationResult | { error: string } {
    let outcome: CancellationResult | { error: string } = { error: NON_DISCLOSING_ERROR };
    this.deps.tx(() => {
      const refOrder = this.deps.orders.load(authenticatedBuyerDid, purchaseOrderId);
      const ref = refOrder?.ref ?? null;
      if (!ref) {
        outcome = { error: NON_DISCLOSING_ERROR };
        return;
      }
      const recorded = this.findRecordedCancellation(
        authenticatedBuyerDid,
        purchaseOrderId,
        cancellationId,
      );
      if (!recorded) {
        outcome = { error: NON_DISCLOSING_ERROR };
        return;
      }
      if (recorded.result !== 'pending_review') {
        // Already terminal: idempotent, return what stands rather than
        // overwriting a decided outcome.
        outcome = recorded;
        return;
      }
      const nowMs = this.deps.now();
      outcome = this.recordResult(
        {
          protocol_version: recorded.protocol_version,
          cancellation_id: cancellationId,
          purchase_order_id: purchaseOrderId,
          order_digest: ref.orderDigest,
        } as unknown as CancellationRequest,
        result,
        statusDigestAtResolution,
        authenticatedBuyerDid,
        ref.quoteId,
        nowMs,
        ref.pinnedVersion,
      );
    });
    return outcome;
  }

  /**
   * §9.13 conversation-version routing. The wire `protocol_version` must
   * equal the EXACT version this order was opened with, not merely share a
   * major.
   *
   * Same-major compatibility belongs to negotiation and routing, not to a
   * conversation already under way: a 1.1 order receiving 1.0 continuation
   * records means the schema hash and the record interpretation can disagree
   * inside one chain, which is precisely what a pinned conversation exists
   * to prevent.
   */
  private versionMatches(protocolVersion: string, pinnedVersion: string): boolean {
    if (pinnedVersion === '') return true; // legacy rows carry no pin
    return protocolVersion === pinnedVersion;
  }

  private findRecordedCancellation(
    buyerDid: string,
    purchaseOrderId: string,
    cancellationId: string,
  ): CancellationResult | null {
    const receipts = this.deps.receipts.listByOrder(buyerDid, purchaseOrderId);
    // A cancellation can have TWO recorded results: the pending_review
    // parking record and the later terminal one from
    // finalizePendingCancellation. Pick by KIND, not by position or
    // timestamp — both can be written under the same clock tick, which
    // leaves "newest by array order" undefined. There is at most one
    // terminal result (finalization refuses unless the current record is
    // pending_review), so this is deterministic.
    let pending: CancellationResult | null = null;
    for (const receipt of receipts) {
      if (receipt.domain !== 'result') continue;
      const result = JSON.parse(receipt.recordJson) as CancellationResult;
      if (result.cancellation_id !== cancellationId) continue;
      if (result.result !== 'pending_review') return result;
      pending = result;
    }
    return pending;
  }

  private recordResult(
    cancellation: CancellationRequest,
    kind: CancellationResultKind,
    statusDigestAtResolution: string | undefined,
    buyerDid: string,
    quoteId: string,
    nowMs: number,
    pinnedVersion: string,
  ): CancellationResult {
    const draft = {
      protocol_version: pinnedVersion,
      cancellation_id: cancellation.cancellation_id,
      purchase_order_id: cancellation.purchase_order_id,
      result: kind,
      resolved_at: isoNow(nowMs),
      ...(statusDigestAtResolution !== undefined
        ? ({
            status_digest_at_resolution: statusDigestAtResolution,
          } satisfies Partial<CancellationResult>)
        : {}),
    };
    const result = {
      ...draft,
      result_digest: commerceRecordDigest(
        'result',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    } as CancellationResult;
    this.deps.receipts.put({
      recordDigest: result.result_digest,
      domain: 'result',
      buyerDid,
      quoteId,
      purchaseOrderId: cancellation.purchase_order_id,
      recordJson: JSON.stringify(result),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
    return result;
  }
}
