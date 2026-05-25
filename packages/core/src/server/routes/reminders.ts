/**
 * Reminder routes — the HTTP surface Brain uses to create + read
 * reminders when it runs out-of-process (home-node-lite).
 *
 * **Why this exists.** In lite, Core and Brain are two separate Node
 * processes. The reminder service (`@dina/core/reminders`) keeps its
 * authoritative state in a process-local in-memory `Map` write-through
 * to `SQLiteReminderRepository`. That repository is wired only in
 * Core's process (`core-server/src/storage/init.ts`). If Brain called
 * `createReminder` / `listByPersona` / `listPending` from its own
 * process, it would mutate Brain's empty Map — the reminder would never
 * reach Core's SQLite, never fire, never surface to the client. So
 * Brain routes those three operations through Core over signed HTTP via
 * `CoreClient.reminderCreate` / `reminderListByPersona` /
 * `reminderListPending`. On mobile, Brain shares the process with Core
 * and calls the service functions directly (no backend set).
 *
 *   POST /v1/reminders            — create a reminder. Body is the
 *       `createReminder` input shape. Response: the created (or, on a
 *       dedup hit, existing) `Reminder`.
 *   GET  /v1/reminders?persona=…  — every reminder (incl. completed) for
 *       a persona. Response: `{ reminders: Reminder[] }`.
 *   GET  /v1/reminders/pending?now=… — every pending reminder due before
 *       `now` (default: server clock). Response: `{ reminders: Reminder[] }`.
 *
 * Auth: brain/admin/device allowlist (`authz.ts` `/v1/reminders`). The
 * signed-auth middleware fires before the handler.
 */

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';
import { REMINDERS_ROOT, REMINDERS_PENDING } from './paths';
import {
  createReminderDurable as createReminderDurableImpl,
  listByPersona as listByPersonaImpl,
  listPending as listPendingImpl,
  completeReminder as completeReminderImpl,
  snoozeReminder as snoozeReminderImpl,
  deleteReminder as deleteReminderImpl,
  getReminder as getReminderImpl,
  fireMissedReminders as fireMissedRemindersImpl,
  type Reminder,
  type RecurringFrequency,
} from '../../reminders/service';

/** Body cap — a create payload is a few short strings; 16 KiB is generous. */
const CREATE_BODY_MAX_BYTES = 16 * 1024;

/** Recurring frequencies the create route accepts. Mirrors the service union. */
const VALID_RECURRING: ReadonlySet<string> = new Set(['', 'daily', 'weekly', 'monthly']);

/**
 * Injectable service surface — defaults to the module-global reminder
 * service. Tests inject fakes so they don't have to reset the global
 * in-memory store between cases.
 */
export interface ReminderRouteDeps {
  /**
   * Durable create — awaits the SQL write so a 200 only acks once the
   * reminder is on disk (HTTP "created" is a durability promise). Defaults
   * to the service's `createReminderDurable`.
   */
  createReminder: typeof createReminderDurableImpl;
  listByPersona: typeof listByPersonaImpl;
  listPending: typeof listPendingImpl;
  completeReminder: typeof completeReminderImpl;
  snoozeReminder: typeof snoozeReminderImpl;
  deleteReminder: typeof deleteReminderImpl;
  getReminder: typeof getReminderImpl;
  fireMissedReminders: typeof fireMissedRemindersImpl;
}

const DEFAULT_DEPS: ReminderRouteDeps = {
  createReminder: createReminderDurableImpl,
  listByPersona: listByPersonaImpl,
  listPending: listPendingImpl,
  completeReminder: completeReminderImpl,
  snoozeReminder: snoozeReminderImpl,
  deleteReminder: deleteReminderImpl,
  getReminder: getReminderImpl,
  fireMissedReminders: fireMissedRemindersImpl,
};

/**
 * Build the handlers bound to the given deps. Exported separately from
 * `registerReminderRoutes` so unit tests can invoke them directly
 * without the full signed-auth pipeline.
 */
export function makeReminderHandlers(deps: Partial<ReminderRouteDeps> = {}): {
  create: (req: CoreRequest) => Promise<CoreResponse>;
  listByPersona: (req: CoreRequest) => Promise<CoreResponse>;
  listPending: (req: CoreRequest) => Promise<CoreResponse>;
  complete: (req: CoreRequest) => Promise<CoreResponse>;
  snooze: (req: CoreRequest) => Promise<CoreResponse>;
  remove: (req: CoreRequest) => Promise<CoreResponse>;
  fire: (req: CoreRequest) => Promise<CoreResponse>;
} {
  const resolved: ReminderRouteDeps = { ...DEFAULT_DEPS, ...deps };
  return {
    create: (req) => handleCreate(req, resolved),
    listByPersona: (req) => handleListByPersona(req, resolved),
    listPending: (req) => handleListPending(req, resolved),
    complete: (req) => handleComplete(req, resolved),
    snooze: (req) => handleSnooze(req, resolved),
    remove: (req) => handleDelete(req, resolved),
    fire: (req) => handleFire(req, resolved),
  };
}

export function registerReminderRoutes(
  router: CoreRouter,
  deps: Partial<ReminderRouteDeps> = {},
): void {
  const handlers = makeReminderHandlers(deps);
  router.post(REMINDERS_ROOT, handlers.create);
  // `/pending` is a distinct exact path from the collection root — the
  // router matches by segment count, so registration order is immaterial.
  router.get(REMINDERS_PENDING, handlers.listPending);
  router.get(REMINDERS_ROOT, handlers.listByPersona);
  // Action sub-resources — the UI's Mark Done / Snooze + delete. `:id` is
  // a path param; the `/v1/reminders` authz prefix already covers these.
  router.post(`${REMINDERS_ROOT}/fire`, handlers.fire);
  router.post(`${REMINDERS_ROOT}/:id/complete`, handlers.complete);
  router.post(`${REMINDERS_ROOT}/:id/snooze`, handlers.snooze);
  router.delete(`${REMINDERS_ROOT}/:id`, handlers.remove);
}

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}

function reminderBody(reminder: Reminder): Record<string, unknown> {
  return reminder as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// POST /v1/reminders
// ---------------------------------------------------------------------------

async function handleCreate(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  if (req.rawBody.byteLength > CREATE_BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${CREATE_BODY_MAX_BYTES} bytes`);
  }
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const body = req.body as Record<string, unknown>;

  // Normalize at the boundary: validate AND store the trimmed forms.
  // Persona especially — a raw " health " is keyed/stored verbatim and
  // then missed by reads for "health"; message trimming drops stray
  // leading/trailing whitespace that's never intended in the displayed
  // reminder (and would also fork the dedup key).
  const message = (typeof body.message === 'string' ? body.message : '').trim();
  if (message === '') {
    return jsonError(400, 'message is required');
  }
  if (typeof body.due_at !== 'number' || !Number.isFinite(body.due_at)) {
    return jsonError(400, 'due_at (epoch ms) is required');
  }
  const persona = (typeof body.persona === 'string' ? body.persona : '').trim();
  if (persona === '') {
    return jsonError(400, 'persona is required');
  }

  let recurring: RecurringFrequency | undefined;
  if (body.recurring !== undefined) {
    if (typeof body.recurring !== 'string' || !VALID_RECURRING.has(body.recurring)) {
      return jsonError(400, 'recurring must be one of: "", daily, weekly, monthly');
    }
    recurring = body.recurring as RecurringFrequency;
  }

  let reminder: Reminder;
  try {
    // Durable: awaits the SQL write; a persistence failure throws here
    // and surfaces as 500, so a 200 means the reminder is on disk.
    reminder = await deps.createReminder({
      message,
      due_at: body.due_at,
      persona,
      kind: typeof body.kind === 'string' ? body.kind : undefined,
      source_item_id:
        typeof body.source_item_id === 'string' ? body.source_item_id : undefined,
      source: typeof body.source === 'string' ? body.source : undefined,
      recurring,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
    });
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: reminderBody(reminder) };
}

// ---------------------------------------------------------------------------
// GET /v1/reminders?persona=…
// ---------------------------------------------------------------------------

async function handleListByPersona(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  const raw = req.query.persona;
  const persona = typeof raw === 'string' ? raw.trim() : '';
  if (persona === '') {
    return jsonError(400, 'persona query parameter is required');
  }
  let reminders: Reminder[];
  try {
    reminders = deps.listByPersona(persona);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { reminders: reminders.map(reminderBody) } };
}

// ---------------------------------------------------------------------------
// GET /v1/reminders/pending?now=…
// ---------------------------------------------------------------------------

async function handleListPending(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  let now: number | undefined;
  const raw = req.query.now;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return jsonError(400, 'now must be a numeric epoch-ms timestamp');
    }
    now = parsed;
  }
  let reminders: Reminder[];
  try {
    reminders = deps.listPending(now);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { reminders: reminders.map(reminderBody) } };
}

// ---------------------------------------------------------------------------
// POST /v1/reminders/:id/complete
// ---------------------------------------------------------------------------
//
// Marks the reminder complete. For a recurring reminder the service mints
// the next occurrence and returns it; otherwise null. Response:
// `{ next: Reminder | null }`. 404 when the id is unknown.

async function handleComplete(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (id === '') return jsonError(400, 'reminder id is required');
  if (deps.getReminder(id) === null) {
    return jsonError(404, `reminder "${id}" not found`);
  }
  let next: Reminder | null;
  try {
    next = deps.completeReminder(id);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { next: next === null ? null : reminderBody(next) } };
}

// ---------------------------------------------------------------------------
// POST /v1/reminders/:id/snooze   body: { snooze_ms: number }
// ---------------------------------------------------------------------------

async function handleSnooze(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (id === '') return jsonError(400, 'reminder id is required');
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const snoozeMs = (req.body as { snooze_ms?: unknown }).snooze_ms;
  if (typeof snoozeMs !== 'number' || !Number.isFinite(snoozeMs) || snoozeMs <= 0) {
    return jsonError(400, 'snooze_ms (positive epoch-ms duration) is required');
  }
  if (deps.getReminder(id) === null) {
    return jsonError(404, `reminder "${id}" not found`);
  }
  try {
    deps.snoozeReminder(id, snoozeMs);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  const updated = deps.getReminder(id);
  return { status: 200, body: { reminder: updated === null ? null : reminderBody(updated) } };
}

// ---------------------------------------------------------------------------
// DELETE /v1/reminders/:id
// ---------------------------------------------------------------------------

async function handleDelete(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (id === '') return jsonError(400, 'reminder id is required');
  let deleted: boolean;
  try {
    deleted = deps.deleteReminder(id);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { deleted } };
}

// ---------------------------------------------------------------------------
// POST /v1/reminders/fire   body: { now?: number }
// ---------------------------------------------------------------------------
//
// Transitions every pending reminder due before `now` to `fired` and
// returns the newly-fired rows. Idempotent: a reminder fires once
// (status flips), so a subsequent call won't re-return it. Driven by the
// lite brain-server's fire loop, which broadcasts the result to the SPA
// over SSE. Mobile fires in-process and never calls this.

async function handleFire(
  req: CoreRequest,
  deps: ReminderRouteDeps,
): Promise<CoreResponse> {
  let now: number | undefined;
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    const rawNow = (req.body as { now?: unknown }).now;
    if (typeof rawNow === 'number' && Number.isFinite(rawNow)) now = rawNow;
  }
  let fired: Reminder[];
  try {
    fired = deps.fireMissedReminders(now);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { fired: fired.map(reminderBody) } };
}
