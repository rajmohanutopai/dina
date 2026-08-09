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
   * §9.13 — the plugin manifest CID that was serving this supplier when the
   * order was admitted, or `''` when no plugin served it.
   *
   * A lifecycle request for this order must be parsed under the contract the
   * order was opened against, and after a plugin update the install's CURRENT
   * manifest is no longer that contract. `pinnedVersion` says which protocol
   * major; this says which manifest actually implements it, which is the key
   * the drain-authorization table is already keyed on. Storing the CID rather
   * than re-deriving a major from the manifest keeps the two from disagreeing
   * — and a manifest declares no protocol major today, so there is nothing to
   * re-derive from.
   */
  servingManifestCid: string;
  /**
   * §16.4 — the install that served this order, or '' when no plugin did.
   *
   * Distinct from `servingManifestCid` because they diverge exactly when it
   * matters: a plugin update moves the CID and keeps the install, so "is this
   * INSTALL still on the hook" is a question the CID cannot answer.
   */
  servingInstallId: string;
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

  /**
   * §16.2 (WS-4.3) — record the recovered proposal and clear the
   * reconciliation flag, CAS on the flag still being set.
   *
   * The CAS matters: two reconcile attempts for one order must not both
   * "succeed", because the second would re-stamp `admitted_epoch` to a later
   * epoch and could un-fence an order a restore had deliberately fenced.
   */
  reconcile(buyerDid: string, purchaseOrderId: string, options: { atEpoch: string }): boolean;
  /** Reserved rows for the restart sweeper (§9.9 step 3). */
  listReserved(): CommerceOrderRef[];
  /**
   * §12.7 (WS-9.5) — orders whose external effect produced a reference.
   *
   * These are the ones a fulfilment sweep can ask about: an order with no
   * external reference has nothing to look up out there, and asking anyway
   * would turn a reconciliation into a fishing expedition across a supplier's
   * whole order history.
   */
  listWithExternalRef(): CommerceOrderRef[];
  /**
   * §16.2 (WS-4.3) — orders re-adopted from a counterparty's held evidence
   * and not yet reconciled. They cannot open a chain or be cancelled, so they
   * are frozen until the buyer presents the proposal it holds.
   *
   * Read by the CENSUS, not by a repair job: there is no local state to
   * reconcile against, so nothing here can clear the flag on its own.
   * Includes decided orders — a decided one that is frozen is the worse case,
   * because the buyer holds an acknowledgement this node can no longer
   * describe.
   */
  listAwaitingReconciliation(): CommerceOrderRef[];
  /** Reserved pre_effect rows whose decision deadline passed. */
  listExpiredPreEffect(nowMs: number): CommerceOrderRef[];
  /** Non-terminal (reserved) count for a pinned major (§9.13 drain release). */
  countReservedByMajor(major: string): number;
  /**
   * Non-terminal count for orders admitted under one plugin manifest (§9.13).
   *
   * Drives lifecycle-continuity RELEASE: the lane for a prior manifest may be
   * closed only once no order it served is still open. Keyed on the manifest
   * rather than the protocol major because that is what the continuity
   * authorization is keyed on, and a manifest declares no major to count by.
   */
  countReservedByServingManifest(servingManifestCid: string): number;
  /** §9.13 — orders this manifest still has WORK for; see the SQLite impl. */
  countUnfinishedByServingManifest(servingManifestCid: string, nowMs: number): number;
  /**
   * Non-terminal count for orders served by ONE install (§16.4).
   *
   * Drives the uninstall obligation refusal. Keyed on the install rather than
   * the manifest because a plugin update moves the CID: an install that has
   * updated once would otherwise stop counting the orders it opened under its
   * previous manifest, and those are exactly the orders it still owes an
   * answer for.
   */
  countReservedByServingInstall(installId: string): number;
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
    servingManifestCid: row.serving_manifest_cid === null ? '' : String(row.serving_manifest_cid),
    // `?? ''` rather than `=== null ? '' :`, because a column MISSING from the
    // SELECT list reads as `undefined`, and `String(undefined)` is the text
    // "undefined" — a value that compares equal to nothing and looks like
    // data. That is exactly how this field silently arrived as a five-letter
    // install id the first time it was added.
    servingInstallId: String(row.serving_install_id ?? ''),
    admittedEpoch: String(row.admitted_epoch),
    reconciliationRequired: Number(row.reconciliation_required) === 1,
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
         quote_digest, pinned_version, serving_manifest_cid, serving_install_id,
         admitted_epoch, reconciliation_required,
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
      'state' | 'effectPhase' | 'acknowledgementJson' | 'externalRef' | 'decidedAt'
    >,
  ): boolean {
    try {
      const affected = this.db.run(
        `INSERT INTO commerce_order_refs (
           buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id,
           quote_digest, pinned_version, serving_manifest_cid, serving_install_id,
           admitted_epoch, reconciliation_required,
           state, effect_phase, decision_deadline_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'pre_effect', ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          ref.buyerDid,
          ref.purchaseOrderId,
          ref.idempotencyKey,
          ref.orderDigest,
          ref.quoteId,
          ref.quoteDigest,
          ref.pinnedVersion,
          ref.servingManifestCid,
          ref.servingInstallId,
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

  reconcile(buyerDid: string, purchaseOrderId: string, options: { atEpoch: string }): boolean {
    const affected = this.db.run(
      `UPDATE commerce_order_refs
       SET admitted_epoch = ?, reconciliation_required = 0
       WHERE buyer_did = ? AND purchase_order_id = ? AND reconciliation_required = 1`,
      [options.atEpoch, buyerDid, purchaseOrderId],
    );
    return affected > 0;
  }

  listReserved(): CommerceOrderRef[] {
    return this.db
      .query(`${SELECT} WHERE state = 'reserved' ORDER BY created_at`)
      .map(rowToOrderRef);
  }

  listWithExternalRef(): CommerceOrderRef[] {
    // `!= ''` as well as NOT NULL: the effect executor records the empty
    // string when an external system answers without a reference, and an
    // empty reference cannot be looked up any more than a missing one.
    return this.db
      .query(`${SELECT} WHERE external_ref IS NOT NULL AND external_ref != '' ORDER BY created_at`)
      .map(rowToOrderRef);
  }

  listAwaitingReconciliation(): CommerceOrderRef[] {
    // No state filter. A DECIDED order can be frozen too, and it is the worse
    // case — the buyer holds an acknowledgement this node can no longer
    // describe — so filtering to `reserved` would hide exactly the rows an
    // owner most needs to see.
    return this.db
      .query(`${SELECT} WHERE reconciliation_required = 1 ORDER BY created_at`)
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

  countReservedByServingManifest(servingManifestCid: string): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commerce_order_refs
        WHERE state = 'reserved' AND serving_manifest_cid = ?`,
      [servingManifestCid],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * §9.13 — orders this manifest still has WORK for, not just reserved ones.
   *
   * The reserved count answers "is anything waiting to be decided", which is
   * the wrong question for releasing lifecycle continuity. An ACCEPTED order
   * is `decided` the moment the supplier answers, and its status chain runs on
   * for days: dispatched, delivered, a dispute window, possibly a
   * cancellation. Releasing on the reserved count would revoke a prior
   * manifest's authority while every one of those still needs it — and the
   * buyer would meet `lifecycle_continuity_unavailable` on an order this
   * supplier accepted.
   *
   * NONTERMINAL is defined by the STATUS CHAIN, which is where the answer
   * lives. `rejected` / `cancelled` / `disputed` end it, and `delivered` ends
   * it once its dispute window has passed.
   *
   * THE WINDOW IS EVALUATED HERE NOW, and the note this replaces said the
   * query "cannot evaluate" it "so a delivered head counts as UNFINISHED and
   * the caller applies the window". Neither caller applied one — both boots
   * returned this count straight to continuity release and uninstall — so a
   * delivered order was unfinished FOR EVER. The safe direction had no floor:
   * every prior manifest CID stayed alive indefinitely and a supplier could
   * never uninstall a pack whose orders had all completed normally.
   *
   * `dispute_window_ends_at` is denormalised onto the head precisely so this
   * question can be asked without loading a receipt, and `nowMs` is a
   * parameter rather than a clock read so the boundary is testable to the
   * millisecond. A delivered head with NO recorded deadline stays unfinished:
   * absent is not expired.
   *
   * An order with NO status head at all is unfinished too — accepted, and the
   * chain not yet started.
   */
  countUnfinishedByServingManifest(servingManifestCid: string, nowMs: number): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commerce_order_refs r
        LEFT JOIN commerce_status_heads h
          ON h.buyer_did = r.buyer_did AND h.purchase_order_id = r.purchase_order_id
        WHERE r.serving_manifest_cid = ?
          AND (
            r.state = 'reserved'
            OR h.state IS NULL
            OR (
              h.state NOT IN ('rejected', 'cancelled', 'disputed', 'delivered')
            )
            OR (
              h.state = 'delivered'
              AND (h.dispute_window_ends_at IS NULL OR h.dispute_window_ends_at > ?)
            )
          )`,
      [servingManifestCid, nowMs],
    );
    return Number(rows[0]?.n ?? 0);
  }

  countReservedByServingInstall(installId: string): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM commerce_order_refs
         WHERE state = 'reserved' AND serving_install_id = ?`,
      [installId],
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

  reconcile(buyerDid: string, purchaseOrderId: string, options: { atEpoch: string }): boolean {
    const ref = this.byOrderId.get(this.orderKey(buyerDid, purchaseOrderId));
    if (!ref || !ref.reconciliationRequired) return false;
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

  listWithExternalRef(): CommerceOrderRef[] {
    return [...this.byOrderId.values()]
      .filter((r) => r.externalRef !== null && r.externalRef !== '')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  listAwaitingReconciliation(): CommerceOrderRef[] {
    // Matches the SQLite ordering and the absence of a state filter — a
    // decided order can be frozen too. The two implementations disagreeing
    // here would make the census depend on which one a test happened to use.
    return [...this.byOrderId.values()]
      .filter((r) => r.reconciliationRequired)
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

  countReservedByServingManifest(servingManifestCid: string): number {
    return this.listReserved().filter((r) => r.servingManifestCid === servingManifestCid).length;
  }

  /**
   * The double has NO STATUS CHAIN to join against, so it counts every order
   * this manifest served that is not `decided` — plus every decided one,
   * because without a chain it cannot know one has finished.
   *
   * Deliberately the CONSERVATIVE reading, matching the SQL's own bias: a lane
   * kept open too long costs a stale CID, while releasing early locks a buyer
   * out of an order this supplier accepted. A double that answered zero where
   * the real store answers one would make the release path untestable in
   * exactly the direction that matters.
   */
  countUnfinishedByServingManifest(servingManifestCid: string): number {
    return [...this.byOrderId.values()].filter((r) => r.servingManifestCid === servingManifestCid)
      .length;
  }

  countReservedByServingInstall(installId: string): number {
    return this.listReserved().filter((r) => r.servingInstallId === installId).length;
  }
}
