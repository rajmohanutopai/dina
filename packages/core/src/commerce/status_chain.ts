/**
 * StatusChain — the supplier-side order status chain aggregate (§9.11, §16.2).
 *
 * WHY THIS EXISTS. The restore prerequisite ("a chain that predates a restore
 * must be FENCED before it moves") escaped three times in one working day:
 * first it was missing from `signStatusUpdate`; then, once added there, it was
 * missing from `signStatusUpdateInTx`, which cancellation reaches directly;
 * then, once shared as a predicate, it turned out it could not express chain
 * CREATION at all — the predicate takes a head epoch, and at genesis there is
 * no head. A rule that every caller must remember to invoke is a rule that
 * will be missed by whichever caller is written next.
 *
 * So the chain now decides. Nothing outside this file may create, advance or
 * fence a status chain, and each of those three operations carries its own
 * restore prerequisite:
 *
 *   - CREATE  refuses when the ORDER was admitted before the current epoch.
 *             At genesis there is no head to ask, so the order reference is
 *             the only durable record of which generation it belongs to.
 *   - ADVANCE refuses when the HEAD predates the current epoch.
 *   - FENCE   is the sanctioned exception: it REQUIRES a strictly higher
 *             epoch, because fencing is how a restored chain rejoins.
 *
 * The genesis case is the one worth stating plainly, because "there is no head
 * yet, so nothing can be damaged" is exactly the reasoning that let it through.
 * The state that matters after a restore is the BUYER's copy, not the local
 * row. A restored supplier whose head row was lost will happily sign a second,
 * different sequence-0 record; the buyer then holds two genesis records for one
 * order and rejects the new one as a fork. The fence cannot repair that — it is
 * unavailable before a genesis exists, and blocked afterwards by the
 * same-sequence fork check. Local absence is the restore symptom, never proof
 * of safety.
 *
 * BOUNDARIES. The aggregate does not sign. The engine builds and digests a
 * candidate record (it owns the supplier identity and the digest domains); the
 * chain decides whether that candidate may become the head and performs the
 * CAS. Business outcomes are typed refusals; impossible state throws
 * CommerceIntegrityError so the surrounding transaction rolls back.
 */

import {
  LEGAL_TRANSITIONS,
  type CommerceOrderStatus,
  type OrderState,
} from '@dina/commerce-protocol';

import { CommerceIntegrityError } from './quote_family';

import type { CommerceStatusHead, CommerceStatusHeadRepository } from './status_heads';

/** Ordinary outcomes. Each maps to an operator- or wire-facing reason. */
export type ChainRefusal =
  | 'no_chain'
  | 'chain_exists'
  | 'order_predates_restore'
  | 'order_awaiting_reconciliation'
  /**
   * §9.11/§16.2 — the buyer proved it holds a chain this node lost, so a
   * fresh genesis would fork against a record it already has. The restore
   * fence is the way forward; a new chain never is.
   */
  | 'chain_evidence_requires_fence'
  | 'chain_predates_restore'
  | 'illegal_transition'
  | 'lines_violation'
  | 'fence_needs_higher_epoch'
  /** Two presented receipts sit at the same sequence with different digests. */
  | 'evidence_forks'
  /** The presented receipts do not form one unbroken chain from the head. */
  | 'evidence_not_contiguous'
  | 'cas_lost';

export type ChainOutcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; refusal: ChainRefusal; detail?: string };

const refuse = (refusal: ChainRefusal, detail?: string): ChainOutcome<never> =>
  detail === undefined ? { ok: false, refusal } : { ok: false, refusal, detail };
const allow = <T>(value: T): ChainOutcome<T> => ({ ok: true, value });

/**
 * Choose the fence predecessor from buyer-presented receipts, and prove the
 * choice is one the local chain can actually stand on (§16.2, §9.11).
 *
 * WHAT WAS MISSING. The selection was `reduce` to the highest sequence, plus
 * two checks against the local head (no rollback, no same-height fork). That
 * leaves two ways to fence onto evidence the chain cannot support:
 *
 *   1. A GAP. A buyer presenting the head's successor and then a receipt six
 *      sequences later fast-forwards the supplier past records nobody showed
 *      it. Each status names its predecessor precisely so the chain has no
 *      gaps; jumping one throws that away at the moment it matters most.
 *   2. A FORK AMONG THE EVIDENCE ITSELF. Two authentic receipts at the same
 *      top sequence with different digests mean the supplier signed twice at
 *      one height. `reduce` silently kept whichever came first in the array —
 *      the buyer chose, by ordering.
 *
 * Both are refusals, not repairs: which branch is real is exactly what this
 * node lost and cannot rederive.
 *
 * ROOTED BY DIGEST, not by requiring the head record itself. A buyer that
 * presents only the records ABOVE our head is being economical, not
 * dishonest; what matters is that the lowest presented successor names our
 * head as its predecessor.
 *
 * PURE, and here rather than in the engine, because it is a chain rule.
 * Signature verification stays with the caller — this function assumes every
 * receipt it is given has already been proven authentic, and its own job is
 * only whether they line up.
 */
export function selectFencePredecessor(
  head: { headSequence: string; headDigest: string },
  verified: readonly CommerceOrderStatus[],
): ChainOutcome<CommerceOrderStatus> {
  const headSeq = BigInt(head.headSequence);
  // One record per sequence, and a disagreement at any height is a fork.
  // Checked across the WHOLE presented set rather than only the top, so a
  // buyer cannot bury a contradiction under a taller receipt.
  const bySequence = new Map<string, CommerceOrderStatus>();
  for (const record of verified) {
    const existing = bySequence.get(record.sequence);
    if (existing !== undefined) {
      if (existing.status_digest !== record.status_digest) {
        return refuse(
          'evidence_forks',
          `two different records presented at sequence ${record.sequence}`,
        );
      }
      continue;
    }
    bySequence.set(record.sequence, record);
  }

  const ascending = [...bySequence.values()].sort((a, b) =>
    BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0,
  );
  const predecessor = ascending.at(-1);
  if (predecessor === undefined) {
    return refuse('evidence_not_contiguous', 'no receipts presented');
  }
  // At or below the head: the caller's rollback and same-height rules own
  // this, and re-deciding here would put the same rule in two places.
  if (BigInt(predecessor.sequence) <= headSeq) return allow(predecessor);

  // Walk head+1 .. predecessor. Every step must be present and must name the
  // step before it.
  let previousDigest = head.headDigest;
  for (let seq = headSeq + 1n; seq <= BigInt(predecessor.sequence); seq += 1n) {
    const record = bySequence.get(seq.toString(10));
    if (record === undefined) {
      return refuse(
        'evidence_not_contiguous',
        `no receipt presented for sequence ${seq.toString(10)}`,
      );
    }
    if (record.previous_status_digest !== previousDigest) {
      return refuse(
        'evidence_not_contiguous',
        `sequence ${record.sequence} does not name the record before it`,
      );
    }
    previousDigest = record.status_digest;
  }
  return allow(predecessor);
}

export interface StatusChainDeps {
  heads: CommerceStatusHeadRepository;
  /** Core's current commerce epoch (§16.2). */
  currentEpoch: () => string;
  now: () => number;
}

/**
 * An instance is a SNAPSHOT of the head row (or its absence), valid for the
 * transaction that loaded it. Reload after any operation that moves the head.
 */
export class StatusChain {
  private constructor(
    private readonly headRow: CommerceStatusHead | null,
    private readonly buyerDid: string,
    private readonly purchaseOrderId: string,
    private readonly deps: StatusChainDeps,
  ) {}

  static load(deps: StatusChainDeps, buyerDid: string, purchaseOrderId: string): StatusChain {
    return new StatusChain(
      deps.heads.get(buyerDid, purchaseOrderId),
      buyerDid,
      purchaseOrderId,
      deps,
    );
  }

  get exists(): boolean {
    return this.headRow !== null;
  }

  /** The current head. Reading it when the chain has none is a caller bug. */
  get head(): CommerceStatusHead {
    if (this.headRow === null) {
      throw new CommerceIntegrityError(
        `status chain read with no head for ${this.purchaseOrderId}`,
      );
    }
    return this.headRow;
  }

  /**
   * Start the chain. `orderAdmittedEpoch` comes from the order reference —
   * the only durable record of which generation the order belongs to, and
   * therefore the only thing that can answer the restore question before a
   * head exists.
   */
  createGenesis(
    candidate: CommerceOrderStatus,
    order: {
      admittedEpoch: string;
      reconciliationRequired: boolean;
      readoptedChainEvidence: boolean;
    },
  ): ChainOutcome<CommerceOrderStatus> {
    if (this.headRow !== null) return refuse('chain_exists');
    // BEFORE the reconciliation bar, because this one never lifts. The
    // ceremony clears `reconciliationRequired`; nothing clears this. An order
    // whose buyer holds a chain cannot be given a genesis at all — the only
    // legal next record is a fence over the evidence that buyer presented.
    if (order.readoptedChainEvidence) return refuse('chain_evidence_requires_fence');
    // Two distinct bars, because they are two distinct facts. An order may
    // belong to an older generation (epoch), or it may be one this node
    // rebuilt from a counterparty's evidence and cannot fully describe
    // (flag). Only the second survives at epoch 1, where there is no lower
    // epoch to encode it with — which is why it is not an epoch sentinel.
    if (order.reconciliationRequired) return refuse('order_awaiting_reconciliation');
    if (BigInt(order.admittedEpoch) < BigInt(this.deps.currentEpoch())) {
      return refuse('order_predates_restore');
    }
    const inserted = this.deps.heads.initGenesis({
      buyerDid: this.buyerDid,
      purchaseOrderId: this.purchaseOrderId,
      headDigest: candidate.status_digest,
      headSequence: '0',
      state: candidate.state,
      supplierEpoch: candidate.supplier_epoch,
      updatedAt: this.deps.now(),
      disputeWindowEndsAt: windowEndsAt(candidate),
    });
    // Lost to a concurrent genesis inside another transaction. An ordinary
    // outcome, not corruption: the other writer's genesis stands.
    return inserted ? allow(candidate) : refuse('chain_exists');
  }

  /**
   * Advance to the next status. `previous` is the record the current head
   * digest names — the caller loads it, fail-closed, because the aggregate
   * does no I/O beyond its own repository. `verifyLines` is the protocol's
   * cumulative-snapshot contract, injected so this file stays free of
   * protocol coupling beyond types.
   */
  advance(
    candidate: CommerceOrderStatus,
    previous: CommerceOrderStatus,
    verifyLines: () => string | null,
  ): ChainOutcome<CommerceOrderStatus> {
    if (this.headRow === null) return refuse('no_chain');
    if (BigInt(this.headRow.supplierEpoch) < BigInt(this.deps.currentEpoch())) {
      return refuse('chain_predates_restore');
    }
    // The head's state came out of a validated record, so it IS an
    // OrderState; the row type widens it to string for storage.
    const from = this.headRow.state as OrderState;
    if (!LEGAL_TRANSITIONS[from]?.includes(candidate.state)) {
      return refuse('illegal_transition', `${from} -> ${candidate.state}`);
    }
    if (candidate.previous_status_digest !== previous.status_digest) {
      throw new CommerceIntegrityError(
        'candidate successor does not name the head it was built from',
      );
    }
    const violation = verifyLines();
    if (violation !== null) return refuse('lines_violation', violation);

    const advanced = this.deps.heads.casAdvance(
      this.buyerDid,
      this.purchaseOrderId,
      this.headRow.headDigest,
      {
        headDigest: candidate.status_digest,
        headSequence: candidate.sequence,
        state: candidate.state,
        supplierEpoch: candidate.supplier_epoch,
        updatedAt: this.deps.now(),
        disputeWindowEndsAt: windowEndsAt(candidate),
      },
    );
    return advanced ? allow(candidate) : refuse('cas_lost');
  }

  /**
   * §16.2 takeover. The ONE operation that requires the chain to predate the
   * current epoch — it is how a restored chain rejoins, so a fence at the
   * same epoch would either be a no-op or a fork.
   */
  fence(candidate: CommerceOrderStatus): ChainOutcome<CommerceOrderStatus> {
    if (this.headRow === null) return refuse('no_chain');
    // Epoch monotonicity for fences is the STORE's documented invariant
    // (`setFence` returns false unless the new epoch is strictly higher, in
    // both implementations). Re-checking it here would duplicate a rule that
    // already has an owner — the same scattering this aggregate exists to
    // end, just pointed one layer down. A mutation proved the duplicate was
    // a no-op: deleting it changed no behaviour, because the store still
    // refused and the refusal still surfaced as fence_needs_higher_epoch.
    const fenced = this.deps.heads.setFence(this.buyerDid, this.purchaseOrderId, {
      headDigest: candidate.status_digest,
      headSequence: candidate.sequence,
      state: candidate.state,
      supplierEpoch: candidate.supplier_epoch,
      updatedAt: this.deps.now(),
      // The SAME derivation the ordinary advance uses. The signed fence already
      // carries the deadline; not copying it here left the stored column stale
      // while the chain moved. The existing delivered-fence test could not see
      // that, because it fenced FROM an already-delivered head — so the old
      // stored value happened to be the right one.
      disputeWindowEndsAt: windowEndsAt(candidate),
    });
    return fenced ? allow(candidate) : refuse('fence_needs_higher_epoch');
  }
}

/**
 * The only production entry point to status-chain state. Handing out chains
 * rather than the repository is what stops a future call site reaching past
 * the rules — `StatusChain.advance()` is worthless if `casAdvance()` stays
 * callable, and `createGenesis()` is worthless if `initGenesis()` does.
 */
export class StatusChainStore {
  constructor(private readonly deps: StatusChainDeps) {}

  load(buyerDid: string, purchaseOrderId: string): StatusChain {
    return StatusChain.load(this.deps, buyerDid, purchaseOrderId);
  }
}

/**
 * The candidate's dispute deadline as epoch ms, or null.
 *
 * DENORMALISED onto the head so terminality can be answered without loading a
 * receipt. `delivered` is the only state §9.11 gives a window, and a head that
 * did not record it was one every caller had to treat as unfinished for ever —
 * which pinned prior manifest CIDs alive and blocked plugin uninstall on
 * orders that had completed perfectly normally.
 */
function windowEndsAt(candidate: CommerceOrderStatus): number | null {
  const iso = candidate.dispute_window_ends_at;
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
