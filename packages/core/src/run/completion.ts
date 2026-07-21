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

import { isRunTerminal } from './domain';
import { getMessageRepository, type MessageRepository } from './message';
import { getRunRepository, type RunRepository } from './repository';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type CompletionStatus = 'completed' | 'failed';
export type ReceiptState = 'verified_pending' | 'advanced';

export interface CompletionReceiptRecord {
  delegation_id: string;
  message_id: string;
  run_id: string;
  status: CompletionStatus;
  result_card_ref: string | null;
  /** R3-01 — the SIGNED result-card digest (first-writer-immutable). A conflicting
   *  completion carrying a different digest is rejected before any card is stored. */
  result_card_digest: string | null;
  /** Round-A A-04 (§13) — a card that arrived while the persona was LOCKED is
   *  device-sealed into the run spool; this ref (SealedResponseRef JSON) points
   *  at the staged copy until unlock replay re-wraps it under the persona DEK
   *  and fills `result_card_ref`. */
  result_card_staged_ref: string | null;
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
  /** A-04 — receipts whose result card is still device-sealed in the spool. */
  listStagedCards(): CompletionReceiptRecord[];
  /** A-04 — unlock replay attached the persona-wrapped card: set the ref +
   *  clear the staged pointer. */
  attachResultCard(delegationId: string, contentId: string, nowMs: number): void;
  /** A-04 — clear a staged pointer whose copy was discarded/lost. */
  clearStagedCard(delegationId: string, nowMs: number): void;
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
    result_card_digest:
      row.result_card_digest === null || row.result_card_digest === undefined
        ? null
        : String(row.result_card_digest),
    result_card_staged_ref:
      row.result_card_staged_ref === null || row.result_card_staged_ref === undefined
        ? null
        : String(row.result_card_staged_ref),
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
         (delegation_id, message_id, run_id, status, result_card_ref, result_card_digest, result_card_staged_ref, receipt_state, issued_at, received_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(delegation_id) DO UPDATE SET
         status = excluded.status,
         result_card_ref = COALESCE(run_completion_receipts.result_card_ref, excluded.result_card_ref),
         result_card_staged_ref = COALESCE(run_completion_receipts.result_card_staged_ref, excluded.result_card_staged_ref),
         updated_at = excluded.updated_at`,
      // Round-C C-01 — both card references are FIRST-WRITER-MONOTONIC (existing
      // wins): a duplicate completion arriving while `verified_pending` can
      // NEITHER clobber the incumbent staged pointer (which would orphan its
      // unique key — the loser is discarded by ITS OWN ref in plane_node)
      // NOR regress an already-attached `result_card_ref` back to null (a
      // card-less resend). The null→non-null attach UPGRADE still works because
      // the upgrade path passes a record whose EXISTING ref is null, so
      // COALESCE(null, new) = new. `result_card_digest` is likewise first-writer
      // (kept out of the DO UPDATE entirely, R3-01).
      [
        r.delegation_id,
        r.message_id,
        r.run_id,
        r.status,
        r.result_card_ref,
        r.result_card_digest,
        r.result_card_staged_ref,
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

  listStagedCards(): CompletionReceiptRecord[] {
    return this.db
      .query(
        'SELECT * FROM run_completion_receipts WHERE result_card_staged_ref IS NOT NULL ORDER BY received_at ASC',
      )
      .map(rowToReceipt);
  }

  attachResultCard(delegationId: string, contentId: string, nowMs: number): void {
    // B-01 — attach KEEPS the staged pointer: the replay clears it only AFTER
    // finalize (destroy-then-ack) succeeds, so a crash between attach and
    // finalize leaves the pointer for the convergence pass, never an
    // unreachable decryptable staging copy.
    this.db.run(
      'UPDATE run_completion_receipts SET result_card_ref = ?, updated_at = ? WHERE delegation_id = ?',
      [contentId, nowMs, delegationId],
    );
  }

  clearStagedCard(delegationId: string, nowMs: number): void {
    this.db.run(
      'UPDATE run_completion_receipts SET result_card_staged_ref = NULL, updated_at = ? WHERE delegation_id = ?',
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
      // C-01 — first-writer-monotonic (mirror SQLite): existing non-null wins,
      // so a duplicate can't clobber the staged pointer or regress an attached
      // card ref to null; a null→non-null upgrade still works (existing null).
      existing.result_card_ref = existing.result_card_ref ?? r.result_card_ref;
      existing.result_card_staged_ref =
        existing.result_card_staged_ref ?? r.result_card_staged_ref;
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
  listStagedCards(): CompletionReceiptRecord[] {
    return [...this.receipts.values()]
      .filter((r) => r.result_card_staged_ref !== null)
      .sort((a, b) => a.received_at - b.received_at)
      .map((r) => ({ ...r }));
  }
  attachResultCard(delegationId: string, contentId: string, nowMs: number): void {
    // B-01 — mirror SQLite: attach keeps the staged pointer (cleared only
    // after finalize by the replay).
    const r = this.receipts.get(delegationId);
    if (r) {
      r.result_card_ref = contentId;
      r.updated_at = nowMs;
    }
  }
  clearStagedCard(delegationId: string, nowMs: number): void {
    const r = this.receipts.get(delegationId);
    if (r) {
      r.result_card_staged_ref = null;
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
  /** R3-01 — the SIGNED result-card digest. Bound to the receipt on first write
   *  (immutable); a later completion with a different digest is rejected. */
  result_card_digest?: string | null;
  /** A-04 (§13) — the device-sealed staged-card pointer when the persona was
   *  locked at arrival (SealedResponseRef JSON); attached on unlock replay. */
  result_card_staged_ref?: string | null;
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
  /** The run store, used to order a completion against the run's drain deadline
   *  (§6.2/§5.1). When wired, a completion arriving after the deadline can never
   *  CAS-advance a still-claimed message — it becomes `outcome_unknown` + evidence
   *  even if the sweeper has not run yet. */
  runRepo?: RunRepository;
  nowMsFn?: () => number;
  /** Verify the runtime-issuer signature + delegation binding (§6.2). The
   *  default is FAIL-CLOSED — an unsigned/unverified completion is rejected
   *  unless a real verifier is composed in (ISVC-8 wire verification). A
   *  fail-open default would let a forged completion advance a message, so the
   *  security contract must reject when no verifier is wired. */
  verifyReceipt?: (input: IngestCompletionInput) => boolean;
}

export class CompletionService {
  private readonly messages: MessageRepository;
  private readonly receipts: CompletionReceiptRepository;
  private readonly runs: RunRepository | null;
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
    this.runs = opts.runRepo ?? getRunRepository();
    this.now = opts.nowMsFn ?? (() => Date.now());
    // Fail-closed: with no verifier wired, reject every completion (a forged
    // completion must never advance a message).
    this.verify = opts.verifyReceipt ?? (() => false);
  }

  /** Step 1+2 (§6.2): verify + commit `verified_pending`, then attempt the
   *  inline CAS advance. */
  ingestCompletion(input: IngestCompletionInput): IngestOutcome {
    if (!this.verify(input)) return 'rejected';

    const existing = this.receipts.getByDelegationId(input.delegation_id);
    const inRef = input.result_card_ref ?? null;
    const inDigest = input.result_card_digest ?? null;
    // First-writer-immutable (§6.2/R3-01) for the OUTCOME + the SIGNED card: a second
    // completion for this delegation with a DIFFERENT status, a DIFFERENT signed card
    // DIGEST, or a DIFFERENT non-null card ref is anomalous and rejected even after
    // advancing (a conflicting `failed` after `completed`, or a swapped card, must
    // never be swallowed — nor its card attached). A null→non-null card-ref UPGRADE
    // is allowed ONLY when the signed digest MATCHES (R2-01 locked→unlock re-send):
    // the provider re-sent the SAME signed completion, so Core attaches its card
    // rather than losing it. The digest gate is what makes the upgrade safe against
    // a conflicting card that was published under this delegation id.
    if (existing !== null) {
      const statusConflict = existing.status !== input.status;
      const digestConflict =
        existing.result_card_digest !== null &&
        inDigest !== null &&
        existing.result_card_digest !== inDigest;
      const refConflict =
        existing.result_card_ref !== null && inRef !== null && existing.result_card_ref !== inRef;
      if (statusConflict || digestConflict || refConflict) return 'rejected';
    }
    if (existing?.receipt_state === 'advanced') {
      // Already advanced. A null→non-null upgrade (identical signed digest, checked
      // above) attaches the post-unlock card; anything else is a pure duplicate.
      if (existing.result_card_ref === null && inRef !== null) {
        this.receipts.upsert({ ...existing, result_card_ref: inRef, updated_at: this.now() });
        return 'advanced';
      }
      return 'duplicate';
    }

    const msg = this.messages.getById(input.message_id);
    // Mismatched delegation_id / run_id / unknown message → reject (never
    // advance). The run_id binding stops a completion signed for one run from
    // advancing a message that belongs to another run (§6.2 delegation binding).
    if (
      msg === null ||
      msg.delegation_id !== input.delegation_id ||
      msg.run_id !== input.run_id
    ) {
      return 'rejected';
    }

    const nowMs = this.now();
    this.receipts.upsert({
      delegation_id: input.delegation_id,
      message_id: input.message_id,
      run_id: input.run_id,
      status: input.status,
      result_card_ref: input.result_card_ref ?? null,
      // First-writer-immutable: keep the digest bound on the first receipt.
      result_card_digest: existing?.result_card_digest ?? inDigest,
      // A-04 — a lock-raced card's device-sealed pointer rides the receipt until
      // the unlock replay attaches the persona-wrapped copy (upsert COALESCEs).
      // C-01 — propose the input staged ref ONLY when the receipt has neither an
      // attached card nor an incumbent staged pointer; otherwise plane_node
      // sees it un-adopted and discards it (its unique key never lingers).
      result_card_staged_ref:
        existing?.result_card_ref != null || existing?.result_card_staged_ref != null
          ? null
          : input.result_card_staged_ref ?? null,
      receipt_state: 'verified_pending',
      issued_at: input.issued_at,
      received_at: nowMs,
      created_at: existing?.created_at ?? nowMs,
      updated_at: nowMs,
    });

    // Deadline ordering (§6.2/§5.1): if the run is already terminal or past its
    // `drain_deadline_at` but the sweep has not yet reconciled this still-claimed
    // message, a completion arriving now is LATE — it must NOT advance
    // dispatched→completed. Record it as append-only evidence and move the
    // message to `outcome_unknown` (the sweep's terminal reconciliation), so the
    // result is deadline-correct even under a delayed sweeper.
    if (this.runs !== null && (msg.state === 'dispatched' || msg.state === 'sending')) {
      const run = this.runs.getById(input.run_id);
      const pastDeadline =
        run !== null &&
        (isRunTerminal(run.state) ||
          (run.drain_deadline_at !== null && nowMs >= run.drain_deadline_at));
      if (pastDeadline) {
        this.messages.appendReconciliation(
          input.message_id,
          JSON.stringify({ delegation_id: input.delegation_id, status: input.status, at: nowMs, late: true }),
          nowMs,
        );
        this.messages.transition(input.message_id, msg.state, 'outcome_unknown', nowMs);
        this.receipts.markAdvanced(input.delegation_id, nowMs);
        return 'reconciliation_evidence';
      }
    }

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
    // Idempotent crash-recovery (§6.2, F13): the two-step advance is a lifecycle
    // transition FOLLOWED BY `markAdvanced`. A crash between them leaves the
    // message terminal but the receipt `verified_pending`; the recovery pass then
    // re-runs here and the `dispatched → to` CAS below fails (already terminal),
    // so the receipt would stay `verified_pending` forever and occupy the bounded
    // recovery page. If the message ALREADY reached the terminal state THIS
    // delegation implies, just finish the receipt — nothing else is re-applied.
    const existing = this.messages.getById(messageId);
    if (existing !== null && existing.delegation_id === delegationId) {
      if (existing.state === to) {
        this.receipts.markAdvanced(delegationId, nowMs);
        return true;
      }
      if (existing.state === 'outcome_unknown') {
        // A late completion already recorded as evidence + outcome_unknown, but
        // the crash hit before markAdvanced — clear the receipt without a second
        // reconciliation append.
        this.receipts.markAdvanced(delegationId, nowMs);
        return false;
      }
    }
    // Deadline ordering, crash-safe (§6.2/§5.1, R2-05): the decision is anchored
    // on the receipt's IMMUTABLE `received_at`, so it is identical whether taken
    // inline on ingestion, in the crash-recovery pass, or at the deadline
    // reconcile. A receipt RECEIVED at/after the run's `drain_deadline_at` (or on
    // a terminal run) is LATE — it can NEVER become completed/failed; it is
    // consumed as append-only evidence and the still-claimed message becomes
    // `outcome_unknown`.
    if (this.runs !== null) {
      const receipt = this.receipts.getByDelegationId(delegationId);
      const msg = this.messages.getById(messageId);
      if (receipt !== null && msg !== null && (msg.state === 'dispatched' || msg.state === 'sending')) {
        const run = this.runs.getById(msg.run_id);
        const late =
          run !== null &&
          (isRunTerminal(run.state) ||
            (run.drain_deadline_at !== null && receipt.received_at >= run.drain_deadline_at));
        if (late) {
          this.messages.appendReconciliation(
            messageId,
            JSON.stringify({ delegation_id: delegationId, status, at: nowMs, late: true }),
            nowMs,
          );
          this.messages.transition(messageId, msg.state, 'outcome_unknown', nowMs);
          this.receipts.markAdvanced(delegationId, nowMs);
          return false; // consumed as late evidence — not advanced to completed
        }
      }
    }
    // CAS keyed on the message being `dispatched` → double-advance impossible.
    if (this.messages.transition(messageId, 'dispatched', to, nowMs)) {
      this.receipts.markAdvanced(delegationId, nowMs);
      return true;
    }
    return false;
  }
}
