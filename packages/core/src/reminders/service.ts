/**
 * Reminder service — CRUD with dedup and recurring support.
 *
 * Reminders are per-persona, deduplicated by the compound key
 * (source_item_id, kind, due_at, persona). This prevents the staging
 * pipeline from creating duplicate reminders when re-processing items.
 *
 * Recurring reminders: daily/weekly/monthly. On completion, the next
 * occurrence is auto-created if recurring is set.
 *
 * Source: ARCHITECTURE.md Section 2.61
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { MS_DAY } from '../constants';
import { getReminderRepository } from './repository';

export type RecurringFrequency = '' | 'daily' | 'weekly' | 'monthly';

export interface Reminder {
  id: string;
  /** 4-char short ID for user-friendly reference (e.g., "snooze abc1"). */
  short_id: string;
  message: string;
  due_at: number;
  recurring: RecurringFrequency;
  completed: number; // 0 = pending, 1 = completed
  created_at: number;
  source_item_id: string;
  source: string;
  persona: string;
  timezone: string;
  kind: string;
  status: string; // 'pending' | 'fired' | 'completed' | 'snoozed'
}

/** In-memory reminder store keyed by ID. */
const reminders = new Map<string, Reminder>();

/** Dedup index: compound key → reminder ID. */
const dedupIndex = new Map<string, string>();

/** Short ID → full ID index for user-friendly lookup. */
const shortIdIndex = new Map<string, string>();

/**
 * Generate a 4-char short ID from the full reminder ID.
 *
 * Uses first 4 hex chars of SHA-256 hash of the ID.
 * On collision, appends a suffix digit.
 */
function generateShortId(fullId: string): string {
  const hash = bytesToHex(sha256(new TextEncoder().encode(fullId)));
  let shortId = hash.slice(0, 4);

  // Handle collision: append suffix digit if 4-char is taken
  let suffix = 0;
  while (shortIdIndex.has(shortId) && shortIdIndex.get(shortId) !== fullId) {
    suffix++;
    shortId = hash.slice(0, 3) + suffix.toString(16);
    if (suffix > 15) {
      // Extremely unlikely: fall back to longer hash
      shortId = hash.slice(0, 6);
      break;
    }
  }

  return shortId;
}

/**
 * Build dedup key from the compound fields. `message` is part of the key:
 * without it, two DIFFERENT manual reminders at the same time + persona
 * ("call mom at 5", "take medicine at 5") collide — they share an empty
 * `source_item_id` and `kind='manual'` — and the second is silently
 * dropped. Dedup must identify a *duplicate*, not "anything at this
 * minute". Source-derived reminders (planner) still dedup correctly on
 * re-ingestion because the same item yields the same message + key.
 *
 * Mirrors the DB `UNIQUE(source_item_id, kind, due_at, persona, message)`
 * in `schemas.ts` — the two MUST agree or a service-level dedup miss
 * becomes a swallowed `INSERT` conflict.
 */
function dedupKey(
  sourceItemId: string,
  kind: string,
  dueAt: number,
  persona: string,
  message: string,
): string {
  return `${sourceItemId}|${kind}|${dueAt}|${persona}|${message}`;
}

/** Subscribers fan-out registered via `subscribeReminderCreated`. */
const createListeners = new Set<(reminder: Reminder) => void>();

export interface CreateReminderInput {
  message: string;
  due_at: number;
  persona: string;
  kind?: string;
  source_item_id?: string;
  source?: string;
  recurring?: RecurringFrequency;
  timezone?: string;
}

/** Construct a reminder (id + short_id + defaults). No registration, no SQL. */
function buildReminder(input: CreateReminderInput, kind: string, sourceItemId: string): Reminder {
  const id = `rem-${bytesToHex(randomBytes(16))}`;
  const shortId = generateShortId(id);
  return {
    id,
    short_id: shortId,
    message: input.message,
    due_at: input.due_at,
    recurring: input.recurring ?? '',
    completed: 0,
    created_at: Date.now(),
    source_item_id: sourceItemId,
    source: input.source ?? '',
    persona: input.persona,
    timezone: input.timezone ?? 'UTC',
    kind,
    status: 'pending',
  };
}

/** Register a reminder in the in-memory store + indexes. */
function registerInMemory(reminder: Reminder, dk: string): void {
  reminders.set(reminder.id, reminder);
  shortIdIndex.set(reminder.short_id, reminder.id);
  dedupIndex.set(dk, reminder.id);
}

/** Look up a live reminder by dedup key, or null. */
function dedupHit(dk: string): Reminder | null {
  const existingId = dedupIndex.get(dk);
  if (!existingId) return null;
  return reminders.get(existingId) ?? null;
}

/**
 * Fan out a freshly-created reminder to subscribers — typically the
 * mobile-side OS-push bridge (`installReminderPushBridge`) which calls
 * `scheduleNotification` so a banner fires when due even with the app
 * backgrounded. Listeners get a frozen clone so a faulty observer can't
 * mutate canonical state; errors are swallowed so a misbehaving bridge
 * can't break reminder creation.
 */
function fanOutCreated(reminder: Reminder): void {
  for (const listener of createListeners) {
    try {
      listener({ ...reminder });
    } catch {
      /* swallow */
    }
  }
}

/**
 * Create a reminder, best-effort persistence. Returns synchronously; the
 * SQL write is fire-and-forget. This is the MOBILE path: the in-memory
 * `reminders` Map is authoritative for reads within the process, and a
 * transient local-SQLite write loss is acceptable (the row still fires
 * + lists this session; only a same-session crash before the async write
 * lands loses it). Lite's HTTP route uses {@link createReminderDurable}
 * instead so a POST never acks before the row is on disk.
 *
 * Dedup: a matching (source_item_id, kind, due_at, persona, message)
 * returns the existing reminder without creating a duplicate.
 */
export function createReminder(input: CreateReminderInput): Reminder {
  const kind = input.kind ?? 'manual';
  const sourceItemId = input.source_item_id ?? '';
  const dk = dedupKey(sourceItemId, kind, input.due_at, input.persona, input.message);

  const hit = dedupHit(dk);
  if (hit) return hit;

  const reminder = buildReminder(input, kind, sourceItemId);
  registerInMemory(reminder, dk);

  const sqlRepo = getReminderRepository();
  if (sqlRepo) {
    // Double-guarded: outer try/catch handles sync-throw variants (e.g.
    // test mocks), inner .catch handles async rejection. A UNIQUE
    // conflict (plain INSERT) on this best-effort path is swallowed —
    // the in-memory Map is authoritative for mobile reads.
    try {
      void sqlRepo.create(reminder).catch(() => {
        /* fail-safe — transient SQL write loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant */
    }
  }

  fanOutCreated(reminder);
  return reminder;
}

/**
 * In-flight durable creates, keyed by dedup key. Coalesces concurrent
 * identical creates onto a single SQL write + outcome so a duplicate
 * request can't ack `success` off a not-yet-persisted in-memory row.
 */
const inflightDurable = new Map<string, Promise<Reminder>>();

/**
 * Create a reminder, durable-at-ack. Unlike {@link createReminder}, the
 * in-memory row is registered ONLY after the SQL write resolves — so a
 * concurrent duplicate never sees (and acks off) a pending row, and a
 * failed write leaves nothing behind. Concurrent identical creates are
 * coalesced onto one in-flight write via `inflightDurable`, and the
 * repository uses a plain `INSERT` (not `INSERT OR IGNORE`), so a real
 * conflict surfaces as a throw rather than a silent no-op masquerading
 * as success. This is the lite HTTP-route path, where "200 created" is a
 * durability promise. With no SQL repo wired (tests / pure in-memory),
 * the in-memory store IS the truth and registration happens immediately.
 *
 * Dedup: a matching (source_item_id, kind, due_at, persona, message)
 * returns the existing reminder without creating a duplicate.
 */
export async function createReminderDurable(input: CreateReminderInput): Promise<Reminder> {
  const kind = input.kind ?? 'manual';
  const sourceItemId = input.source_item_id ?? '';
  const dk = dedupKey(sourceItemId, kind, input.due_at, input.persona, input.message);

  // Already durably created in this process (registered post-persist)?
  const hit = dedupHit(dk);
  if (hit) return hit;

  // A concurrent identical create is mid-write — await its outcome rather
  // than racing a second INSERT (which would conflict) or acking early.
  const existingFlight = inflightDurable.get(dk);
  if (existingFlight) return existingFlight;

  const flight = (async (): Promise<Reminder> => {
    const reminder = buildReminder(input, kind, sourceItemId);
    const sqlRepo = getReminderRepository();
    if (sqlRepo) {
      // Plain INSERT — a UNIQUE conflict or write error throws here, so a
      // 200 is only returned once the row is genuinely on disk.
      await sqlRepo.create(reminder);
    }
    // Durable (or no repo wired): register + fan out only now.
    registerInMemory(reminder, dk);
    fanOutCreated(reminder);
    return reminder;
  })();

  inflightDurable.set(dk, flight);
  try {
    return await flight;
  } catch (err) {
    throw new Error(
      `reminders: durable create failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    inflightDurable.delete(dk);
  }
}

/** Subscribe to reminder-creation events. Returns a disposer. */
export function subscribeReminderCreated(
  listener: (reminder: Reminder) => void,
): () => void {
  createListeners.add(listener);
  return () => {
    createListeners.delete(listener);
  };
}

/** Get a reminder by ID. */
export function getReminder(id: string): Reminder | null {
  return reminders.get(id) ?? null;
}

/**
 * Get a reminder by its 4-char short ID.
 *
 * Used for user-friendly commands like "snooze abc1" or "complete f3e2".
 */
export function getByShortId(shortId: string): Reminder | null {
  const fullId = shortIdIndex.get(shortId.toLowerCase());
  if (!fullId) return null;
  return reminders.get(fullId) ?? null;
}

/**
 * List pending reminders (not completed, due_at <= now).
 * Sorted by due_at ascending (soonest first).
 *
 * Includes both `'pending'` (never fired) AND `'snoozed'` (fired, then
 * pushed forward via {@link snoozeReminder}). Snooze semantically
 * means "re-fire when the new due_at arrives" — without including
 * `'snoozed'` here, snoozes silently disappear forever.
 */
export function listPending(now?: number): Reminder[] {
  const currentTime = now ?? Date.now();
  const pending: Reminder[] = [];

  for (const r of reminders.values()) {
    if (
      r.completed === 0 &&
      (r.status === 'pending' || r.status === 'snoozed') &&
      r.due_at <= currentTime
    ) {
      pending.push(r);
    }
  }

  return pending.sort((a, b) => a.due_at - b.due_at);
}

/**
 * Get the single earliest pending reminder (due_at <= now).
 *
 * Returns null if no reminders are due. Used by the reminder firing
 * loop to process one reminder at a time — matching Go's NextPending.
 */
export function nextPending(now?: number): Reminder | null {
  const currentTime = now ?? Date.now();
  let earliest: Reminder | null = null;

  for (const r of reminders.values()) {
    if (r.completed === 0 && r.status === 'pending' && r.due_at <= currentTime) {
      if (!earliest || r.due_at < earliest.due_at) {
        earliest = r;
      }
    }
  }

  return earliest;
}

/**
 * Fire all missed reminders — past-due pending reminders that were
 * not fired because the app was backgrounded or restarted.
 *
 * Matches Go's startup recovery: fires past-due reminders on startup.
 * Returns the list of fired reminders. Each is marked status='fired'.
 *
 * The status flip is also written through to SQL so the next cold
 * launch sees `'fired'` and `listPending`/`hydrateRemindersFromRepo`
 * skip them. Without the write-through, every cold launch re-fires
 * every past-due reminder ever created, because hydration restores
 * them as `'pending'` — surfaced live as MT-29-I1 / MT-43-I2 on
 * 2026-05-07: the same MT-15 reminders re-emitted at 6:35 → 6:38 →
 * 6:43 across three cold launches.
 *
 * @param onFire — optional callback invoked for each fired reminder
 */
export function fireMissedReminders(
  now?: number,
  onFire?: (reminder: Reminder) => void,
): Reminder[] {
  const pending = listPending(now);
  const fired: Reminder[] = [];

  for (const r of pending) {
    r.status = 'fired';
    persistStatus(r.id, { status: 'fired' });
    fired.push(r);
    if (onFire) onFire(r);
  }

  return fired;
}

/**
 * List all reminders for a persona.
 * Includes completed reminders.
 */
export function listByPersona(persona: string): Reminder[] {
  return [...reminders.values()].filter((r) => r.persona === persona);
}

/**
 * Complete a reminder. If recurring, create the next occurrence.
 * Returns the next occurrence if created, null otherwise.
 */
export function completeReminder(id: string): Reminder | null {
  const reminder = reminders.get(id);
  if (!reminder) throw new Error(`reminders: "${id}" not found`);

  reminder.completed = 1;
  reminder.status = 'completed';
  persistStatus(reminder.id, { status: 'completed', completed: 1 });

  // Create next occurrence for recurring reminders
  if (reminder.recurring) {
    const nextDueAt = computeNextOccurrence(reminder.due_at, reminder.recurring);
    return createReminder({
      message: reminder.message,
      due_at: nextDueAt,
      persona: reminder.persona,
      kind: reminder.kind,
      source_item_id: reminder.source_item_id,
      source: reminder.source,
      recurring: reminder.recurring,
      timezone: reminder.timezone,
    });
  }

  return null;
}

/**
 * Snooze a reminder by `snoozeMs` from now (or from `due_at`, whichever
 * is later). User intent for "snooze 1h" is "remind me in 1 hour from
 * now" — without the `max`, snoozing a past-due reminder would still
 * leave it past-due (e.g. due 2h ago, snooze 1h → still 1h past-due
 * and the watcher re-fires immediately).
 *
 * Status flips to `'snoozed'`; {@link listPending} treats `'snoozed'`
 * the same as `'pending'` so the new due_at correctly re-arms the
 * fire-watcher.
 */
export function snoozeReminder(id: string, snoozeMs: number, now?: number): void {
  const reminder = reminders.get(id);
  if (!reminder) throw new Error(`reminders: "${id}" not found`);
  const base = Math.max(reminder.due_at, now ?? Date.now());
  reminder.due_at = base + snoozeMs;
  reminder.status = 'snoozed';
  persistStatus(reminder.id, { status: 'snoozed', due_at: reminder.due_at });
}

/**
 * Fire-and-forget write-through for status/due_at mutations.
 *
 * Same shape as the inline `void sqlRepo.create(reminder).catch(...)`
 * inside `createReminder`: any sync-throw or async-rejection is
 * swallowed because reminder UX must not break on a transient SQL
 * write loss. The in-memory `reminders` Map is the authoritative
 * read surface within the process; the SQL write only matters for
 * the *next* cold start's hydration, where it prevents stale state
 * from re-firing.
 */
function persistStatus(id: string, updates: Partial<Reminder>): void {
  const sqlRepo = getReminderRepository();
  if (!sqlRepo) return;
  try {
    void sqlRepo.update(id, updates).catch(() => {
      /* fail-safe — transient SQL write loss is acceptable */
    });
  } catch {
    /* fail-safe — sync-throw variant */
  }
}

/** Delete a reminder. Returns true if found. */
export function deleteReminder(id: string): boolean {
  const reminder = reminders.get(id);
  if (!reminder) return false;

  const dk = dedupKey(
    reminder.source_item_id,
    reminder.kind,
    reminder.due_at,
    reminder.persona,
    reminder.message,
  );
  dedupIndex.delete(dk);
  shortIdIndex.delete(reminder.short_id);
  reminders.delete(id);
  return true;
}

/** Compute the next occurrence for a recurring reminder. */
function computeNextOccurrence(dueAt: number, frequency: RecurringFrequency): number {
  switch (frequency) {
    case 'daily':
      return dueAt + MS_DAY;
    case 'weekly':
      return dueAt + 7 * MS_DAY;
    case 'monthly':
      return dueAt + 30 * MS_DAY;
    default:
      return dueAt;
  }
}

/** Reset all reminder state (for testing). */
export function resetReminderState(): void {
  reminders.clear();
  dedupIndex.clear();
  shortIdIndex.clear();
  createListeners.clear();
  inflightDurable.clear();
}

/**
 * Hydrate the in-memory reminder Map from the SQL repository.
 *
 * The service writes through to SQL (see `createReminder`) but reads
 * exclusively from the in-memory `reminders` Map. After every cold
 * start the Map is fresh-empty, so reminders persisted in prior
 * sessions are invisible to the UI even though SQL still has them —
 * `useReminders` returns 0 rows, the chat reply that just created a
 * reminder shows it (because `createReminder` populated the Map this
 * session), but the next session is amnesiac.
 *
 * Same shape as `hydrateContactDirectory`. Idempotent — re-hydrating
 * over an existing Map skips duplicates rather than throwing on the
 * dedup index.
 *
 * Returns the number of newly loaded rows.
 */
export async function hydrateRemindersFromRepo(): Promise<number> {
  const sqlRepo = getReminderRepository();
  if (sqlRepo === null) return 0;

  const rows = await sqlRepo.listAll();
  let loaded = 0;
  for (const r of rows) {
    if (reminders.has(r.id)) continue;
    reminders.set(r.id, r);
    shortIdIndex.set(r.short_id, r.id);
    const dk = dedupKey(r.source_item_id, r.kind, r.due_at, r.persona, r.message);
    if (!dedupIndex.has(dk)) dedupIndex.set(dk, r.id);
    loaded++;
  }
  return loaded;
}
