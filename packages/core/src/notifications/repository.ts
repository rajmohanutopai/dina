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
 */

export type NotificationKind =
  | 'reminder'
  | 'approval'
  | 'nudge'
  | 'briefing'
  | 'ask_approval';

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
      const r = this.rows[i]!;
      const expired = r.expiresAt !== null ? r.expiresAt < cutoff : r.firedAt < cutoff;
      if (expired) {
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
