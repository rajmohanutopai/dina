/**
 * The buyer's negotiation ledger (NEGOTIATION_PLAN §5, buyer side).
 *
 * Every counter this node sent and what came back, and each tender's policy
 * and state. The offers themselves stay in the verified quote store: a
 * revision a supplier sends is believed only after the chain check there, and
 * this ledger records only that the answer arrived.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { QuoteOutcome } from '@dina/commerce-protocol';

/**
 * `unsent` — retained, and the transport could not prove it left (§12.7).
 * `pending` — the supplier held, and said a lower price is before its owner:
 * the loop may ask again.
 */
export type SentCounterState = 'sent' | 'revised' | 'held' | 'pending' | 'refused' | 'unsent';

export interface SentCounter {
  counterId: string;
  /** '' for a manual counter outside a tender. */
  tenderId: string;
  supplierDid: string;
  quoteId: string;
  round: number;
  state: SentCounterState;
  counterJson: string;
  /** The quote digest the answer carried ('' until answered). */
  answerDigest: string;
  sentAt: number;
  answeredAt: number | null;
  /** How many times this counter went out; a silent one is sent once more. */
  attempts: number;
}

export type TenderNoticeState = 'pending' | 'sent' | 'abandoned';

export interface TenderNotice {
  tenderId: string;
  supplierDid: string;
  /**
   * `not_awarded`: an award went elsewhere, or the window ran out.
   * `negotiation_closed`: no more counters; the quote may still be awarded.
   */
  outcome: QuoteOutcome;
  requestId: string;
  quoteId: string;
  serviceRkey: string;
  state: TenderNoticeState;
  attempts: number;
  updatedAt: number;
}

export type TenderNegotiationState = 'negotiating' | 'ready' | 'awarded' | 'closed';

export interface TenderNegotiation {
  tenderId: string;
  currency: string;
  /** Empty for both: a tender awarded without a policy names neither. */
  targetTotalMinor: string;
  budgetCeilingMinor: string;
  maxRounds: number;
  deadlineAt: number;
  state: TenderNegotiationState;
  awardedSupplierDid: string;
  approvalId: string;
  updatedAt: number;
}

export interface BuyerNegotiationRepository {
  putCounter(counter: SentCounter): void;
  getCounter(counterId: string): SentCounter | null;
  countersForQuote(supplierDid: string, quoteId: string): SentCounter[];
  /** CAS from `sent`/`unsent`; false when the counter was already answered. */
  answerCounter(
    counterId: string,
    state: Exclude<SentCounterState, 'sent' | 'unsent'>,
    answerDigest: string,
    atMs: number,
  ): boolean;
  putTender(policy: TenderNegotiation): void;
  getTender(tenderId: string): TenderNegotiation | null;
  listTenders(state: TenderNegotiationState): TenderNegotiation[];
  /**
   * Tenders whose window has closed and that are neither awarded nor closed,
   * with or without a policy — the ones the sweeper still has to close.
   */
  listLapsedTenderIds(nowMs: number): string[];
  /** Written with the award, the close, or the end of negotiating; first writer wins. */
  putNotice(notice: TenderNotice): void;
  listNotices(state: TenderNoticeState): TenderNotice[];
  /** Every notice one tender wrote, whatever its state. */
  listNoticesForTender(tenderId: string): TenderNotice[];
  updateNotice(
    tenderId: string,
    supplierDid: string,
    outcome: QuoteOutcome,
    state: TenderNoticeState,
    attempts: number,
    atMs: number,
  ): void;
  /** CAS on state; false when another writer moved it first. */
  moveTender(
    tenderId: string,
    from: TenderNegotiationState,
    to: TenderNegotiationState,
    atMs: number,
    award?: { supplierDid: string; approvalId: string },
  ): boolean;
}

function counterFromRow(row: DBRow): SentCounter {
  return {
    counterId: String(row.counter_id),
    tenderId: String(row.tender_id),
    supplierDid: String(row.supplier_did),
    quoteId: String(row.quote_id),
    round: Number(row.round),
    state: String(row.state) as SentCounterState,
    counterJson: String(row.counter_json),
    answerDigest: String(row.answer_digest),
    sentAt: Number(row.sent_at),
    answeredAt:
      row.answered_at === null || row.answered_at === undefined ? null : Number(row.answered_at),
    attempts: row.attempts === null || row.attempts === undefined ? 1 : Number(row.attempts),
  };
}

function noticeFromRow(row: DBRow): TenderNotice {
  return {
    tenderId: String(row.tender_id),
    supplierDid: String(row.supplier_did),
    outcome: String(row.outcome) as QuoteOutcome,
    requestId: String(row.request_id),
    quoteId: String(row.quote_id),
    serviceRkey: String(row.service_rkey),
    state: String(row.state) as TenderNoticeState,
    attempts: Number(row.attempts),
    updatedAt: Number(row.updated_at),
  };
}

function tenderFromRow(row: DBRow): TenderNegotiation {
  return {
    tenderId: String(row.tender_id),
    currency: String(row.currency),
    targetTotalMinor: String(row.target_total_minor),
    budgetCeilingMinor: String(row.budget_ceiling_minor),
    maxRounds: Number(row.max_rounds),
    deadlineAt: Number(row.deadline_at),
    state: String(row.state) as TenderNegotiationState,
    awardedSupplierDid: String(row.awarded_supplier_did),
    approvalId: String(row.approval_id),
    updatedAt: Number(row.updated_at),
  };
}

export class SQLiteBuyerNegotiationRepository implements BuyerNegotiationRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  putCounter(counter: SentCounter): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_buyer_counters
         (counter_id, tender_id, supplier_did, quote_id, round, state, counter_json,
          answer_digest, sent_at, answered_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        counter.counterId,
        counter.tenderId,
        counter.supplierDid,
        counter.quoteId,
        counter.round,
        counter.state,
        counter.counterJson,
        counter.answerDigest,
        counter.sentAt,
        counter.answeredAt,
        counter.attempts,
      ],
    );
  }

  getCounter(counterId: string): SentCounter | null {
    const rows = this.db.query(`SELECT * FROM commerce_buyer_counters WHERE counter_id = ?`, [
      counterId,
    ]);
    return rows[0] === undefined ? null : counterFromRow(rows[0]);
  }

  countersForQuote(supplierDid: string, quoteId: string): SentCounter[] {
    return this.db
      .query(
        `SELECT * FROM commerce_buyer_counters WHERE supplier_did = ? AND quote_id = ? ORDER BY round`,
        [supplierDid, quoteId],
      )
      .map(counterFromRow);
  }

  answerCounter(
    counterId: string,
    state: Exclude<SentCounterState, 'sent' | 'unsent'>,
    answerDigest: string,
    atMs: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE commerce_buyer_counters SET state = ?, answer_digest = ?, answered_at = ?
          WHERE counter_id = ? AND state IN ('sent', 'unsent')`,
        [state, answerDigest, atMs, counterId],
      ) > 0
    );
  }

  putTender(policy: TenderNegotiation): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_tender_negotiation
         (tender_id, currency, target_total_minor, budget_ceiling_minor, max_rounds, deadline_at,
          state, awarded_supplier_did, approval_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        policy.tenderId,
        policy.currency,
        policy.targetTotalMinor,
        policy.budgetCeilingMinor,
        policy.maxRounds,
        policy.deadlineAt,
        policy.state,
        policy.awardedSupplierDid,
        policy.approvalId,
        policy.updatedAt,
      ],
    );
  }

  putNotice(notice: TenderNotice): void {
    this.db.run(
      `INSERT OR IGNORE INTO commerce_tender_notices
         (tender_id, supplier_did, outcome, request_id, quote_id, service_rkey, state, attempts,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        notice.tenderId,
        notice.supplierDid,
        notice.outcome,
        notice.requestId,
        notice.quoteId,
        notice.serviceRkey,
        notice.state,
        notice.attempts,
        notice.updatedAt,
      ],
    );
  }

  listNotices(state: TenderNoticeState): TenderNotice[] {
    return this.db
      .query(`SELECT * FROM commerce_tender_notices WHERE state = ? ORDER BY updated_at`, [state])
      .map(noticeFromRow);
  }

  listNoticesForTender(tenderId: string): TenderNotice[] {
    return this.db
      .query(
        `SELECT * FROM commerce_tender_notices WHERE tender_id = ? ORDER BY supplier_did, outcome`,
        [tenderId],
      )
      .map(noticeFromRow);
  }

  updateNotice(
    tenderId: string,
    supplierDid: string,
    outcome: QuoteOutcome,
    state: TenderNoticeState,
    attempts: number,
    atMs: number,
  ): void {
    this.db.run(
      `UPDATE commerce_tender_notices SET state = ?, attempts = ?, updated_at = ?
        WHERE tender_id = ? AND supplier_did = ? AND outcome = ?`,
      [state, attempts, atMs, tenderId, supplierDid, outcome],
    );
  }

  getTender(tenderId: string): TenderNegotiation | null {
    const rows = this.db.query(`SELECT * FROM commerce_tender_negotiation WHERE tender_id = ?`, [
      tenderId,
    ]);
    return rows[0] === undefined ? null : tenderFromRow(rows[0]);
  }

  listTenders(state: TenderNegotiationState): TenderNegotiation[] {
    return this.db
      .query(`SELECT * FROM commerce_tender_negotiation WHERE state = ? ORDER BY updated_at`, [
        state,
      ])
      .map(tenderFromRow);
  }

  listLapsedTenderIds(nowMs: number): string[] {
    return this.db
      .query(
        `SELECT t.tender_id FROM commerce_tenders t
           LEFT JOIN commerce_tender_negotiation n ON n.tender_id = t.tender_id
          WHERE t.expires_at <= ? AND (n.state IS NULL OR n.state IN ('negotiating', 'ready'))
          ORDER BY t.expires_at`,
        [nowMs],
      )
      .map((row) => String(row.tender_id));
  }

  moveTender(
    tenderId: string,
    from: TenderNegotiationState,
    to: TenderNegotiationState,
    atMs: number,
    award?: { supplierDid: string; approvalId: string },
  ): boolean {
    return (
      this.db.run(
        award === undefined
          ? `UPDATE commerce_tender_negotiation SET state = ?, updated_at = ?
              WHERE tender_id = ? AND state = ?`
          : `UPDATE commerce_tender_negotiation SET state = ?, updated_at = ?,
               awarded_supplier_did = ?, approval_id = ?
              WHERE tender_id = ? AND state = ?`,
        award === undefined
          ? [to, atMs, tenderId, from]
          : [to, atMs, award.supplierDid, award.approvalId, tenderId, from],
      ) > 0
    );
  }
}
