/**
 * Scratchpad repository — durable checkpoint storage for multi-step
 * reasoning tasks. One row per task_id; every `checkpoint` is an
 * upsert (merge semantics on conflict). Stale rows get swept by the
 * 24h sweeper + proactively on read.
 *
 * Port of Python's `brain/src/service/scratchpad.py` storage model
 * + main-dina's `core/internal/adapter/sqlite/scratchpad.go` SQL
 * contract. The service-layer service in `./service.ts` calls into
 * this repo; the HTTP route handler in `server/routes/scratchpad.ts`
 * glues it to `/v1/scratchpad`.
 *
 * Two backends:
 *   - `SQLiteScratchpadRepository` — production.
 *   - `InMemoryScratchpadRepository` — tests + early boot when
 *     SQLite isn't wired yet.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface ScratchpadEntry {
  taskId: string;
  step: number;
  context: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadRepository {
  /** UPSERT — insert on first sight, overwrite step+context on
   *  conflict. `createdAt` is preserved across updates; `updatedAt`
   *  is bumped on every call. */
  upsert(taskId: string, step: number, context: Record<string, unknown>, nowMs: number): void;
  /** Read the latest checkpoint for `taskId`. Returns null when
   *  absent or when the stored row is older than `staleMs` (TTL). */
  get(taskId: string, nowMs: number, staleMs: number): ScratchpadEntry | null;
  /** Delete a single row. Safe to call on a missing id. */
  remove(taskId: string): void;
  /** Sweep stale rows (updatedAt older than `nowMs - staleMs`).
   *  Returns the number of deleted rows for telemetry. */
  sweep(nowMs: number, staleMs: number): number;
}

let registered: ScratchpadRepository | null = null;

export function setScratchpadRepository(r: ScratchpadRepository | null): void {
  registered = r;
}

export function getScratchpadRepository(): ScratchpadRepository | null {
  return registered;
}

export class SQLiteScratchpadRepository implements ScratchpadRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  upsert(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
    nowMs: number,
  ): void {
    const contextJson = JSON.stringify(context);
    this.db.run(
      `INSERT INTO scratchpad (task_id, step, context, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         step = excluded.step,
         context = excluded.context,
         updated_at = excluded.updated_at`,
      [taskId, step, contextJson, nowMs, nowMs],
    );
  }

  get(taskId: string, nowMs: number, staleMs: number): ScratchpadEntry | null {
    const rows = this.db.query(
      `SELECT task_id, step, context, created_at, updated_at
       FROM scratchpad
       WHERE task_id = ?
       LIMIT 1`,
      [taskId],
    );
    if (rows.length === 0) return null;
    const row = rows[0] as DBRow;
    const entry = rowToEntry(row);
    if (nowMs - entry.updatedAt >= staleMs) {
      // Proactively evict so the next writer re-inserts with a fresh
      // createdAt (matches Python's "fresh start" contract).
      this.remove(taskId);
      return null;
    }
    return entry;
  }

  remove(taskId: string): void {
    this.db.run(`DELETE FROM scratchpad WHERE task_id = ?`, [taskId]);
  }

  sweep(nowMs: number, staleMs: number): number {
    const cutoff = nowMs - staleMs;
    const rows = this.db.query(
      `SELECT COUNT(*) as n FROM scratchpad WHERE updated_at < ?`,
      [cutoff],
    );
    const count = rows.length > 0 ? Number((rows[0] as DBRow).n ?? 0) : 0;
    if (count > 0) {
      this.db.run(`DELETE FROM scratchpad WHERE updated_at < ?`, [cutoff]);
    }
    return count;
  }
}

/**
 * In-memory backend — test-time + early-boot fallback. Honours the
 * same TTL semantics as the SQLite backend so tests that target
 * either implementation behave identically.
 */
export class InMemoryScratchpadRepository implements ScratchpadRepository {
  private readonly rows = new Map<string, ScratchpadEntry>();

  upsert(
    taskId: string,
    step: number,
    context: Record<string, unknown>,
    nowMs: number,
  ): void {
    const existing = this.rows.get(taskId);
    this.rows.set(taskId, {
      taskId,
      step,
      context,
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
    });
  }

  get(taskId: string, nowMs: number, staleMs: number): ScratchpadEntry | null {
    const entry = this.rows.get(taskId);
    if (!entry) return null;
    if (nowMs - entry.updatedAt >= staleMs) {
      this.rows.delete(taskId);
      return null;
    }
    return entry;
  }

  remove(taskId: string): void {
    this.rows.delete(taskId);
  }

  sweep(nowMs: number, staleMs: number): number {
    const cutoff = nowMs - staleMs;
    let n = 0;
    for (const [id, entry] of this.rows) {
      if (entry.updatedAt < cutoff) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

function rowToEntry(row: DBRow): ScratchpadEntry {
  let context: Record<string, unknown> = {};
  const raw = row.context;
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        context = parsed as Record<string, unknown>;
      }
    } catch {
      /* corrupt json → empty context, caller gets a clean slate */
    }
  }
  return {
    taskId: String(row.task_id),
    step: Number(row.step ?? 0),
    context,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
