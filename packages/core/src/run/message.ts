/**
 * Per-message lifecycle (Tier-0 metadata) — INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §6.3. The verified payload itself lives envelope-encrypted in the payload
 * store (ISVC-2); this is the lifecycle/routing metadata Core advances.
 *
 * Lifecycle (§6.3):
 *
 *   enqueued → classification_pending → classified ─┬─► deny        (terminal)
 *                                                    ├─► acknowledged (terminal)
 *                                                    └─► approved → risk_pending → risk_authorized
 *                                                          │            → dispatch_pending → sending
 *                                                          │              → dispatched → completed|failed
 *                                                          └─► policy_refused (terminal)
 *   undecided/classification_pending/risk_pending/risk_authorized/unclaimed dispatch_pending
 *     + fencing/expiry/deadline ─► cancelled | expired
 *   dispatched ─(timeout)─► outcome_unknown  (+ append-only reconciliation evidence)
 *
 * Action messages get the Tier-2 base directly (Brain is never consulted for
 * action loudness, §9.1); informational messages carry a Brain `tier_candidate`.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type MessageKind = 'informational' | 'action';

export type MessageState =
  | 'enqueued'
  | 'classification_pending'
  | 'classified'
  | 'deny'
  | 'acknowledged'
  | 'approved'
  | 'risk_pending'
  | 'risk_authorized'
  | 'policy_refused'
  | 'dispatch_pending'
  | 'sending'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled'
  | 'expired';

export const MESSAGE_TERMINAL_STATES: ReadonlySet<MessageState> = new Set<MessageState>([
  'deny',
  'acknowledged',
  'policy_refused',
  'completed',
  'failed',
  'outcome_unknown',
  'cancelled',
  'expired',
]);

/** States that count as enqueued-but-undecided for `outstanding` (§7). */
export const ENQUEUED_UNDECIDED_STATES: ReadonlySet<MessageState> = new Set<MessageState>([
  'enqueued',
  'classification_pending',
  'classified',
]);

/** States a fencing barrier / expiry / deadline cancels-or-expires now (§5.1).
 *  `approved` is included: an owner-approved action rests here until the run
 *  engine risk-gates it, so it is UNCLAIMED and must be fenced (VERIF #1). */
export const FENCEABLE_STATES: ReadonlySet<MessageState> = new Set<MessageState>([
  'enqueued',
  'classification_pending',
  'classified',
  'approved',
  'risk_pending',
  'risk_authorized',
  'dispatch_pending',
]);

/** Allowed lifecycle transitions (the state machine). */
const VALID_TRANSITIONS: Readonly<Record<MessageState, readonly MessageState[]>> = Object.freeze({
  enqueued: ['classification_pending', 'cancelled', 'expired'],
  classification_pending: ['classified', 'cancelled', 'expired'],
  classified: ['deny', 'acknowledged', 'approved', 'cancelled', 'expired'],
  deny: [],
  acknowledged: [],
  approved: ['risk_pending', 'cancelled', 'expired'],
  risk_pending: ['risk_authorized', 'policy_refused', 'cancelled', 'expired'],
  risk_authorized: ['dispatch_pending', 'cancelled', 'expired'],
  policy_refused: [],
  dispatch_pending: ['sending', 'cancelled', 'expired'],
  // sending → outcome_unknown: a claimed-but-not-yet-confirmed delegation at the
  // drain deadline (§5.1 "already-claimed → outcome_unknown").
  sending: ['dispatched', 'failed', 'outcome_unknown'],
  dispatched: ['completed', 'failed', 'outcome_unknown'],
  completed: [],
  failed: [],
  outcome_unknown: [],
  cancelled: [],
  expired: [],
} satisfies Record<MessageState, readonly MessageState[]>);

export function isValidMessageTransition(from: MessageState, to: MessageState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isMessageTerminal(state: MessageState): boolean {
  return MESSAGE_TERMINAL_STATES.has(state);
}

/** Owner decision on a classified message. */
export type MessageDecision = 'approve' | 'deny' | 'acknowledge';

/** Which source set the final delivery tier (§9.1). */
export type TierSource = 'action_base' | 'brain_candidate' | 'classify_timeout_ceiling';

export interface MessageRecord {
  message_id: string;
  run_id: string;
  reservation_id: string | null;
  dedup_key: string;
  sequence: number;
  kind: MessageKind;
  action_type: string | null;
  risk_class: string | null;
  state: MessageState;
  decision: MessageDecision | null;
  decision_revision: number;
  delegation_id: string | null;
  /** the message's own signed expiry (§6.3), ms. */
  expires_at: number;
  payload_ref: string | null;
  /** The provider-signed, plaintext-verified content digest (`card_digest`,
   *  E76-05/06) — a STABLE content identity (unlike the randomized ciphertext id
   *  in `payload_ref`). Used for the classify-view digest + same-dedup content
   *  rejection. Null for a message stored before this field existed. */
  content_digest: string | null;
  tier_candidate: number | null;
  final_tier: number | null;
  tier_source: TierSource | null;
  /** append-only late-completion reconciliation evidence (JSON array). */
  reconciliation_evidence: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRepository {
  create(msg: MessageRecord): void;
  getById(messageId: string): MessageRecord | null;
  listByRun(runId: string): MessageRecord[];
  countEnqueuedUndecided(runId: string): number;

  /**
   * R5-05 — distinct run ids with at least one message in a DISPATCH-actionable
   * state (`approved` | `risk_authorized` | `sending`), ordered by each run's
   * OLDEST actionable message so the dispatcher visits the most-overdue action
   * first. Bounds the per-tick fan-out WITHOUT hiding a later run's action behind
   * older idle runs — the fix for the fixed-run-page starvation class. A
   * dispatched message leaves these states, so the set self-drains across ticks.
   */
  listRunIdsWithActionableMessages(limit: number): string[];

  /** CAS lifecycle transition, validated against the state machine. Returns
   *  true iff the message was in `from` AND the edge is allowed. */
  transition(messageId: string, from: MessageState, to: MessageState, nowMs: number): boolean;

  /** Set the delivery tier fields (§9.1). */
  setTier(
    messageId: string,
    fields: { tier_candidate?: number; final_tier?: number; tier_source?: TierSource },
    nowMs: number,
  ): void;

  /** Record the owner decision (classified → approved/deny/acknowledged) with a
   *  fresh decision_revision, atomically. Returns true iff it was `classified`. */
  decide(
    messageId: string,
    decision: MessageDecision,
    decisionRevision: number,
    nowMs: number,
  ): boolean;

  setDelegationId(messageId: string, delegationId: string, nowMs: number): boolean;
  appendReconciliation(messageId: string, evidenceJson: string, nowMs: number): void;

  /** Fence every FENCEABLE message of a run to `terminal` (a fencing barrier /
   *  expiry / deadline, §5.1). Returns the fenced message ids. */
  fenceOpen(runId: string, terminal: 'cancelled' | 'expired', nowMs: number): string[];

  /** 81B-07 — expire every PRE-dispatch decidable message of a run whose OWN
   *  `expires_at` has passed, or (when the RUN's hard bound has passed) all of
   *  them, to `expired`. Runs before decisions are surfaced + before admission
   *  accounting so a stale message is never offered nor counted. Returns the
   *  expired ids; idempotent (already-terminal rows are untouched). */
  /**
   * Expire every decidable message past its own or the run's hard bound and
   * return their ids. R2-03 — `onExpired` (if supplied) runs INSIDE the same
   * commit as the message-state update, so a caller can fence each expired
   * message's classification job atomically (message-expire + job-cancel are one
   * transaction; a crash can't leave a terminal message with a live pending job).
   * The callback's writes must target the SAME db adapter to join the transaction.
   */
  expireDecidable(
    runId: string,
    nowMs: number,
    runExpiresAt: number,
    onExpired?: (expiredIds: string[]) => void,
  ): string[];

  size(): number;
}

const COLS = [
  'message_id',
  'run_id',
  'reservation_id',
  'dedup_key',
  'sequence',
  'kind',
  'action_type',
  'risk_class',
  'state',
  'decision',
  'decision_revision',
  'delegation_id',
  'expires_at',
  'payload_ref',
  'content_digest',
  'tier_candidate',
  'final_tier',
  'tier_source',
  'reconciliation_evidence',
  'created_at',
  'updated_at',
] as const;

function decisionTargetState(decision: MessageDecision): MessageState {
  switch (decision) {
    case 'approve':
      return 'approved';
    case 'deny':
      return 'deny';
    case 'acknowledge':
      return 'acknowledged';
  }
}

function rowToMsg(row: DBRow): MessageRecord {
  const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    message_id: String(row.message_id),
    run_id: String(row.run_id),
    reservation_id: s(row.reservation_id),
    dedup_key: String(row.dedup_key),
    sequence: Number(row.sequence),
    kind: String(row.kind) as MessageKind,
    action_type: s(row.action_type),
    risk_class: s(row.risk_class),
    state: String(row.state) as MessageState,
    decision: s(row.decision) as MessageDecision | null,
    decision_revision: Number(row.decision_revision),
    delegation_id: s(row.delegation_id),
    expires_at: Number(row.expires_at),
    payload_ref: s(row.payload_ref),
    content_digest: s(row.content_digest),
    tier_candidate: n(row.tier_candidate),
    final_tier: n(row.final_tier),
    tier_source: s(row.tier_source) as TierSource | null,
    reconciliation_evidence: String(row.reconciliation_evidence ?? '[]'),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const FENCEABLE_SQL =
  "('enqueued','classification_pending','classified','approved','risk_pending','risk_authorized','dispatch_pending')";
const UNDECIDED_SQL = "('enqueued','classification_pending','classified')";
// 81B-07 + round-A A-09 — pre-CLAIM states that expire on their own/the run's
// hard bound. `approved`/`risk_authorized` are included: past expiry the
// dispatch guard refuses the claim anyway (an expired action must never
// dispatch), so without a terminal transition the row would stay "actionable"
// forever — rescanned every engine tick and never crypto-shredded. Only a
// CLAIMED effect (`sending`/`dispatched`) and the lock-held `dispatch_pending`
// re-arm survive expiry, reconciled by the drain deadline instead (§6.3/§9).
const EXPIRABLE_SQL =
  "('enqueued','classification_pending','classified','risk_pending','approved','risk_authorized')";

export class SQLiteMessageRepository implements MessageRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(msg: MessageRecord): void {
    const placeholders = COLS.map(() => '?').join(', ');
    this.db.execute(
      `INSERT INTO run_messages (${COLS.join(', ')}) VALUES (${placeholders})`,
      COLS.map((c) => {
        const v = msg[c as keyof MessageRecord];
        return v ?? null;
      }),
    );
  }

  getById(messageId: string): MessageRecord | null {
    const rows = this.db.query('SELECT * FROM run_messages WHERE message_id = ? LIMIT 1', [messageId]);
    return rows.length > 0 ? rowToMsg(rows[0]) : null;
  }

  listByRun(runId: string): MessageRecord[] {
    return this.db
      .query('SELECT * FROM run_messages WHERE run_id = ? ORDER BY sequence ASC', [runId])
      .map(rowToMsg);
  }

  listRunIdsWithActionableMessages(limit: number): string[] {
    return this.db
      .query<{ run_id: string }>(
        `SELECT run_id FROM run_messages
          WHERE state IN ('approved', 'risk_authorized', 'sending')
          GROUP BY run_id
          ORDER BY MIN(created_at) ASC
          LIMIT ?`,
        [limit],
      )
      .map((r) => String(r.run_id));
  }

  countEnqueuedUndecided(runId: string): number {
    const rows = this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_messages WHERE run_id = ? AND state IN ${UNDECIDED_SQL}`,
      [runId],
    );
    return rows[0]?.n ?? 0;
  }

  transition(messageId: string, from: MessageState, to: MessageState, nowMs: number): boolean {
    if (!isValidMessageTransition(from, to)) return false;
    return (
      this.db.run('UPDATE run_messages SET state = ?, updated_at = ? WHERE message_id = ? AND state = ?', [
        to,
        nowMs,
        messageId,
        from,
      ]) > 0
    );
  }

  setTier(
    messageId: string,
    fields: { tier_candidate?: number; final_tier?: number; tier_source?: TierSource },
    nowMs: number,
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [nowMs];
    if (fields.tier_candidate !== undefined) {
      sets.push('tier_candidate = ?');
      params.push(fields.tier_candidate);
    }
    if (fields.final_tier !== undefined) {
      sets.push('final_tier = ?');
      params.push(fields.final_tier);
    }
    if (fields.tier_source !== undefined) {
      sets.push('tier_source = ?');
      params.push(fields.tier_source);
    }
    params.push(messageId);
    this.db.run(`UPDATE run_messages SET ${sets.join(', ')} WHERE message_id = ?`, params);
  }

  decide(
    messageId: string,
    decision: MessageDecision,
    decisionRevision: number,
    nowMs: number,
  ): boolean {
    return (
      this.db.run(
        "UPDATE run_messages SET state = ?, decision = ?, decision_revision = ?, updated_at = ? WHERE message_id = ? AND state = 'classified'",
        [decisionTargetState(decision), decision, decisionRevision, nowMs, messageId],
      ) > 0
    );
  }

  setDelegationId(messageId: string, delegationId: string, nowMs: number): boolean {
    return (
      this.db.run('UPDATE run_messages SET delegation_id = ?, updated_at = ? WHERE message_id = ?', [
        delegationId,
        nowMs,
        messageId,
      ]) > 0
    );
  }

  appendReconciliation(messageId: string, evidenceJson: string, nowMs: number): void {
    const msg = this.getById(messageId);
    if (msg === null) return;
    let arr: unknown[];
    try {
      arr = JSON.parse(msg.reconciliation_evidence) as unknown[];
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
    arr.push(JSON.parse(evidenceJson));
    this.db.run('UPDATE run_messages SET reconciliation_evidence = ?, updated_at = ? WHERE message_id = ?', [
      JSON.stringify(arr),
      nowMs,
      messageId,
    ]);
  }

  fenceOpen(runId: string, terminal: 'cancelled' | 'expired', nowMs: number): string[] {
    const ids = this.db
      .query<{ message_id: string }>(
        `SELECT message_id FROM run_messages WHERE run_id = ? AND state IN ${FENCEABLE_SQL}`,
        [runId],
      )
      .map((r) => String(r.message_id));
    this.db.run(
      `UPDATE run_messages SET state = ?, updated_at = ? WHERE run_id = ? AND state IN ${FENCEABLE_SQL}`,
      [terminal, nowMs, runId],
    );
    return ids;
  }

  expireDecidable(
    runId: string,
    nowMs: number,
    runExpiresAt: number,
    onExpired?: (expiredIds: string[]) => void,
  ): string[] {
    // `? <= ?` (runExpiresAt <= nowMs) is a whole-run bound; `expires_at <= ?` is
    // per-message. Either makes a decidable row terminal-`expired`.
    const where = `run_id = ? AND state IN ${EXPIRABLE_SQL} AND (expires_at <= ? OR ? <= ?)`;
    const ids = this.db
      .query<{ message_id: string }>(`SELECT message_id FROM run_messages WHERE ${where}`, [
        runId,
        nowMs,
        runExpiresAt,
        nowMs,
      ])
      .map((r) => String(r.message_id));
    if (ids.length > 0) {
      // R2-03 — the message-state UPDATE and the caller's job-fencing (onExpired)
      // commit together: statements on the same db adapter join this transaction,
      // so a crash can never leave an `expired` message with a live `pending` job.
      this.db.transaction(() => {
        this.db.run(`UPDATE run_messages SET state = 'expired', updated_at = ? WHERE ${where}`, [
          nowMs,
          runId,
          nowMs,
          runExpiresAt,
          nowMs,
        ]);
        if (onExpired !== undefined) onExpired(ids);
      });
    }
    return ids;
  }

  size(): number {
    const rows = this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM run_messages');
    return rows[0]?.n ?? 0;
  }
}

export class InMemoryMessageRepository implements MessageRepository {
  private readonly rows = new Map<string, MessageRecord>();

  create(msg: MessageRecord): void {
    this.rows.set(msg.message_id, { ...msg });
  }
  getById(messageId: string): MessageRecord | null {
    const r = this.rows.get(messageId);
    return r ? { ...r } : null;
  }
  listByRun(runId: string): MessageRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.run_id === runId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((r) => ({ ...r }));
  }
  listRunIdsWithActionableMessages(limit: number): string[] {
    const oldestByRun = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (r.state === 'approved' || r.state === 'risk_authorized' || r.state === 'sending') {
        const prev = oldestByRun.get(r.run_id);
        if (prev === undefined || r.created_at < prev) oldestByRun.set(r.run_id, r.created_at);
      }
    }
    return [...oldestByRun.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([runId]) => runId);
  }
  countEnqueuedUndecided(runId: string): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.run_id === runId && ENQUEUED_UNDECIDED_STATES.has(r.state)) n++;
    }
    return n;
  }
  transition(messageId: string, from: MessageState, to: MessageState, nowMs: number): boolean {
    if (!isValidMessageTransition(from, to)) return false;
    const r = this.rows.get(messageId);
    if (!r || r.state !== from) return false;
    r.state = to;
    r.updated_at = nowMs;
    return true;
  }
  setTier(
    messageId: string,
    fields: { tier_candidate?: number; final_tier?: number; tier_source?: TierSource },
    nowMs: number,
  ): void {
    const r = this.rows.get(messageId);
    if (!r) return;
    if (fields.tier_candidate !== undefined) r.tier_candidate = fields.tier_candidate;
    if (fields.final_tier !== undefined) r.final_tier = fields.final_tier;
    if (fields.tier_source !== undefined) r.tier_source = fields.tier_source;
    r.updated_at = nowMs;
  }
  decide(
    messageId: string,
    decision: MessageDecision,
    decisionRevision: number,
    nowMs: number,
  ): boolean {
    const r = this.rows.get(messageId);
    if (!r || r.state !== 'classified') return false;
    r.state = decisionTargetState(decision);
    r.decision = decision;
    r.decision_revision = decisionRevision;
    r.updated_at = nowMs;
    return true;
  }
  setDelegationId(messageId: string, delegationId: string, nowMs: number): boolean {
    const r = this.rows.get(messageId);
    if (!r) return false;
    r.delegation_id = delegationId;
    r.updated_at = nowMs;
    return true;
  }
  appendReconciliation(messageId: string, evidenceJson: string, nowMs: number): void {
    const r = this.rows.get(messageId);
    if (!r) return;
    let arr: unknown[];
    try {
      arr = JSON.parse(r.reconciliation_evidence) as unknown[];
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
    arr.push(JSON.parse(evidenceJson));
    r.reconciliation_evidence = JSON.stringify(arr);
    r.updated_at = nowMs;
  }
  fenceOpen(runId: string, terminal: 'cancelled' | 'expired', nowMs: number): string[] {
    const out: string[] = [];
    for (const r of this.rows.values()) {
      if (r.run_id === runId && FENCEABLE_STATES.has(r.state)) {
        out.push(r.message_id);
        r.state = terminal;
        r.updated_at = nowMs;
      }
    }
    return out;
  }
  expireDecidable(
    runId: string,
    nowMs: number,
    runExpiresAt: number,
    onExpired?: (expiredIds: string[]) => void,
  ): string[] {
    const expirable = new Set<MessageState>([
      'enqueued',
      'classification_pending',
      'classified',
      'risk_pending',
      'approved',
      'risk_authorized',
    ]);
    const runExpired = runExpiresAt <= nowMs;
    const out: string[] = [];
    for (const r of this.rows.values()) {
      if (
        r.run_id === runId &&
        expirable.has(r.state) &&
        (r.expires_at <= nowMs || runExpired)
      ) {
        out.push(r.message_id);
        r.state = 'expired';
        r.updated_at = nowMs;
      }
    }
    // R2-03 — fence in the same synchronous step (in-memory has no crash window).
    if (out.length > 0 && onExpired !== undefined) onExpired(out);
    return out;
  }
  size(): number {
    return this.rows.size;
  }
}

let repo: MessageRepository | null = null;
export function setMessageRepository(r: MessageRepository | null): void {
  repo = r;
}
export function getMessageRepository(): MessageRepository | null {
  return repo;
}
