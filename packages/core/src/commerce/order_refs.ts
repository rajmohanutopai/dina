/**
 * Commerce order-reference / idempotency store (spec §15.5, §9.9).
 *
 * One row per (buyerDid, purchaseOrderId); (buyerDid, idempotencyKey)
 * is a second UNIQUE identity. The row is the recoverable work item:
 * created `reserved`/`pre_effect` in the SAME transaction as the
 * quote-use hold, flipped to `effect_started` BEFORE any external
 * boundary attempt, and `decided` atomically with the acknowledgement
 * and the hold settlement. Recovery rules by phase live in the
 * admission engine (admission.ts); this store owns the primitives and
 * their CAS discipline.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type CommerceOrderRefState = 'reserved' | 'decided';
export type CommerceEffectPhase = 'pre_effect' | 'effect_started';

export interface CommerceOrderRef {
  buyerDid: string;
  purchaseOrderId: string;
  idempotencyKey: string;
  orderDigest: string;
  quoteId: string;
  quoteDigest: string;
  /** Commerce protocol MAJOR pinned at admission (§9.13 lifecycle routing). */
  pinnedMajor: string;
  state: CommerceOrderRefState;
  effectPhase: CommerceEffectPhase;
  /** Recorded SIGNED acknowledgement JSON once decided (§15.5). */
  acknowledgementJson: string | null;
  externalRef: string | null;
  /** Epoch ms deadline for pre_effect decision recovery (§9.9 step 3). */
  decisionDeadlineAt: number | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface DecideOptions {
  acknowledgementJson: string;
  externalRef?: string | null;
  decidedAt: number;
  /** When true, the CAS additionally requires effect_phase='pre_effect' —
   *  the decision_timeout path may NEVER decide an effect_started row. */
  requirePreEffect?: boolean;
}

export interface CommerceOrderRefRepository {
  getByOrderId(buyerDid: string, purchaseOrderId: string): CommerceOrderRef | null;
  getByIdempotencyKey(buyerDid: string, idempotencyKey: string): CommerceOrderRef | null;
  /** Insert the reserved record. False when either unique key exists. */
  createReserved(
    ref: Omit<
      CommerceOrderRef,
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt'
    >,
  ): boolean;
  /** CAS reserved/pre_effect -> effect_started. Durable BEFORE the effect. */
  markEffectStarted(buyerDid: string, purchaseOrderId: string): boolean;
  /** CAS reserved -> decided, persisting the acknowledgement. */
  decide(buyerDid: string, purchaseOrderId: string, options: DecideOptions): boolean;
  /** Reserved rows for the restart sweeper (§9.9 step 3). */
  listReserved(): CommerceOrderRef[];
  /** Reserved pre_effect rows whose decision deadline passed. */
  listExpiredPreEffect(nowMs: number): CommerceOrderRef[];
  /** Non-terminal (reserved) count for a pinned major (§9.13 drain release). */
  countReservedByMajor(major: string): number;
}

function rowToOrderRef(row: DBRow): CommerceOrderRef {
  return {
    buyerDid: String(row.buyer_did),
    purchaseOrderId: String(row.purchase_order_id),
    idempotencyKey: String(row.idempotency_key),
    orderDigest: String(row.order_digest),
    quoteId: String(row.quote_id),
    quoteDigest: String(row.quote_digest),
    pinnedMajor: String(row.pinned_major),
    state: String(row.state) as CommerceOrderRefState,
    effectPhase: String(row.effect_phase) as CommerceEffectPhase,
    acknowledgementJson:
      row.acknowledgement_json === null ? null : String(row.acknowledgement_json),
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    decisionDeadlineAt: row.decision_deadline_at === null ? null : Number(row.decision_deadline_at),
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
  };
}

const SELECT = `
  SELECT buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id,
         quote_digest, pinned_major, state, effect_phase, acknowledgement_json,
         external_ref, decision_deadline_at, created_at, decided_at
  FROM commerce_order_refs
`;

export class SQLiteCommerceOrderRefRepository implements CommerceOrderRefRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  getByOrderId(buyerDid: string, purchaseOrderId: string): CommerceOrderRef | null {
    const rows = this.db.query(`${SELECT} WHERE buyer_did = ? AND purchase_order_id = ?`, [
      buyerDid,
      purchaseOrderId,
    ]);
    return rows[0] ? rowToOrderRef(rows[0]) : null;
  }

  getByIdempotencyKey(buyerDid: string, idempotencyKey: string): CommerceOrderRef | null {
    const rows = this.db.query(`${SELECT} WHERE buyer_did = ? AND idempotency_key = ?`, [
      buyerDid,
      idempotencyKey,
    ]);
    return rows[0] ? rowToOrderRef(rows[0]) : null;
  }

  createReserved(
    ref: Omit<
      CommerceOrderRef,
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt'
    >,
  ): boolean {
    try {
      const affected = this.db.run(
        `INSERT INTO commerce_order_refs (
           buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id,
           quote_digest, pinned_major, state, effect_phase, decision_deadline_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', 'pre_effect', ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          ref.buyerDid,
          ref.purchaseOrderId,
          ref.idempotencyKey,
          ref.orderDigest,
          ref.quoteId,
          ref.quoteDigest,
          ref.pinnedMajor,
          ref.decisionDeadlineAt,
          ref.createdAt,
        ],
      );
      return affected > 0;
    } catch {
      // The idempotency-key unique index conflicts via exception on some
      // engines instead of ON CONFLICT (composite target) — same meaning.
      return false;
    }
  }

  markEffectStarted(buyerDid: string, purchaseOrderId: string): boolean {
    const affected = this.db.run(
      `UPDATE commerce_order_refs SET effect_phase = 'effect_started'
       WHERE buyer_did = ? AND purchase_order_id = ?
         AND state = 'reserved' AND effect_phase = 'pre_effect'`,
      [buyerDid, purchaseOrderId],
    );
    return affected > 0;
  }

  decide(buyerDid: string, purchaseOrderId: string, options: DecideOptions): boolean {
    const phaseClause = options.requirePreEffect ? `AND effect_phase = 'pre_effect'` : '';
    const affected = this.db.run(
      `UPDATE commerce_order_refs
       SET state = 'decided', acknowledgement_json = ?, external_ref = ?, decided_at = ?
       WHERE buyer_did = ? AND purchase_order_id = ? AND state = 'reserved' ${phaseClause}`,
      [
        options.acknowledgementJson,
        options.externalRef ?? null,
        options.decidedAt,
        buyerDid,
        purchaseOrderId,
      ],
    );
    return affected > 0;
  }

  listReserved(): CommerceOrderRef[] {
    return this.db
      .query(`${SELECT} WHERE state = 'reserved' ORDER BY created_at`)
      .map(rowToOrderRef);
  }

  listExpiredPreEffect(nowMs: number): CommerceOrderRef[] {
    return this.db
      .query(
        `${SELECT} WHERE state = 'reserved' AND effect_phase = 'pre_effect'
           AND decision_deadline_at IS NOT NULL AND decision_deadline_at <= ?
         ORDER BY decision_deadline_at`,
        [nowMs],
      )
      .map(rowToOrderRef);
  }

  countReservedByMajor(major: string): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commerce_order_refs WHERE state = 'reserved' AND pinned_major = ?`,
      [major],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

export class InMemoryCommerceOrderRefRepository implements CommerceOrderRefRepository {
  private readonly byOrderId = new Map<string, CommerceOrderRef>();

  private orderKey(buyerDid: string, purchaseOrderId: string): string {
    return `${buyerDid}\u0000${purchaseOrderId}`;
  }

  getByOrderId(buyerDid: string, purchaseOrderId: string): CommerceOrderRef | null {
    const ref = this.byOrderId.get(this.orderKey(buyerDid, purchaseOrderId));
    return ref ? { ...ref } : null;
  }

  getByIdempotencyKey(buyerDid: string, idempotencyKey: string): CommerceOrderRef | null {
    for (const ref of this.byOrderId.values()) {
      if (ref.buyerDid === buyerDid && ref.idempotencyKey === idempotencyKey) return { ...ref };
    }
    return null;
  }

  createReserved(
    ref: Omit<
      CommerceOrderRef,
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt'
    >,
  ): boolean {
    if (this.byOrderId.has(this.orderKey(ref.buyerDid, ref.purchaseOrderId))) return false;
    if (this.getByIdempotencyKey(ref.buyerDid, ref.idempotencyKey)) return false;
    this.byOrderId.set(this.orderKey(ref.buyerDid, ref.purchaseOrderId), {
      ...ref,
      state: 'reserved',
      effectPhase: 'pre_effect',
      acknowledgementJson: null,
      externalRef: null,
      decidedAt: null,
    });
    return true;
  }

  markEffectStarted(buyerDid: string, purchaseOrderId: string): boolean {
    const ref = this.byOrderId.get(this.orderKey(buyerDid, purchaseOrderId));
    if (!ref || ref.state !== 'reserved' || ref.effectPhase !== 'pre_effect') return false;
    ref.effectPhase = 'effect_started';
    return true;
  }

  decide(buyerDid: string, purchaseOrderId: string, options: DecideOptions): boolean {
    const ref = this.byOrderId.get(this.orderKey(buyerDid, purchaseOrderId));
    if (!ref || ref.state !== 'reserved') return false;
    if (options.requirePreEffect && ref.effectPhase !== 'pre_effect') return false;
    ref.state = 'decided';
    ref.acknowledgementJson = options.acknowledgementJson;
    ref.externalRef = options.externalRef ?? null;
    ref.decidedAt = options.decidedAt;
    return true;
  }

  listReserved(): CommerceOrderRef[] {
    return [...this.byOrderId.values()]
      .filter((r) => r.state === 'reserved')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  listExpiredPreEffect(nowMs: number): CommerceOrderRef[] {
    return this.listReserved().filter(
      (r) =>
        r.effectPhase === 'pre_effect' &&
        r.decisionDeadlineAt !== null &&
        r.decisionDeadlineAt <= nowMs,
    );
  }

  countReservedByMajor(major: string): number {
    return this.listReserved().filter((r) => r.pinnedMajor === major).length;
  }
}

let repository: CommerceOrderRefRepository | null = null;

export function setCommerceOrderRefRepository(repo: CommerceOrderRefRepository | null): void {
  repository = repo;
}

export function getCommerceOrderRefRepository(): CommerceOrderRefRepository | null {
  return repository;
}
