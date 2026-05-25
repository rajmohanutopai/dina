/**
 * Durable D2D outbox repository (issues.txt §1).
 *
 * Backs the D2D outbox with SQLCipher so queued outbound messages
 * survive mobile app kill/restart. The in-memory `outbox.ts` Map is a
 * dev/test fallback only — when a repository is installed via
 * `setD2DOutboxRepository`, every enqueue/claim/mark routes through SQL
 * and `queued: true` is reported only after a row is durably written.
 *
 * **Sync on purpose.** Like every other repository here it speaks the
 * synchronous `DatabaseAdapter` contract (see `db_adapter.ts` — SQLite
 * is CPU-bound and op-sqlite/better-sqlite3 are both synchronous). The
 * send path (`d2d/send.ts`) enqueues synchronously, so a failed SQL
 * write throws and the caller can honestly report `queued: false`
 * instead of lying about durability.
 *
 * Payload model: we persist the SEMANTIC message (target DID + type +
 * JSON body), not the sealed wire bytes. The DID document, MsgBox
 * endpoint, and recipient X25519 key are re-resolved and the envelope
 * re-sealed at retry time (drainer in `transport/retry.ts`). Storing
 * sealed bytes would strand a message whenever the recipient rotates
 * keys or moves endpoints.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/** Lifecycle of a queued D2D message. Mirrors the CHECK in the schema. */
export type D2DOutboxState = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';

/** A persisted outbox row (semantic payload, not wire bytes). */
export interface D2DOutboxRow {
  id: string;
  targetDID: string;
  messageType: string;
  bodyJson: string;
  idempotencyKey: string | null;
  state: D2DOutboxState;
  attempts: number;
  nextAttemptAt: number;
  lastAttemptAt: number | null;
  leaseUntil: number | null;
  expiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Fields needed to enqueue a new message. */
export interface D2DOutboxInsert {
  id: string;
  targetDID: string;
  messageType: string;
  bodyJson: string;
  idempotencyKey?: string | null;
  /** First-attempt time (usually `now` for immediate retry). */
  nextAttemptAt: number;
  /** Absolute terminal time; `null`/omitted = no TTL. */
  expiresAt?: number | null;
  createdAt: number;
}

export interface D2DOutboxRepository {
  /**
   * Insert a queued message. Idempotent on `idempotencyKey`: if a
   * non-terminal row already exists for that key, returns the existing
   * row WITHOUT inserting or resetting its retry state. Returns the
   * persisted (or pre-existing) row. Throws on a genuine SQL error so
   * the caller never reports a phantom `queued: true`.
   */
  insert(row: D2DOutboxInsert): D2DOutboxRow;
  get(id: string): D2DOutboxRow | null;
  findActiveByIdempotencyKey(key: string): D2DOutboxRow | null;
  /**
   * Atomically claim up to `limit` due messages: rows in `pending` or
   * `failed` whose `nextAttemptAt <= now` and which have not expired,
   * flipped to `sending` with `leaseUntil = now + leaseMs`. Returns the
   * claimed rows (already in `sending` state).
   */
  claimDue(now: number, leaseMs: number, limit: number): D2DOutboxRow[];
  /** Terminal success. */
  markSent(id: string, now: number): void;
  /** Schedule another attempt with the given backoff + recorded error. */
  markFailed(id: string, attempts: number, nextAttemptAt: number, error: string, now: number): void;
  /** Terminal failure (max attempts or expiry). */
  markDead(id: string, error: string, now: number): void;
  /**
   * Reclaim `sending` rows whose lease expired (a crash mid-send) back
   * to `pending`. Run on boot before the drainer starts. Returns count.
   */
  resetStaleSending(now: number): number;
  /** All rows in a state (tests + diagnostics). */
  listByState(state: D2DOutboxState): D2DOutboxRow[];
  /** Every row (tests + boot diagnostics). */
  listAll(): D2DOutboxRow[];
  /** Drop terminal (`sent`/`dead`) rows older than `cutoff`. Returns count. */
  deleteTerminalBefore(cutoff: number): number;
  /** Remove a single row (tests). */
  remove(id: string): boolean;
}

let repo: D2DOutboxRepository | null = null;
export function setD2DOutboxRepository(r: D2DOutboxRepository | null): void {
  repo = r;
}
export function getD2DOutboxRepository(): D2DOutboxRepository | null {
  return repo;
}

const ALL_COLUMNS =
  'id, target_did, message_type, body_json, idempotency_key, state, attempts, ' +
  'next_attempt_at, last_attempt_at, lease_until, expires_at, last_error, created_at, updated_at';

export class SQLiteD2DOutboxRepository implements D2DOutboxRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  insert(row: D2DOutboxInsert): D2DOutboxRow {
    const key = row.idempotencyKey ?? null;
    if (key !== null) {
      const existing = this.findActiveByIdempotencyKey(key);
      if (existing !== null) return existing;
    }
    try {
      this.db.execute(
        `INSERT INTO d2d_outbox
           (id, target_did, message_type, body_json, idempotency_key, state, attempts,
            next_attempt_at, last_attempt_at, lease_until, expires_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL, ?, ?)`,
        [
          row.id,
          row.targetDID,
          row.messageType,
          row.bodyJson,
          key,
          row.nextAttemptAt,
          row.expiresAt ?? null,
          row.createdAt,
          row.createdAt,
        ],
      );
    } catch (err) {
      // A concurrent enqueue of the same idempotency key lost the race to
      // the partial unique index (idx_d2d_outbox_idem_active). The message
      // IS durably queued — under the row that won — so return that rather
      // than throwing, which would make the caller falsely report the
      // message lost. (Single-process sync SQLite serialises enqueues, so
      // this is defence-in-depth for a multi-drainer future.)
      if (key !== null) {
        const winner = this.findActiveByIdempotencyKey(key);
        if (winner !== null) return winner;
      }
      throw err;
    }
    const persisted = this.get(row.id);
    if (persisted === null) {
      throw new Error(`d2d_outbox: insert of ${row.id} did not persist`);
    }
    return persisted;
  }

  get(id: string): D2DOutboxRow | null {
    const rows = this.db.query(`SELECT ${ALL_COLUMNS} FROM d2d_outbox WHERE id = ?`, [id]);
    return rows.length > 0 ? rowToOutbox(rows[0]) : null;
  }

  findActiveByIdempotencyKey(key: string): D2DOutboxRow | null {
    const rows = this.db.query(
      `SELECT ${ALL_COLUMNS} FROM d2d_outbox
        WHERE idempotency_key = ? AND state IN ('pending', 'sending', 'failed')
        LIMIT 1`,
      [key],
    );
    return rows.length > 0 ? rowToOutbox(rows[0]) : null;
  }

  claimDue(now: number, leaseMs: number, limit: number): D2DOutboxRow[] {
    const leaseUntil = now + leaseMs;
    let claimed: D2DOutboxRow[] = [];
    // One transaction so the SELECT-then-UPDATE window can't double-claim.
    this.db.transaction(() => {
      const due = this.db.query(
        `SELECT ${ALL_COLUMNS} FROM d2d_outbox
          WHERE state IN ('pending', 'failed')
            AND next_attempt_at <= ?
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY next_attempt_at ASC
          LIMIT ?`,
        [now, now, limit],
      );
      for (const r of due) {
        const id = String(r.id);
        this.db.execute(
          `UPDATE d2d_outbox SET state = 'sending', lease_until = ?, updated_at = ? WHERE id = ?`,
          [leaseUntil, now, id],
        );
      }
      claimed = due.map((r) => ({ ...rowToOutbox(r), state: 'sending', leaseUntil, updatedAt: now }));
    });
    return claimed;
  }

  markSent(id: string, now: number): void {
    this.db.execute(
      `UPDATE d2d_outbox SET state = 'sent', lease_until = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  markFailed(id: string, attempts: number, nextAttemptAt: number, error: string, now: number): void {
    this.db.execute(
      `UPDATE d2d_outbox
          SET state = 'failed', attempts = ?, next_attempt_at = ?, last_attempt_at = ?,
              lease_until = NULL, last_error = ?, updated_at = ?
        WHERE id = ?`,
      [attempts, nextAttemptAt, now, error.slice(0, 500), now, id],
    );
  }

  markDead(id: string, error: string, now: number): void {
    this.db.execute(
      `UPDATE d2d_outbox
          SET state = 'dead', lease_until = NULL, last_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
      [now, error.slice(0, 500), now, id],
    );
  }

  resetStaleSending(now: number): number {
    return this.db.run(
      `UPDATE d2d_outbox SET state = 'pending', lease_until = NULL, updated_at = ?
        WHERE state = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?`,
      [now, now],
    );
  }

  listByState(state: D2DOutboxState): D2DOutboxRow[] {
    return this.db
      .query(`SELECT ${ALL_COLUMNS} FROM d2d_outbox WHERE state = ? ORDER BY created_at ASC`, [state])
      .map(rowToOutbox);
  }

  listAll(): D2DOutboxRow[] {
    return this.db
      .query(`SELECT ${ALL_COLUMNS} FROM d2d_outbox ORDER BY created_at ASC`)
      .map(rowToOutbox);
  }

  deleteTerminalBefore(cutoff: number): number {
    return this.db.run(
      `DELETE FROM d2d_outbox WHERE state IN ('sent', 'dead') AND updated_at < ?`,
      [cutoff],
    );
  }

  remove(id: string): boolean {
    const existing = this.db.query('SELECT 1 FROM d2d_outbox WHERE id = ?', [id]);
    if (existing.length === 0) return false;
    this.db.execute('DELETE FROM d2d_outbox WHERE id = ?', [id]);
    return true;
  }
}

/**
 * In-memory implementation of the same contract — the dev/test fallback
 * used by `outbox.ts` when no SQL repository is installed. Mirrors the
 * SQLite semantics exactly (idempotency, lease-based claim, expiry
 * filtering, stale-lease reset) so the parity test can assert the two
 * behave identically. NOT durable — production must install the SQLite
 * repo (issues.txt: "In-memory outbox may remain only as test/dev
 * fallback").
 */
export class InMemoryD2DOutboxRepository implements D2DOutboxRepository {
  private rows = new Map<string, D2DOutboxRow>();

  /** Drop everything (test isolation). */
  clear(): void {
    this.rows.clear();
  }

  insert(row: D2DOutboxInsert): D2DOutboxRow {
    const key = row.idempotencyKey ?? null;
    if (key !== null) {
      const existing = this.findActiveByIdempotencyKey(key);
      if (existing !== null) return existing;
    }
    const r: D2DOutboxRow = {
      id: row.id,
      targetDID: row.targetDID,
      messageType: row.messageType,
      bodyJson: row.bodyJson,
      idempotencyKey: key,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: row.nextAttemptAt,
      lastAttemptAt: null,
      leaseUntil: null,
      expiresAt: row.expiresAt ?? null,
      lastError: null,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    };
    this.rows.set(r.id, r);
    return { ...r };
  }

  get(id: string): D2DOutboxRow | null {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }

  findActiveByIdempotencyKey(key: string): D2DOutboxRow | null {
    for (const r of this.rows.values()) {
      if (
        r.idempotencyKey === key &&
        (r.state === 'pending' || r.state === 'sending' || r.state === 'failed')
      ) {
        return { ...r };
      }
    }
    return null;
  }

  claimDue(now: number, leaseMs: number, limit: number): D2DOutboxRow[] {
    const leaseUntil = now + leaseMs;
    const due = [...this.rows.values()]
      .filter(
        (r) =>
          (r.state === 'pending' || r.state === 'failed') &&
          r.nextAttemptAt <= now &&
          (r.expiresAt === null || r.expiresAt > now),
      )
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit);
    const claimed: D2DOutboxRow[] = [];
    for (const r of due) {
      r.state = 'sending';
      r.leaseUntil = leaseUntil;
      r.updatedAt = now;
      claimed.push({ ...r });
    }
    return claimed;
  }

  markSent(id: string, now: number): void {
    const r = this.rows.get(id);
    if (!r) return;
    r.state = 'sent';
    r.leaseUntil = null;
    r.lastAttemptAt = now;
    r.updatedAt = now;
  }

  markFailed(id: string, attempts: number, nextAttemptAt: number, error: string, now: number): void {
    const r = this.rows.get(id);
    if (!r) return;
    r.state = 'failed';
    r.attempts = attempts;
    r.nextAttemptAt = nextAttemptAt;
    r.lastAttemptAt = now;
    r.leaseUntil = null;
    r.lastError = error.slice(0, 500);
    r.updatedAt = now;
  }

  markDead(id: string, error: string, now: number): void {
    const r = this.rows.get(id);
    if (!r) return;
    r.state = 'dead';
    r.leaseUntil = null;
    r.lastAttemptAt = now;
    r.lastError = error.slice(0, 500);
    r.updatedAt = now;
  }

  resetStaleSending(now: number): number {
    let count = 0;
    for (const r of this.rows.values()) {
      if (r.state === 'sending' && r.leaseUntil !== null && r.leaseUntil <= now) {
        r.state = 'pending';
        r.leaseUntil = null;
        r.updatedAt = now;
        count++;
      }
    }
    return count;
  }

  listByState(state: D2DOutboxState): D2DOutboxRow[] {
    return [...this.rows.values()]
      .filter((r) => r.state === state)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  listAll(): D2DOutboxRow[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r }));
  }

  deleteTerminalBefore(cutoff: number): number {
    let count = 0;
    for (const [id, r] of this.rows.entries()) {
      if ((r.state === 'sent' || r.state === 'dead') && r.updatedAt < cutoff) {
        this.rows.delete(id);
        count++;
      }
    }
    return count;
  }

  remove(id: string): boolean {
    return this.rows.delete(id);
  }
}

function rowToOutbox(row: DBRow): D2DOutboxRow {
  return {
    id: String(row.id ?? ''),
    targetDID: String(row.target_did ?? ''),
    messageType: String(row.message_type ?? ''),
    bodyJson: String(row.body_json ?? ''),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    state: String(row.state ?? 'pending') as D2DOutboxState,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: Number(row.next_attempt_at ?? 0),
    lastAttemptAt: row.last_attempt_at === null ? null : Number(row.last_attempt_at),
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
