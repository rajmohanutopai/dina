/**
 * Brain's turns for kinds outside the shelf engine (COMMITMENT_KERNEL §15
 * step 11): a goods buyer's counter target, a shipper's fee, a group's slot.
 *
 * One row per turn, asked once. `result_json` keeps what Core needs to act on
 * the answer without asking the other side again (the request a shipper is
 * answering, the tender member a counter is for); once the move is applied
 * the row keeps Brain's answer, so a resend gets the same one. A turn not
 * answered within its kind's wait is closed `fallen_back`, and the fixed
 * style plays it.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

export type StrategyTurnState = 'pending' | 'applied' | 'fallen_back';

export interface StrategyTurn {
  kind: string;
  negotiationId: string;
  turn: number;
  taskId: string;
  state: StrategyTurnState;
  /** Pending: what Core needs to act on the answer. Applied: the answer too. */
  result: Record<string, unknown>;
  createdAt: number;
}

export class StrategyTurnStore {
  constructor(private readonly db: DatabaseAdapter) {}

  get(kind: string, negotiationId: string, turn: number): StrategyTurn | null {
    const row = this.db.query(
      `SELECT * FROM commitment_strategy_turns WHERE kind = ? AND negotiation_id = ? AND turn = ?`,
      [kind, negotiationId, turn],
    )[0];
    return row === undefined ? null : fromRow(row);
  }

  /** Record a turn handed to the strategy; false when it was asked already. */
  put(row: Omit<StrategyTurn, 'state'>): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commitment_strategy_turns
           (kind, negotiation_id, turn, task_id, state, result_json, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [
          row.kind,
          row.negotiationId,
          row.turn,
          row.taskId,
          JSON.stringify(row.result),
          row.createdAt,
        ],
      ) > 0
    );
  }

  /** Close a pending turn once; false when it was closed already (a replayed commit). */
  close(
    kind: string,
    negotiationId: string,
    turn: number,
    state: 'applied' | 'fallen_back',
    result?: Record<string, unknown>,
  ): boolean {
    const current = this.get(kind, negotiationId, turn);
    if (current === null || current.state !== 'pending') return false;
    return (
      this.db.run(
        `UPDATE commitment_strategy_turns SET state = ?, result_json = ?
          WHERE kind = ? AND negotiation_id = ? AND turn = ? AND state = 'pending'`,
        [state, JSON.stringify(result ?? current.result), kind, negotiationId, turn],
      ) > 0
    );
  }

  /** Keep more with a pending turn (a verdict already charged, say); false when it is closed. */
  note(
    kind: string,
    negotiationId: string,
    turn: number,
    result: Record<string, unknown>,
  ): boolean {
    return (
      this.db.run(
        `UPDATE commitment_strategy_turns SET result_json = ?
          WHERE kind = ? AND negotiation_id = ? AND turn = ? AND state = 'pending'`,
        [JSON.stringify(result), kind, negotiationId, turn],
      ) > 0
    );
  }

  /**
   * Hand a pending turn to the strategy again (the owner answered its
   * question): the new job, its wait counted from now. False when it is closed.
   */
  restart(
    kind: string,
    negotiationId: string,
    turn: number,
    args: { taskId: string; result: Record<string, unknown>; nowMs: number },
  ): boolean {
    return (
      this.db.run(
        `UPDATE commitment_strategy_turns SET task_id = ?, result_json = ?, created_at = ?
          WHERE kind = ? AND negotiation_id = ? AND turn = ? AND state = 'pending'`,
        [args.taskId, JSON.stringify(args.result), args.nowMs, kind, negotiationId, turn],
      ) > 0
    );
  }

  /** Turns of a kind still pending that were asked before `beforeMs`. */
  stale(kind: string, beforeMs: number): StrategyTurn[] {
    return this.db
      .query(
        `SELECT * FROM commitment_strategy_turns WHERE kind = ? AND state = 'pending' AND created_at < ?`,
        [kind, beforeMs],
      )
      .map(fromRow);
  }
}

function fromRow(row: Record<string, unknown>): StrategyTurn {
  const state = String(row.state);
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.result_json || '{}')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      result = parsed as Record<string, unknown>;
  } catch {
    result = {};
  }
  return {
    kind: String(row.kind),
    negotiationId: String(row.negotiation_id),
    turn: Number(row.turn),
    taskId: String(row.task_id),
    state: state === 'applied' || state === 'fallen_back' ? state : 'pending',
    result,
    createdAt: Number(row.created_at),
  };
}
