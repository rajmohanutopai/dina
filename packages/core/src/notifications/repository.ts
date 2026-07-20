/**
 * Notification-log repository — pluggable backing for Brain's inbox
 * store (task 5.66).
 *
 * Brain owns the runtime store (`packages/brain/src/notifications/inbox.ts`).
 * This module exposes the **interface + in-memory implementation**
 * the inbox dual-writes through. A persistence layer (SQLite, kv_store,
 * something else) can implement this interface later and install
 * itself via `setNotificationLogRepository`.
 *
 * Contract: append upserts on `id`; markRead is one-shot (returns
 * false on second ack); listAll is newest-first; purgeBefore drops
 * rows older than the cutoff (preferring explicit `expiresAt` when
 * present). reset wipes for tests + identity reset.
 *
 * **Guided-demo scoping (now carried, R4-03).** The stored row carries
 * `dataScope` and the SQLite table a `data_scope` column, so a persisted
 * notification keeps its scope. `purgeByScopePrefix('guided_demo:')` lets the
 * inbox's `dropGuidedDemoNotifications` drop persisted demo rows on teardown —
 * a demo notification never survives the demo in the durable log. The inbox's
 * `storedToItem` carries `dataScope` back instead of defaulting to `'user'`.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type NotificationKind =
  | 'reminder'
  | 'approval'
  | 'nudge'
  | 'briefing'
  | 'ask_approval'
  // Interactive-run decision (INTERACTIVE_SERVICES_ARCHITECTURE.md §3.1) and
  // standalone push notification (PUSH_SERVICES_ARCHITECTURE.md §8/§15).
  | 'run'
  | 'push';

export interface StoredNotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  firedAt: number;
  readAt: number | null;
  sourceId: string;
  /** Optional in-app deep link (e.g. `dina://chat/main?focus=msg-abc`). */
  deepLink: string | null;
  /** Optional explicit TTL — when null, the periodic sweeper falls back
   *  to `cleanupPeriodDays` from settings. */
  expiresAt: number | null;
  /** Data scope (`'user'` or `'guided_demo:<run_id>'`). Persisted so a demo
   *  notification stays scoped and can be purged on demo teardown (R4-03). */
  dataScope: string;
}

/**
 * R5-08 — the snake_case WIRE shape for a notification crossing an HTTP/SSE
 * boundary. Internal code keeps camelCase (`StoredNotificationItem`); every wire
 * hop maps through this so the "all JSON is snake_case" invariant holds and
 * other-language protocol clients interoperate.
 */
export interface NotificationWireDTO {
  id: string;
  kind: string;
  title: string;
  body: string;
  fired_at: number;
  read_at: number | null;
  source_id: string;
  deep_link: string | null;
  expires_at: number | null;
  data_scope: string;
}

/** camelCase stored row → snake_case wire DTO. */
export function storedNotificationToWire(item: StoredNotificationItem): NotificationWireDTO {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    fired_at: item.firedAt,
    read_at: item.readAt,
    source_id: item.sourceId,
    deep_link: item.deepLink,
    expires_at: item.expiresAt,
    data_scope: item.dataScope,
  };
}

/** Validate + map an untrusted snake_case wire body → a stored row, or null. */
export function wireToStoredNotification(raw: unknown): StoredNotificationItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (id === '') return null;
  if (typeof o.kind !== 'string' || o.kind === '') return null;
  if (typeof o.title !== 'string' || typeof o.body !== 'string') return null;
  if (typeof o.fired_at !== 'number' || !Number.isFinite(o.fired_at)) return null;
  return {
    id,
    kind: o.kind as NotificationKind,
    title: o.title,
    body: o.body,
    firedAt: o.fired_at,
    readAt: typeof o.read_at === 'number' && Number.isFinite(o.read_at) ? o.read_at : null,
    sourceId: typeof o.source_id === 'string' ? o.source_id : '',
    deepLink: typeof o.deep_link === 'string' ? o.deep_link : null,
    expiresAt: typeof o.expires_at === 'number' && Number.isFinite(o.expires_at) ? o.expires_at : null,
    dataScope: typeof o.data_scope === 'string' && o.data_scope !== '' ? o.data_scope : 'user',
  };
}

export interface NotificationLogRepository {
  /** Append a notification. Upserts on `id` so a producer that fires
   *  twice (e.g. reminder + watcher race) doesn't duplicate. */
  append(item: StoredNotificationItem): Promise<void>;
  /** Mark a notification read. No-op if id isn't found. Returns
   *  whether the row was actually mutated (false when already read or
   *  not found) so callers can avoid spurious subscriber fan-out. */
  markRead(id: string, readAt: number): Promise<boolean>;
  /** List every notification, newest-first. Tests + cold-start hydrate
   *  call this. Production list views bound the size with `limit`. */
  listAll(limit?: number): Promise<StoredNotificationItem[]>;
  /** Drop rows whose `firedAt < cutoff` AND (no explicit expiresAt OR
   *  expiresAt < cutoff). Returns the number purged. */
  purgeBefore(cutoff: number): Promise<number>;
  /** Drop every row whose `dataScope` starts with `prefix` (e.g.
   *  `'guided_demo:'`). Backs `dropGuidedDemoNotifications` so a demo
   *  notification never survives the demo in the durable log (R4-03). */
  purgeByScopePrefix(prefix: string): Promise<number>;
  /** Wipe — for testing + identity reset. */
  reset(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Global accessor — same setter convention as chat / reminders / scratchpad
// repos. Boot wires a persistence implementation once via
// `setNotificationLogRepository`; tests override with
// `new InMemoryNotificationLogRepository()`. When `null`, the inbox
// store stays purely in-memory (still fully usable — process-bounded).
// ---------------------------------------------------------------------------

let repo: NotificationLogRepository | null = null;

export function setNotificationLogRepository(r: NotificationLogRepository | null): void {
  repo = r;
}

export function getNotificationLogRepository(): NotificationLogRepository | null {
  return repo;
}

// ---------------------------------------------------------------------------
// In-memory implementation — tests + pre-persistence boots
// ---------------------------------------------------------------------------

export class InMemoryNotificationLogRepository implements NotificationLogRepository {
  private readonly rows: StoredNotificationItem[] = [];

  async append(item: StoredNotificationItem): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === item.id);
    const cloned: StoredNotificationItem = { ...item };
    if (idx >= 0) {
      this.rows[idx] = cloned;
    } else {
      this.rows.push(cloned);
    }
  }

  async markRead(id: string, readAt: number): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.readAt !== null) return false;
    row.readAt = readAt;
    return true;
  }

  async listAll(limit?: number): Promise<StoredNotificationItem[]> {
    const sorted = [...this.rows].sort((a, b) => b.firedAt - a.firedAt).map((r) => ({ ...r }));
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  async purgeBefore(cutoff: number): Promise<number> {
    let purged = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r === undefined) continue;
      const expired = r.expiresAt !== null ? r.expiresAt < cutoff : r.firedAt < cutoff;
      if (expired) {
        this.rows.splice(i, 1);
        purged += 1;
      }
    }
    return purged;
  }

  async purgeByScopePrefix(prefix: string): Promise<number> {
    let purged = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r !== undefined && r.dataScope.startsWith(prefix)) {
        this.rows.splice(i, 1);
        purged += 1;
      }
    }
    return purged;
  }

  async reset(): Promise<void> {
    this.rows.length = 0;
  }
}

// ---------------------------------------------------------------------------
// SQLite implementation — the durable log (R4-03). Writes to `identity.sqlite`
// (Tier 0, owner-private) via the `notification_log` table (migration v27).
// Synchronous adapter under an async interface: the calls resolve immediately.
// ---------------------------------------------------------------------------

const NOTIFICATION_COLUMNS =
  'id, kind, title, body, fired_at, read_at, source_id, deep_link, expires_at, data_scope';

function rowToStored(r: DBRow): StoredNotificationItem {
  return {
    id: String(r.id),
    kind: String(r.kind) as NotificationKind,
    title: String(r.title),
    body: String(r.body),
    firedAt: Number(r.fired_at),
    readAt: r.read_at === null || r.read_at === undefined ? null : Number(r.read_at),
    sourceId: String(r.source_id),
    deepLink: r.deep_link === null || r.deep_link === undefined ? null : String(r.deep_link),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    dataScope: r.data_scope === null || r.data_scope === undefined ? 'user' : String(r.data_scope),
  };
}

/** Escape LIKE metacharacters (`%`, `_`, `\`) so a literal prefix matches
 *  literally under `ESCAPE '\'`. */
function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class SqliteNotificationLogRepository implements NotificationLogRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async append(item: StoredNotificationItem): Promise<void> {
    // Upsert on id (mirrors the in-memory full-replace: a re-fire overwrites).
    this.db.run(
      `INSERT INTO notification_log (${NOTIFICATION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, body = excluded.body,
         fired_at = excluded.fired_at, read_at = excluded.read_at,
         source_id = excluded.source_id, deep_link = excluded.deep_link,
         expires_at = excluded.expires_at, data_scope = excluded.data_scope`,
      [
        item.id,
        item.kind,
        item.title,
        item.body,
        item.firedAt,
        item.readAt,
        item.sourceId,
        item.deepLink,
        item.expiresAt,
        item.dataScope,
      ],
    );
  }

  async markRead(id: string, readAt: number): Promise<boolean> {
    // One-shot: only an unread row flips, so a second ack returns false.
    const affected = this.db.run(
      `UPDATE notification_log SET read_at = ? WHERE id = ? AND read_at IS NULL`,
      [readAt, id],
    );
    return affected > 0;
  }

  async listAll(limit?: number): Promise<StoredNotificationItem[]> {
    const rows = this.db.query(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notification_log
       ORDER BY fired_at DESC${limit !== undefined ? ' LIMIT ?' : ''}`,
      limit !== undefined ? [limit] : [],
    );
    return rows.map(rowToStored);
  }

  async purgeBefore(cutoff: number): Promise<number> {
    return this.db.run(
      `DELETE FROM notification_log
       WHERE (expires_at IS NOT NULL AND expires_at < ?)
          OR (expires_at IS NULL AND fired_at < ?)`,
      [cutoff, cutoff],
    );
  }

  async purgeByScopePrefix(prefix: string): Promise<number> {
    return this.db.run(
      `DELETE FROM notification_log WHERE data_scope LIKE ? ESCAPE '\\'`,
      [`${escapeLike(prefix)}%`],
    );
  }

  async reset(): Promise<void> {
    this.db.run(`DELETE FROM notification_log`, []);
  }
}
