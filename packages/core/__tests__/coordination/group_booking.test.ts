/**
 * COMMITMENT_KERNEL §15 step 6 — a group plan's binding record, per pair.
 *
 *   K-01  a settled plan books each guest who accepted the chosen slot, once;
 *         the record names that guest only — no other guest, no reply, no plan;
 *   K-02  widened or abandoned after it settled: each booked guest is told
 *         "cancelled", naming the slot it booked, under the next number;
 *   K-03  a send that throws, or that the sender reports it did not take, is
 *         tried again on the next sync;
 *   K-04  a plan that settles on another slot after a cancellation that never
 *         went out books the guest again on the new slot;
 *   K-05  the guest keeps nothing that is not from its organiser, about it,
 *         between two parties, and well formed;
 *   K-06  the guest keeps the organiser's latest word whatever the order of
 *         arrival: cancelled before booked, an older slot after a newer one;
 *   K-07  the reminder follows the record — set for booked, gone for
 *         cancelled — and stays so across a restart;
 *   K-08  each word is saved before it is sent, and a word the sender did not
 *         take is sent again under the same number;
 *   K-09  a reminder a crash left unlinked is found by the record's key; a
 *         reconcile that started before a cancellation never brings the
 *         booking back.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  admitBooked,
  BookingStore,
  bookingRecordId,
  reconcileBookingReminders,
  syncBookings,
  type BookedBody,
} from '../../src/coordination/group_booking';
import { getReminder, listByPersona, resetReminderState } from '../../src/reminders/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { GroupPlan } from '../../src/coordination/group_plan';
import type { D2DSendOutcome } from '../../src/server/routes/d2d_msg';

const MIKE = 'did:plc:mikeorganiser0000000000';
const GARCIA = 'did:plc:garciafamily000000000000';
const MILLER = 'did:plc:millerfamily000000000000';
const JOHNSON = 'did:plc:johnsonfamily00000000000';
const SAT = { start: '2027-03-27T15:00:00Z' };
const SUN = { start: '2027-03-28T15:00:00Z' };
const TOOK: D2DSendOutcome = { messageId: 'm', delivered: true, buffered: false, queued: false };
const REFUSED: D2DSendOutcome = {
  messageId: 'm',
  delivered: false,
  buffered: false,
  queued: false,
};

function settled(chosen = SAT): GroupPlan {
  const accepted = (slot: typeof SAT) => ({ status: 'accepted' as const, accepted_slots: [slot] });
  return {
    planId: 'plan-1',
    intent: "Emma's 8th birthday",
    createdAt: 1,
    updatedAt: 2,
    windowSeconds: 300,
    round: 2,
    roundOpenedAt: 1,
    guests: [
      {
        contactDid: GARCIA,
        required: true,
        spokes: [],
        reply: accepted(chosen),
        outcome: 'answered',
        disclosures: [],
      },
      // Optional, and the chosen day does not suit them: not booked.
      {
        contactDid: MILLER,
        required: false,
        spokes: [],
        reply: accepted({ start: 'some other day' }),
        outcome: 'answered',
        disclosures: [],
      },
      {
        contactDid: JOHNSON,
        required: false,
        spokes: [],
        reply: null,
        outcome: 'unreachable',
        disclosures: [],
      },
    ],
    candidates: [chosen],
    fold: null,
    chosen,
    state: 'settled',
  };
}

describe('the booked record, organiser side', () => {
  const sender = () => {
    const sent: { to: string; type: string; body: BookedBody }[] = [];
    let answer: 'took' | 'throw' | 'refuse' = 'took';
    return {
      sent,
      next: (a: typeof answer) => {
        answer = a;
      },
      send: async (to: string, type: string, body: Record<string, unknown>) => {
        const now = answer;
        answer = 'took';
        if (now === 'throw') throw new Error('offline');
        if (now === 'refuse') return REFUSED;
        sent.push({ to, type, body: body as unknown as BookedBody });
        return TOOK;
      },
    };
  };
  const saved: GroupPlan[] = [];
  const deps = (s: ReturnType<typeof sender>) => ({
    sendD2D: s.send,
    selfDid: MIKE,
    nowMs: () => 1_000,
    persist: (p: GroupPlan) => {
      saved.push(p);
    },
  });

  it('K-01: books each guest who accepted, once, about that guest alone', async () => {
    const s = sender();
    const first = await syncBookings(settled(), deps(s));
    expect(s.sent.map((m) => m.to)).toEqual([GARCIA]);
    expect(s.sent[0]?.body).toEqual({
      v: 1,
      record_id: bookingRecordId(MIKE, 'plan-1', GARCIA),
      seq: 1,
      state: 'booked',
      title: "Emma's 8th birthday",
      slot: SAT,
      organiser_did: MIKE,
      guest_did: GARCIA,
      issued_at: new Date(1_000).toISOString(),
    });
    expect(JSON.stringify(s.sent[0]?.body)).not.toMatch(/miller|johnson|accepted|plan-1/i);
    expect(s.sent[0]?.type).toBe('coordination.booked');
    const again = await syncBookings(first.plan, deps(s));
    expect(again.changed).toBe(false);
    expect(s.sent).toHaveLength(1);
  });

  it('K-02: widened after it settled, each booked guest hears "cancelled" under the next number', async () => {
    const s = sender();
    const booked = (await syncBookings(settled(), deps(s))).plan;
    await syncBookings({ ...booked, state: 'proposing', chosen: null }, deps(s));
    expect(s.sent.map((m) => [m.to, m.body.state, m.body.seq, m.body.slot])).toEqual([
      [GARCIA, 'booked', 1, SAT],
      [GARCIA, 'cancelled', 2, SAT],
    ]);
  });

  it('K-03: a send that throws, or that the sender did not take, is tried again', async () => {
    for (const failure of ['throw', 'refuse'] as const) {
      const s = sender();
      s.next(failure);
      const first = await syncBookings(settled(), deps(s));
      // The word is recorded (and saved) before the send that failed.
      expect(first).toMatchObject({ changed: true, pending: true });
      const second = await syncBookings(first.plan, deps(s));
      expect(second).toMatchObject({ changed: true, pending: false });
      expect(s.sent.map((m) => [m.to, m.body.seq])).toEqual([[GARCIA, 1]]);
    }
  });

  it('K-08: each word is saved before it is sent; a word not taken goes again under its number', async () => {
    saved.length = 0;
    const s = sender();
    let savedBeforeSend = false;
    const watch = {
      ...deps(s),
      sendD2D: async (to: string, type: string, body: Record<string, unknown>) => {
        const last = saved.at(-1) as
          | (GroupPlan & { bookings?: Record<string, { seq: number; sent: boolean }> })
          | undefined;
        savedBeforeSend =
          last?.bookings?.[GARCIA]?.seq === 1 && last.bookings[GARCIA]?.sent === false;
        return s.send(to, type, body);
      },
    };
    s.next('refuse');
    const first = await syncBookings(settled(), watch);
    expect(savedBeforeSend).toBe(true);
    expect(first.pending).toBe(true);
    await syncBookings(first.plan, watch);
    expect(s.sent.map((m) => m.body.seq)).toEqual([1]);
  });

  it('K-04: settling on another slot after a lost cancellation books the new slot', async () => {
    const s = sender();
    const booked = (await syncBookings(settled(SAT), deps(s))).plan;
    s.next('throw');
    const widened = await syncBookings({ ...booked, state: 'proposing', chosen: null }, deps(s));
    expect(widened.pending).toBe(true);
    const resettled = await syncBookings(
      { ...settled(SUN), bookings: (widened.plan as { bookings?: unknown }).bookings } as GroupPlan,
      deps(s),
    );
    expect(resettled.pending).toBe(false);
    expect(s.sent.map((m) => [m.body.state, m.body.seq, m.body.slot])).toEqual([
      ['booked', 1, SAT],
      // Cancellation 2 never went out; Sunday's booking goes as 3.
      ['booked', 3, SUN],
    ]);
  });
});

describe('the booked record, guest side', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;
  let store: BookingStore;
  const NOW = Date.parse('2027-03-01T00:00:00Z');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-booking-'));
    db = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    store = new BookingStore(db);
    resetReminderState();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const RECORD = bookingRecordId(MIKE, 'plan-1', GARCIA);
  const body = (over: Partial<BookedBody> = {}): BookedBody => ({
    v: 1,
    record_id: RECORD,
    seq: 1,
    state: 'booked',
    title: "Emma's 8th birthday",
    slot: SAT,
    organiser_did: MIKE,
    guest_did: GARCIA,
    issued_at: '2027-03-01T00:00:00Z',
    ...over,
  });
  const admit = (b: unknown, from = MIKE) =>
    admitBooked({ store, fromDid: from, selfDid: GARCIA, body: b, nowMs: NOW });

  it('K-05: nothing kept that is not from its organiser, about this node, between two, well formed', () => {
    expect(admit(body(), MILLER)).toEqual({ outcome: 'refused', reason: 'not_the_sender' });
    expect(admit(body({ guest_did: MILLER }))).toEqual({
      outcome: 'refused',
      reason: 'not_this_guest',
    });
    expect(admit(body({ guest_did: MIKE }))).toEqual({ outcome: 'refused', reason: 'malformed' });
    expect(admit({ ...body(), others: [MILLER] })).toEqual({
      outcome: 'refused',
      reason: 'malformed',
    });
    expect(admit(body({ seq: 0 }))).toEqual({ outcome: 'refused', reason: 'malformed' });
    expect(admit('not json')).toEqual({ outcome: 'refused', reason: 'malformed' });
    expect(store.list()).toEqual([]);
  });

  it('K-06: the latest word wins whatever the order of arrival', () => {
    // Cancelled (2) before booked (1): it stays cancelled.
    expect(admit(body({ seq: 2, state: 'cancelled' }))).toEqual({
      outcome: 'stored',
      state: 'cancelled',
    });
    expect(admit(body({ seq: 1 }))).toEqual({ outcome: 'stale' });
    expect(store.get(MIKE, RECORD)).toMatchObject({ state: 'cancelled', seq: 2 });
    // Booked again on Sunday (4), then Saturday's older word (3) arrives late.
    expect(admit(body({ seq: 4, slot: SUN }))).toEqual({ outcome: 'stored', state: 'booked' });
    expect(admit(body({ seq: 3, slot: SAT }))).toEqual({ outcome: 'stale' });
    expect(store.get(MIKE, RECORD)).toMatchObject({ state: 'booked', seq: 4, slot: SUN });
    // A repeat is stale too: nothing changes.
    expect(admit(body({ seq: 4, slot: SUN }))).toEqual({ outcome: 'stale' });
  });

  it('K-07: the reminder follows the record, across a restart', async () => {
    admit(body());
    await reconcileBookingReminders(store, NOW);
    const id = store.get(MIKE, RECORD)?.reminderId ?? '';
    expect(getReminder(id)).toMatchObject({
      due_at: Date.parse(SAT.start),
      message: "Emma's 8th birthday",
    });
    // A restart loses the in-memory reminder: the next reconcile sets it again.
    resetReminderState();
    await reconcileBookingReminders(store, NOW);
    const again = store.get(MIKE, RECORD)?.reminderId ?? '';
    expect(getReminder(again)?.due_at).toBe(Date.parse(SAT.start));
    // Moved to Sunday: one reminder, at Sunday.
    admit(body({ seq: 2, slot: SUN }));
    await reconcileBookingReminders(store, NOW);
    expect(
      listByPersona('general')
        .filter((r) => r.kind === 'booking')
        .map((r) => r.due_at),
    ).toEqual([Date.parse(SUN.start)]);
    // Cancelled: no reminder, and none comes back after a restart.
    admit(body({ seq: 3, state: 'cancelled' }));
    await reconcileBookingReminders(store, NOW);
    expect(store.get(MIKE, RECORD)?.reminderId).toBeNull();
    expect(listByPersona('general').filter((r) => r.kind === 'booking')).toEqual([]);
    resetReminderState();
    await reconcileBookingReminders(store, NOW);
    expect(listByPersona('general').filter((r) => r.kind === 'booking')).toEqual([]);
  });

  it('K-09: an unlinked reminder is found by its key; a stale reconcile never resurrects a booking', async () => {
    admit(body());
    await reconcileBookingReminders(store, NOW);
    // A crash between the reminder and its link: the record forgets the link.
    store.linkReminder(MIKE, RECORD, 1, null);
    admit(body({ seq: 2, state: 'cancelled' }));
    await reconcileBookingReminders(store, NOW);
    expect(listByPersona('general').filter((r) => r.kind === 'booking')).toEqual([]);
    // Booked again (3), its reconcile starts; a cancellation (4) lands while it runs.
    admit(body({ seq: 3, slot: SUN }));
    const running = reconcileBookingReminders(store, NOW);
    admit(body({ seq: 4, state: 'cancelled', slot: SUN }));
    const after = reconcileBookingReminders(store, NOW);
    await Promise.all([running, after]);
    expect(store.get(MIKE, RECORD)).toMatchObject({ state: 'cancelled', seq: 4 });
    expect(listByPersona('general').filter((r) => r.kind === 'booking')).toEqual([]);
  });
});
