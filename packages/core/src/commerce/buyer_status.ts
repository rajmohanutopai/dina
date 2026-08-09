/**
 * The BUYER's copy of the supplier's signed status chain (§9.11, §16.2).
 *
 * WHY THIS EXISTS. §9.11 ends on a sentence the implementation had not
 * answered: "Receiver-side chain checks remain fork DETECTION for a
 * misbehaving supplier." Supplier-side CAS stops a CONFORMING supplier from
 * emitting two successors of one head — it is a correctness aid for the honest
 * party and no defence at all against the dishonest one, because the party
 * running the CAS is the party you are worried about. The buyer's own check is
 * the whole of the protection, and it was missing: `verifyStatusSuccession`
 * and `verifyRestoreFence` were written, tested, and called by nothing.
 *
 * A supplier could therefore tell one buyer `dispatched` and another
 * `cancelled` for the same order, roll a chain backwards, or re-point it at a
 * different purchase order, and every one of those would be recorded as
 * ordinary progress.
 *
 * IT KEEPS THE WHOLE CHAIN, not the head. §16.2 lets a restored supplier fence
 * a chain by naming a strict ANCESTOR of the buyer's head — the signatures
 * after the backup are gone, so the head itself may be unreachable to them.
 * Deciding whether a named predecessor is an ancestor needs the records
 * between, so a head-only store would have to either refuse every fence
 * (stranding an honestly restored supplier) or accept any (handing a forger
 * the takeover).
 *
 * A FORK NEVER MOVES THE HEAD. When a record fails succession the chain stays
 * exactly where it was and the fault is written to the buyer's order record —
 * the field that already exists for "this is not something the node can stand
 * behind". Recording the contradiction and keeping the last verified state is
 * the only honest pair: dropping it silently loses the evidence, and applying
 * it would let the contradiction win.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  validateCommerceOrderStatus,
  validateGenesisStatus,
  verifyRestoreFence,
  verifyStatusSuccession,
  type CommerceOrderStatus,
  type GenesisEvent,
  type PurchaseOrderLine,
  type RetainedEnvelope,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { rehydrateEnvelopeEvidence, rehydrateOrderStatus } from './rehydrate';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * The verified transport envelope a record arrived in (§12.7, §16.2).
 *
 * The WHOLE message, not just its id and signature. A signature is
 * checkable only against the bytes it was made over, and those bytes are
 * the message's deterministic serialization — so a buyer that keeps the
 * signature and discards the message keeps something no supplier can
 * ever verify. Retaining the envelope is what turns held evidence from a
 * claim into proof.
 */
export interface EnvelopeEvidence {
  envelopeId: string;
  /** Hex Ed25519 over the D2D envelope, verified before it reached here. */
  signature: string;
  /** The signed message, field-for-field as the signature covered it. */
  envelope: RetainedEnvelope;
}

export interface HeldStatusEvidence {
  record: CommerceOrderStatus;
  evidence: EnvelopeEvidence;
}

/** What the in-memory double keeps: a record that may have no envelope yet. */
interface StoredStatusRow {
  record: CommerceOrderStatus;
  evidence: EnvelopeEvidence | null;
}

export interface BuyerStatusRepository {
  /** Every accepted record for one order, oldest first. */
  chain(supplierDid: string, purchaseOrderId: string): CommerceOrderStatus[];
  /**
   * Record an accepted status. Returns false when this sequence is already
   * taken — the primary key IS the compare-and-swap, so a second successor of
   * one head loses here rather than overwriting the first.
   */
  append(args: {
    supplierDid: string;
    purchaseOrderId: string;
    status: CommerceOrderStatus;
    /** §12.7 — the verified envelope that delivered it, when there was one. */
    evidence?: EnvelopeEvidence;
    acceptedAt: number;
  }): boolean;
  /**
   * Every accepted record WITH the envelope that delivered it (§12.7).
   *
   * Separate from `chain` because the chain is the yardstick succession runs
   * against and must stay a list of records; this is the evidence view, and a
   * record with no envelope is simply absent from it — a buyer cannot present
   * what it cannot attribute.
   */
  evidenceChain(supplierDid: string, purchaseOrderId: string): HeldStatusEvidence[];
  /**
   * §16.2 takeover: drop everything after `keepThroughSequence` and append the
   * fence, atomically. Two steps that can interleave would leave the chain
   * either truncated with no head or holding both branches.
   */
  takeover(args: {
    supplierDid: string;
    purchaseOrderId: string;
    keepThroughSequence: string;
    fence: CommerceOrderStatus;
    evidence?: EnvelopeEvidence;
    acceptedAt: number;
  }): boolean;
}

function rowToStatus(row: DBRow): CommerceOrderStatus {
  // Re-validated, never cast, and through the ONE module that reads stored
  // commerce records. The row is editable by anything with the database open,
  // and this record is the evidence the succession check runs AGAINST — a
  // tampered head would let the next real status be called a fork, or a forged
  // one be called a successor.
  const rehydrated = rehydrateOrderStatus(String(row.record_json), String(row.status_digest), hash);
  if (!rehydrated.ok) {
    throw new BuyerChainIntegrityError(
      `stored status ${String(row.status_digest)}: ${rehydrated.error}`,
    );
  }
  return rehydrated.value;
}

/** A stored chain that no longer describes itself. Not an ordinary refusal. */
export class BuyerChainIntegrityError extends Error {}

export class SQLiteBuyerStatusRepository implements BuyerStatusRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  chain(supplierDid: string, purchaseOrderId: string): CommerceOrderStatus[] {
    return this.db
      .query(
        `SELECT status_digest, record_json FROM commerce_buyer_status_records
          WHERE supplier_did = ? AND purchase_order_id = ?
          ORDER BY sequence_num`,
        [supplierDid, purchaseOrderId],
      )
      .map(rowToStatus);
  }

  append(args: {
    supplierDid: string;
    purchaseOrderId: string;
    status: CommerceOrderStatus;
    evidence?: EnvelopeEvidence;
    acceptedAt: number;
  }): boolean {
    return this.insert(args) > 0;
  }

  evidenceChain(supplierDid: string, purchaseOrderId: string): HeldStatusEvidence[] {
    return this.db
      .query(
        `SELECT status_digest, record_json, evidence_json FROM commerce_buyer_status_records
          WHERE supplier_did = ? AND purchase_order_id = ? AND evidence_json IS NOT NULL
          ORDER BY sequence_num`,
        [supplierDid, purchaseOrderId],
      )
      .map((row) => ({ record: rowToStatus(row), evidence: rehydrateEnvelopeEvidence(row.evidence_json) }))
      .filter((entry): entry is HeldStatusEvidence => entry.evidence !== null);
  }

  private insert(args: {
    supplierDid: string;
    purchaseOrderId: string;
    status: CommerceOrderStatus;
    evidence?: EnvelopeEvidence;
    acceptedAt: number;
  }): number {
    const { status } = args;
    return this.db.run(
      `INSERT INTO commerce_buyer_status_records
         (supplier_did, purchase_order_id, sequence, sequence_num, status_digest,
          state, record_json, evidence_json, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(supplier_did, purchase_order_id, sequence_num) DO NOTHING`,
      [
        args.supplierDid,
        args.purchaseOrderId,
        status.sequence,
        Number(status.sequence),
        status.status_digest,
        status.state,
        JSON.stringify(status),
        args.evidence === undefined ? null : JSON.stringify(args.evidence),
        args.acceptedAt,
      ],
    );
  }

  takeover(args: {
    supplierDid: string;
    purchaseOrderId: string;
    keepThroughSequence: string;
    fence: CommerceOrderStatus;
    evidence?: EnvelopeEvidence;
    acceptedAt: number;
  }): boolean {
    let ok = false;
    this.db.transaction(() => {
      this.db.run(
        `DELETE FROM commerce_buyer_status_records
          WHERE supplier_did = ? AND purchase_order_id = ? AND sequence_num > ?`,
        [args.supplierDid, args.purchaseOrderId, Number(args.keepThroughSequence)],
      );
      ok =
        this.insert({
          supplierDid: args.supplierDid,
          purchaseOrderId: args.purchaseOrderId,
          status: args.fence,
          ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
          acceptedAt: args.acceptedAt,
        }) > 0;
    });
    return ok;
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryBuyerStatusRepository implements BuyerStatusRepository {
  // `evidence: null` for a record stored WITHOUT a verified envelope, rather
  // than a blank-field sentinel. A sentinel envelope is a fake one, and the
  // whole point of this store is that the difference between real evidence
  // and something shaped like it decides whether a duplicate order is legal.
  private readonly rows = new Map<string, StoredStatusRow[]>();

  private key(supplierDid: string, purchaseOrderId: string): string {
    return `${supplierDid} ${purchaseOrderId}`;
  }

  private held(supplierDid: string, purchaseOrderId: string): StoredStatusRow[] {
    return [...(this.rows.get(this.key(supplierDid, purchaseOrderId)) ?? [])].sort(
      (a, b) => Number(a.record.sequence) - Number(b.record.sequence),
    );
  }

  chain(supplierDid: string, purchaseOrderId: string): CommerceOrderStatus[] {
    return this.held(supplierDid, purchaseOrderId).map((entry) => entry.record);
  }

  evidenceChain(supplierDid: string, purchaseOrderId: string): HeldStatusEvidence[] {
    // Only rows that CARRY an envelope. The double mirrors the SQL, which
    // filters `evidence_json IS NOT NULL`: a record the buyer cannot
    // attribute is not evidence, and a double that returned it anyway would
    // let a test pass on evidence production could never present.
    return this.held(supplierDid, purchaseOrderId).filter(
      (entry): entry is HeldStatusEvidence => entry.evidence !== null,
    );
  }

  append(args: {
    supplierDid: string;
    purchaseOrderId: string;
    status: CommerceOrderStatus;
    evidence?: EnvelopeEvidence;
  }): boolean {
    const k = this.key(args.supplierDid, args.purchaseOrderId);
    const held = this.rows.get(k) ?? [];
    if (held.some((entry) => entry.record.sequence === args.status.sequence)) return false;
    this.rows.set(k, [...held, { record: args.status, evidence: args.evidence ?? null }]);
    return true;
  }

  takeover(args: {
    supplierDid: string;
    purchaseOrderId: string;
    keepThroughSequence: string;
    fence: CommerceOrderStatus;
    evidence?: EnvelopeEvidence;
  }): boolean {
    const k = this.key(args.supplierDid, args.purchaseOrderId);
    const kept = (this.rows.get(k) ?? []).filter(
      (entry) => Number(entry.record.sequence) <= Number(args.keepThroughSequence),
    );
    this.rows.set(k, [...kept, { record: args.fence, evidence: args.evidence ?? null }]);
    return true;
  }
}

/**
 * What happened to an inbound status.
 *
 * `fork` and `unreadable` are deliberately distinct. A record that fails to
 * parse is a broken supplier or a mangled hop; a record that parses and
 * contradicts the chain is a supplier saying two different things about one
 * order, which is the only one of the two that is evidence of anything.
 */
export type BuyerStatusOutcome =
  | 'applied'
  /** Already held at this sequence with this digest. An idempotent repeat. */
  | 'duplicate'
  | 'unreadable'
  /** The record names another order, buyer, or supplier than the one asked. */
  | 'not_our_order'
  /** No buyer order record, so nothing to hang a chain on. */
  | 'unknown_order'
  /** The order exists but the buyer never kept its lines, so §9.11's
   *  cumulative check cannot run. Refused rather than skipped. */
  | 'undescribable'
  /** Contradicts the held chain. Head unchanged; the reason is recorded. */
  | 'fork';

export interface BuyerStatusIngest {
  outcome: BuyerStatusOutcome;
  /** Present on `fork` and `unreadable`: why, in protocol terms. */
  detail?: string;
  /** The chain's state after this record; unchanged on any refusal. */
  state?: string;
}

/**
 * Verify one inbound status against what the buyer already holds, and record
 * it only if it survives.
 *
 * `supplierDid` is the TRANSPORT-authenticated sender. The record's own
 * `supplier_did` is checked against it rather than trusted, because a field
 * inside a body a counterparty wrote cannot establish who wrote it.
 */
export function verifyInboundStatus(args: {
  supplierDid: string;
  purchaseOrderId: string;
  /** The buyer's own record of the order, for binding and lines. */
  order: {
    buyerDid: string;
    supplierDid: string;
    lines: readonly PurchaseOrderLine[] | null;
    /** The resolving event, from the acknowledgement the buyer holds. */
    genesisEvent: GenesisEvent | null;
  };
  status: unknown;
  /** §12.7 — the verified envelope that delivered it, when there was one. */
  evidence?: EnvelopeEvidence;
  repository: BuyerStatusRepository;
  nowMs: number;
}): BuyerStatusIngest {
  const structural = validateCommerceOrderStatus(args.status, hash);
  if (structural !== null) return { outcome: 'unreadable', detail: structural };
  const status = args.status as CommerceOrderStatus;

  // BINDING FIRST, before any chain reasoning. A record that belongs to
  // another conversation must never reach a succession check: the checks
  // compare against the held head, and a mismatch there reads as a fork by
  // this supplier rather than as an answer about somebody else's order.
  if (status.supplier_did !== args.supplierDid) {
    return { outcome: 'not_our_order', detail: 'status.supplier_did is not the authenticated sender' };
  }
  if (status.purchase_order_id !== args.purchaseOrderId) {
    return { outcome: 'not_our_order', detail: 'status.purchase_order_id is not the order asked about' };
  }
  if (status.buyer_did !== args.order.buyerDid) {
    return { outcome: 'not_our_order', detail: 'status.buyer_did is not this node' };
  }
  if (args.order.supplierDid !== '' && status.supplier_did !== args.order.supplierDid) {
    return { outcome: 'not_our_order', detail: 'status is signed by a supplier this order did not name' };
  }

  // §9.11's lines rule is CUMULATIVE against the order. Without the order's
  // lines the check cannot run, and running it against an empty list would
  // reject every status that carries lines — turning ordinary dispatch into a
  // fork. Refusing is the only reading that does not manufacture evidence.
  if (args.order.lines === null) {
    return {
      outcome: 'undescribable',
      detail: 'this order kept no lines, so a cumulative fulfilment check cannot run (§9.11)',
    };
  }
  const lines = args.order.lines;

  const held = args.repository.chain(args.supplierDid, args.purchaseOrderId);
  const nowIso = new Date(args.nowMs).toISOString();

  if (held.length === 0) {
    if (status.restore_fence === true) {
      // §16.2 is explicit: a fence names a predecessor in the HELD chain. With
      // nothing held there is nothing to fence, and accepting one would let a
      // supplier open a chain at any sequence it liked.
      return { outcome: 'fork', detail: 'fence: no held chain to fence against' };
    }
    if (args.order.genesisEvent === null) {
      return {
        outcome: 'undescribable',
        detail: 'no acknowledgement held, so the genesis state cannot be checked (§9.11)',
      };
    }
    const genesisError = validateGenesisStatus(status, args.order.genesisEvent);
    if (genesisError !== null) return { outcome: 'fork', detail: genesisError };
    const applied = args.repository.append({
      supplierDid: args.supplierDid,
      purchaseOrderId: args.purchaseOrderId,
      status,
      ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
      acceptedAt: args.nowMs,
    });
    // Lost to a concurrent ingest of the same genesis. Ordinary, not a fork —
    // re-read and answer as the duplicate it is.
    return applied
      ? { outcome: 'applied', state: status.state }
      : duplicateOrFork(args.repository, args.supplierDid, args.purchaseOrderId, status);
  }

  const head = held.at(-1);
  if (head === undefined) {
    throw new BuyerChainIntegrityError('status chain reported rows and returned none');
  }
  if (status.status_digest === head.status_digest) {
    return { outcome: 'duplicate', state: head.state };
  }

  if (status.restore_fence === true) {
    const verdict = verifyRestoreFence(status, held, lines, hash, nowIso);
    if (verdict !== 'head' && verdict !== 'ancestor') {
      return { outcome: 'fork', detail: verdict };
    }
    // A fence naming the head extends it; one naming an ancestor TAKES OVER,
    // discarding the records after it. Both go through the same call because
    // the difference is only which sequence survives.
    const keepThrough =
      status.previous_status_digest === undefined
        ? '-1'
        : (held.find((entry) => entry.status_digest === status.previous_status_digest)?.sequence ??
          '-1');
    const ok = args.repository.takeover({
      supplierDid: args.supplierDid,
      purchaseOrderId: args.purchaseOrderId,
      keepThroughSequence: keepThrough,
      fence: status,
      ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
      acceptedAt: args.nowMs,
    });
    return ok
      ? { outcome: 'applied', state: status.state }
      : duplicateOrFork(args.repository, args.supplierDid, args.purchaseOrderId, status);
  }

  const succession = verifyStatusSuccession(head, status, lines, nowIso);
  if (succession !== null) return { outcome: 'fork', detail: succession, state: head.state };

  const applied = args.repository.append({
    supplierDid: args.supplierDid,
    purchaseOrderId: args.purchaseOrderId,
    status,
    acceptedAt: args.nowMs,
  });
  return applied
    ? { outcome: 'applied', state: status.state }
    : duplicateOrFork(args.repository, args.supplierDid, args.purchaseOrderId, status);
}

/**
 * An append that lost its insert. Either the same record arrived twice, or the
 * supplier emitted a SECOND successor at that sequence — and those are exactly
 * the two cases §9.11 says a receiver must tell apart ("duplicate sequence with
 * different digest" is a rejection, a duplicate record is not).
 */
function duplicateOrFork(
  repository: BuyerStatusRepository,
  supplierDid: string,
  purchaseOrderId: string,
  status: CommerceOrderStatus,
): BuyerStatusIngest {
  const reread = repository.chain(supplierDid, purchaseOrderId);
  const atSequence = reread.find((entry) => entry.sequence === status.sequence);
  if (atSequence !== undefined && atSequence.status_digest === status.status_digest) {
    return { outcome: 'duplicate', state: atSequence.state };
  }
  return {
    outcome: 'fork',
    detail: `status: sequence ${status.sequence} is already held with a different digest — supplier fork (§9.11)`,
    ...(reread.at(-1) === undefined ? {} : { state: String(reread.at(-1)?.state) }),
  };
}

/**
 * ASKING for a status, over the one outbound lane every other commerce
 * capability uses (§11.2a).
 *
 * A dedicated transport would be a second thing to keep in step with the four
 * egress gates, signing and MsgBox — and the copy that fell behind would be
 * the one nobody looked at. The same argument the reconcile sender records,
 * for the same reason.
 *
 * THE ANSWER DOES NOT COME BACK HERE. It arrives later on the response lane
 * and lands in `verifyInboundStatus`, so this reports only whether the
 * question left the node. Reporting an outcome would be inventing one.
 */
export interface StatusAskResult {
  sent: boolean;
}

export function makeServiceQueryStatusAsk(deps: {
  dispatch: (args: {
    toDid: string;
    body: {
      query_id: string;
      capability: string;
      params: Record<string, unknown>;
      ttl_seconds: number;
      service_uri: string;
    };
  }) => Promise<{ sent: boolean; deniedAt?: string; error?: string }>;
  ttlSeconds?: number;
}): (args: {
  supplierDid: string;
  serviceRkey: string;
  purchaseOrderId: string;
  /** Where this buyer's verified chain ends; absent means "from the start". */
  sinceSequence?: string;
}) => Promise<StatusAskResult> {
  return async ({ supplierDid, serviceRkey, purchaseOrderId, sinceSequence }) => {
    const result = await deps.dispatch({
      toDid: supplierDid,
      body: {
        // The purchase order id IS the correlation id, as it is on every other
        // lane: the response bridge reads `query_id` back as the order, so two
        // questions about one order must not look like two conversations.
        query_id: purchaseOrderId,
        capability: 'order_status',
        // §9.11 — stating where the chain ends is what makes the answer
        // CHECKABLE. Without it the supplier sends everything it has, which
        // is correct but wasteful; with a wrong value it sends too little and
        // the buyer cannot link what arrives.
        params: {
          purchase_order_id: purchaseOrderId,
          ...(sinceSequence === undefined ? {} : { since_sequence: sinceSequence }),
        },
        ttl_seconds: deps.ttlSeconds ?? 300,
        // A supplier may run commerce on a non-default listing, and a query
        // with no service_uri is checked against the default one.
        service_uri: `at://${supplierDid}/com.dinakernel.service.profile/${serviceRkey}`,
      },
    });
    // A gate refusal is the one case where nothing crossed the boundary and we
    // can say so. A throw propagates to the caller, which parks rather than
    // claiming the question was never asked.
    return { sent: result.deniedAt === undefined && result.sent };
  };
}
