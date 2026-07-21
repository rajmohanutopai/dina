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
  currentDataScope,
  getNotificationLogRepository,
  isGuidedDemoScope,
  type DataScope,
  type NotificationKind,
  type StoredNotificationItem,
} from '@dina/core';

export type { NotificationKind } from '@dina/core';

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
  /** Data scope the notification was created in. Stamped at append so the
   *  guided-demo teardown can drop demo-scope notifications (the inbox is an
   *  in-memory store the DB-level deleteDataScope can't reach). */
  readonly dataScope: DataScope;
}

export type NotificationEvent =
  | { type: 'appended'; item: NotificationItem }
  | { type: 'marked_read'; id: string }
  | { type: 'hydrated'; loaded: number };

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
/** The shared in-memory insert both append variants use: idempotent id-upsert,
 *  sorted-insert by firedAt DESC, subscriber fire only for a NEW id. */
function insertItem(input: AppendNotificationInput): NotificationItem {
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
    // Stamp the scope so a guided-demo notification can be dropped on teardown.
    dataScope: currentDataScope(),
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

  if (existingIdx < 0) fire({ type: 'appended', item });
  maybePurge(firedAt);
  return item;
}

export interface AppendNotificationInput {
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
}

export function appendNotification(input: AppendNotificationInput): NotificationItem {
  const item = insertItem(input);
  persist(item);
  return item;
}

/**
 * R5-04 — the FAILURE-ATOMIC append: same in-memory insert, but AWAITS the
 * durable write and THROWS when it fails, so a delivery pipeline can refuse to
 * report success (and its workflow event stays unacknowledged → Core retries;
 * the idempotent id makes the retry an upsert, never a duplicate). The in-memory
 * item is left in place on failure — the retry converges durability, and the
 * user-visible view was already correct.
 */
export async function appendNotificationDurable(
  input: AppendNotificationInput,
): Promise<NotificationItem> {
  const item = insertItem(input);
  const repo = getNotificationLogRepository();
  if (repo !== null) {
    await repo.append(itemToStored(item));
  }
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

/**
 * Drop every notification created in a guided-demo scope. Called from the demo
 * teardown's cache refresh — the inbox is an in-memory store, so the DB-level
 * `deleteDataScope` can't reach it (and on mobile the persistent log isn't even
 * wired). User-scope notifications are untouched. Fires `'hydrated'` so live
 * subscribers (the unread badge) recompute. Returns the number dropped.
 */
export function dropGuidedDemoNotifications(): number {
  const before = items.length;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isGuidedDemoScope(items[i]!.dataScope)) items.splice(i, 1);
  }
  const dropped = before - items.length;
  if (dropped > 0) fire({ type: 'hydrated', loaded: items.length });
  // R4-03 — a persistent log now carries scope, so also drop persisted demo
  // rows; otherwise a demo notification would survive teardown in the durable
  // log. Fire-and-forget (mirrors `persist`): a no-op when no repo is wired.
  const repo = getNotificationLogRepository();
  if (repo !== null) {
    try {
      void repo.purgeByScopePrefix('guided_demo:').catch((err) => {
        console.warn('[notifications] demo-scope purge failed:', err);
      });
    } catch (err) {
      console.warn('[notifications] demo-scope purge failed:', err);
    }
  }
  return dropped;
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
  //
  // Fire `'hydrated'` so live subscribers (`useUnreadCount`,
  // notification-list views) recompute against the freshly restocked
  // store. Without this, the Approvals tab badge stays at 0 across the
  // entire cold launch even when SQL holds N pending rows — surfaced
  // live as MT-43-I1 on 2026-05-07: 5 pending approval rows visible on
  // the Approvals screen, but the tab-bar badge stayed empty until a
  // new notification arrived.
  fire({ type: 'hydrated', loaded: items.length });
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

/**
 * R5-09 — MERGE durable rows into the in-memory store WITHOUT clearing it.
 * Reconnect reconciliation for a remote-backed inbox (the web client): a
 * `hydrateNotifications({force})` REPLACES the store wholesale, so an SSE frame
 * folded in the same instant as the snapshot fetch could be clobbered by a
 * snapshot that predates it. Merging upserts by id instead (preserving each
 * row's `readAt`, unlike a re-`appendNotification`), so nothing already folded
 * is ever dropped. Fires one `'hydrated'` event when anything changed.
 */
export function mergeNotifications(rows: StoredNotificationItem[]): number {
  let changed = 0;
  const appended: NotificationItem[] = [];
  for (const row of rows) {
    const item = storedToItem(row);
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx >= 0) {
      items[idx] = item;
    } else {
      let insertAt = 0;
      while (insertAt < items.length && items[insertAt]!.firedAt >= item.firedAt) insertAt += 1;
      items.splice(insertAt, 0, item);
      appended.push(item);
    }
    changed += 1;
  }
  // Round-A A-06 — a merged-in NEW row fires `appended` so live forwarders
  // (the brain-server SSE stream) deliver it to connected clients: on the split
  // server this merge IS how a Core-process notification reaches Brain after
  // boot (the reconcile poll), not only how a reconnect back-fills.
  for (const item of appended) fire({ type: 'appended', item });
  if (changed > 0) fire({ type: 'hydrated', loaded: items.length });
  return changed;
}

/**
 * R5-03 — drop the in-memory view WITHOUT erasing the durable log. Called on
 * identity teardown/switch so one identity's notifications never bleed into the
 * next in the same JS process, while its persisted rows stay intact for when it
 * signs back in. (Unlike `resetNotifications`, which also wipes the durable
 * store — that's a test/identity-erase concern, not a sign-out.) The next
 * `hydrateNotifications()` refills from whichever identity's repo is then wired.
 * Fires `'hydrated'` so a live unread badge recomputes to 0.
 */
export function clearNotificationsMemory(): void {
  items.length = 0;
  lastPurgeAt = 0;
  // B-03 — cancel outstanding persist retries: a timer surviving an identity
  // switch must never fire against the next identity's wiring (the retry is
  // repo-bound anyway; cancelling closes the window entirely).
  for (const t of pendingPersistRetries) clearTimeout(t);
  pendingPersistRetries.clear();
  fire({ type: 'hydrated', loaded: 0 });
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

/** Round-B B-03 — outstanding persist-retry timers, cancelled on identity
 *  teardown so a retry can never fire after the repository was swapped. */
const pendingPersistRetries = new Set<ReturnType<typeof setTimeout>>();

function persist(
  item: NotificationItem,
  attempt = 0,
  boundRepo?: ReturnType<typeof getNotificationLogRepository>,
): void {
  // B-03 — a RETRY stays bound to the repository that owned the FIRST attempt
  // (never re-resolving the swappable global): if identity A's append fails and
  // the retry fires after identity B is wired, the write goes to A's (now
  // closed) repo and fails again — never into B's database. Teardown also
  // cancels outstanding timers via clearNotificationsMemory.
  const repo = boundRepo ?? getNotificationLogRepository();
  if (repo === null) return;
  try {
    void repo.append(itemToStored(item)).catch((err) => {
      // Round-A A-06 — a transient durable-write failure (split-server HTTP
      // blip, busy DB) retries with backoff instead of silently dropping the
      // durable copy; the idempotent id makes each retry an upsert. After the
      // budget the failure is logged (metadata only) and the in-memory copy —
      // which the user already sees — remains authoritative for this session.
      if (attempt < 3) {
        const t = setTimeout(() => {
          pendingPersistRetries.delete(t);
          persist(item, attempt + 1, repo);
        }, 2_000 * (attempt + 1));
        pendingPersistRetries.add(t);
        (t as { unref?: () => void }).unref?.();
        return;
      }
      console.warn('[notifications] persist failed after retries:', err);
    });
  } catch (err) {

    console.warn('[notifications] persist failed:', err);
  }
}

function persistMarkRead(id: string, readAt: number): void {
  const repo = getNotificationLogRepository();
  if (repo === null) return;
  try {
    void repo.markRead(id, readAt).catch((err) => {
       
      console.warn('[notifications] markRead persist failed:', err);
    });
  } catch (err) {
     
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
       
      console.warn('[notifications] purge failed:', err);
    });
  } catch (err) {
     
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
    dataScope: item.dataScope,
  };
}

/** Coerce a persisted `data_scope` string back to a typed `DataScope`; an
 *  unrecognized value falls back to `'user'` (never mis-scopes a real row). */
function coerceDataScope(raw: string): DataScope {
  return raw === 'user' || isGuidedDemoScope(raw as DataScope) ? (raw as DataScope) : 'user';
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
    // R4-03 — carry the persisted scope so a hydrated demo row stays demo-scoped
    // (and is purgeable on teardown), not silently promoted to 'user'.
    dataScope: coerceDataScope(row.dataScope),
  };
}
