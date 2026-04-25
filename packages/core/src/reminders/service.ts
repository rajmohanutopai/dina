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

/** Build dedup key from the compound fields. */
function dedupKey(sourceItemId: string, kind: string, dueAt: number, persona: string): string {
  return `${sourceItemId}|${kind}|${dueAt}|${persona}`;
}

/**
 * Create a reminder. Returns the reminder.
 *
 * Dedup: if a reminder with the same (source_item_id, kind, due_at, persona)
 * already exists, returns the existing one without creating a duplicate.
 */
export function createReminder(input: {
  message: string;
  due_at: number;
  persona: string;
  kind?: string;
  source_item_id?: string;
  source?: string;
  recurring?: RecurringFrequency;
  timezone?: string;
}): Reminder {
  const kind = input.kind ?? 'manual';
  const sourceItemId = input.source_item_id ?? '';
  const dk = dedupKey(sourceItemId, kind, input.due_at, input.persona);

  // Dedup check
  const existingId = dedupIndex.get(dk);
  if (existingId) {
    const existing = reminders.get(existingId);
    if (existing) return existing;
  }

  const id = `rem-${bytesToHex(randomBytes(16))}`;
  const shortId = generateShortId(id);
  const now = Date.now();

  const reminder: Reminder = {
    id,
    short_id: shortId,
    message: input.message,
    due_at: input.due_at,
    recurring: input.recurring ?? '',
    completed: 0,
    created_at: now,
    source_item_id: sourceItemId,
    source: input.source ?? '',
    persona: input.persona,
    timezone: input.timezone ?? 'UTC',
    kind,
    status: 'pending',
  };

  reminders.set(id, reminder);
  shortIdIndex.set(shortId, id);
  dedupIndex.set(dk, id);
  // SQL write-through — fire-and-forget since Phase 2.3 (task 2.3).
  // Double-guarded: outer try/catch handles sync-throw variants (e.g.
  // test mocks), inner .catch handles async rejection. `reminders` Map
  // is authoritative for reads within the process.
  const sqlRepo = getReminderRepository();
  if (sqlRepo) {
    try {
      void sqlRepo.create(reminder).catch(() => {
        /* fail-safe — transient SQL write loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant */
    }
  }
  return reminder;
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
 */
export function listPending(now?: number): Reminder[] {
  const currentTime = now ?? Date.now();
  const pending: Reminder[] = [];

  for (const r of reminders.values()) {
    if (r.completed === 0 && r.status === 'pending' && r.due_at <= currentTime) {
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

/** Snooze a reminder by pushing due_at forward. */
export function snoozeReminder(id: string, snoozeMs: number): void {
  const reminder = reminders.get(id);
  if (!reminder) throw new Error(`reminders: "${id}" not found`);
  reminder.due_at += snoozeMs;
  reminder.status = 'snoozed';
}

/** Delete a reminder. Returns true if found. */
export function deleteReminder(id: string): boolean {
  const reminder = reminders.get(id);
  if (!reminder) return false;

  const dk = dedupKey(reminder.source_item_id, reminder.kind, reminder.due_at, reminder.persona);
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
    const dk = dedupKey(r.source_item_id, r.kind, r.due_at, r.persona);
    if (!dedupIndex.has(dk)) dedupIndex.set(dk, r.id);
    loaded++;
  }
  return loaded;
}
