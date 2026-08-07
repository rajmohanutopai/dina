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
  /**
   * §9.13 — the EXACT protocol version of the order that opened this
   * conversation. Continuation records are emitted at this version, and a
   * lifecycle request must match it exactly. The MAJOR is derived from it
   * where drain counting needs one; storing both invites them to disagree.
   */
  pinnedVersion: string;
  /**
   * §16.2 — the commerce epoch in force when this order was admitted.
   *
   * Chain ADVANCEMENT can ask the status head whether it predates a
   * restore. Chain CREATION cannot: at genesis there is no head. The
   * order reference is the only durable record of when the order entered,
   * so it is the only thing that can answer "may this node still sign a
   * first status for you". Missing that, a restored supplier re-signs a
   * divergent genesis and forks against the record the buyer already holds
   * — unrepairable, because the fence needs a chain to fence.
   */
  admittedEpoch: string;
  /**
   * §16.2 — true when this reference was REBUILT from a counterparty's held
   * evidence rather than admitted here. Such an order lacks its lines, quote
   * context and external state, so chain creation is barred until the
   * per-order reconciliation ceremony clears it. Distinct from
   * `admittedEpoch`: that answers "which generation", this answers "do we
   * actually know what this order is".
   */
  reconciliationRequired: boolean;
  /**
   * §16.2 (WS-4.3) — the digest-verified order proposal recovered by the
   * reconciliation ceremony. Empty until then, and empty forever for an
   * order this node admitted itself (it never lost the proposal).
   */
  orderJson: string;
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
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt' | 'orderJson'
    >,
  ): boolean;
  /** CAS reserved/pre_effect -> effect_started. Durable BEFORE the effect. */
  markEffectStarted(buyerDid: string, purchaseOrderId: string): boolean;
  /** CAS reserved -> decided, persisting the acknowledgement. */
  decide(buyerDid: string, purchaseOrderId: string, options: DecideOptions): boolean;

  /**
   * §16.2 (WS-4.3) — record the recovered proposal and clear the
   * reconciliation flag, CAS on the flag still being set.
   *
   * The CAS matters: two reconcile attempts for one order must not both
   * "succeed", because the second would re-stamp `admitted_epoch` to a later
   * epoch and could un-fence an order a restore had deliberately fenced.
   */
  reconcile(
    buyerDid: string,
    purchaseOrderId: string,
    options: { orderJson: string; atEpoch: string },
  ): boolean;
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
    pinnedVersion: String(row.pinned_version),
    admittedEpoch: String(row.admitted_epoch),
    reconciliationRequired: Number(row.reconciliation_required) === 1,
    orderJson: String(row.order_json ?? ''),
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
         quote_digest, pinned_version, admitted_epoch, reconciliation_required, order_json,
         state, effect_phase, acknowledgement_json,
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
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt' | 'orderJson'
    >,
  ): boolean {
    try {
      const affected = this.db.run(
        `INSERT INTO commerce_order_refs (
           buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id,
           quote_digest, pinned_version, admitted_epoch, reconciliation_required, state, effect_phase, decision_deadline_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'pre_effect', ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          ref.buyerDid,
          ref.purchaseOrderId,
          ref.idempotencyKey,
          ref.orderDigest,
          ref.quoteId,
          ref.quoteDigest,
          ref.pinnedVersion,
          ref.admittedEpoch,
          ref.reconciliationRequired ? 1 : 0,
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

  reconcile(
    buyerDid: string,
    purchaseOrderId: string,
    options: { orderJson: string; atEpoch: string },
  ): boolean {
    const affected = this.db.run(
      `UPDATE commerce_order_refs
       SET order_json = ?, admitted_epoch = ?, reconciliation_required = 0
       WHERE buyer_did = ? AND purchase_order_id = ? AND reconciliation_required = 1`,
      [options.orderJson, options.atEpoch, buyerDid, purchaseOrderId],
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
      `SELECT COUNT(*) AS n FROM commerce_order_refs
       WHERE state = 'reserved' AND substr(pinned_version, 1, instr(pinned_version, '.') - 1) = ?`,
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
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt' | 'orderJson'
    >,
  ): boolean {
    if (this.byOrderId.has(this.orderKey(ref.buyerDid, ref.purchaseOrderId))) return false;
    if (this.getByIdempotencyKey(ref.buyerDid, ref.idempotencyKey)) return false;
    this.byOrderId.set(this.orderKey(ref.buyerDid, ref.purchaseOrderId), {
      ...ref,
      // Empty on admission: this node received the proposal and never lost
      // it. Only the reconciliation ceremony fills it, for an order rebuilt
      // from a counterparty's evidence.
      orderJson: '',
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

  reconcile(
    buyerDid: string,
    purchaseOrderId: string,
    options: { orderJson: string; atEpoch: string },
  ): boolean {
    const ref = this.byOrderId.get(this.orderKey(buyerDid, purchaseOrderId));
    if (!ref || !ref.reconciliationRequired) return false;
    ref.orderJson = options.orderJson;
    ref.admittedEpoch = options.atEpoch;
    ref.reconciliationRequired = false;
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
    return this.listReserved().filter((r) => r.pinnedVersion.split('.')[0] === major).length;
  }
}

