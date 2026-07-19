/**
 * Reminder backend — the seam that lets Brain's reminder create/read
 * paths run both in-process (mobile) and out-of-process (home-node-lite).
 *
 * **Why this exists.** The reminder service (`@dina/core/reminders`)
 * keeps its authoritative state in a process-local in-memory `Map`,
 * write-through to `SQLiteReminderRepository`. That repository is wired
 * only in Core's process. On mobile, Brain shares that process, so
 * calling `createReminder` / `listByPersona` / `listPending` directly is
 * correct. In lite, Brain runs in its OWN process — a direct call would
 * mutate Brain's empty Map, and the reminder would never reach Core's
 * store, never fire, never surface to the client.
 *
 * So lite's brain-server registers a `ReminderBackend` at boot
 * (`setReminderBackend`) wired to its `CoreClient`, and every Brain
 * reminder consumer goes through the `*Routed` wrappers below. When no
 * backend is set (mobile / tests), the wrappers fall back to the
 * in-process service functions. Parallel to `setVaultReadBackend` /
 * `setPeopleReadBackend` in `vault_context/assembly`.
 */

import {
  createReminder as createReminderInProcess,
  listByPersona as listByPersonaInProcess,
  listPending as listPendingInProcess,
  type Reminder,
} from '@dina/core/reminders';

import type { CoreClient, ReminderCreateInput } from '@dina/core';

/**
 * Narrow surface — only the three reminder operations Brain performs.
 * Lets a test inject three lambdas instead of a full CoreClient.
 */
export interface ReminderBackend {
  reminderCreate: CoreClient['reminderCreate'];
  reminderListByPersona: CoreClient['reminderListByPersona'];
  reminderListPending: CoreClient['reminderListPending'];
}

let reminderBackend: ReminderBackend | null = null;

/**
 * Register a remote reminder backend. Home-node-lite's brain-server
 * calls this at boot with its `CoreClient`. Mobile leaves it unset so
 * the in-process service is used.
 */
export function setReminderBackend(backend: ReminderBackend | null): void {
  reminderBackend = backend;
}

export function getReminderBackend(): ReminderBackend | null {
  return reminderBackend;
}

/**
 * Create a reminder. Routes through Core in lite (backend set), else the
 * in-process service. Always async so the call shape is identical on
 * both targets.
 */
export async function createReminderRouted(input: ReminderCreateInput): Promise<Reminder> {
  if (reminderBackend !== null) {
    return reminderBackend.reminderCreate(input);
  }
  return createReminderInProcess(input);
}

/** Every reminder (incl. completed) for a persona. */
export async function listRemindersByPersonaRouted(persona: string): Promise<Reminder[]> {
  if (reminderBackend !== null) {
    return reminderBackend.reminderListByPersona(persona);
  }
  return listByPersonaInProcess(persona);
}

/** Every pending reminder due before `now` (default: now). */
export async function listPendingRemindersRouted(now?: number): Promise<Reminder[]> {
  if (reminderBackend !== null) {
    return reminderBackend.reminderListPending(now);
  }
  return listPendingInProcess(now);
}
