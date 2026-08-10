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
  validateCancellationResult,
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
  type RetainedEnvelope,
  type Sha256Fn,
  HeldEvidence,
  readPurchaseOrderProposal,
} from '@dina/commerce-protocol';

import { ackIdSuffix } from './admission';
import { type CommerceOrderStore } from './commerce_order';
import { CommerceIntegrityError, type QuoteFamilyStore } from './quote_family';
import { signedHere } from './receipt_evidence';
import {
  rehydrateAcknowledgement,
  rehydrateOrderStatus,
  rehydratePurchaseOrder,
} from './rehydrate';
import {
  selectFencePredecessor,
  type ChainRefusal,
  type StatusChainStore,
} from './status_chain';

import type { CommerceReceiptRepository } from './receipts';

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
  chain_predates_restore: 'status: chain predates a restore — sign the restore fence first (§16.2)',
  illegal_transition: 'status: illegal transition (§9.11)',
  lines_violation: 'status: cumulative line snapshot violation (§9.11)',
  fence_needs_higher_epoch: 'fence: requires a strictly higher epoch — restore first (§16.2)',
  evidence_forks: 'fence: presented receipts disagree at one sequence (§9.11)',
  evidence_not_contiguous:
    'fence: presented receipts do not form one unbroken chain from the head (§16.2)',
  cas_lost: 'status: CAS at signing — concurrent successor won (§9.11)',
};

/**
 * Compile-time proof that a switch covered its union, with a runtime throw
 * for the corrupt-store case the type system cannot see.
 */
function exhaustiveDecision(value: never): never {
  throw new CommerceIntegrityError(
    `stored acknowledgement carries an unrecognised kind: ${JSON.stringify(value)}`,
  );
}

/** Prefer the aggregate's precise detail; fall back to the refusal name. */
function chainError(outcome: { refusal: ChainRefusal; detail?: string }): string {
  const base = CHAIN_ERROR[outcome.refusal];
  return outcome.detail === undefined ? base : `${base}: ${outcome.detail}`;
}

/** Non-disclosing rejection: identical for "no such order", "not your
 *  order", and "digest mismatch" (§11.2). */
export const NON_DISCLOSING_ERROR = 'commerce: unknown order or unauthorized caller';

export interface LifecycleEngineDeps {
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
   * §12.7/§16.2 — did THIS supplier's key sign these bytes?
   *
   * ONLY the cryptography. The callback gets the retained message and a
   * signature, and answers whether the supplier's key produced one over
   * the other. Everything else — that the message came FROM this
   * supplier, went TO this buyer, and actually carries the record being
   * presented — is checked in `verifyHeldRecord` below, in compiled code
   * that no composition root can decline to implement.
   *
   * That split is the point. The earlier shape passed
   * `{recordJson, recordDigest}`: a record and a hash of that record,
   * both computable by anyone holding or inventing the record. No
   * implementation could establish authenticity from it, so every boot
   * that wired something was wiring a check that proved nothing.
   *
   * Fail closed: Core treats a missing verifier as "cannot verify", and
   * held-evidence re-adoption is refused non-disclosingly.
   */
  verifyHeldEvidence?: (evidence: {
    envelope: RetainedEnvelope;
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

/** Bound on the signed-body walk: far above any real response body. */
const MAX_SIGNED_BODY_NODES = 10_000;

/**
 * Does the signed body actually commit to this record?
 *
 * The digest is a collision-resistant hash of the record's canonical form,
 * and the record's own validator recomputes it before this runs — so a
 * digest appearing among the signed body's strings means the supplier put
 * its name to a message carrying exactly that record.
 *
 * WALKS THE PARSED JSON rather than searching the raw text. A substring hit
 * inside an unrelated blob (a base64 attachment, a free-text note) would be
 * a match that means nothing; a string VALUE at some path is a field the
 * sender wrote.
 *
 * Unparseable body => false. A supplier's own message is JSON; anything
 * else is not evidence this code should reason about.
 */
function signedBodyCommitsTo(body: string, digest: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const stack: unknown[] = [parsed];
  // Bounded so a deeply nested or wide body cannot spin here. The cap is far
  // above any real service response and far below anything expensive.
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SIGNED_BODY_NODES) {
    visited += 1;
    const node = stack.pop();
    if (typeof node === 'string') {
      if (node === digest) return true;
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    stack.push(...Object.values(node as Record<string, unknown>));
  }
  return false;
}

/**
 * A stored cancellation-result receipt as an object, or `null` when the row
 * cannot be believed.
 *
 * `JSON.parse` in a try/catch is NOT enough, and the gap is narrow enough to
 * have survived review twice. `JSON.parse('null')` SUCCEEDS — it returns
 * `null` — so the catch never fires and the caller dereferences null one line
 * later, OUTSIDE the guard. `rehydrate.ts` records finding exactly this on the
 * acknowledgement path; both cancellation scans had reproduced it.
 *
 * It defeated the property those scans are written for. Each is documented as
 * skipping a row it cannot read so that ONE corrupt receipt cannot make every
 * other cancellation on the order unanswerable — and a single `null` row threw
 * a TypeError straight out of the scan instead, which is that failure exactly.
 * The commerce boundary test exempts this file on the strength of that
 * documented reason, so the reason had better be true.
 *
 * Arrays are refused too: a list is not a record, and `[].cancellation_id` is
 * a quiet `undefined` rather than a refusal.
 */
function parseResultReceipt(recordJson: string): CancellationResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as CancellationResult;
}

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
  signGenesisInTx(
    buyerDid: string,
    purchaseOrderId: string,
  ): CommerceOrderStatus | { error: string } {
    let outcome: CommerceOrderStatus | { error: string } = { error: NON_DISCLOSING_ERROR };
    ((): void => {
      const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
      const ref = refOrder?.ref ?? null;
      if (!ref || ref.state !== 'decided') {
        outcome = { error: 'status: genesis requires a decided order (§9.11)' };
        return;
      }
      // REHYDRATED, not cast. This acknowledgement decides what genesis
      // status this node SIGNS, and the row is editable by anything with the
      // database open — a cast made a store-editable blob into the content of
      // a signature. `rehydrateAcknowledgement` re-derives the digest, so a
      // tampered or truncated row is refused rather than signed over.
      const read = rehydrateAcknowledgement(ref.acknowledgementJson, hash);
      if (!read.ok) {
        outcome = {
          error: `status: decided order has no usable acknowledgement — ${read.error}`,
        };
        return;
      }
      const acknowledgement: OrderAcknowledgement = read.value;
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
      const created = this.deps.chains.load(buyerDid, purchaseOrderId).createGenesis(status, ref);
      if (!created.ok) {
        outcome = { error: chainError(created) };
        return;
      }
      this.persistStatus(status, ref.quoteId, nowMs);
      outcome = status;
    })();
    return outcome;
  }

  /**
   * Sign a successor status. CAS against the stored head; the legal
   * transition graph and the cumulative complete-snapshot line rules
   * are enforced BEFORE the head advances.
   */
  signStatusUpdateInTx(
    buyerDid: string,
    purchaseOrderId: string,
    fields: StatusUpdateFields,
  ): CommerceOrderStatus | { error: string } {
    let outcome: CommerceOrderStatus | { error: string } = { error: NON_DISCLOSING_ERROR };
    ((): void => {
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
        const loaded = this.loadHeadStatus(
          buyerDid,
          purchaseOrderId,
          head.headDigest,
          'delivered head',
        );
        if ('error' in loaded) {
          outcome = loaded;
          return;
        }
        const delivered = loaded;
        if (delivered.dispute_window_ends_at === undefined) {
          outcome = {
            error:
              'status: delivered head carries no dispute window — cannot sign disputed (§9.11)',
          };
          return;
        }
        if (nowMs > Date.parse(delivered.dispute_window_ends_at)) {
          outcome = {
            error:
              'status: delivered -> disputed is legal only before dispute_window_ends_at (§9.11)',
          };
          return;
        }
      }
      const status = this.buildStatus(
        buyerDid,
        purchaseOrderId,
        {
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
        },
        ref.pinnedVersion,
      );
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
      const rehydratedOrder = rehydratePurchaseOrder(orderReceipt.recordJson, hash);
      if (!rehydratedOrder.ok) {
        outcome = { error: `status: ${rehydratedOrder.error}` };
        return;
      }
      const order = rehydratedOrder.value;
      // FAIL CLOSED, same as the dispute deadline above. Passing
      // `undefined` here made verifyStatusLines skip the cumulative
      // comparison entirely, so a lost receipt let Core sign a REGRESSING
      // fulfilled_quantity and advance the head — §9.11 says a decrease is
      // an illegal update, rejected like any other graph violation.
      const loadedPrevious = this.loadHeadStatus(
        buyerDid,
        purchaseOrderId,
        head.headDigest,
        'previous head',
      );
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
    })();
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
  signRestoreFenceInTx(
    buyerDid: string,
    purchaseOrderId: string,
    heldStatusReceipts: readonly HeldEvidence<CommerceOrderStatus>[],
  ): CommerceOrderStatus | { error: string } {
    let outcome: CommerceOrderStatus | { error: string } = { error: NON_DISCLOSING_ERROR };
    ((): void => {
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
            this.verifyHeldRecord({
              evidence,
              recordDigest: receipt.status_digest,
              buyerDid,
            })
          );
        })
        .map((evidence) => evidence.record);
      if (verified.length === 0) {
        outcome = { error: 'fence: no verifiable held status receipts to fence against (§16.2)' };
        return;
      }
      const chain = this.deps.chains.load(buyerDid, purchaseOrderId);
      if (!chain.exists) {
        outcome = { error: 'fence: no local chain for this order' };
        return;
      }
      const head = chain.head;
      // CHOSEN BY THE CHAIN RULE, not by `reduce` over sequences. Picking the
      // tallest receipt says nothing about whether the ones below it line up:
      // a gap fast-forwards this supplier past records nobody showed it, and
      // two receipts at one height mean it signed twice there — with `reduce`
      // the buyer picked the winner by array order.
      //
      // The chain is loaded FIRST now, because the rule needs the local head
      // to root the walk.
      const chosen = selectFencePredecessor(head, verified);
      if (!chosen.ok) {
        outcome = { error: chainError(chosen) };
        return;
      }
      const predecessor = chosen.value;
      if (statusIsTerminal(predecessor, isoNow(this.deps.now()))) {
        outcome = { error: 'fence: the order is already terminal — nothing to resume' };
        return;
      }
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
          error:
            'fence: presented evidence is behind the local head — refusing to roll back (§16.2)',
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
      // Two epoch bars, because the buyer applies a different one than we do.
      //
      // Ours is the LOCAL head: a fence at our own epoch would be a no-op or
      // a fork. The buyer's (`verifyRestoreFence`) is ITS head — and after a
      // restore the buyer's head can sit above ours, on records we lost.
      // Checking only the local head therefore lets Core sign a fence the
      // buyer must refuse for "requires a strictly higher supplier_epoch",
      // stranding the order that the fence exists to rescue.
      //
      // A conforming buyer presents its chain including its head, so the
      // highest epoch among the VERIFIED receipts is the buyer's head epoch.
      // Anything it withholds only lowers this bar, and a lower bar cannot
      // make us sign something the buyer accepts — it just leaves us
      // refusing later, on the buyer's rule, instead of here.
      const highestPresentedEpoch = verified.reduce(
        (highest, candidate) =>
          BigInt(candidate.supplier_epoch) > highest ? BigInt(candidate.supplier_epoch) : highest,
        0n,
      );
      const bar =
        BigInt(head.supplierEpoch) > highestPresentedEpoch
          ? BigInt(head.supplierEpoch)
          : highestPresentedEpoch;
      if (BigInt(epoch) <= bar) {
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
      // RE-DERIVE against the order, do not restate on faith (§9.11).
      //
      // The fence copies the predecessor's fulfilment forward, and the
      // predecessor carries our own signature — so it is tempting to treat it
      // as already proven. It is not. What that signature proves is that we
      // signed the record ONCE, against whatever order state we held THEN. A
      // restore is exactly the moment those two halves can disagree: the
      // order reference and the status receipts are separate tables and can
      // come back from different backup vintages.
      //
      // The buyer runs `verifyStatusLines(fence, order_lines, predecessor)`
      // before accepting. Running it here is not belt-and-braces — it is the
      // difference between refusing to sign and signing a record the buyer
      // must reject, which strands the order the fence was rescuing.
      //
      // ONE ARM OF THIS IS INERT TODAY, deliberately. `verifyStatusLines`
      // checks two things: the candidate against the ORDER (complete
      // snapshot, ordered unit, within the ordered quantity) and the
      // candidate against the PREVIOUS record (no cumulative regression).
      // Only the first can fail here, because the fence copies the
      // predecessor's lines verbatim, so the second compares them with
      // themselves. Passing `predecessor` anyway keeps this call byte-for-byte
      // the buyer's call: §16.2 permits a fence to legally ADVANCE from its
      // predecessor rather than restate it, and on the day this engine takes
      // that option the cumulative arm goes live with no edit here. A test
      // cannot cover an inert branch, so it is named here instead of being
      // left to look like a guard that is doing work.
      const orderReceipt = this.deps.receipts.get(ref.orderDigest);
      if (!orderReceipt) {
        outcome = { error: 'fence: order receipt missing — store integrity failure (§16.2)' };
        return;
      }
      const rehydratedOrder = rehydratePurchaseOrder(orderReceipt.recordJson, hash);
      if (!rehydratedOrder.ok) {
        outcome = { error: `fence: ${rehydratedOrder.error}` };
        return;
      }
      const lineError = verifyStatusLines(
        status,
        rehydratedOrder.value.accepted_lines,
        predecessor,
      );
      if (lineError !== null) {
        outcome = { error: `fence: ${lineError}` };
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
    })();
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Cancellation (§12.8)
  // -------------------------------------------------------------------------

  resolveCancellationInTx(
    request: unknown,
    authenticatedBuyerDid: string,
    policy: CancellationPolicy,
  ): CancellationResult | { error: string } {
    const structural = validateCancellationRequest(request, hash);
    if (structural) return { error: structural };
    const cancellation = request as unknown as CancellationRequest;

    let outcome: CancellationResult | { error: string } = { error: NON_DISCLOSING_ERROR };
    ((): void => {
      const refOrder = this.deps.orders.load(authenticatedBuyerDid, cancellation.purchase_order_id);
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

      // §16.2 (WS-4.4) — a cancellation may not DECIDE an order whose
      // post-backup decision was lost.
      //
      // RACE ARM 1 below treats `reserved` as "not yet decided" and lets the
      // cancellation win: it refunds the hold and signs a `cancellation_won`
      // genesis. After a restore that reading is unsound. An order restored
      // as reserved may have been accepted AFTER the backup was taken — the
      // buyer holds an acknowledgement this node no longer has. Deciding it
      // now forks the chain against the record the buyer already holds and
      // refunds capacity that was actually committed.
      //
      // Nothing local can tell the two apart, which is what reconciliation
      // is for. So this answers nothing and RECORDS nothing: no receipt, no
      // frozen result. The buyer's route to certainty is `order_reconcile`,
      // and its cancellation gets a real decision once the order is
      // reconciled and this guard stops firing.
      //
      // Deliberately NOT `pending_review`: that claims a human is looking at
      // it, which is false, and would let `finalizePendingCancellation`
      // decide the very order we cannot decide.
      if (ref.reconciliationRequired) {
        outcome = {
          error: 'commerce: order is awaiting reconciliation — it cannot be cancelled yet (§16.2)',
        };
        return;
      }
      if (BigInt(ref.admittedEpoch) < BigInt(this.deps.currentEpoch())) {
        outcome = {
          error: 'commerce: order predates a restore — reconcile it before cancelling (§16.2)',
        };
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
        // §9.12 (WS-2.8) — signed here, no counterparty envelope.
        evidenceJson: signedHere(nowMs),
        createdAt: nowMs,
      });

      // RACE ARM 1: order still reserved — cancellation wins over
      // acceptance atomically (§12.8/§9.11 cancellation_won genesis).
      if (ref.state === 'reserved') {
        // Built and validated before ANY state mutation on this path.
        const acknowledgement = this.buildCancellationAcknowledgement(
          authenticatedBuyerDid,
          cancellation.purchase_order_id,
          ref,
          nowMs,
        );
        if (acknowledgement === null) {
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
        const won = this.settleCancellationWin(
          authenticatedBuyerDid,
          cancellation.purchase_order_id,
          ref,
          acknowledgement,
          nowMs,
          true,
        );
        if ('error' in won) {
          outcome = won;
          return;
        }
        outcome = this.recordResult(
          cancellation,
          'cancelled',
          won.genesisDigest,
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
      // A missing receipt and one that fails re-validation are the same thing
      // here: this path cannot decide a cancellation without the order it is
      // cancelling, and a record we cannot vouch for is not that order.
      const rehydratedOrder =
        orderReceipt === null ? null : rehydratePurchaseOrder(orderReceipt.recordJson, hash);
      const order = rehydratedOrder !== null && rehydratedOrder.ok ? rehydratedOrder.value : null;
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
        const transition = this.signStatusUpdateRecord(
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
    })();
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Reconcile (§12.7)
  // -------------------------------------------------------------------------

  reconcileInTx(
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
    ((): void => {
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
            // `reconciliationRequired` joins `effect_started` here for the
            // same reason: both mean this node cannot say what happens next,
            // and `received_processing` ("we are working on it") would be a
            // claim nobody is backing. A re-adopted order normally reaches
            // the DECIDED branch below, so this arm covers the narrow window
            // where re-adoption created the reference and did not decide.
            ref.effectPhase === 'effect_started' || ref.reconciliationRequired
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
        if (ref.reconciliationRequired) {
          // THE RE-ADOPTED ORDER (WS-2.3). This node holds the decision —
          // it came from the buyer's own signed evidence — but it cannot
          // ACT on it: re-adoption rebuilds a reference, not the order's
          // lines, its quote context, or its external state, and chain
          // creation stays barred until the owner runs the §16.2 ceremony.
          //
          // Answering `received_accepted` here is true and useless. It hands
          // the buyer back the document they just presented, and it says
          // "accepted" to a party who will then wait for status updates that
          // cannot come. `received_unresolved` is the vocabulary's own word
          // for "this supplier holds the order but cannot report where it
          // is", and its retry gives a human the time this needs.
          //
          // NOT a new outcome: §12.7's set is frozen with vectors, and a
          // fourth value would be a wire-major change to say something the
          // existing one already says.
          outcome = {
            outcome: 'received_unresolved',
            retry_after_seconds: this.deps.unresolvedRetryAfterSeconds ?? 300,
          };
          return;
        }
        // Same discipline on the reconcile answer: this is the evidence a
        // buyer receives back as "here is what we agreed", and a cast would
        // let a corrupt row become that answer. An unreadable row is an
        // UNRESOLVED outcome, never a fabricated decision — the buyer asks
        // again rather than being told something this node cannot stand behind.
        const read = rehydrateAcknowledgement(ref.acknowledgementJson, hash);
        if (!read.ok) {
          outcome = {
            outcome: 'received_unresolved',
            retry_after_seconds: this.deps.unresolvedRetryAfterSeconds ?? 300,
          };
          return;
        }
        outcome = this.decisionOutcome(read.value);
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
          !this.verifyHeldRecord({
            evidence: held,
            recordDigest: heldRecord.acknowledgement_digest,
            buyerDid: authenticatedBuyerDid,
          })
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
          // A re-adopted order that is still frozen answers the same thing
          // its next poll will (see the reserved branch above); echoing the
          // buyer's OWN held acknowledgement back at them would assert a
          // state this node cannot yet act on.
          outcome = byOrderId.reconciliationRequired
            ? {
                outcome: 'received_unresolved',
                retry_after_seconds: this.deps.unresolvedRetryAfterSeconds ?? 300,
              }
            : this.decisionOutcome(heldRecord);
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
          // §9.13 — EMPTY on purpose: held evidence records the protocol
          // version but not which manifest served the order, and guessing the
          // current one would claim a contract this node cannot vouch for. A
          // re-adopted order is barred from chain creation until reconciled
          // anyway, so it never needs prior-manifest routing.
          servingManifestCid: '',
          servingInstallId: '',
          // §16.2 — the epoch this node ADOPTED the reference in, which is
          // the current one. The order is older than that, but this node has
          // no trustworthy value for when: held evidence carries the
          // protocol version, not the supplier epoch the order was admitted
          // under, and inventing a lower number would put a fabricated fact
          // in the column the fence reads.
          //
          // SO THE EPOCH IS NOT WHAT BARS THIS ORDER — `reconciliationRequired`
          // below is, and it is the only barrier. An earlier version of this
          // comment claimed a pre-restore stamp made chain CREATION refuse;
          // the code has always stamped the current epoch, so that second
          // barrier never existed and a reader was being told the guard was
          // twice as strong as it is.
          //
          // What the flag buys is the same outcome by an honest route:
          // re-adoption rebuilds an order reference from a buyer's held
          // acknowledgement but NOT the order's lines, quote context or
          // external state (a recorded open finding), so this node must not
          // sign a first status for an order it cannot fully describe — the
          // buyer may hold a chain this node knows nothing about, and a fresh
          // genesis would fork against it. `status_chain` refuses creation
          // with `order_awaiting_reconciliation` until the per-order ceremony
          // clears the flag, and `disaster_recovery_journey.test.ts` pins that
          // refusal so the single barrier cannot be removed silently.
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
        const adopted = this.deps.orders.load(authenticatedBuyerDid, request.purchase_order_id);
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
        // Re-adoption SUCCEEDED and the answer is still `received_unresolved`
        // (WS-2.3). The decision is known — it is the buyer's own signed
        // evidence — but this node cannot act on it, and the same order must
        // not say `accepted` on the poll that re-adopted it and
        // `unresolved` on every poll after. One order, one answer, until the
        // owner's §16.2 ceremony makes it describable again.
        outcome = {
          outcome: 'received_unresolved',
          retry_after_seconds: this.deps.unresolvedRetryAfterSeconds ?? 300,
        };
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
            this.verifyHeldRecord({
              evidence,
              recordDigest: receipt.status_digest,
              buyerDid: authenticatedBuyerDid,
            })
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
    })();
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Map an acknowledgement to the reconcile outcome it reports (WS-0.7).
   *
   * WHAT THE DEFAULT ARM IS AND IS NOT FOR. It is NOT reachable today: every
   * caller either builds the acknowledgement here or runs
   * `validateOrderAcknowledgement` first, which rejects an unknown `kind`
   * before the switch sees it. Stating that plainly because the tempting
   * justification — "held evidence comes from a counterparty" — is wrong, and
   * a comment that oversells a guard is worse than no comment.
   *
   * It earns its place against a DIFFERENT failure: the protocol adding a
   * fourth acknowledgement kind. The validator would accept it immediately;
   * this switch would not, and without a default it would fall off the end and
   * return `undefined` typed as a result. That is a silent wrong answer to a
   * buyer, produced by a change in another package that compiles cleanly here.
   * `received_unresolved` is the vocabulary's own word for "this supplier
   * holds the order but cannot report a decision", so the buyer keeps polling
   * rather than acting on a decision this node never made.
   */
  /**
   * §12.7/§16.2 — is this held record really something I signed for THIS
   * buyer?
   *
   * Four checks, all of them compiled and none of them delegated:
   *
   *  1. the retained message came FROM this supplier;
   *  2. it went TO the buyer now presenting it, so one buyer cannot replay
   *     another's evidence;
   *  3. the record's content digest appears among the signed body's own
   *     strings — WITHOUT this, `{record, signature}` is an unbound pair
   *     and a buyer could present a genuine signature from one message
   *     beside a record from another, or an invented one;
   *  4. the signature verifies under this supplier's key.
   *
   * Only (4) is the injected callback's business. The binding checks stay
   * here because a composition root that implemented the callback loosely
   * would otherwise silently drop them, and the failure mode is a supplier
   * re-adopting an order it never accepted.
   *
   * Fail closed everywhere: no verifier, no supplier DID, or an
   * unparseable body all mean NOT verified.
   */
  private verifyHeldRecord(args: {
    evidence: { envelope: RetainedEnvelope; signature: string; signer_key_id?: string };
    recordDigest: string;
    buyerDid: string;
  }): boolean {
    const supplierDid = this.deps.supplierDid();
    if (supplierDid === '') return false;
    const { envelope } = args.evidence;
    if (envelope.from !== supplierDid) return false;
    if (!envelope.to.includes(args.buyerDid)) return false;
    if (!signedBodyCommitsTo(envelope.body, args.recordDigest)) return false;
    return (
      this.deps.verifyHeldEvidence?.({
        envelope,
        signature: args.evidence.signature,
        ...(args.evidence.signer_key_id !== undefined
          ? { signerKeyId: args.evidence.signer_key_id }
          : {}),
        supplierDid,
      }) === true
    );
  }

  private decisionOutcome(acknowledgement: OrderAcknowledgement): OrderReconcileResult {
    switch (acknowledgement.kind) {
      case 'accepted':
        return { outcome: 'received_accepted', acknowledgement };
      case 'rejected':
        return { outcome: 'received_rejected', acknowledgement };
      case 'counterproposal':
        return { outcome: 'received_countered', acknowledgement };
      default:
        // UNREACHABLE, and now provably so — `acknowledgement` narrows to
        // `never` here, which is the compiler stating that the three arms
        // above cover the union. Assigning it to a `never` binding keeps that
        // true: adding a fourth acknowledgement kind without a case makes
        // THIS LINE fail tsc rather than silently falling through.
        //
        // The arm used to answer `received_unresolved`, which tells a buyer
        // to keep polling a record that can never resolve — an impossible
        // state dressed as a business outcome. Every caller arrives through
        // `rehydrateAcknowledgement`, which validates the closed kind set
        // before returning, so a fourth value would mean a corrupt row rather
        // than an unusual question.
        return exhaustiveDecision(acknowledgement);
    }
  }

  /**
   * Load the status record a head digest names, FAIL CLOSED.
   *
   * Present, parseable, structurally valid, digest-bound to the head, and
   * BELONGING TO THIS CHAIN — anything less and we do not know the state we
   * are about to extend, so we must not sign. This exists once because it was
   * written once inline (for the dispute deadline) and omitted at the very
   * next use (the cumulative-lines predecessor), which silently disabled the
   * §9.11 monotonicity check whenever a receipt was lost.
   *
   * WHY THE IDENTITY CHECK IS SEPARATE FROM THE DIGEST CHECK. They answer two
   * different questions and it is easy to think the first answers both. The
   * digest proves the record is the one the head NAMES; it says nothing about
   * whether that record belongs HERE. The receipt store is keyed by digest
   * across every order this node has ever handled, so a head row pointing at
   * another order's status — a corrupted row, a restore that recombined
   * tables, a future writer with a swapped argument — loads clean and is then
   * used as the predecessor: its state drives transition legality, its lines
   * become the cumulative floor, and the successor we sign extends a stranger's
   * chain. Binding the three identity fields costs one comparison and closes
   * the whole class.
   */
  private loadHeadStatus(
    buyerDid: string,
    purchaseOrderId: string,
    headDigest: string,
    why: string,
  ): CommerceOrderStatus | { error: string } {
    const receipt = this.deps.receipts.get(headDigest);
    if (!receipt) {
      return { error: `status: ${why} receipt missing — store integrity failure (§9.11)` };
    }
    // Through the ONE safe reader, not a local parse-and-cast. The checks were
    // equivalent — parse, validate, compare the digest — but written a second
    // time, and a second copy of a rule is a place for the two to diverge.
    // `rehydrateOrderStatus` also collapses "unreadable" and "does not match"
    // into one refusal, which is right: both mean this node cannot know the
    // state it is about to extend.
    const read = rehydrateOrderStatus(receipt.recordJson, headDigest, hash);
    if (!read.ok) {
      return { error: `status: ${why} receipt does not match the head (§9.11)` };
    }
    const record = read.value;
    if (
      record.purchase_order_id !== purchaseOrderId ||
      record.buyer_did !== buyerDid ||
      record.supplier_did !== this.deps.supplierDid()
    ) {
      return {
        error: `status: ${why} receipt belongs to a different chain — store integrity failure (§9.11)`,
      };
    }
    return record;
  }

  private buildStatus(
    buyerDid: string,
    purchaseOrderId: string,
    fields: StatusFields,
    pinnedVersion: string,
  ): CommerceOrderStatus {
    // ANNOTATED, and that is the whole point. An unannotated literal gets no
    // excess-property check, and a spread never gets one — so with `draft`
    // untyped a camelCase wire key rode through both this literal and the
    // typed result below. Annotating the DRAFT is what makes a misspelt or
    // wrong-cased key fail tsc on the line that writes it, which is the
    // check the three shipped wire bugs went around.
    const draft: Omit<CommerceOrderStatus, 'status_digest'> = {
      // §9.13 — the conversation's version, not this build's. A supplier
      // that has upgraded must still speak to an in-flight order in the
      // language it was opened in.
      protocol_version: pinnedVersion,
      purchase_order_id: purchaseOrderId,
      buyer_did: buyerDid,
      supplier_did: this.deps.supplierDid(),
      ...fields,
    };
    // No `as CommerceOrderStatus` on the way out either. The cast that used
    // to sit here told tsc to accept whatever the spread produced, so even a
    // typed draft would not have been checked against the result.
    const status: CommerceOrderStatus = {
      ...draft,
      status_digest: commerceRecordDigest(
        'status',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    };
    return status;
  }

  private persistStatus(status: CommerceOrderStatus, quoteId: string, nowMs: number): void {
    this.deps.receipts.put({
      recordDigest: status.status_digest,
      domain: 'status',
      buyerDid: status.buyer_did,
      quoteId,
      purchaseOrderId: status.purchase_order_id,
      recordJson: JSON.stringify(status),
      // §9.12 (WS-2.8) — this supplier signed the status; the chain is its
      // own claim, so the evidence says where it came from.
      evidenceJson: signedHere(nowMs),
      createdAt: nowMs,
    });
  }

  /**
   * Sign a genesis from an ALREADY-RESOLVED order reference.
   *
   * Named `…Record` rather than `…InTx` since ARCH-0c: every method on this
   * class now runs inside a transaction its service opened, so the suffix
   * stopped distinguishing anything. What distinguishes this one is that it
   * takes the resolved reference instead of loading it.
   */
  private signGenesisRecord(
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
    const created = this.deps.chains.load(buyerDid, purchaseOrderId).createGenesis(status, order);
    if (!created.ok) return { error: chainError(created) };
    this.persistStatus(status, quoteId, nowMs);
    return status;
  }

  /**
   * §16.2 (WS-4.3) — the per-order reconciliation ceremony.
   *
   * Re-adoption rebuilds an order from the buyer's held acknowledgement and
   * stamps it `reconciliationRequired`, which bars chain creation and (since
   * WS-4.4) cancellation. NOTHING cleared that flag, so a re-adopted order
   * stayed frozen for ever. This is the way out.
   *
   * The buyer presents the order proposal it holds. Core validates it and
   * requires its digest to equal the one on the reference — which came from
   * this supplier's own signed acknowledgement, so the check binds the
   * recovered document to what the supplier already committed to. A
   * different order cannot be substituted.
   *
   * Non-disclosing throughout: unknown order, another buyer's order, an
   * order that was never re-adopted, and a mismatched proposal are one
   * answer.
   */
  reconcileRestoredOrderInTx(
    proposal: unknown,
    authenticatedBuyerDid: string,
  ): { ok: true } | { error: string } {
    const read = readPurchaseOrderProposal(proposal, hash);
    if (!read.ok) return { error: read.error };
    const order = read.order;
    // No separate buyer check: `orders.load` is keyed on (buyerDid,
    // purchaseOrderId), so looking the order up under the AUTHENTICATED
    // caller IS the ownership test — the same entitlement-by-possession the
    // ingress gate uses. A comparison against the proposal's own `buyer_did`
    // would be a second, weaker copy of a rule the lookup already enforces:
    // the proposal is attacker-supplied, the key is not.

    let outcome: { ok: true } | { error: string } = { error: NON_DISCLOSING_ERROR };
    ((): void => {
      const loaded = this.deps.orders.load(authenticatedBuyerDid, order.purchase_order_id);
      if (loaded === null) return;
      const done = loaded.reconcile({
        presentedDigest: order.order_digest,
        // Stamp the CURRENT epoch: the order is described again and belongs
        // to this generation. Leaving the old epoch would keep it fenced by
        // the pre-restore check and the ceremony would achieve nothing.
        atEpoch: this.deps.currentEpoch(),
      });
      if (!done.ok) return;

      // Put the recovered proposal where the code that needs it LOOKS. The
      // receipt store is the durable home of every commerce document, keyed
      // by digest, and `signStatusUpdate` reads the order receipt to check
      // cumulative line snapshots — it fails `order receipt missing` without
      // one. Recording the proposal anywhere else would clear the flag and
      // leave the order still unable to move, which is a ceremony that
      // reports success and achieves nothing.
      this.deps.receipts.put({
        recordDigest: order.order_digest,
        domain: 'order',
        buyerDid: order.buyer_did,
        quoteId: order.quote_id,
        purchaseOrderId: order.purchase_order_id,
        recordJson: JSON.stringify(order),
        evidenceJson: '{}',
        createdAt: this.deps.now(),
      });
      outcome = { ok: true };
    })();
    return outcome;
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
    /**
     * The state the chain OPENS at. `accepted` is a live chain that will run
     * on; `rejected` opens and closes in the same record.
     *
     * IT USED TO BE HARD-CODED to `accepted`, and admission only called this
     * for an acceptance — so a rejected or countered order got no chain at
     * all. That is not a cosmetic gap: `countUnfinishedByServingManifest`
     * reads a MISSING head as unfinished, so every rejected order counted as
     * open work for ever, holding a prior manifest's lifecycle authority and
     * blocking plugin uninstall. It is the same failure the delivered-order
     * dispute-window fix addressed, arriving by a different route.
     *
     * A buyer also has nothing to verify without it. §9.11's chain is where a
     * rejection becomes a record they can show, rather than a claim that
     * exists only inside an acknowledgement they were handed.
     */
    openAt: 'accepted' | 'rejected' = 'accepted',
  ): { error: string } | null {
    const refOrder = this.deps.orders.load(buyerDid, purchaseOrderId);
    const ref = refOrder?.ref ?? null;
    if (!ref || ref.state !== 'decided') {
      return { error: 'status: genesis requires a decided order (§9.11)' };
    }
    const signed = this.signGenesisRecord(
      buyerDid,
      purchaseOrderId,
      openAt,
      ref.quoteId,
      ref,
      this.deps.now(),
    );
    return 'error' in signed ? signed : null;
  }

  /** Sign a successor from an ALREADY-RESOLVED reference and head. */
  private signStatusUpdateRecord(
    buyerDid: string,
    purchaseOrderId: string,
    ref: { orderDigest: string; quoteId: string; pinnedVersion: string },
    head: { headDigest: string; headSequence: string; state: string; supplierEpoch: string },
    fields: StatusUpdateFields,
  ): CommerceOrderStatus | { error: string } {
    const nowMs = this.deps.now();
    const status = this.buildStatus(
      buyerDid,
      purchaseOrderId,
      {
        sequence: (BigInt(head.headSequence) + 1n).toString(10),
        previous_status_digest: head.headDigest,
        state: fields.state,
        supplier_epoch: this.deps.currentEpoch(),
        updated_at: isoNow(nowMs),
      },
      ref.pinnedVersion,
    );
    // Fail-closed predecessor load, same contract as the public path: the
    // chain refuses to advance against a record it cannot verify. Cancellation
    // transitions carry no line snapshot, so line verification is a no-op.
    const loadedPrevious = this.loadHeadStatus(
      buyerDid,
      purchaseOrderId,
      head.headDigest,
      'previous head',
    );
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
  finalizePendingCancellationInTx(
    authenticatedBuyerDid: string,
    purchaseOrderId: string,
    cancellationId: string,
    result: Exclude<CancellationResultKind, 'pending_review'>,
  ): CancellationResult | { error: string } {
    let outcome: CancellationResult | { error: string } = { error: NON_DISCLOSING_ERROR };
    ((): void => {
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
      const request = {
        protocol_version: recorded.protocol_version,
        cancellation_id: cancellationId,
        purchase_order_id: purchaseOrderId,
        order_digest: ref.orderDigest,
      } as unknown as CancellationRequest;

      // A LOSING finalization decides nothing. The external effect happened,
      // so the order is still live and still owed a real decision through the
      // ordinary path; all this records is that the cancellation did not win.
      if (result !== 'cancelled') {
        outcome = this.recordResult(
          request,
          result,
          undefined,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }

      // A WINNING finalization must do the work the live path does, and a
      // review can be parked in TWO different places, so there are two.
      //
      // It used to do neither: it recorded a terminal `cancelled` and stopped.
      // Nothing was decided, no capacity was refunded, no chain moved, and
      // the digest the protocol REQUIRES `cancelled` to carry arrived as an
      // optional caller parameter — so an omitted one produced a record the
      // buyer must reject, and a wrong one bound the ruling to a head this
      // engine never ruled on. Either way it was durable and terminal, so
      // idempotency replayed it forever and the review could not reopen. A
      // caller cannot supply a fact it does not own; the parameter is gone.
      const finalizeChain = this.deps.chains.load(authenticatedBuyerDid, purchaseOrderId);

      // PARKED BEFORE GENESIS — `reserved` with an external effect in flight
      // (§12.8 race arm 1). Winning means what winning meant there: decide
      // the order, refund the hold, sign the `cancellation_won` genesis.
      if (!finalizeChain.exists) {
        const acknowledgement = this.buildCancellationAcknowledgement(
          authenticatedBuyerDid,
          purchaseOrderId,
          ref,
          nowMs,
        );
        if (acknowledgement === null) {
          outcome = { error: NON_DISCLOSING_ERROR };
          return;
        }
        // `requirePreEffect: false`, unlike the race arm. That guard stops an
        // AUTOMATIC path deciding an order whose external effect may have
        // happened; here it demonstrably did, and the review closed because
        // someone established what it did. Keeping the guard would make a
        // parked review impossible to close in the one direction it was
        // parked to allow.
        const won = this.settleCancellationWin(
          authenticatedBuyerDid,
          purchaseOrderId,
          ref,
          acknowledgement,
          nowMs,
          false,
        );
        if ('error' in won) {
          outcome = won;
          return;
        }
        outcome = this.recordResult(
          request,
          'cancelled',
          won.genesisDigest,
          authenticatedBuyerDid,
          ref.quoteId,
          nowMs,
          ref.pinnedVersion,
        );
        return;
      }

      // PARKED AFTER GENESIS — the order was accepted and supplier policy
      // asked for a review. Winning means the chain transitions to
      // `cancelled`, exactly as the policy verdict does on the live path, and
      // the result is bound to the head it ruled on.
      const ruledOn = finalizeChain.head;
      const transition = this.signStatusUpdateRecord(
        authenticatedBuyerDid,
        purchaseOrderId,
        ref,
        ruledOn,
        { state: 'cancelled' },
      );
      if ('error' in transition) {
        outcome = transition;
        return;
      }
      outcome = this.recordResult(
        request,
        'cancelled',
        ruledOn.headDigest,
        authenticatedBuyerDid,
        ref.quoteId,
        nowMs,
        ref.pinnedVersion,
      );
    })();
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
    // There used to be a `pinnedVersion === '' -> true` escape hatch here for
    // "legacy rows carry no pin". Two things were wrong with it. Such a row
    // cannot exist — `pinned_version` is NOT NULL with no default, and the
    // only writer stores the order's own validated `protocol_version`, so
    // nothing in the schema or the code can produce an empty pin. And if one
    // ever did appear, the hatch opened the WRONG way: it disabled §9.13
    // version pinning for exactly the row whose version nobody knows, and
    // sent an empty `protocol_version` into every record built from it.
    // Comparing unconditionally means an unknown pin refuses instead.
    return protocolVersion === pinnedVersion;
  }

  /**
   * §12.5 — which cancellations on this order are waiting on a person.
   *
   * WHY A SCAN AND NOT AN INDEX. A `pending_review` result is written into
   * the receipt store, which is the record of what this node signed; a second
   * table listing them would be a projection that can disagree with the
   * evidence. The scan is bounded to ONE order and its callers already hold
   * the short list of unresolved orders, so the cost is a handful of rows on
   * a screen an operator opened deliberately.
   *
   * EXCLUDES ANY CANCELLATION THAT HAS SINCE BEEN DECIDED, by asking
   * `findRecordedCancellation` rather than by reading the parking record
   * alone. Both records survive — the parking one is never overwritten — so
   * reading only for `pending_review` would keep offering a decision that has
   * already been made.
   */
  listPendingReviewCancellationsInTx(
    buyerDid: string,
    purchaseOrderId: string,
  ): CancellationResult[] {
    const seen = new Set<string>();
    const pending: CancellationResult[] = [];
    for (const receipt of this.deps.receipts.listByOrder(buyerDid, purchaseOrderId)) {
      if (receipt.domain !== 'result') continue;
      // An unreadable row is a row that matches nothing, exactly as the
      // lookup below treats it. One corrupt receipt must not hide every
      // other cancellation on this order.
      const result = parseResultReceipt(receipt.recordJson);
      if (result === null) continue;
      if (seen.has(result.cancellation_id)) continue;
      seen.add(result.cancellation_id);
      const current = this.findRecordedCancellation(
        buyerDid,
        purchaseOrderId,
        result.cancellation_id,
      );
      if (current !== null && current.result === 'pending_review') pending.push(current);
    }
    return pending;
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
      // WS-2.2 — a corrupt result receipt used to THROW out of the
      // cancellation path. One unreadable row must not make every OTHER
      // cancellation for this order unanswerable, so it is skipped: the scan
      // is looking for a specific `cancellation_id` and a row it cannot read
      // is a row it cannot match.
      const result = parseResultReceipt(receipt.recordJson);
      if (result === null) continue;
      if (result.cancellation_id !== cancellationId) continue;
      if (result.result !== 'pending_review') return result;
      pending = result;
    }
    return pending;
  }

  /**
   * The acknowledgement a won cancellation produces (§9.9 `rejected` with
   * `cancelled_by_buyer`). Built in one place because two paths need the
   * identical record — the race arm and the finalization of a parked review.
   */
  private buildCancellationAcknowledgement(
    buyerDid: string,
    purchaseOrderId: string,
    ref: { orderDigest: string; pinnedVersion: string },
    nowMs: number,
  ): OrderAcknowledgement | null {
    // Annotated for the reason `buildStatus` is: an unannotated literal is
    // not excess-property checked, and the `as OrderAcknowledgement` below
    // used to accept whatever came out of it. Both acknowledgement builders
    // shipped a camelCase key this way.
    //
    // EXTRACTED TO THE VARIANT, not `Omit` over the union. The type is
    // discriminated, and `Omit` distributes across it by keeping only the
    // fields every member shares — so `reason_code` would vanish and this
    // literal would be checked against the wrong shape. This builder always
    // emits a rejection, so it says so.
    const draft: Omit<
      Extract<OrderAcknowledgement, { kind: 'rejected' }>,
      'acknowledgement_digest'
    > = {
      protocol_version: ref.pinnedVersion,
      // SAME bounded helper as the admission path. This construction site
      // kept `ack:${purchase_order_id}` after the first was fixed: a legal
      // 128-character order id produced a 132-character acknowledgement id
      // that validateId rejects — and the path has ALREADY refunded the hold
      // and signed the cancellation_won genesis by the time it answers, so
      // the buyer is left holding a record it must refuse against an order
      // Core considers closed.
      acknowledgement_id: `ack:${ackIdSuffix(purchaseOrderId)}`,
      purchase_order_id: purchaseOrderId,
      order_digest: ref.orderDigest,
      buyer_did: buyerDid,
      supplier_did: this.deps.supplierDid(),
      issued_at: isoNow(nowMs),
      kind: 'rejected' as const,
      reason_code: 'cancelled_by_buyer',
    };
    const acknowledgement: OrderAcknowledgement = {
      ...draft,
      acknowledgement_digest: commerceRecordDigest(
        'acknowledgement',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    };
    return validateOrderAcknowledgement(acknowledgement, hash) === null ? acknowledgement : null;
  }

  /**
   * Everything a WON cancellation must do, in one place: decide the order,
   * refund the hold, retain the acknowledgement, and sign the
   * `cancellation_won` genesis (§9.11, §12.8).
   *
   * WHY THIS IS EXTRACTED. Two paths reach the same outcome — the race arm,
   * where the cancellation beats a pre-effect reservation, and the
   * finalization of a review that was parked because the effect had started.
   * The second used to record a terminal `cancelled` and do NONE of this: the
   * order stayed `reserved` for good, the quote capacity stayed held for
   * good, no genesis was ever signed, and the buyer was told the order was
   * cancelled. Duplicating sixty lines to fix that would have set up the next
   * divergence, so there is now one implementation and two callers.
   *
   * `requirePreEffect` is the ONLY difference between them, and it is a real
   * one: the race arm must refuse to decide an order whose external effect
   * may already have happened, while finalization exists precisely because a
   * human established what that effect did.
   */
  private settleCancellationWin(
    buyerDid: string,
    purchaseOrderId: string,
    ref: {
      orderDigest: string;
      quoteId: string;
      pinnedVersion: string;
      admittedEpoch: string;
      reconciliationRequired: boolean;
    },
    acknowledgement: OrderAcknowledgement,
    nowMs: number,
    requirePreEffect: boolean,
  ): { genesisDigest: string } | { error: string } {
    const order = this.deps.orders.load(buyerDid, purchaseOrderId);
    const decided =
      order !== null &&
      order.decide({
        acknowledgementJson: JSON.stringify(acknowledgement),
        decidedAt: nowMs,
        requirePreEffect,
      }).ok;
    if (!decided) {
      // Lost the race to a concurrent decision inside another tx.
      return { error: 'cancellation: decision race lost — retry reconcile' };
    }
    // Throws on a failed CAS: the cancellation has already won the decision
    // race above, so a hold that will not refund means the order refs and the
    // quote ledger disagree. Rolling back beats committing a cancellation
    // whose capacity stays held.
    const family = this.deps.families.load(ref.quoteId);
    if (family === null) {
      throw new CommerceIntegrityError(
        `cancelled order references a missing quote family ${ref.quoteId}`,
      );
    }
    family.settle(purchaseOrderId, 'refunded');
    this.deps.receipts.put({
      recordDigest: acknowledgement.acknowledgement_digest,
      domain: 'acknowledgement',
      buyerDid,
      quoteId: ref.quoteId,
      purchaseOrderId,
      recordJson: JSON.stringify(acknowledgement),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
    const genesis = this.signGenesisRecord(
      buyerDid,
      purchaseOrderId,
      'cancellation_won',
      ref.quoteId,
      ref,
      nowMs,
    );
    return 'error' in genesis ? genesis : { genesisDigest: genesis.status_digest };
  }

  private recordResult(
    cancellation: CancellationRequest,
    kind: CancellationResultKind,
    statusDigestAtResolution: string | undefined,
    buyerDid: string,
    quoteId: string,
    nowMs: number,
    pinnedVersion: string,
  ): CancellationResult | { error: string } {
    const draft: Omit<CancellationResult, 'result_digest'> = {
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
    const result: CancellationResult = {
      ...draft,
      result_digest: commerceRecordDigest(
        'result',
        draft as unknown as Record<string, unknown>,
        hash,
      ),
    };
    // VALIDATE BEFORE THE WRITE, and refuse rather than record.
    //
    // This function used to write whatever it was handed. That mattered
    // because `cancelled` is the one kind the protocol requires to carry the
    // head it ruled on, and a caller could reach here without one: the
    // resulting record fails the buyer's `validateCancellationResult`, so the
    // buyer must reject it — and because it is now the RECORDED terminal
    // result, idempotency replays it forever and finalization refuses to
    // reopen a review that is no longer `pending_review`. One missing field
    // ended the conversation permanently.
    //
    // Refusing leaves the review parked, which is recoverable. That asymmetry
    // is the whole argument for checking here rather than trusting callers.
    //
    // NO CURRENT INPUT REACHES THE REFUSAL, and deleting this check kills no
    // test — a mutation confirmed that. Said plainly rather than left to look
    // like an active guard: now that both `cancelled` paths derive the digest
    // from a head they just wrote, every field is constructed rather than
    // passed in, so there is nothing left to be wrong. It stays because the
    // bug it answers was a CALLER supplying a field it did not own, and the
    // next kind added to `CancellationResultKind` with its own field
    // requirement is the same mistake waiting to be made in a function that
    // writes durable, terminal, unreopenable evidence.
    const invalid = validateCancellationResult(result, hash);
    if (invalid !== null) {
      return { error: `cancellation: refusing to record an invalid result — ${invalid}` };
    }
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
