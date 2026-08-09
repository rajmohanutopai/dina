/**
 * Supplier-side quote ledger (spec §9.8, §9.9, §16.2): the head CAS
 * at signing plus provisional use holds.
 *
 * - The HEAD row is the only place a valid revision can be born: a
 *   revision whose previousQuoteDigest is not the stored head fails
 *   the CAS, so a conforming supplier cannot emit two live successors.
 * - USES are provisional holds keyed on the consuming order:
 *   held -> committed (accepted) | refunded (every rejected outcome,
 *   counterproposal, proven non-execution). Remaining capacity =
 *   maxUses - (held + committed). Settlement happens in the SAME
 *   transaction as the acknowledgement (admission engine).
 * - `voidUnexpired` is the §16.2 restore rule: pre-backup capacity is
 *   never resurrected; admission against a voided head returns
 *   quote_superseded.
 *
 * Atomicity note: check-and-hold and decide-and-settle span multiple
 * calls — the ADMISSION ENGINE wraps them in one TxRunner
 * transaction; these methods never open their own.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface CommerceQuoteHead {
  quoteId: string;
  buyerDid: string;
  headDigest: string;
  headRevision: string;
  /** Canonical positive-integer string; immutable per quoteId. */
  maxUses: string;
  /** Epoch ms end of validity (admission-time expiry checks). */
  validUntil: number;
  supplierEpoch: string;
  voided: boolean;
  createdAt: number;
  updatedAt: number;
}

export type QuoteUseState = 'held' | 'committed' | 'refunded';

export interface CommerceQuoteLedgerRepository {
  getHead(quoteId: string): CommerceQuoteHead | null;
  /**
   * Every family this supplier has issued, newest first.
   *
   * OWNER-FACING ONLY. Nothing on the wire enumerates a supplier's quotes:
   * the list names every buyer this business has priced for and what it
   * offered them, which is its whole commercial position.
   */
  listHeads(): CommerceQuoteHead[];
  /** Register a fresh family at revision "1". False when it exists. */
  registerHead(head: Omit<CommerceQuoteHead, 'voided' | 'updatedAt'>): boolean;
  /** CAS the head forward (revision N -> N+1 signing gate). */
  casAdvanceHead(
    quoteId: string,
    expectedDigest: string,
    next: {
      headDigest: string;
      headRevision: string;
      supplierEpoch: string;
      /**
       * §16.2: the head's validity window MUST advance with the head.
       * Leaving it at revision 1's value made restore voiding use a
       * stale deadline — an extended revision could look expired (so
       * escape voiding) and resurrect capacity.
       */
      validUntil: number;
      updatedAt: number;
    },
  ): boolean;
  /** §16.2 restore: void every unexpired head. Returns count voided. */
  voidUnexpired(nowMs: number, updatedAt: number): number;
  /** held + committed uses (capacity consumers). */
  activeUseCount(quoteId: string): number;
  getUse(quoteId: string, purchaseOrderId: string): QuoteUseState | null;
  /** Insert a hold. False when a use row already exists for the order. */
  holdUse(quoteId: string, purchaseOrderId: string, createdAt: number): boolean;
  /** CAS held -> committed | refunded. */
  settleUse(
    quoteId: string,
    purchaseOrderId: string,
    state: 'committed' | 'refunded',
    settledAt: number,
  ): boolean;
}

function rowToHead(row: DBRow): CommerceQuoteHead {
  return {
    quoteId: String(row.quote_id),
    buyerDid: String(row.buyer_did),
    headDigest: String(row.head_digest),
    headRevision: String(row.head_revision),
    maxUses: String(row.max_uses),
    validUntil: Number(row.valid_until),
    supplierEpoch: String(row.supplier_epoch),
    voided: Number(row.voided) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class SQLiteCommerceQuoteLedgerRepository implements CommerceQuoteLedgerRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  getHead(quoteId: string): CommerceQuoteHead | null {
    const rows = this.db.query(`SELECT * FROM commerce_quote_heads WHERE quote_id = ?`, [quoteId]);
    return rows[0] ? rowToHead(rows[0]) : null;
  }

  listHeads(): CommerceQuoteHead[] {
    // Newest first, then by id so two families created in the same millisecond
    // do not shuffle between reads — an owner list that reorders itself on
    // refresh reads as if something changed.
    const rows = this.db.query(
      `SELECT * FROM commerce_quote_heads ORDER BY created_at DESC, quote_id ASC`,
      [],
    );
    return rows.map(rowToHead);
  }

  registerHead(head: Omit<CommerceQuoteHead, 'voided' | 'updatedAt'>): boolean {
    const affected = this.db.run(
      `INSERT INTO commerce_quote_heads (
         quote_id, buyer_did, head_digest, head_revision, max_uses,
         valid_until, supplier_epoch, voided, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(quote_id) DO NOTHING`,
      [
        head.quoteId,
        head.buyerDid,
        head.headDigest,
        head.headRevision,
        head.maxUses,
        head.validUntil,
        head.supplierEpoch,
        head.createdAt,
        head.createdAt,
      ],
    );
    return affected > 0;
  }

  casAdvanceHead(
    quoteId: string,
    expectedDigest: string,
    next: {
      headDigest: string;
      headRevision: string;
      supplierEpoch: string;
      /**
       * §16.2: the head's validity window MUST advance with the head.
       * Leaving it at revision 1's value made restore voiding use a
       * stale deadline — an extended revision could look expired (so
       * escape voiding) and resurrect capacity.
       */
      validUntil: number;
      updatedAt: number;
    },
  ): boolean {
    const affected = this.db.run(
      `UPDATE commerce_quote_heads
       SET head_digest = ?, head_revision = ?, supplier_epoch = ?, valid_until = ?, updated_at = ?
       WHERE quote_id = ? AND head_digest = ? AND voided = 0`,
      [
        next.headDigest,
        next.headRevision,
        next.supplierEpoch,
        next.validUntil,
        next.updatedAt,
        quoteId,
        expectedDigest,
      ],
    );
    return affected > 0;
  }

  voidUnexpired(nowMs: number, updatedAt: number): number {
    return this.db.run(
      `UPDATE commerce_quote_heads SET voided = 1, updated_at = ?
       WHERE voided = 0 AND valid_until > ?`,
      [updatedAt, nowMs],
    );
  }

  activeUseCount(quoteId: string): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commerce_quote_uses
       WHERE quote_id = ? AND state IN ('held', 'committed')`,
      [quoteId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  getUse(quoteId: string, purchaseOrderId: string): QuoteUseState | null {
    const rows = this.db.query<{ state: string }>(
      `SELECT state FROM commerce_quote_uses WHERE quote_id = ? AND purchase_order_id = ?`,
      [quoteId, purchaseOrderId],
    );
    return rows[0] ? (String(rows[0].state) as QuoteUseState) : null;
  }

  holdUse(quoteId: string, purchaseOrderId: string, createdAt: number): boolean {
    const affected = this.db.run(
      `INSERT INTO commerce_quote_uses (quote_id, purchase_order_id, state, created_at)
       VALUES (?, ?, 'held', ?)
       ON CONFLICT(quote_id, purchase_order_id) DO NOTHING`,
      [quoteId, purchaseOrderId, createdAt],
    );
    return affected > 0;
  }

  settleUse(
    quoteId: string,
    purchaseOrderId: string,
    state: 'committed' | 'refunded',
    settledAt: number,
  ): boolean {
    const affected = this.db.run(
      `UPDATE commerce_quote_uses SET state = ?, settled_at = ?
       WHERE quote_id = ? AND purchase_order_id = ? AND state = 'held'`,
      [state, settledAt, quoteId, purchaseOrderId],
    );
    return affected > 0;
  }
}

export class InMemoryCommerceQuoteLedgerRepository implements CommerceQuoteLedgerRepository {
  private readonly heads = new Map<string, CommerceQuoteHead>();
  private readonly uses = new Map<string, { state: QuoteUseState; createdAt: number }>();

  private useKey(quoteId: string, purchaseOrderId: string): string {
    return `${quoteId} ${purchaseOrderId}`;
  }

  getHead(quoteId: string): CommerceQuoteHead | null {
    const head = this.heads.get(quoteId);
    return head ? { ...head } : null;
  }

  listHeads(): CommerceQuoteHead[] {
    return [...this.heads.values()]
      .map((head) => ({ ...head }))
      .sort((a, b) => b.createdAt - a.createdAt || a.quoteId.localeCompare(b.quoteId));
  }

  registerHead(head: Omit<CommerceQuoteHead, 'voided' | 'updatedAt'>): boolean {
    if (this.heads.has(head.quoteId)) return false;
    this.heads.set(head.quoteId, { ...head, voided: false, updatedAt: head.createdAt });
    return true;
  }

  casAdvanceHead(
    quoteId: string,
    expectedDigest: string,
    next: {
      headDigest: string;
      headRevision: string;
      supplierEpoch: string;
      /**
       * §16.2: the head's validity window MUST advance with the head.
       * Leaving it at revision 1's value made restore voiding use a
       * stale deadline — an extended revision could look expired (so
       * escape voiding) and resurrect capacity.
       */
      validUntil: number;
      updatedAt: number;
    },
  ): boolean {
    const head = this.heads.get(quoteId);
    if (!head || head.voided || head.headDigest !== expectedDigest) return false;
    head.headDigest = next.headDigest;
    head.headRevision = next.headRevision;
    head.supplierEpoch = next.supplierEpoch;
    head.validUntil = next.validUntil;
    head.updatedAt = next.updatedAt;
    return true;
  }

  voidUnexpired(nowMs: number, updatedAt: number): number {
    let voided = 0;
    for (const head of this.heads.values()) {
      if (!head.voided && head.validUntil > nowMs) {
        head.voided = true;
        head.updatedAt = updatedAt;
        voided += 1;
      }
    }
    return voided;
  }

  activeUseCount(quoteId: string): number {
    let count = 0;
    for (const [key, use] of this.uses) {
      if (key.startsWith(`${quoteId} `) && use.state !== 'refunded') count += 1;
    }
    return count;
  }

  getUse(quoteId: string, purchaseOrderId: string): QuoteUseState | null {
    return this.uses.get(this.useKey(quoteId, purchaseOrderId))?.state ?? null;
  }

  holdUse(quoteId: string, purchaseOrderId: string, createdAt: number): boolean {
    const key = this.useKey(quoteId, purchaseOrderId);
    if (this.uses.has(key)) return false;
    this.uses.set(key, { state: 'held', createdAt });
    return true;
  }

  settleUse(quoteId: string, purchaseOrderId: string, state: 'committed' | 'refunded'): boolean {
    const use = this.uses.get(this.useKey(quoteId, purchaseOrderId));
    if (!use || use.state !== 'held') return false;
    use.state = state;
    return true;
  }
}
