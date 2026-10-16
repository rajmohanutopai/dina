/**
 * The binding record of a settled group plan (COMMITMENT_KERNEL §15 step 6;
 * owner decision 2026-10-16).
 *
 * The plan stays a star (GROUP_COORDINATION_ARCHITECTURE.md §3): nothing is
 * held by many nodes together, and no guest learns who else was asked. What
 * is new is that the two sides of each pair now hold the same record of what
 * they agreed. When a plan settles, the organiser's Core sends each guest who
 * accepted the chosen slot a `coordination.booked` message about that pair
 * alone: the slot, the plan's title as the guest was asked, the organiser and
 * that guest. The guest's Core keeps it and sets a reminder. If the plan is
 * widened, abandoned or deleted after it settled, the same record goes again
 * as `cancelled`; if it settles again on another slot, as a new `booked`.
 *
 * Every message for one pair carries a sequence number, one higher each time
 * the organiser's word changes; the guest keeps only the highest it has seen,
 * a cancellation included, so messages that arrive out of order never undo a
 * later one. The guest's record is the truth its reminder follows.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { MSG_TYPE_COORDINATION_BOOKED } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { getReminderRepository } from '../reminders/repository';
import { createReminderDurable, deleteReminder, listByPersona } from '../reminders/service';

import { isMeetingSlot, slotKey, type MeetingSlot } from './group_fold';

import type { GroupPlan } from './group_plan';
import type { D2DSender, D2DSendOutcome } from '../server/routes/d2d_msg';
import type { DatabaseAdapter } from '../storage/db_adapter';

export const BOOKED_MESSAGE = MSG_TYPE_COORDINATION_BOOKED;

export type BookingState = 'booked' | 'cancelled';

/** The wire body. One pair: never another guest, never the plan. */
export interface BookedBody {
  v: 1;
  record_id: string;
  /** One higher each time the organiser's word for this pair changes. */
  seq: number;
  state: BookingState;
  /** The plan's title, as the guest was asked it. */
  title: string;
  slot: MeetingSlot;
  organiser_did: string;
  guest_did: string;
  issued_at: string;
}

const MAX_TITLE = 280;
const MAX_SEQ = 1_000_000;
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,200}$/;
const RECORD_ID = /^[0-9a-f]{32}$/;

/** One id per (organiser, plan, guest): the same for every message of that pair. */
export function bookingRecordId(organiserDid: string, planId: string, guestDid: string): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(`${organiserDid}\n${planId}\n${guestDid}`)),
  ).slice(0, 32);
}

export function validateBookedBody(value: unknown): BookedBody | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(',');
  if (keys !== 'guest_did,issued_at,organiser_did,record_id,seq,slot,state,title,v') return null;
  if (b.v !== 1) return null;
  if (typeof b.record_id !== 'string' || !RECORD_ID.test(b.record_id)) return null;
  if (typeof b.seq !== 'number' || !Number.isInteger(b.seq) || b.seq < 1 || b.seq > MAX_SEQ)
    return null;
  if (b.state !== 'booked' && b.state !== 'cancelled') return null;
  if (typeof b.title !== 'string' || b.title.trim() === '' || b.title.length > MAX_TITLE)
    return null;
  if (!isMeetingSlot(b.slot) || b.slot.start.length > 64) return null;
  if (typeof b.organiser_did !== 'string' || !DID.test(b.organiser_did)) return null;
  if (typeof b.guest_did !== 'string' || !DID.test(b.guest_did)) return null;
  // A pair is two parties.
  if (b.organiser_did === b.guest_did) return null;
  if (typeof b.issued_at !== 'string' || Number.isNaN(Date.parse(b.issued_at))) return null;
  return b as unknown as BookedBody;
}

// ---------------------------------------------------------------------------
// The organiser's side
// ---------------------------------------------------------------------------

/**
 * What each guest was last given about this plan: the word, the slot, its
 * number, and whether the sender has taken it. A word is recorded before it is
 * sent, so a crash never loses one a guest may already hold.
 */
export type PlanBookings = Record<
  string,
  { state: BookingState; slot: MeetingSlot; seq: number; sent: boolean }
>;

/** The guests a settled plan books: those whose confirm reply accepted the chosen slot. */
export function guestsToBook(plan: GroupPlan): string[] {
  if (plan.state !== 'settled' || plan.chosen === null) return [];
  const chosen = slotKey(plan.chosen);
  return plan.guests
    .filter(
      (g) =>
        g.outcome === 'answered' &&
        g.reply?.status === 'accepted' &&
        (g.reply.accepted_slots ?? []).some((s) => slotKey(s) === chosen),
    )
    .map((g) => g.contactDid);
}

/**
 * Did the sender take the message? A sender that reports an outcome must say
 * it was delivered, buffered or queued for retry; one that reports nothing
 * (an adapter that keeps no outcome) took it unless it threw.
 */
function accepted(outcome: D2DSendOutcome | undefined): boolean {
  if (outcome === undefined) return true;
  return outcome.delivered || outcome.buffered || outcome.queued;
}

/**
 * Bring what each guest holds in line with the plan: "booked" (with the slot)
 * to every guest a settled plan books, "cancelled" to every guest booked
 * before and no longer. Each new word is recorded with its number and saved
 * (`persist`) BEFORE it is sent; a word not yet taken by the sender is sent
 * again, under the same number, on the next call (the guest ignores a repeat).
 * `pending` says whether any word is still to be taken.
 */
export async function syncBookings(
  plan: GroupPlan & { bookings?: PlanBookings },
  deps: {
    sendD2D: D2DSender;
    selfDid: string;
    nowMs: () => number;
    persist: (plan: GroupPlan & { bookings?: PlanBookings }) => void;
  },
): Promise<{ plan: GroupPlan & { bookings?: PlanBookings }; changed: boolean; pending: boolean }> {
  const bookings: PlanBookings = { ...(plan.bookings ?? {}) };
  const wanted = new Set(guestsToBook(plan));
  const chosen = plan.chosen;
  let changed = false;
  // 1. Decide each guest's word, and record a new one before anything is sent.
  for (const guestDid of new Set([...wanted, ...Object.keys(bookings)])) {
    const told = bookings[guestDid];
    const word: { state: BookingState; slot: MeetingSlot } | null =
      wanted.has(guestDid) && chosen !== null
        ? { state: 'booked', slot: chosen }
        : told?.state === 'booked'
          ? { state: 'cancelled', slot: told.slot }
          : null;
    if (word === null) continue;
    if (
      told !== undefined &&
      told.state === word.state &&
      slotKey(told.slot) === slotKey(word.slot)
    )
      continue;
    bookings[guestDid] = { ...word, seq: (told?.seq ?? 0) + 1, sent: false };
    changed = true;
  }
  let current = changed ? { ...plan, bookings } : plan;
  if (changed) deps.persist(current);
  // 2. Send every word the sender has not taken yet.
  let taken = false;
  for (const [guestDid, told] of Object.entries(bookings)) {
    if (told.sent) continue;
    const body: BookedBody = {
      v: 1,
      record_id: bookingRecordId(deps.selfDid, plan.planId, guestDid),
      seq: told.seq,
      state: told.state,
      title: plan.intent.slice(0, MAX_TITLE),
      slot: told.slot,
      organiser_did: deps.selfDid,
      guest_did: guestDid,
      issued_at: new Date(deps.nowMs()).toISOString(),
    };
    let ok = false;
    try {
      const outcome = await deps.sendD2D(
        guestDid,
        BOOKED_MESSAGE,
        body as unknown as Record<string, unknown>,
      );
      ok = accepted(outcome ?? undefined);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    bookings[guestDid] = { ...told, sent: true };
    taken = true;
    appendAudit('coordination', `booking_${told.state}`, plan.planId, 'guests=1');
  }
  if (taken) {
    current = { ...plan, bookings };
    deps.persist(current);
  }
  const pending = Object.values(bookings).some((t) => !t.sent);
  return { plan: current, changed: changed || taken, pending };
}

// ---------------------------------------------------------------------------
// The guest's side
// ---------------------------------------------------------------------------

export interface BookingRow {
  organiserDid: string;
  recordId: string;
  seq: number;
  state: BookingState;
  title: string;
  slot: MeetingSlot;
  issuedAt: string;
  reminderId: string | null;
  updatedAt: number;
}

export class BookingStore {
  constructor(private readonly db: DatabaseAdapter) {}

  get(organiserDid: string, recordId: string): BookingRow | null {
    const row = this.db.query(
      `SELECT * FROM coordination_bookings WHERE organiser_did = ? AND record_id = ?`,
      [organiserDid, recordId],
    )[0];
    if (row === undefined) return null;
    return {
      organiserDid: String(row.organiser_did),
      recordId: String(row.record_id),
      seq: Number(row.seq),
      state: String(row.state) as BookingState,
      title: String(row.title),
      slot: JSON.parse(String(row.slot_json)) as MeetingSlot,
      issuedAt: String(row.issued_at),
      reminderId: row.reminder_id === null ? null : String(row.reminder_id),
      updatedAt: Number(row.updated_at),
    };
  }

  put(row: BookingRow): void {
    this.db.execute(
      `INSERT OR REPLACE INTO coordination_bookings
         (organiser_did, record_id, seq, state, title, slot_json, issued_at, reminder_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.organiserDid,
        row.recordId,
        row.seq,
        row.state,
        row.title,
        JSON.stringify(row.slot),
        row.issuedAt,
        row.reminderId,
        row.updatedAt,
      ],
    );
  }

  /**
   * Link a reminder to a record, only while the record is still the one the
   * caller read (its number unchanged): a newer word is never written over.
   */
  linkReminder(
    organiserDid: string,
    recordId: string,
    seq: number,
    reminderId: string | null,
  ): void {
    this.db.execute(
      `UPDATE coordination_bookings SET reminder_id = ?
        WHERE organiser_did = ? AND record_id = ? AND seq = ?`,
      [reminderId, organiserDid, recordId, seq],
    );
  }

  list(): BookingRow[] {
    return this.db
      .query(`SELECT organiser_did, record_id FROM coordination_bookings ORDER BY updated_at DESC`)
      .map((r) => this.get(String(r.organiser_did), String(r.record_id)))
      .filter((r): r is BookingRow => r !== null);
  }
}

let installed: BookingStore | null = null;

/** Storage boot installs the store on the identity database; null in tests that do not. */
export function installBookingStore(store: BookingStore | null): void {
  installed = store;
}

export function getBookingStore(): BookingStore | null {
  return installed;
}

export type BookedAdmission =
  | { outcome: 'stored'; state: BookingState }
  | { outcome: 'stale' }
  | { outcome: 'refused'; reason: string };

/**
 * A `coordination.booked` reached this node. The caller has checked the
 * envelope, its signature, that the sender is a contact, and passes the DID
 * the message was delivered to (`selfDid`), never one the sender wrote. Kept
 * as data: nothing in it is an instruction. The record is stored here; its
 * reminder follows it (`reconcileBookingReminders`).
 */
export function admitBooked(args: {
  store: BookingStore;
  fromDid: string;
  selfDid: string;
  body: unknown;
  nowMs: number;
}): BookedAdmission {
  const body = validateBookedBody(args.body);
  if (body === null) return { outcome: 'refused', reason: 'malformed' };
  if (body.organiser_did !== args.fromDid) return { outcome: 'refused', reason: 'not_the_sender' };
  if (body.guest_did !== args.selfDid) return { outcome: 'refused', reason: 'not_this_guest' };
  const held = args.store.get(args.fromDid, body.record_id);
  // Only a later word from the organiser changes what is held.
  if (held !== null && body.seq <= held.seq) return { outcome: 'stale' };
  args.store.put({
    organiserDid: args.fromDid,
    recordId: body.record_id,
    seq: body.seq,
    state: body.state,
    title: body.title,
    slot: body.slot,
    issuedAt: body.issued_at,
    reminderId: held?.reminderId ?? null,
    updatedAt: args.nowMs,
  });
  appendAudit(
    'coordination',
    body.state === 'booked' ? 'booking_received' : 'booking_cancelled_received',
    body.record_id,
    '',
  );
  return { outcome: 'stored', state: body.state };
}

/** One reconcile at a time: each starts after the one before has finished. */
let reconciling: Promise<void> = Promise.resolve();

/**
 * Bring every booking's reminder in line with its record: a booked record
 * with its slot still ahead has one reminder, due at the slot; a cancelled
 * record has none. Reminders are found by the record's own key, linked or not,
 * so one a crash left unlinked is still found. Each reconcile reads the record
 * afresh and links only while its number is unchanged, so a newer word is
 * never undone. Durable both ways; run after each admission and at boot.
 */
export function reconcileBookingReminders(
  store: BookingStore,
  nowMs: number,
  persona = 'general',
): Promise<void> {
  const run = reconciling.then(() => reconcileOnce(store, nowMs, persona));
  reconciling = run.catch(() => undefined);
  return run;
}

async function reconcileOnce(store: BookingStore, nowMs: number, persona: string): Promise<void> {
  const removeDurably = async (id: string): Promise<void> => {
    deleteReminder(id);
    await getReminderRepository()?.remove(id);
  };
  for (const listed of store.list()) {
    const row = store.get(listed.organiserDid, listed.recordId);
    if (row === null) continue;
    const key = `${row.organiserDid}:${row.recordId}`;
    const due = Date.parse(row.slot.start);
    const wantReminder = row.state === 'booked' && !Number.isNaN(due) && due > nowMs;
    const existing = listByPersona(persona).filter(
      (r) => r.kind === 'booking' && r.source_item_id === key,
    );
    let keep = wantReminder ? (existing.find((r) => r.due_at === due) ?? null) : null;
    for (const r of existing) if (r !== keep) await removeDurably(r.id);
    if (wantReminder && keep === null) {
      keep = await createReminderDurable({
        message: row.title,
        due_at: due,
        persona,
        kind: 'booking',
        source_item_id: key,
        source: 'coordination.booked',
      });
    }
    const linked = keep?.id ?? null;
    if (linked !== row.reminderId)
      store.linkReminder(row.organiserDid, row.recordId, row.seq, linked);
  }
}
