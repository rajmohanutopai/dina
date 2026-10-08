/**
 * REAL_LIFE_FIXES §2.6 — reminders for a dated event are derived in code
 * (dina_details.md 3.3 / 13.2): the day before at 10:00 with the prep note,
 * and the day itself at 09:00, in the owner's timezone.
 */

import { deriveEventReminders, wallClockToEpoch } from '../../src/reasoning/schedule_reminder_tool';

const TZ = 'Asia/Kolkata';
const at = (y: number, m: number, d: number, h = 0, min = 0): number => wallClockToEpoch(y, m, d, h, min, TZ);

describe('deriveEventReminders', () => {
  it('a birthday gives the day before at 10:00 (with the note) and the day at 09:00', () => {
    const out = deriveEventReminders(
      { kind: 'birthday', month: 11, day: 7, title: "Emma's birthday", prep_note: 'she loves dinosaurs' },
      at(2026, 10, 8, 12),
      TZ,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.reminders).toEqual([
      { message: "Emma's birthday is tomorrow — she loves dinosaurs", dueAtMs: at(2026, 11, 6, 10) },
      { message: "Emma's birthday is today", dueAtMs: at(2026, 11, 7, 9) },
    ]);
  });

  it('a birthday already past this year moves to next year', () => {
    const out = deriveEventReminders({ kind: 'birthday', month: 3, day: 2, title: "Juno's birthday" }, at(2026, 10, 8), TZ);
    if (!out.ok) throw new Error(out.error);
    expect(out.reminders[1]!.dueAtMs).toBe(at(2027, 3, 2, 9));
  });

  it('29 February falls on 28 February in a non-leap year', () => {
    const out = deriveEventReminders({ kind: 'anniversary', month: 2, day: 29, title: 'Our anniversary' }, at(2026, 10, 8), TZ);
    if (!out.ok) throw new Error(out.error);
    expect(out.reminders[1]!.dueAtMs).toBe(at(2027, 2, 28, 9));
  });

  it('a one-time event keeps its date and never rolls to next year', () => {
    const past = deriveEventReminders({ kind: 'one_time', month: 3, day: 2, title: 'The conference' }, at(2026, 10, 8), TZ);
    expect(past.ok).toBe(false);
    const future = deriveEventReminders(
      { kind: 'one_time', month: 12, day: 1, year: 2026, title: 'The school play', time: '18:30' },
      at(2026, 10, 8),
      TZ,
    );
    if (!future.ok) throw new Error(future.error);
    expect(future.reminders.map((r) => r.dueAtMs)).toEqual([at(2026, 11, 30, 10), at(2026, 12, 1, 18, 30)]);
  });

  it('a prep time already past is skipped; the day-of reminder stays', () => {
    const out = deriveEventReminders({ kind: 'birthday', month: 10, day: 9, title: "Sam's birthday" }, at(2026, 10, 8, 14), TZ);
    if (!out.ok) throw new Error(out.error);
    expect(out.reminders).toEqual([{ message: "Sam's birthday is today", dueAtMs: at(2026, 10, 9, 9) }]);
  });

  it('the day-before reminder uses the calendar day across a DST change', () => {
    const ny = 'America/New_York';
    // US DST starts 8 March 2026; the day before a 9 March event is 8 March.
    const out = deriveEventReminders({ kind: 'birthday', month: 3, day: 9, title: "Ana's birthday" }, wallClockToEpoch(2026, 1, 5, 0, 0, ny), ny);
    if (!out.ok) throw new Error(out.error);
    expect(out.reminders[0]!.dueAtMs).toBe(wallClockToEpoch(2026, 3, 8, 10, 0, ny));
  });
});
