/**
 * Idempotency receipts and per-principal budgets for inbound A2A
 * (design §4.1, §7.2 steps 5–6).
 *
 * A receipt is keyed by (principal, operation, message id) and holds the
 * hash of the request as sent, the hash of what will execute, and the task
 * id the call was answered with. Ingress reads it BEFORE rate limiting and
 * every gate: the same call again (same hash) gets the same task back; the
 * same message id with a different request is a conflict that changes
 * nothing. A receipt is written in the same commit as the operation it
 * answers, refusals included, so a replay of a refused call is refused the
 * same way.
 *
 * Budgets are per principal, in memory, over a sliding minute: a call that
 * is new spends the normal budget; a replay answered from its receipt spends
 * a separate ceiling ten times larger; a read or a cancel (GetTask,
 * ListTasks, CancelTask) spends a third budget of the same size. Beyond
 * any, the caller is told to slow down and nothing else happens. The gateway
 * limits per IP at its own edge; Core exempts the gateway's routes from its
 * per-address limiter and the gateway's DID from its per-DID bucket, and
 * these budgets do the per-client limiting, so one busy client cannot
 * starve the others.
 */

import type { A2AStore } from './store';

/** New calls per principal per minute (production default). */
export const A2A_PRINCIPAL_BUDGET_PER_MINUTE = 60;
/** Replays per principal per minute, answered from receipts. */
export const A2A_REPLAY_CEILING_PER_MINUTE = A2A_PRINCIPAL_BUDGET_PER_MINUTE * 10;
/** Reads and cancels (GetTask, ListTasks, CancelTask) per principal per minute. */
export const A2A_READ_BUDGET_PER_MINUTE = A2A_PRINCIPAL_BUDGET_PER_MINUTE * 10;
/** At most this many principals are tracked; the quietest is dropped first. */
export const MAX_TRACKED_PRINCIPALS = 10_000;
const WINDOW_MS = 60_000;

export interface ReceiptRow {
  principal: string;
  operation: string;
  message_id: string;
  request_hash_pre: string;
  request_hash_post: string | null;
  mapped_external_id: string;
  status: string;
  created_at: number;
}

export function findReceipt(store: A2AStore, principal: string, operation: string, messageId: string): ReceiptRow | null {
  const rows = store.db.query(
    'SELECT * FROM a2a_idempotency_receipts WHERE principal = ? AND operation = ? AND message_id = ?',
    [principal, operation, messageId],
  ) as unknown as ReceiptRow[];
  return rows[0] ?? null;
}

/** Write a receipt. Call inside the commit that creates what it maps to. */
export function insertReceipt(store: A2AStore, row: ReceiptRow): void {
  store.db.execute(
    `INSERT INTO a2a_idempotency_receipts
       (principal, operation, message_id, request_hash_pre, request_hash_post, mapped_external_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.principal,
      row.operation,
      row.message_id,
      row.request_hash_pre,
      row.request_hash_post,
      row.mapped_external_id,
      row.status,
      row.created_at,
    ],
  );
}

export type ReceiptCheck =
  | { kind: 'miss' }
  | { kind: 'replay'; receipt: ReceiptRow }
  | { kind: 'conflict' };

/** Step 5: the receipt decides before anything else may. */
export function checkReceipt(
  store: A2AStore,
  key: { principal: string; operation: string; messageId: string },
  requestHashPre: string,
): ReceiptCheck {
  const receipt = findReceipt(store, key.principal, key.operation, key.messageId);
  if (receipt === null) return { kind: 'miss' };
  return receipt.request_hash_pre === requestHashPre ? { kind: 'replay', receipt } : { kind: 'conflict' };
}

/** Sliding-minute budgets per principal, one for new calls and one for replays. */
export class PrincipalBudgets {
  private readonly misses = new Map<string, number[]>();
  private readonly replays = new Map<string, number[]>();
  private readonly reads = new Map<string, number[]>();

  constructor(
    private readonly limits: { perMinute: number; replayPerMinute: number; readPerMinute: number } = {
      perMinute: A2A_PRINCIPAL_BUDGET_PER_MINUTE,
      replayPerMinute: A2A_REPLAY_CEILING_PER_MINUTE,
      readPerMinute: A2A_READ_BUDGET_PER_MINUTE,
    },
  ) {}

  /** Spend one new call; false when the principal is over its budget. */
  chargeMiss(principal: string, nowMs: number): boolean {
    return this.charge(this.misses, principal, this.limits.perMinute, nowMs);
  }

  /** Spend one replay; false when the principal is over its replay ceiling. */
  chargeReplay(principal: string, nowMs: number): boolean {
    return this.charge(this.replays, principal, this.limits.replayPerMinute, nowMs);
  }

  /** Spend one read or cancel; false when the principal is over its read budget. */
  chargeRead(principal: string, nowMs: number): boolean {
    return this.charge(this.reads, principal, this.limits.readPerMinute, nowMs);
  }

  private charge(book: Map<string, number[]>, principal: string, limit: number, nowMs: number): boolean {
    const recent = (book.get(principal) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    if (recent.length >= limit) {
      book.set(principal, recent);
      return false;
    }
    recent.push(nowMs);
    book.delete(principal); // re-insert so iteration order is least-recently-used first
    book.set(principal, recent);
    if (book.size > MAX_TRACKED_PRINCIPALS) {
      const oldest = book.keys().next().value;
      if (oldest !== undefined) book.delete(oldest);
    }
    return true;
  }
}
