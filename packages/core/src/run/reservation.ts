/**
 * Reservation store (Tier-0) — the atomic bounded-queue admission slot
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§13).
 *
 * In PULL mode Core opens a `reserved` slot BEFORE fetching, then either commits
 * it (a verified message enqueued) or releases it (fetch error / barrier raced).
 * A lock-raced fetch becomes `held_by_lock` (ISVC-6); a detected staged-blob
 * loss becomes `response_lost` (ISVC-6); an owner skip of a lost item is
 * terminal `skipped`. `reserved` + `held_by_lock` are the OPEN reservations that
 * count toward `outstanding` (§7). All mutating methods are CAS-guarded,
 * single-statement (so the admission service can compose them inside one Tier-0
 * transaction — the enqueue-commit CAS).
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type ReservationState =
  | 'reserved'
  | 'committed'
  | 'released'
  | 'held_by_lock'
  | 'response_lost'
  | 'skipped';

/** States that count as an OPEN reservation for `outstanding` (§7). */
export const OPEN_RESERVATION_STATES: ReadonlySet<ReservationState> = new Set<ReservationState>([
  'reserved',
  'held_by_lock',
]);

export interface ReservationRecord {
  reservation_id: string;
  run_id: string;
  /** pull read-idempotency identity (the run's fetch_cursor at reservation). */
  cursor: number;
  state: ReservationState;
  message_id: string | null;
  dedup_key: string | null;
  content_digest: string | null;
  /** held_by_lock: spool blob id + digest (ISVC-6). */
  sealed_response_ref: string | null;
  /** held_by_lock: the verified message's Tier-0 metadata (id, sequence,
   *  dedup_key, kind, action_type, expires_at, content_digest) as JSON, so the
   *  unlock replay can run the SAME guarded enqueue-commit the live ingest uses.
   *  Metadata only — the payload itself lives Core-sealed in the spool. */
  held_message_json: string | null;
  error_reason: string | null;
  error_at: number | null;
  /** not applied to held_by_lock (§7). */
  lease_expires_at: number | null;
  query_correlation_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CommitReservationInput {
  message_id: string;
  dedup_key: string;
  content_digest: string;
}

export interface ReservationRepository {
  create(res: ReservationRecord): void;
  getById(reservationId: string): ReservationRecord | null;
  listByRun(runId: string): ReservationRecord[];
  /** Count of OPEN reservations (reserved + held_by_lock) for a run. */
  countOpen(runId: string): number;

  /** Stamp the correlation id the pacer tags its `service.query` with, so the
   *  provider's response can be matched back to this slot (§7). CAS on `reserved`
   *  (a committed/released slot is never re-tagged). Returns true iff stamped. */
  setQueryCorrelation(reservationId: string, correlationId: string, nowMs: number): boolean;
  /** The reserved slot awaiting the response for this correlation id (§7). Returns
   *  null if none (already committed / invalidated / unknown id). */
  getByCorrelation(correlationId: string): ReservationRecord | null;

  /** CAS `from → committed` (default from `reserved`), stamping the wire ids —
   *  the enqueue-commit linearization point. `from: 'held_by_lock'` is the
   *  unlock-replay commit (§7): the SAME CAS, entered from the held state. */
  commit(
    reservationId: string,
    input: CommitReservationInput,
    nowMs: number,
    from?: 'reserved' | 'held_by_lock',
  ): boolean;

  /** CAS `reserved → released` (fetch error / barrier raced). */
  release(reservationId: string, nowMs: number): boolean;

  /** CAS `reserved → held_by_lock` (ISVC-6 §7): a lock-raced verified response
   *  whose ciphertext was DURABLY staged in the spool first. Stamps the
   *  `sealed_response_ref` + the message metadata the replay needs. */
  holdByLock(
    reservationId: string,
    sealedResponseRefJson: string,
    heldMessageJson: string,
    nowMs: number,
  ): boolean;

  /** CAS `held_by_lock → response_lost` (§7): the staged blob is unrecoverable
   *  (missing/corrupt/shredded). Persists the detected reason. */
  markResponseLost(reservationId: string, reason: string, nowMs: number): boolean;

  /** CAS `response_lost → skipped` (owner `skip_lost_reservation`, terminal). */
  skipLost(reservationId: string, nowMs: number): boolean;

  /** Every `held_by_lock` reservation (unlock replay + boot recovery). */
  listHeldByLock(): ReservationRecord[];

  /** Invalidate every OPEN reservation of a run (barrier / termination, §5.1):
   *  reserved/held_by_lock → released. Returns the invalidated records so the
   *  caller can crypto-shred any staged ciphertext (ISVC-6). */
  invalidateOpen(runId: string, nowMs: number): ReservationRecord[];

  /** Reclaim lease-expired `reserved` slots (a crashed fetch, §7). `held_by_lock`
   *  is NEVER lease-reclaimed (it holds a durable Core-sealed response). Returns
   *  the count reclaimed. */
  reclaimLeaseExpired(nowMs: number): number;

  size(): number;
}

const COLS = [
  'reservation_id',
  'run_id',
  'cursor',
  'state',
  'message_id',
  'dedup_key',
  'content_digest',
  'sealed_response_ref',
  'held_message_json',
  'error_reason',
  'error_at',
  'lease_expires_at',
  'query_correlation_id',
  'created_at',
  'updated_at',
] as const;

function rowToRes(row: DBRow): ReservationRecord {
  const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    reservation_id: String(row.reservation_id),
    run_id: String(row.run_id),
    cursor: Number(row.cursor),
    state: String(row.state) as ReservationState,
    message_id: s(row.message_id),
    dedup_key: s(row.dedup_key),
    content_digest: s(row.content_digest),
    sealed_response_ref: s(row.sealed_response_ref),
    held_message_json: s(row.held_message_json),
    error_reason: s(row.error_reason),
    error_at: n(row.error_at),
    lease_expires_at: n(row.lease_expires_at),
    query_correlation_id: s(row.query_correlation_id),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class SQLiteReservationRepository implements ReservationRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(res: ReservationRecord): void {
    const placeholders = COLS.map(() => '?').join(', ');
    this.db.execute(
      `INSERT INTO run_reservations (${COLS.join(', ')}) VALUES (${placeholders})`,
      COLS.map((c) => res[c as keyof ReservationRecord] ?? null),
    );
  }

  getById(reservationId: string): ReservationRecord | null {
    const rows = this.db.query('SELECT * FROM run_reservations WHERE reservation_id = ? LIMIT 1', [
      reservationId,
    ]);
    return rows.length > 0 ? rowToRes(rows[0]) : null;
  }

  listByRun(runId: string): ReservationRecord[] {
    return this.db
      .query('SELECT * FROM run_reservations WHERE run_id = ? ORDER BY cursor ASC', [runId])
      .map(rowToRes);
  }

  countOpen(runId: string): number {
    const rows = this.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM run_reservations WHERE run_id = ? AND state IN ('reserved','held_by_lock')",
      [runId],
    );
    return rows[0]?.n ?? 0;
  }

  commit(
    reservationId: string,
    input: CommitReservationInput,
    nowMs: number,
    from: 'reserved' | 'held_by_lock' = 'reserved',
  ): boolean {
    return (
      this.db.run(
        `UPDATE run_reservations
           SET state = 'committed', message_id = ?, dedup_key = ?, content_digest = ?, updated_at = ?
         WHERE reservation_id = ? AND state = ?`,
        [input.message_id, input.dedup_key, input.content_digest, nowMs, reservationId, from],
      ) > 0
    );
  }

  release(reservationId: string, nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE run_reservations SET state = 'released', updated_at = ? WHERE reservation_id = ? AND state = 'reserved'",
        [nowMs, reservationId],
      ) > 0
    );
  }

  holdByLock(
    reservationId: string,
    sealedResponseRefJson: string,
    heldMessageJson: string,
    nowMs: number,
  ): boolean {
    return (
      this.db.run(
        `UPDATE run_reservations
           SET state = 'held_by_lock', sealed_response_ref = ?, held_message_json = ?, updated_at = ?
         WHERE reservation_id = ? AND state = 'reserved'`,
        [sealedResponseRefJson, heldMessageJson, nowMs, reservationId],
      ) > 0
    );
  }

  markResponseLost(reservationId: string, reason: string, nowMs: number): boolean {
    return (
      this.db.run(
        `UPDATE run_reservations
           SET state = 'response_lost', error_reason = ?, error_at = ?, updated_at = ?
         WHERE reservation_id = ? AND state = 'held_by_lock'`,
        [reason, nowMs, nowMs, reservationId],
      ) > 0
    );
  }

  skipLost(reservationId: string, nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE run_reservations SET state = 'skipped', updated_at = ? WHERE reservation_id = ? AND state = 'response_lost'",
        [nowMs, reservationId],
      ) > 0
    );
  }

  listHeldByLock(): ReservationRecord[] {
    return this.db
      .query("SELECT * FROM run_reservations WHERE state = 'held_by_lock' ORDER BY cursor ASC")
      .map(rowToRes);
  }

  setQueryCorrelation(reservationId: string, correlationId: string, nowMs: number): boolean {
    return (
      this.db.run(
        "UPDATE run_reservations SET query_correlation_id = ?, updated_at = ? WHERE reservation_id = ? AND state = 'reserved'",
        [correlationId, nowMs, reservationId],
      ) > 0
    );
  }

  getByCorrelation(correlationId: string): ReservationRecord | null {
    const rows = this.db.query(
      'SELECT * FROM run_reservations WHERE query_correlation_id = ? LIMIT 1',
      [correlationId],
    );
    return rows.length > 0 ? rowToRes(rows[0]) : null;
  }

  invalidateOpen(runId: string, nowMs: number): ReservationRecord[] {
    const open = this.db
      .query(
        "SELECT * FROM run_reservations WHERE run_id = ? AND state IN ('reserved','held_by_lock')",
        [runId],
      )
      .map(rowToRes);
    this.db.run(
      "UPDATE run_reservations SET state = 'released', updated_at = ? WHERE run_id = ? AND state IN ('reserved','held_by_lock')",
      [nowMs, runId],
    );
    return open;
  }

  reclaimLeaseExpired(nowMs: number): number {
    return this.db.run(
      "UPDATE run_reservations SET state = 'released', updated_at = ? WHERE state = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
      [nowMs, nowMs],
    );
  }

  size(): number {
    const rows = this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM run_reservations');
    return rows[0]?.n ?? 0;
  }
}

export class InMemoryReservationRepository implements ReservationRepository {
  private readonly rows = new Map<string, ReservationRecord>();

  create(res: ReservationRecord): void {
    this.rows.set(res.reservation_id, { ...res });
  }
  getById(reservationId: string): ReservationRecord | null {
    const r = this.rows.get(reservationId);
    return r ? { ...r } : null;
  }
  listByRun(runId: string): ReservationRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.run_id === runId)
      .sort((a, b) => a.cursor - b.cursor)
      .map((r) => ({ ...r }));
  }
  countOpen(runId: string): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.run_id === runId && OPEN_RESERVATION_STATES.has(r.state)) n++;
    }
    return n;
  }
  commit(
    reservationId: string,
    input: CommitReservationInput,
    nowMs: number,
    from: 'reserved' | 'held_by_lock' = 'reserved',
  ): boolean {
    const r = this.rows.get(reservationId);
    if (!r || r.state !== from) return false;
    r.state = 'committed';
    r.message_id = input.message_id;
    r.dedup_key = input.dedup_key;
    r.content_digest = input.content_digest;
    r.updated_at = nowMs;
    return true;
  }
  release(reservationId: string, nowMs: number): boolean {
    const r = this.rows.get(reservationId);
    if (!r || r.state !== 'reserved') return false;
    r.state = 'released';
    r.updated_at = nowMs;
    return true;
  }
  holdByLock(
    reservationId: string,
    sealedResponseRefJson: string,
    heldMessageJson: string,
    nowMs: number,
  ): boolean {
    const r = this.rows.get(reservationId);
    if (!r || r.state !== 'reserved') return false;
    r.state = 'held_by_lock';
    r.sealed_response_ref = sealedResponseRefJson;
    r.held_message_json = heldMessageJson;
    r.updated_at = nowMs;
    return true;
  }
  markResponseLost(reservationId: string, reason: string, nowMs: number): boolean {
    const r = this.rows.get(reservationId);
    if (!r || r.state !== 'held_by_lock') return false;
    r.state = 'response_lost';
    r.error_reason = reason;
    r.error_at = nowMs;
    r.updated_at = nowMs;
    return true;
  }
  skipLost(reservationId: string, nowMs: number): boolean {
    const r = this.rows.get(reservationId);
    if (!r || r.state !== 'response_lost') return false;
    r.state = 'skipped';
    r.updated_at = nowMs;
    return true;
  }
  listHeldByLock(): ReservationRecord[] {
    return [...this.rows.values()]
      .filter((r) => r.state === 'held_by_lock')
      .sort((a, b) => a.cursor - b.cursor)
      .map((r) => ({ ...r }));
  }
  setQueryCorrelation(reservationId: string, correlationId: string, nowMs: number): boolean {
    const r = this.rows.get(reservationId);
    if (!r || r.state !== 'reserved') return false;
    r.query_correlation_id = correlationId;
    r.updated_at = nowMs;
    return true;
  }
  getByCorrelation(correlationId: string): ReservationRecord | null {
    for (const r of this.rows.values()) {
      if (r.query_correlation_id === correlationId) return { ...r };
    }
    return null;
  }
  invalidateOpen(runId: string, nowMs: number): ReservationRecord[] {
    const out: ReservationRecord[] = [];
    for (const r of this.rows.values()) {
      if (r.run_id === runId && OPEN_RESERVATION_STATES.has(r.state)) {
        out.push({ ...r });
        r.state = 'released';
        r.updated_at = nowMs;
      }
    }
    return out;
  }
  reclaimLeaseExpired(nowMs: number): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.state === 'reserved' && r.lease_expires_at !== null && r.lease_expires_at < nowMs) {
        r.state = 'released';
        r.updated_at = nowMs;
        n++;
      }
    }
    return n;
  }
  size(): number {
    return this.rows.size;
  }
}

let repo: ReservationRepository | null = null;
export function setReservationRepository(r: ReservationRepository | null): void {
  repo = r;
}
export function getReservationRepository(): ReservationRepository | null {
  return repo;
}
