/**
 * Task 5.38 — EventExtractor tests.
 */

import {
  DEFAULT_MIN_TEXT_LENGTH,
  EventExtractor,
} from '../src/brain/event_extractor';

/** Fixed "now" — 2026-04-22T00:00:00Z. */
const NOW_MS = Date.UTC(2026, 3, 22);

function ext(): EventExtractor {
  return new EventExtractor({ nowMsFn: () => NOW_MS });
}

describe('EventExtractor (task 5.38)', () => {
  describe('short-text filter', () => {
    it('text below minimum → []', () => {
      const e = ext();
      expect(e.extract({ text: 'short' })).toEqual([]);
    });

    it('DEFAULT_MIN_TEXT_LENGTH is 10', () => {
      expect(DEFAULT_MIN_TEXT_LENGTH).toBe(10);
    });

    it('custom minTextLength', () => {
      const e = new EventExtractor({ nowMsFn: () => NOW_MS, minTextLength: 3 });
      // Needs a date + keyword still.
      const r = e.extract({ text: 'due 2026-03-15' });
      expect(r.length).toBeGreaterThan(0);
    });
  });

  describe('payment_due', () => {
    it('payment keyword + ISO date', () => {
      const r = ext().extract({ text: 'Payment due 2026-03-15' });
      expect(r).toHaveLength(1);
      expect(r[0]!.kind).toBe('payment_due');
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
      expect(r[0]!.message).toMatch(/Payment due/);
    });

    it.each([
      'invoice due 2026-03-15',
      'payment 2026-03-15',
      'bill 2026-03-15',
      'due 2026-03-15',
      'overdue balance 2026-03-15',
      'amount owed 2026-03-15',
      'payable 2026-03-15',
    ])('matches keyword in "%s"', (text) => {
      const r = ext().extract({ text });
      expect(r.some((e) => e.kind === 'payment_due')).toBe(true);
    });
  });

  describe('appointment', () => {
    it('appointment keyword + month name + ordinal', () => {
      const r = ext().extract({ text: 'Doctor appointment on March 15' });
      expect(r).toHaveLength(1);
      expect(r[0]!.kind).toBe('appointment');
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z'); // current year = 2026
    });

    it.each([
      'meeting on 2026-03-15',
      'consultation on 2026-03-15',
      'visit on 2026-03-15',
      'checkup on 2026-03-15',
      'check-up on 2026-03-15',
      'session on 2026-03-15',
      'call on 2026-03-15',
      'interview on 2026-03-15',
      'vaccination on 2026-03-15',
      'vaccine on 2026-03-15',
      'jab on 2026-03-15',
    ])('matches keyword in "%s"', (text) => {
      const r = ext().extract({ text });
      expect(r.some((e) => e.kind === 'appointment')).toBe(true);
    });
  });

  describe('birthday', () => {
    it('birthday + date', () => {
      const r = ext().extract({ text: "Emma's birthday on March 21" });
      expect(r).toHaveLength(1);
      expect(r[0]!.kind).toBe('birthday');
      expect(r[0]!.triggerAtIso).toBe('2026-03-21T09:00:00.000Z');
    });

    it.each(['bday', 'birthday', 'birth day', 'born', 'anniversary'])(
      'matches keyword in "%s on 2026-05-01"',
      (keyword) => {
        const r = ext().extract({ text: `${keyword} on 2026-05-01` });
        expect(r.some((e) => e.kind === 'birthday')).toBe(true);
      },
    );
  });

  describe('date-parse negative cases', () => {
    it('no date → []', () => {
      const r = ext().extract({ text: 'Payment due some day' });
      expect(r).toEqual([]);
    });

    it('no keyword → []', () => {
      const r = ext().extract({ text: 'Nothing happens 2026-03-15' });
      expect(r).toEqual([]);
    });

    it('invalid ISO date → []', () => {
      // Feb 30 doesn't exist; buildTs rolls over then rejects.
      const r = ext().extract({ text: 'payment due 2026-02-30' });
      expect(r).toEqual([]);
    });

    it('bogus month name skipped', () => {
      const r = ext().extract({
        text: 'Payment due Xenember 15, 2026',
      });
      expect(r).toEqual([]);
    });
  });

  describe('date format variations', () => {
    it('"March 15, 2026"', () => {
      const r = ext().extract({ text: 'Payment due March 15, 2026' });
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });

    it('"Mar 15 2026" short month name', () => {
      const r = ext().extract({ text: 'Payment due Mar 15 2026' });
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });

    it('"15/03/2026" (European D/M/Y)', () => {
      const r = ext().extract({ text: 'Invoice due 15/03/2026' });
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });

    it('"15-03-2026" (European hyphenated)', () => {
      const r = ext().extract({ text: 'Invoice due 15-03-2026' });
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });

    it('"15th March" (ordinal day + month, no year → current year)', () => {
      const r = ext().extract({ text: 'Appointment 15th March' });
      // current year = 2026 (fixed clock).
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });

    it('"March 15th" (month + ordinal day, no year)', () => {
      const r = ext().extract({ text: 'Appointment March 15th' });
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });

    it('"March 15" (month + day, no year)', () => {
      const r = ext().extract({ text: 'Appointment March 15' });
      expect(r[0]!.triggerAtIso).toBe('2026-03-15T09:00:00.000Z');
    });
  });

  describe('multiple events in same text', () => {
    it('text with both payment + appointment keywords → 2 events', () => {
      const r = ext().extract({
        text: 'Bill payment AND doctor appointment on 2026-03-15',
      });
      expect(r).toHaveLength(2);
      expect(r.map((e) => e.kind).sort()).toEqual(['appointment', 'payment_due']);
    });
  });

  describe('message building', () => {
    it('uses summary when provided', () => {
      const r = ext().extract({
        text: 'Payment due on 2026-03-15',
        summary: 'Electric bill',
      });
      expect(r[0]!.message).toBe('Payment due: Electric bill');
    });

    it('falls back to truncated text when no summary', () => {
      const r = ext().extract({
        text: 'Payment due 2026-03-15 for the monthly electric bill from PG&E',
      });
      expect(r[0]!.message).toMatch(/^Payment due: /);
      // Body snippet capped at 100 chars.
      expect(r[0]!.message.length).toBeLessThan(140);
    });

    it('appends "(from <sender>)" when sender present', () => {
      const r = ext().extract({
        text: 'Appointment on 2026-03-15',
        summary: 'Dentist visit',
        sender: 'Dr Carl',
      });
      expect(r[0]!.message).toBe('Appointment: Dentist visit (from Dr Carl)');
    });
  });

  describe('hasAnyEvent probe', () => {
    it('true when both date + keyword present', () => {
      expect(ext().hasAnyEvent('Payment due 2026-03-15')).toBe(true);
    });

    it('false when only keyword present', () => {
      expect(ext().hasAnyEvent('Payment due sometime')).toBe(false);
    });

    it('false when only date present', () => {
      expect(ext().hasAnyEvent('Random text with 2026-03-15 date')).toBe(false);
    });

    it('false for short text', () => {
      expect(ext().hasAnyEvent('x')).toBe(false);
    });
  });

  describe('triggerAtMs precision', () => {
    it('always 09:00 UTC', () => {
      const r = ext().extract({ text: 'payment due 2026-06-01' });
      const d = new Date(r[0]!.triggerAtMs);
      expect(d.getUTCHours()).toBe(9);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
      expect(d.getUTCMilliseconds()).toBe(0);
    });

    it('Date-arithmetic sanity: triggerAtMs equals Date(iso).getTime()', () => {
      const r = ext().extract({ text: 'payment due 2026-06-01' });
      expect(r[0]!.triggerAtMs).toBe(Date.parse(r[0]!.triggerAtIso));
    });
  });

  describe('current-year resolution', () => {
    it('uses injected clock\'s UTC year for year-less dates', () => {
      const future = new EventExtractor({
        nowMsFn: () => Date.UTC(2030, 0, 1),
      });
      const r = future.extract({ text: 'Appointment March 15' });
      expect(r[0]!.triggerAtIso).toBe('2030-03-15T09:00:00.000Z');
    });
  });
});
