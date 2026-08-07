/**
 * Supplier-side status-chain heads (spec §9.11, §16.2): CAS at
 * signing, mirroring quote heads — a conforming supplier cannot emit
 * two valid successors of one status. Fence advancement (§16.2
 * restore takeover) bypasses the digest CAS but must strictly raise
 * the epoch; the engine (status_engine.ts) enforces the surrounding
 * reconciliation rules.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface CommerceStatusHead {
  buyerDid: string;
  purchaseOrderId: string;
  headDigest: string;
  /** Canonical non-negative integer string ("0" at genesis). */
  headSequence: string;
  state: string;
  supplierEpoch: string;
  updatedAt: number;
}

export interface CommerceStatusHeadRepository {
  get(buyerDid: string, purchaseOrderId: string): CommerceStatusHead | null;

  /**
   * §16.4 — how many chains have NOT reached a terminal state. An uninstall
   * that strands these leaves the buyer unable to learn the outcome of an
   * order this supplier committed to.
   */
  countNonTerminal(terminalStates: readonly string[]): number;
  /** Insert the genesis head (sequence "0"). False when one exists. */
  initGenesis(head: CommerceStatusHead): boolean;
  /** CAS the head forward against the expected digest. */
  casAdvance(
    buyerDid: string,
    purchaseOrderId: string,
    expectedDigest: string,
    next: {
      headDigest: string;
      headSequence: string;
      state: string;
      supplierEpoch: string;
      updatedAt: number;
    },
  ): boolean;
  /**
   * §16.2 fence: replace the head after restore reconciliation. The
   * store guard is epoch-monotonicity (strictly higher than the
   * stored head's epoch); the chain-position rules (predecessor is the
   * buyer's head or a strict ancestor, sequence is predecessor+1, state
   * legality) are enforced by `CommerceLifecycleEngine.signRestoreFence`,
   * which is this method's only production caller.
   */
  setFence(
    buyerDid: string,
    purchaseOrderId: string,
    next: {
      headDigest: string;
      headSequence: string;
      state: string;
      supplierEpoch: string;
      updatedAt: number;
    },
  ): boolean;
}

function rowToHead(row: DBRow): CommerceStatusHead {
  return {
    buyerDid: String(row.buyer_did),
    purchaseOrderId: String(row.purchase_order_id),
    headDigest: String(row.head_digest),
    headSequence: String(row.head_sequence),
    state: String(row.state),
    supplierEpoch: String(row.supplier_epoch),
    updatedAt: Number(row.updated_at),
  };
}

/** Canonical-integer-string comparison via BigInt (never SQL). */
function epochGreater(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

export class SQLiteCommerceStatusHeadRepository implements CommerceStatusHeadRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(buyerDid: string, purchaseOrderId: string): CommerceStatusHead | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_status_heads WHERE buyer_did = ? AND purchase_order_id = ?`,
      [buyerDid, purchaseOrderId],
    );
    return rows[0] ? rowToHead(rows[0]) : null;
  }

  countNonTerminal(terminalStates: readonly string[]): number {
    const placeholders = terminalStates.map(() => '?').join(', ');
    const rows = this.db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM commerce_status_heads WHERE state NOT IN (${placeholders})`,
      [...terminalStates],
    );
    return Number(rows[0]?.c ?? 0);
  }

  initGenesis(head: CommerceStatusHead): boolean {
    const affected = this.db.run(
      `INSERT INTO commerce_status_heads (
         buyer_did, purchase_order_id, head_digest, head_sequence, state,
         supplier_epoch, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(buyer_did, purchase_order_id) DO NOTHING`,
      [
        head.buyerDid,
        head.purchaseOrderId,
        head.headDigest,
        head.headSequence,
        head.state,
        head.supplierEpoch,
        head.updatedAt,
      ],
    );
    return affected > 0;
  }

  casAdvance(
    buyerDid: string,
    purchaseOrderId: string,
    expectedDigest: string,
    next: {
      headDigest: string;
      headSequence: string;
      state: string;
      supplierEpoch: string;
      updatedAt: number;
    },
  ): boolean {
    const affected = this.db.run(
      `UPDATE commerce_status_heads
       SET head_digest = ?, head_sequence = ?, state = ?, supplier_epoch = ?, updated_at = ?
       WHERE buyer_did = ? AND purchase_order_id = ? AND head_digest = ?`,
      [
        next.headDigest,
        next.headSequence,
        next.state,
        next.supplierEpoch,
        next.updatedAt,
        buyerDid,
        purchaseOrderId,
        expectedDigest,
      ],
    );
    return affected > 0;
  }

  setFence(
    buyerDid: string,
    purchaseOrderId: string,
    next: {
      headDigest: string;
      headSequence: string;
      state: string;
      supplierEpoch: string;
      updatedAt: number;
    },
  ): boolean {
    // Epoch monotonicity is checked in JS (canonical integer strings do
    // not compare correctly under SQL text collation for mixed lengths).
    const current = this.get(buyerDid, purchaseOrderId);
    if (!current || !epochGreater(next.supplierEpoch, current.supplierEpoch)) return false;
    const affected = this.db.run(
      `UPDATE commerce_status_heads
       SET head_digest = ?, head_sequence = ?, state = ?, supplier_epoch = ?, updated_at = ?
       WHERE buyer_did = ? AND purchase_order_id = ? AND head_digest = ?`,
      [
        next.headDigest,
        next.headSequence,
        next.state,
        next.supplierEpoch,
        next.updatedAt,
        buyerDid,
        purchaseOrderId,
        current.headDigest,
      ],
    );
    return affected > 0;
  }
}

export class InMemoryCommerceStatusHeadRepository implements CommerceStatusHeadRepository {
  private readonly heads = new Map<string, CommerceStatusHead>();

  private key(buyerDid: string, purchaseOrderId: string): string {
    return `${buyerDid} ${purchaseOrderId}`;
  }

  get(buyerDid: string, purchaseOrderId: string): CommerceStatusHead | null {
    const head = this.heads.get(this.key(buyerDid, purchaseOrderId));
    return head ? { ...head } : null;
  }

  countNonTerminal(terminalStates: readonly string[]): number {
    const terminal = new Set(terminalStates);
    let count = 0;
    for (const head of this.heads.values()) {
      if (!terminal.has(head.state)) count += 1;
    }
    return count;
  }

  initGenesis(head: CommerceStatusHead): boolean {
    const key = this.key(head.buyerDid, head.purchaseOrderId);
    if (this.heads.has(key)) return false;
    this.heads.set(key, { ...head });
    return true;
  }

  casAdvance(
    buyerDid: string,
    purchaseOrderId: string,
    expectedDigest: string,
    next: {
      headDigest: string;
      headSequence: string;
      state: string;
      supplierEpoch: string;
      updatedAt: number;
    },
  ): boolean {
    const head = this.heads.get(this.key(buyerDid, purchaseOrderId));
    if (!head || head.headDigest !== expectedDigest) return false;
    Object.assign(head, next);
    return true;
  }

  setFence(
    buyerDid: string,
    purchaseOrderId: string,
    next: {
      headDigest: string;
      headSequence: string;
      state: string;
      supplierEpoch: string;
      updatedAt: number;
    },
  ): boolean {
    const head = this.heads.get(this.key(buyerDid, purchaseOrderId));
    if (!head || !epochGreater(next.supplierEpoch, head.supplierEpoch)) return false;
    Object.assign(head, next);
    return true;
  }
}

