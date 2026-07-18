/**
 * Completion-receipt store + the two-step idempotent-CAS advancement
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §6.2).
 *
 * A provider's runtime-issuer-signed completion returns through the delegation's
 * signed return path and lands here keyed by `delegation_id`. Advancement is
 * two-step, NOT a single claimed-atomic transaction: on the ingestion event Core
 * verifies + commits the receipt as `verified_pending`, then attempts an inline
 * CAS advance of the message lifecycle (`dispatched → completed|failed`). If
 * contended / crash-interleaved, the receipt stays `verified_pending` and a
 * separate idempotent recovery pass performs the CAS advance exactly once.
 * Because the advance is a CAS keyed on `delegation_id` (via the message state),
 * double-advance is impossible. A validly-signed LATE completion (after
 * `outcome_unknown`/termination) is preserved as append-only reconciliation
 * evidence. Forged/unsigned/replayed/mismatched are rejected.
 */

import { getMessageRepository, type MessageRepository } from './message';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type CompletionStatus = 'completed' | 'failed';
export type ReceiptState = 'verified_pending' | 'advanced';

export interface CompletionReceiptRecord {
  delegation_id: string;
  message_id: string;
  run_id: string;
  status: CompletionStatus;
  result_card_ref: string | null;
  receipt_state: ReceiptState;
  issued_at: number;
  received_at: number;
  created_at: number;
  updated_at: number;
}

export interface CompletionReceiptRepository {
  upsert(receipt: CompletionReceiptRecord): void;
  getByDelegationId(delegationId: string): CompletionReceiptRecord | null;
  listVerifiedPending(limit?: number): CompletionReceiptRecord[];
  markAdvanced(delegationId: string, nowMs: number): void;
  size(): number;
}

function rowToReceipt(row: DBRow): CompletionReceiptRecord {
  return {
    delegation_id: String(row.delegation_id),
    message_id: String(row.message_id),
    run_id: String(row.run_id),
    status: String(row.status) as CompletionStatus,
    result_card_ref:
      row.result_card_ref === null || row.result_card_ref === undefined ? null : String(row.result_card_ref),
    receipt_state: String(row.receipt_state) as ReceiptState,
    issued_at: Number(row.issued_at),
    received_at: Number(row.received_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class SQLiteCompletionReceiptRepository implements CompletionReceiptRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  upsert(r: CompletionReceiptRecord): void {
    this.db.run(
      `INSERT INTO run_completion_receipts
         (delegation_id, message_id, run_id, status, result_card_ref, receipt_state, issued_at, received_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(delegation_id) DO UPDATE SET
         status = excluded.status, result_card_ref = excluded.result_card_ref, updated_at = excluded.updated_at`,
      [
        r.delegation_id,
        r.message_id,
        r.run_id,
        r.status,
        r.result_card_ref,
        r.receipt_state,
        r.issued_at,
        r.received_at,
        r.created_at,
        r.updated_at,
      ],
    );
  }

  getByDelegationId(delegationId: string): CompletionReceiptRecord | null {
    const rows = this.db.query('SELECT * FROM run_completion_receipts WHERE delegation_id = ? LIMIT 1', [
      delegationId,
    ]);
    return rows.length > 0 ? rowToReceipt(rows[0]) : null;
  }

  listVerifiedPending(limit = 64): CompletionReceiptRecord[] {
    return this.db
      .query(
        "SELECT * FROM run_completion_receipts WHERE receipt_state = 'verified_pending' ORDER BY received_at ASC LIMIT ?",
        [limit],
      )
      .map(rowToReceipt);
  }

  markAdvanced(delegationId: string, nowMs: number): void {
    this.db.run(
      "UPDATE run_completion_receipts SET receipt_state = 'advanced', updated_at = ? WHERE delegation_id = ?",
      [nowMs, delegationId],
    );
  }

  size(): number {
    const rows = this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM run_completion_receipts');
    return rows[0]?.n ?? 0;
  }
}

export class InMemoryCompletionReceiptRepository implements CompletionReceiptRepository {
  private readonly receipts = new Map<string, CompletionReceiptRecord>();
  upsert(r: CompletionReceiptRecord): void {
    const existing = this.receipts.get(r.delegation_id);
    if (existing) {
      existing.status = r.status;
      existing.result_card_ref = r.result_card_ref;
      existing.updated_at = r.updated_at;
    } else {
      this.receipts.set(r.delegation_id, { ...r });
    }
  }
  getByDelegationId(delegationId: string): CompletionReceiptRecord | null {
    const r = this.receipts.get(delegationId);
    return r ? { ...r } : null;
  }
  listVerifiedPending(limit = 64): CompletionReceiptRecord[] {
    return [...this.receipts.values()]
      .filter((r) => r.receipt_state === 'verified_pending')
      .sort((a, b) => a.received_at - b.received_at)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  markAdvanced(delegationId: string, nowMs: number): void {
    const r = this.receipts.get(delegationId);
    if (r) {
      r.receipt_state = 'advanced';
      r.updated_at = nowMs;
    }
  }
  size(): number {
    return this.receipts.size;
  }
}

let repo: CompletionReceiptRepository | null = null;
export function setCompletionReceiptRepository(r: CompletionReceiptRepository | null): void {
  repo = r;
}
export function getCompletionReceiptRepository(): CompletionReceiptRepository | null {
  return repo;
}

// ---------------------------------------------------------------------------
// The completion advancement service
// ---------------------------------------------------------------------------

export interface IngestCompletionInput {
  delegation_id: string;
  message_id: string;
  run_id: string;
  status: CompletionStatus;
  result_card_ref?: string | null;
  issued_at: number;
}

export type IngestOutcome =
  | 'advanced'
  | 'verified_pending'
  | 'reconciliation_evidence'
  | 'duplicate'
  | 'rejected';

export interface CompletionServiceOptions {
  messageRepo?: MessageRepository;
  receiptRepo?: CompletionReceiptRepository;
  nowMsFn?: () => number;
  /** Verify the runtime-issuer signature + delegation binding (§6.2). Default
   *  accepts (the wire signature verification is composed in — ISVC-8). */
  verifyReceipt?: (input: IngestCompletionInput) => boolean;
}

export class CompletionService {
  private readonly messages: MessageRepository;
  private readonly receipts: CompletionReceiptRepository;
  private readonly now: () => number;
  private readonly verify: (input: IngestCompletionInput) => boolean;

  constructor(opts: CompletionServiceOptions = {}) {
    const messages = opts.messageRepo ?? getMessageRepository();
    const receipts = opts.receiptRepo ?? getCompletionReceiptRepository();
    if (messages === null || receipts === null) {
      throw new Error('CompletionService: message + receipt repositories must be wired');
    }
    this.messages = messages;
    this.receipts = receipts;
    this.now = opts.nowMsFn ?? (() => Date.now());
    this.verify = opts.verifyReceipt ?? (() => true);
  }

  /** Step 1+2 (§6.2): verify + commit `verified_pending`, then attempt the
   *  inline CAS advance. */
  ingestCompletion(input: IngestCompletionInput): IngestOutcome {
    if (!this.verify(input)) return 'rejected';

    const existing = this.receipts.getByDelegationId(input.delegation_id);
    if (existing?.receipt_state === 'advanced') return 'duplicate';

    const msg = this.messages.getById(input.message_id);
    // mismatched delegation_id / unknown message → reject (never advance).
    if (msg === null || msg.delegation_id !== input.delegation_id) return 'rejected';

    const nowMs = this.now();
    this.receipts.upsert({
      delegation_id: input.delegation_id,
      message_id: input.message_id,
      run_id: input.run_id,
      status: input.status,
      result_card_ref: input.result_card_ref ?? null,
      receipt_state: 'verified_pending',
      issued_at: input.issued_at,
      received_at: nowMs,
      created_at: existing?.created_at ?? nowMs,
      updated_at: nowMs,
    });

    // Late completion (message already terminal, e.g. outcome_unknown) →
    // append-only reconciliation evidence; the receipt is consumed as evidence.
    if (['outcome_unknown', 'cancelled', 'expired', 'completed', 'failed'].includes(msg.state)) {
      this.messages.appendReconciliation(
        input.message_id,
        JSON.stringify({ delegation_id: input.delegation_id, status: input.status, at: nowMs }),
        nowMs,
      );
      this.receipts.markAdvanced(input.delegation_id, nowMs);
      return 'reconciliation_evidence';
    }

    return this.tryAdvance(input.delegation_id, input.message_id, input.status, nowMs)
      ? 'advanced'
      : 'verified_pending';
  }

  /** The idempotent recovery pass (crash backstop, §6.2): advance every
   *  `verified_pending` receipt whose message is still `dispatched`. */
  recoverAdvance(): number {
    let advanced = 0;
    const nowMs = this.now();
    for (const r of this.receipts.listVerifiedPending()) {
      if (this.tryAdvance(r.delegation_id, r.message_id, r.status, nowMs)) advanced++;
    }
    return advanced;
  }

  /**
   * Reconcile a claimed message at the drain deadline (§6.2/§5.1). If a
   * `verified_pending` receipt exists, advance it first (a completion that
   * arrived before the deadline is never mis-recorded); otherwise the still-claimed
   * message becomes `outcome_unknown`.
   */
  reconcileAtDeadline(messageId: string): 'advanced' | 'outcome_unknown' | 'noop' {
    const msg = this.messages.getById(messageId);
    if (msg === null || (msg.state !== 'sending' && msg.state !== 'dispatched')) return 'noop';
    const nowMs = this.now();
    if (msg.delegation_id !== null) {
      const receipt = this.receipts.getByDelegationId(msg.delegation_id);
      if (receipt?.receipt_state === 'verified_pending') {
        // A completion that arrived before the deadline is never mis-recorded
        // (§6.2). If the message is still `sending` (claimed, send unconfirmed),
        // move it to `dispatched` first so the CAS advance can fire (VERIF #4).
        if (msg.state === 'sending') this.messages.transition(messageId, 'sending', 'dispatched', nowMs);
        if (this.tryAdvance(receipt.delegation_id, messageId, receipt.status, nowMs)) return 'advanced';
      }
    }
    // no completion → outcome_unknown (already-claimed, unknown external outcome).
    if (msg.state === 'dispatched') {
      this.messages.transition(messageId, 'dispatched', 'outcome_unknown', nowMs);
    } else {
      this.messages.transition(messageId, 'sending', 'outcome_unknown', nowMs);
    }
    return 'outcome_unknown';
  }

  private tryAdvance(delegationId: string, messageId: string, status: CompletionStatus, nowMs: number): boolean {
    const to = status === 'completed' ? 'completed' : 'failed';
    // CAS keyed on the message being `dispatched` → double-advance impossible.
    if (this.messages.transition(messageId, 'dispatched', to, nowMs)) {
      this.receipts.markAdvanced(delegationId, nowMs);
      return true;
    }
    return false;
  }
}
