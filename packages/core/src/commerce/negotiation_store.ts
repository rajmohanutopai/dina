/**
 * The supplier's negotiation ledger (NEGOTIATION_PLAN §5, supplier side).
 *
 * Three things a supplier must remember about counter-offers, all money-free:
 * what each buyer asked and what Core answered (so a repeat is answered the
 * same way and the per-buyer daily cap can be counted), which owner questions
 * are open or answered for a quote line, and which quotes a buyer closed with
 * a not-awarded notice. The quote itself stays in the quote ledger; nothing
 * here is a price anyone is held to.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface ReceivedCounter {
  buyerDid: string;
  counterId: string;
  quoteId: string;
  round: number;
  counterDigest: string;
  counterJson: string;
  /** Exactly what went back on the wire, replayed on a repeat. */
  answerJson: string;
  createdAt: number;
}

export type OwnerPriceState = 'pending' | 'approved' | 'declined' | 'withdrawn';

export interface OwnerPriceQuestion {
  quoteId: string;
  lineId: string;
  buyerDid: string;
  askedMinorUnits: string;
  state: OwnerPriceState;
  taskId: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface QuoteOutcomeRecord {
  buyerDid: string;
  quoteId: string;
  requestId: string;
  outcome: 'not_awarded';
  receivedAt: number;
}

export interface NegotiationRepository {
  getCounter(buyerDid: string, counterId: string): ReceivedCounter | null;
  /**
   * First writer wins; false when the counter id is already recorded. An
   * admitted counter is RESERVED with an empty `answerJson` before the runner
   * is asked, so counters still in progress count toward the daily cap and
   * the round limit (rule 2).
   */
  putCounter(counter: ReceivedCounter): boolean;
  /** Fill a reserved counter's answer; false when it already has one. */
  answerReserved(buyerDid: string, counterId: string, answerJson: string): boolean;
  /** Counters from one buyer since an instant — the §3 rule-2 daily cap. */
  countCountersSince(buyerDid: string, sinceMs: number): number;
  /** This buyer's counters since a time, oldest first: the quote and the answer given. */
  listCountersSince(buyerDid: string, sinceMs: number): { quoteId: string; answerJson: string }[];
  /** The answers this node gave one buyer on one quote, oldest first — the round limit. */
  listAnswersForQuote(buyerDid: string, quoteId: string): string[];
  /** One question per quote line; a newer ask replaces a pending one. */
  askOwner(question: OwnerPriceQuestion): void;
  questionsForQuote(quoteId: string): OwnerPriceQuestion[];
  /** CAS from `pending`; false when the question already moved. */
  decideQuestion(taskId: string, state: Exclude<OwnerPriceState, 'pending'>, atMs: number): boolean;
  putOutcome(outcome: QuoteOutcomeRecord): void;
  outcomeFor(buyerDid: string, quoteId: string): QuoteOutcomeRecord | null;
}

function counterFromRow(row: DBRow): ReceivedCounter {
  return {
    buyerDid: String(row.buyer_did),
    counterId: String(row.counter_id),
    quoteId: String(row.quote_id),
    round: Number(row.round),
    counterDigest: String(row.counter_digest),
    counterJson: String(row.counter_json),
    answerJson: String(row.answer_json),
    createdAt: Number(row.created_at),
  };
}

function questionFromRow(row: DBRow): OwnerPriceQuestion {
  return {
    quoteId: String(row.quote_id),
    lineId: String(row.line_id),
    buyerDid: String(row.buyer_did),
    askedMinorUnits: String(row.asked_minor_units),
    state: String(row.state) as OwnerPriceState,
    taskId: String(row.task_id),
    createdAt: Number(row.created_at),
    decidedAt:
      row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at),
  };
}

export class SQLiteNegotiationRepository implements NegotiationRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  getCounter(buyerDid: string, counterId: string): ReceivedCounter | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_negotiation_counters WHERE buyer_did = ? AND counter_id = ?`,
      [buyerDid, counterId],
    );
    return rows[0] === undefined ? null : counterFromRow(rows[0]);
  }

  putCounter(counter: ReceivedCounter): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_negotiation_counters
           (buyer_did, counter_id, quote_id, round, counter_digest, counter_json, answer_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          counter.buyerDid,
          counter.counterId,
          counter.quoteId,
          counter.round,
          counter.counterDigest,
          counter.counterJson,
          counter.answerJson,
          counter.createdAt,
        ],
      ) > 0
    );
  }

  answerReserved(buyerDid: string, counterId: string, answerJson: string): boolean {
    return (
      this.db.run(
        `UPDATE commerce_negotiation_counters SET answer_json = ?
          WHERE buyer_did = ? AND counter_id = ? AND answer_json = ''`,
        [answerJson, buyerDid, counterId],
      ) > 0
    );
  }

  countCountersSince(buyerDid: string, sinceMs: number): number {
    const rows = this.db.query(
      `SELECT COUNT(*) AS n FROM commerce_negotiation_counters WHERE buyer_did = ? AND created_at >= ?`,
      [buyerDid, sinceMs],
    );
    return Number(rows[0]?.n ?? 0);
  }

  listCountersSince(buyerDid: string, sinceMs: number): { quoteId: string; answerJson: string }[] {
    return this.db
      .query(
        `SELECT quote_id, answer_json FROM commerce_negotiation_counters
          WHERE buyer_did = ? AND created_at >= ? ORDER BY created_at`,
        [buyerDid, sinceMs],
      )
      .map((row) => ({ quoteId: String(row.quote_id), answerJson: String(row.answer_json) }));
  }

  listAnswersForQuote(buyerDid: string, quoteId: string): string[] {
    return this.db
      .query(
        `SELECT answer_json FROM commerce_negotiation_counters
          WHERE buyer_did = ? AND quote_id = ? ORDER BY created_at`,
        [buyerDid, quoteId],
      )
      .map((row) => String(row.answer_json));
  }

  askOwner(question: OwnerPriceQuestion): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_negotiation_approvals
         (quote_id, line_id, buyer_did, asked_minor_units, state, task_id, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        question.quoteId,
        question.lineId,
        question.buyerDid,
        question.askedMinorUnits,
        question.state,
        question.taskId,
        question.createdAt,
        question.decidedAt,
      ],
    );
  }

  questionsForQuote(quoteId: string): OwnerPriceQuestion[] {
    return this.db
      .query(`SELECT * FROM commerce_negotiation_approvals WHERE quote_id = ? ORDER BY line_id`, [
        quoteId,
      ])
      .map(questionFromRow);
  }

  decideQuestion(
    taskId: string,
    state: Exclude<OwnerPriceState, 'pending'>,
    atMs: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE commerce_negotiation_approvals SET state = ?, decided_at = ?
          WHERE task_id = ? AND state = 'pending'`,
        [state, atMs, taskId],
      ) > 0
    );
  }

  putOutcome(outcome: QuoteOutcomeRecord): void {
    this.db.run(
      `INSERT OR IGNORE INTO commerce_quote_outcomes
         (buyer_did, quote_id, request_id, outcome, received_at)
       VALUES (?, ?, ?, ?, ?)`,
      [outcome.buyerDid, outcome.quoteId, outcome.requestId, outcome.outcome, outcome.receivedAt],
    );
  }

  outcomeFor(buyerDid: string, quoteId: string): QuoteOutcomeRecord | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_quote_outcomes WHERE buyer_did = ? AND quote_id = ?`,
      [buyerDid, quoteId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          buyerDid: String(row.buyer_did),
          quoteId: String(row.quote_id),
          requestId: String(row.request_id),
          outcome: 'not_awarded',
          receivedAt: Number(row.received_at),
        };
  }
}
