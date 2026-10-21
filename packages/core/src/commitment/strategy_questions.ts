/**
 * Brain's questions to the owner mid-deal (COMMITMENT_KERNEL §15 step 11).
 *
 * A strategy may answer its turn with a yes-or-no question for the owner. The
 * question goes on a card; the turn waits (the stale-turn sweep leaves it
 * alone) until the owner answers or the card lapses. A yes or a no goes into
 * the next brief and the turn is asked again; a lapse lets the fixed style
 * play. Nothing binds while a question is open.
 *
 * At most `MAX_OWNER_QUESTIONS` per negotiation: a strategy cannot keep the
 * owner answering instead of bargaining.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

export const MAX_OWNER_QUESTIONS = 2;

/** The longest question a card shows. */
export const MAX_QUESTION_LENGTH = 280;

/** The longest a question waits for the owner, whatever the deal's own deadline. */
export const QUESTION_WAIT_MS = 24 * 60 * 60 * 1000;

/** A question the owner would have less than this to answer is not put. */
export const LEAST_QUESTION_WAIT_MS = 5 * 60 * 1000;

export type OwnerAnswer = 'yes' | 'no' | 'lapsed';

export interface StrategyQuestion {
  kind: string;
  negotiationId: string;
  turn: number;
  askNo: number;
  question: string;
  cardId: string;
  answer: OwnerAnswer | null;
  askedAt: number;
  answeredAt: number | null;
}

/** A question as a strategy wrote it, made fit for a card; null when there is none. */
export function cleanQuestion(raw: string): string | null {
  // One line, no control characters, bounded: the card shows it as given.
  const text = Array.from(raw, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : ch;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > MAX_QUESTION_LENGTH ? `${text.slice(0, MAX_QUESTION_LENGTH - 1)}…` : text;
}

export class StrategyQuestionStore {
  constructor(private readonly db: DatabaseAdapter) {}

  /** Questions asked in one negotiation, any turn. */
  countFor(kind: string, negotiationId: string): number {
    const row = this.db.query(
      `SELECT COUNT(*) AS n FROM commitment_strategy_questions WHERE kind = ? AND negotiation_id = ?`,
      [kind, negotiationId],
    )[0];
    return Number(row?.n ?? 0);
  }

  /** Record a question; false when this turn already has one open. */
  ask(row: Omit<StrategyQuestion, 'answer' | 'answeredAt' | 'askNo'>): boolean {
    if (this.openFor(row.kind, row.negotiationId, row.turn) !== null) return false;
    const askNo = this.countFor(row.kind, row.negotiationId) + 1;
    this.db.execute(
      `INSERT INTO commitment_strategy_questions
         (kind, negotiation_id, turn, ask_no, question, card_id, answer, asked_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      [row.kind, row.negotiationId, row.turn, askNo, row.question, row.cardId, row.askedAt],
    );
    return true;
  }

  /** The question a turn is waiting on, if any. */
  openFor(kind: string, negotiationId: string, turn: number): StrategyQuestion | null {
    const row = this.db.query(
      `SELECT * FROM commitment_strategy_questions
        WHERE kind = ? AND negotiation_id = ? AND turn = ? AND answer IS NULL`,
      [kind, negotiationId, turn],
    )[0];
    return row === undefined ? null : fromRow(row);
  }

  /** Questions still waiting in one negotiation, any turn. */
  openIn(kind: string, negotiationId: string): StrategyQuestion[] {
    return this.db
      .query(
        `SELECT * FROM commitment_strategy_questions
          WHERE kind = ? AND negotiation_id = ? AND answer IS NULL`,
        [kind, negotiationId],
      )
      .map(fromRow);
  }

  /** Every question still waiting, of the kinds named: what boot looks over. */
  openOf(kinds: readonly string[]): StrategyQuestion[] {
    if (kinds.length === 0) return [];
    return this.db
      .query(
        `SELECT * FROM commitment_strategy_questions
          WHERE answer IS NULL AND kind IN (${kinds.map(() => '?').join(', ')})`,
        [...kinds],
      )
      .map(fromRow);
  }

  byCard(cardId: string): StrategyQuestion | null {
    const row = this.db.query(`SELECT * FROM commitment_strategy_questions WHERE card_id = ?`, [
      cardId,
    ])[0];
    return row === undefined ? null : fromRow(row);
  }

  /** Settle an open question once; false when it was settled already. */
  answer(cardId: string, answer: OwnerAnswer, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE commitment_strategy_questions SET answer = ?, answered_at = ?
          WHERE card_id = ? AND answer IS NULL`,
        [answer, nowMs, cardId],
      ) > 0
    );
  }

  /** The owner's answers in one negotiation, in the order asked: what the next brief carries. */
  answered(kind: string, negotiationId: string): { question: string; answer: 'yes' | 'no' }[] {
    return this.db
      .query(
        `SELECT question, answer FROM commitment_strategy_questions
          WHERE kind = ? AND negotiation_id = ? AND answer IN ('yes', 'no')
          ORDER BY ask_no`,
        [kind, negotiationId],
      )
      .map((row) => ({
        question: String(row.question),
        answer: row.answer === 'yes' ? 'yes' : 'no',
      }));
  }
}

function fromRow(row: Record<string, unknown>): StrategyQuestion {
  const answer = row.answer;
  return {
    kind: String(row.kind),
    negotiationId: String(row.negotiation_id),
    turn: Number(row.turn),
    askNo: Number(row.ask_no),
    question: String(row.question),
    cardId: String(row.card_id),
    answer: answer === 'yes' || answer === 'no' || answer === 'lapsed' ? answer : null,
    askedAt: Number(row.asked_at),
    answeredAt:
      row.answered_at === null || row.answered_at === undefined ? null : Number(row.answered_at),
  };
}
