/**
 * Unified notifications inbox (task 5.66).
 *
 * Single in-memory + persistent log that fans the four producer
 * surfaces (reminder fire events, ApprovalManager requests, nudge
 * dispatcher, briefing pipeline) into a single chronological feed
 * the UI can render anywhere — chat thread cards, mobile push
 * payloads, or the Notifications screen (5.67).
 *
 * **Why a brain-side store, not a mobile-side one?** Two reasons:
 *   1. Producers all live brain-side already (reminder/service,
 *      ApprovalManager singleton, nudge dispatcher, briefing
 *      pipeline) — colocation avoids three new IPC hops.
 *   2. The desktop CLI / admin UI eventually consume the same feed;
 *      keeping it brain-side means one bridge serves all clients.
 *
 * **Persistence model**: dual-write same as `chat/thread.ts`. The
 * in-memory `items` array is the read surface; the repository
 * persists for durability and hydrates on boot. Failures are logged
 * but don't propagate — a transient SQLite error mustn't break the
 * subscriber chain.
 *
 * **Auto-purge**: a single `maybePurge()` runs after each append
 * (rate-limited to once per `PURGE_INTERVAL_MS`) so we don't grow
 * unbounded between explicit sweeps. Default retention 30 days; the
 * repository's `purgeBefore` does the work.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  getNotificationLogRepository,
  type NotificationKind,
  type StoredNotificationItem,
} from '../../../core/src/notifications/repository';

export type { NotificationKind } from '../../../core/src/notifications/repository';

export interface NotificationItem {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly firedAt: number;
  readAt: number | null;
  readonly sourceId: string;
  readonly deepLink?: string;
  readonly expiresAt?: number;
}

export type NotificationEvent =
  | { type: 'appended'; item: NotificationItem }
  | { type: 'marked_read'; id: string };

export type NotificationListener = (event: NotificationEvent) => void;

const MS_DAY = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
/** Cap how often we touch the repo for purge — 1h is plenty for a UI
 *  store; the next boot replays + sweeps anyway. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const items: NotificationItem[] = [];
const subscribers = new Set<NotificationListener>();
let lastPurgeAt = 0;
let retentionDays = DEFAULT_RETENTION_DAYS;

/** Override the default 30-day retention. Call from boot when the
 *  user's `cleanupPeriodDays` setting differs. */
export function setRetentionDays(days: number): void {
  if (!Number.isFinite(days) || days <= 0) return;
  retentionDays = Math.floor(days);
}

/**
 * Append a notification to the inbox. Returns the stored item with a
 * generated id (or the caller-supplied id, used by producers that want
 * idempotent semantics — fire-twice → upsert, no duplicate event).
 */
export function appendNotification(input: {
  kind: NotificationKind;
  title: string;
  body: string;
  sourceId?: string;
  /** Optional caller-supplied id for idempotent appends. */
  id?: string;
  deepLink?: string;
  expiresAt?: number;
  /** Override clock — for tests. */
  now?: number;
}): NotificationItem {
  const firedAt = input.now ?? Date.now();
  const id = input.id ?? `nt-${bytesToHex(randomBytes(6))}`;

  // Idempotent path: if an item with this id already exists, treat as
  // upsert + skip the subscriber fire (callers expecting "this is new"
  // semantics won't be misled by a re-emit).
  const existingIdx = items.findIndex((i) => i.id === id);
  const item: NotificationItem = {
    id,
    kind: input.kind,
    title: input.title,
    body: input.body,
    firedAt,
    readAt: null,
    sourceId: input.sourceId ?? '',
    ...(input.deepLink !== undefined && { deepLink: input.deepLink }),
    ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
  };

  if (existingIdx >= 0) {
    items[existingIdx] = item;
  } else {
    // Sorted-insert by firedAt DESC so list reads are O(1) without
    // re-sorting. New items typically land at index 0.
    let insertAt = 0;
    while (insertAt < items.length && items[insertAt]!.firedAt >= firedAt) insertAt += 1;
    items.splice(insertAt, 0, item);
  }

  persist(item);
  if (existingIdx < 0) fire({ type: 'appended', item });
  maybePurge(firedAt);
  return item;
}

/**
 * Mark an item read. Fires `marked_read` once on the first ack;
 * subsequent acks are no-ops (returns false). The first-ack timestamp
 * is preserved so "when did you read this?" stays meaningful.
 */
export function markNotificationRead(id: string, now?: number): boolean {
  const item = items.find((i) => i.id === id);
  if (!item || item.readAt !== null) return false;
  item.readAt = now ?? Date.now();
  persistMarkRead(id, item.readAt);
  fire({ type: 'marked_read', id });
  return true;
}

export interface ListNotificationsOptions {
  /** Only return items with firedAt >= since. */
  since?: number;
  /** Restrict to specific kinds. */
  kinds?: readonly NotificationKind[];
  /** Cap results. */
  limit?: number;
  /** When true, only unread items. */
  unreadOnly?: boolean;
}

/** Newest-first list. Matches the repository's ordering so the
 *  in-memory + persistent surfaces always agree. */
export function listNotifications(opts: ListNotificationsOptions = {}): NotificationItem[] {
  const kinds = opts.kinds !== undefined ? new Set(opts.kinds) : null;
  const out: NotificationItem[] = [];
  for (const item of items) {
    if (opts.since !== undefined && item.firedAt < opts.since) continue;
    if (kinds !== null && !kinds.has(item.kind)) continue;
    if (opts.unreadOnly === true && item.readAt !== null) continue;
    out.push({ ...item });
    if (opts.limit !== undefined && out.length >= opts.limit) break;
  }
  return out;
}

/** Cheap unread count (no list materialisation). Optional kind filter
 *  for per-tab badges (5.69). */
export function getUnreadCount(kind?: NotificationKind): number {
  let n = 0;
  for (const item of items) {
    if (item.readAt !== null) continue;
    if (kind !== undefined && item.kind !== kind) continue;
    n += 1;
  }
  return n;
}

export function subscribeNotifications(listener: NotificationListener): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/**
 * Hydrate the in-memory store from the persistent log on boot. Called
 * once after persistence is wired (mirror of `hydrateThread`). No-op
 * if the in-memory store already has items unless `force` is set.
 */
export async function hydrateNotifications(opts: { force?: boolean } = {}): Promise<number> {
  const repo = getNotificationLogRepository();
  if (repo === null) return 0;
  if (!opts.force && items.length > 0) return 0;
  const rows = await repo.listAll();
  items.length = 0;
  for (const row of rows) {
    items.push(storedToItem(row));
  }
  // listAll already returns newest-first — preserve.
  return items.length;
}

/** Reset for tests. */
export function resetNotifications(): void {
  items.length = 0;
  subscribers.clear();
  lastPurgeAt = 0;
  retentionDays = DEFAULT_RETENTION_DAYS;
  const repo = getNotificationLogRepository();
  if (repo !== null) {
    try {
      void repo.reset().catch(() => {
        /* swallow — tests proceed regardless */
      });
    } catch {
      /* swallow sync-throw variants too */
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function fire(event: NotificationEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* swallow — one faulty observer mustn't break fan-out */
    }
  }
}

function persist(item: NotificationItem): void {
  const repo = getNotificationLogRepository();
  if (repo === null) return;
  try {
    void repo.append(itemToStored(item)).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[notifications] persist failed:', err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notifications] persist failed:', err);
  }
}

function persistMarkRead(id: string, readAt: number): void {
  const repo = getNotificationLogRepository();
  if (repo === null) return;
  try {
    void repo.markRead(id, readAt).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[notifications] markRead persist failed:', err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notifications] markRead persist failed:', err);
  }
}

function maybePurge(now: number): void {
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = now;
  const cutoff = now - retentionDays * MS_DAY;
  // Drop in-memory rows past retention.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const expired = item.expiresAt !== undefined ? item.expiresAt < cutoff : item.firedAt < cutoff;
    if (expired) items.splice(i, 1);
  }
  const repo = getNotificationLogRepository();
  if (repo === null) return;
  try {
    void repo.purgeBefore(cutoff).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[notifications] purge failed:', err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notifications] purge failed:', err);
  }
}

function itemToStored(item: NotificationItem): StoredNotificationItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    firedAt: item.firedAt,
    readAt: item.readAt,
    sourceId: item.sourceId,
    deepLink: item.deepLink ?? null,
    expiresAt: item.expiresAt ?? null,
  };
}

function storedToItem(row: StoredNotificationItem): NotificationItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    firedAt: row.firedAt,
    readAt: row.readAt,
    sourceId: row.sourceId,
    ...(row.deepLink !== null && { deepLink: row.deepLink }),
    ...(row.expiresAt !== null && { expiresAt: row.expiresAt }),
  };
}
