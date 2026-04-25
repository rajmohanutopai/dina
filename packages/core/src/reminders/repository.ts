/**
 * Reminder SQL repository — backs reminder CRUD with SQLite.
 *
 * **Phase 2.3 (task 2.3).** Port methods return `Promise<T>`. SQLite
 * under go-sqlcipher is sync internally; the `async` keyword wraps
 * each sync result in a resolved Promise — zero microtask overhead
 * beyond one promise per call. Service-layer `createReminder()` in
 * `reminders/service.ts` keeps its sync signature via fire-and-forget
 * write-through (same pattern as AuditRepository / DeviceRepository).
 *
 * Source: ARCHITECTURE.md — op-sqlite persistence layer
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { Reminder } from './service';

export interface ReminderRepository {
  create(reminder: Reminder): Promise<void>;
  get(id: string): Promise<Reminder | null>;
  listPending(nowMs: number): Promise<Reminder[]>;
  listByPersona(persona: string): Promise<Reminder[]>;
  /**
   * Return every persisted row regardless of status / completion / due_at.
   * Used by `hydrateRemindersFromRepo()` on boot to rebuild the in-memory
   * Map from SQL — without this, the Map starts empty after every cold
   * start and reminders persisted in prior sessions are invisible to the
   * UI even though SQL still has them.
   */
  listAll(): Promise<Reminder[]>;
  update(id: string, updates: Partial<Reminder>): Promise<void>;
  remove(id: string): Promise<boolean>;
}

let repo: ReminderRepository | null = null;
export function setReminderRepository(r: ReminderRepository | null): void {
  repo = r;
}
export function getReminderRepository(): ReminderRepository | null {
  return repo;
}

export class SQLiteReminderRepository implements ReminderRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(r: Reminder): Promise<void> {
    this.db.execute(
      `INSERT OR IGNORE INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.short_id,
        r.message,
        r.due_at,
        r.persona,
        r.kind,
        r.source_item_id,
        r.source,
        r.recurring,
        r.timezone,
        r.status,
        r.completed,
        r.created_at,
      ],
    );
  }

  async get(id: string): Promise<Reminder | null> {
    const rows = this.db.query('SELECT * FROM reminders WHERE id = ?', [id]);
    return rows.length > 0 ? rowToReminder(rows[0]) : null;
  }

  async listPending(nowMs: number): Promise<Reminder[]> {
    const rows = this.db.query(
      'SELECT * FROM reminders WHERE completed = 0 AND status = ? AND due_at <= ? ORDER BY due_at ASC',
      ['pending', nowMs],
    );
    return rows.map(rowToReminder);
  }

  async listByPersona(persona: string): Promise<Reminder[]> {
    const rows = this.db.query('SELECT * FROM reminders WHERE persona = ?', [persona]);
    return rows.map(rowToReminder);
  }

  async listAll(): Promise<Reminder[]> {
    const rows = this.db.query('SELECT * FROM reminders ORDER BY due_at ASC');
    return rows.map(rowToReminder);
  }

  async update(id: string, updates: Partial<Reminder>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.completed !== undefined) {
      sets.push('completed = ?');
      params.push(updates.completed);
    }
    if (updates.due_at !== undefined) {
      sets.push('due_at = ?');
      params.push(updates.due_at);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.execute(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.db.query('SELECT 1 FROM reminders WHERE id = ?', [id]);
    if (existing.length === 0) return false;
    this.db.execute('DELETE FROM reminders WHERE id = ?', [id]);
    return true;
  }
}

function rowToReminder(row: DBRow): Reminder {
  const id = String(row.id ?? '');
  return {
    id,
    short_id: String(row.short_id ?? id.slice(4, 8)), // fallback: first 4 chars after 'rem-'
    message: String(row.message ?? ''),
    due_at: Number(row.due_at ?? 0),
    persona: String(row.persona ?? 'general'),
    kind: String(row.kind ?? 'manual'),
    source_item_id: String(row.source_item_id ?? ''),
    source: String(row.source ?? ''),
    recurring: String(row.recurring ?? '') as Reminder['recurring'],
    timezone: String(row.timezone ?? ''),
    status: String(row.status ?? 'pending'),
    completed: Number(row.completed ?? 0),
    created_at: Number(row.created_at ?? 0),
  };
}
