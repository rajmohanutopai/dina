/**
 * T1J.8 — Temporal event extraction from vault items.
 *
 * Category A: fixture-based. Verifies date detection creates correct
 * reminder payloads for invoices, appointments, birthdays, deadlines.
 * Tests dual-gate logic (keyword + date), multiple date formats,
 * and expanded keyword set.
 *
 * Source: brain/tests/test_event_extractor.py
 */

import {
  extractEvents,
  isValidReminderPayload,
  extractBirthdayDate,
  extractTime,
  parseRelativeMinutes,
  ARRIVAL_LEAD_MS,
  isExtractedEventKind,
  EXTRACTED_EVENT_KINDS,
} from '../../src/enrichment/event_extractor';
import type { ExtractionInput } from '../../src/enrichment/event_extractor';

describe('Event Extractor', () => {
  describe('extractEvents — month-day format', () => {
    it('extracts payment due date from invoice', () => {
      const input: ExtractionInput = {
        item_id: 'item-001',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Invoice #1234 due March 15, 2026',
        body: 'Your invoice of $500 is due by March 15, 2026.',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('payment_due');
      expect(events[0].fire_at).toContain('2026-03-15');
      expect(events[0].source_item_id).toBe('item-001');
    });

    it('extracts appointment from calendar-like text', () => {
      const input: ExtractionInput = {
        item_id: 'item-002',
        type: 'event',
        timestamp: 1700000000,
        summary: 'Dentist appointment March 20, 2026 at 2pm',
        body: 'Appointment with Dr. Smith on March 20, 2026 at 2:00 PM.',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('appointment');
      expect(events[0].fire_at).toContain('2026-03-20');
    });

    it('extracts birthday with date', () => {
      const input: ExtractionInput = {
        item_id: 'item-003',
        type: 'note',
        timestamp: 1700000000,
        summary: "Emma's birthday is March 15",
        body: "Remember: Emma's birthday is on March 15.",
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('birthday');
      expect(events[0].fire_at).toContain('03-15');
    });

    it('returns empty when no dates found', () => {
      const input: ExtractionInput = {
        item_id: 'item-004',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Weekly status update',
        body: 'Everything is on track. No action items.',
      };
      const events = extractEvents(input);
      expect(events).toEqual([]);
    });

    it('skips birthday without parseable date', () => {
      const input: ExtractionInput = {
        item_id: 'item-005',
        type: 'note',
        timestamp: 1700000000,
        summary: "Emma's birthday is coming up",
        body: "Don't forget Emma's birthday!",
      };
      const events = extractEvents(input);
      expect(events).toEqual([]);
    });

    it('includes source_item_id for lineage tracking', () => {
      const input: ExtractionInput = {
        item_id: 'item-006',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Meeting tomorrow at March 22',
        body: 'See you at March 22.',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].source_item_id).toBe('item-006');
    });

    it('extracts deadline', () => {
      const input: ExtractionInput = {
        item_id: 'item-007',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Project deadline April 1, 2026',
        body: 'The final deadline is April 1, 2026.',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('deadline');
      expect(events[0].fire_at).toContain('2026-04-01');
    });

    it('uses current year when year not specified', () => {
      const input: ExtractionInput = {
        item_id: 'item-008',
        type: 'note',
        timestamp: 1700000000, // Nov 2023
        summary: 'Meeting on June 5',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      // contextTimestamp is 2023, so year should be 2023
      expect(events[0].fire_at).toContain('2023-06-05');
    });
  });

  describe('extractEvents — ISO date format (YYYY-MM-DD)', () => {
    it('extracts ISO date from deadline text', () => {
      const input: ExtractionInput = {
        item_id: 'iso-001',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Deadline is 2026-04-15',
        body: 'The project deadline is 2026-04-15.',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('deadline');
      expect(events[0].fire_at).toContain('2026-04-15');
    });

    it('extracts ISO date from appointment text', () => {
      const input: ExtractionInput = {
        item_id: 'iso-002',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Doctor appointment on 2026-03-20',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('2026-03-20');
    });
  });

  describe('extractEvents — DD/MM/YYYY format', () => {
    it('extracts DD/MM/YYYY from bill text', () => {
      const input: ExtractionInput = {
        item_id: 'ddmm-001',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Bill due 15/03/2026',
        body: 'Your bill is due by 15/03/2026.',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('payment_due');
      expect(events[0].fire_at).toContain('2026-03-15');
    });

    it('rejects invalid DD/MM/YYYY (month > 12)', () => {
      const input: ExtractionInput = {
        item_id: 'ddmm-002',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Payment due 15/13/2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events).toEqual([]);
    });
  });

  describe('extractEvents — ordinal dates', () => {
    it('extracts "27th March" (ordinal + month)', () => {
      const input: ExtractionInput = {
        item_id: 'ord-001',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Meeting on 27th March',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('03-27');
    });

    it('extracts "March 27th" (month + ordinal)', () => {
      const input: ExtractionInput = {
        item_id: 'ord-002',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Appointment on March 27th',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('03-27');
    });

    it('extracts "1st April 2026" with year', () => {
      const input: ExtractionInput = {
        item_id: 'ord-003',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Deadline is 1st April 2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('2026-04-01');
    });

    it('extracts "December 3rd" (month + ordinal, no year)', () => {
      const input: ExtractionInput = {
        item_id: 'ord-004',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Call scheduled December 3rd',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('12-03');
    });
  });

  describe('dual-gate logic', () => {
    it('date without keyword → empty (no reminder)', () => {
      const input: ExtractionInput = {
        item_id: 'gate-001',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Something happened on March 15',
        body: 'The weather was nice on March 15.',
      };
      const events = extractEvents(input);
      expect(events).toEqual([]);
    });

    it('keyword without date → empty (no reminder)', () => {
      const input: ExtractionInput = {
        item_id: 'gate-002',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Schedule a meeting soon',
        body: 'We need to have a meeting about the project.',
      };
      const events = extractEvents(input);
      expect(events).toEqual([]);
    });

    it('keyword + date → creates reminder', () => {
      const input: ExtractionInput = {
        item_id: 'gate-003',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Meeting on March 15',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('appointment');
    });
  });

  describe('expanded keywords', () => {
    it('"consultation" → appointment', () => {
      const input: ExtractionInput = {
        item_id: 'kw-001',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Consultation with specialist on March 10, 2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('appointment');
    });

    it('"vaccination" → appointment', () => {
      const input: ExtractionInput = {
        item_id: 'kw-002',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Vaccination scheduled for April 5, 2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('appointment');
    });

    it('"bill" → payment_due', () => {
      const input: ExtractionInput = {
        item_id: 'kw-003',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Electricity bill due March 20, 2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('payment_due');
    });

    it('"anniversary" → birthday kind', () => {
      const input: ExtractionInput = {
        item_id: 'kw-004',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Wedding anniversary June 10',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('birthday');
    });

    it('"bday" → birthday kind', () => {
      const input: ExtractionInput = {
        item_id: 'kw-005',
        type: 'note',
        timestamp: 1700000000,
        summary: "Tom's bday is July 4",
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('birthday');
    });

    it('"overdue" → payment_due', () => {
      const input: ExtractionInput = {
        item_id: 'kw-006',
        type: 'email',
        timestamp: 1700000000,
        summary: 'Account overdue since January 15, 2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('payment_due');
    });

    it('"check-up" → appointment', () => {
      const input: ExtractionInput = {
        item_id: 'kw-007',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Annual check-up on February 28, 2026',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].kind).toBe('appointment');
    });
  });

  describe('isValidReminderPayload', () => {
    it('validates a complete reminder payload', () => {
      expect(
        isValidReminderPayload({
          fire_at: '2026-03-15T09:00:00Z',
          message: "Emma's birthday tomorrow",
          kind: 'birthday',
          source_item_id: 'item-003',
        }),
      ).toBe(true);
    });

    it('rejects payload with empty fire_at', () => {
      expect(
        isValidReminderPayload({
          fire_at: '',
          message: 'test',
          kind: 'custom',
          source_item_id: 'x',
        }),
      ).toBe(false);
    });

    it('rejects payload with invalid ISO date', () => {
      expect(
        isValidReminderPayload({
          fire_at: 'not-a-date',
          message: 'test',
          kind: 'custom',
          source_item_id: 'x',
        }),
      ).toBe(false);
    });

    it('rejects payload with empty message', () => {
      expect(
        isValidReminderPayload({
          fire_at: '2026-03-15T09:00:00Z',
          message: '',
          kind: 'custom',
          source_item_id: 'x',
        }),
      ).toBe(false);
    });

    it('rejects payload with empty source_item_id', () => {
      expect(
        isValidReminderPayload({
          fire_at: '2026-03-15T09:00:00Z',
          message: 'test',
          kind: 'custom',
          source_item_id: '',
        }),
      ).toBe(false);
    });
  });

  describe('extractBirthdayDate', () => {
    it('extracts "March 15" from birthday text', () => {
      const result = extractBirthdayDate("Emma's birthday is March 15");
      expect(result).not.toBeNull();
      expect(result).toContain('03-15');
    });

    it('extracts "March 15, 2026" with year', () => {
      const result = extractBirthdayDate("Alice's birthday is March 15, 2026");
      expect(result).toBe('2026-03-15');
    });

    it('returns null when no date found', () => {
      expect(extractBirthdayDate("Emma's birthday soon")).toBeNull();
    });

    it('returns null when no birthday keyword', () => {
      expect(extractBirthdayDate('Meeting on March 15')).toBeNull();
    });

    it('handles abbreviated month', () => {
      const result = extractBirthdayDate('Birthday is Dec 25');
      expect(result).not.toBeNull();
      expect(result).toContain('12-25');
    });

    it('handles ordinal date "birthday on 25th December"', () => {
      const result = extractBirthdayDate('Birthday on 25th December');
      expect(result).not.toBeNull();
      expect(result).toContain('12-25');
    });
  });

  describe('extractTime (wired TIME_PATTERN)', () => {
    it('"at 2pm" → { hour: 14, minute: 0 }', () => {
      expect(extractTime('Meeting at 2pm')).toEqual({ hour: 14, minute: 0 });
    });

    it('"at 2:00 PM" → { hour: 14, minute: 0 }', () => {
      expect(extractTime('Dentist at 2:00 PM')).toEqual({ hour: 14, minute: 0 });
    });

    it('"at 14:00" → { hour: 14, minute: 0 }', () => {
      expect(extractTime('Call at 14:00')).toEqual({ hour: 14, minute: 0 });
    });

    it('"at 3:30pm" → { hour: 15, minute: 30 }', () => {
      expect(extractTime('Appointment at 3:30pm')).toEqual({ hour: 15, minute: 30 });
    });

    it('"at 9am" → { hour: 9, minute: 0 }', () => {
      expect(extractTime('Breakfast at 9am')).toEqual({ hour: 9, minute: 0 });
    });

    it('"at 12pm" → { hour: 12, minute: 0 } (noon)', () => {
      expect(extractTime('Lunch at 12pm')).toEqual({ hour: 12, minute: 0 });
    });

    it('returns null when no time found', () => {
      expect(extractTime('Meeting tomorrow')).toBeNull();
    });

    it('extracted time appears in event fire_at', () => {
      const input: ExtractionInput = {
        item_id: 'time-001',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Dentist appointment March 20 at 2pm',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('T14:00:00Z');
    });

    it('defaults to 09:00 when no time in text', () => {
      const input: ExtractionInput = {
        item_id: 'time-002',
        type: 'note',
        timestamp: 1700000000,
        summary: 'Meeting on March 20',
        body: '',
      };
      const events = extractEvents(input);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].fire_at).toContain('T09:00:00Z');
    });
  });

  describe('arrival events (relative time)', () => {
    it('parses "in 15 minutes" → 15', () => {
      expect(parseRelativeMinutes('I am coming in 15 minutes')).toBe(15);
    });

    it('parses "in 1 hour" → 60', () => {
      expect(parseRelativeMinutes('be there in 1 hour')).toBe(60);
    });

    it('parses "in 2 hours" → 120', () => {
      expect(parseRelativeMinutes('arriving in 2 hours')).toBe(120);
    });

    it('parses "10 mins away" → 10', () => {
      expect(parseRelativeMinutes("I'm 10 mins away")).toBe(10);
    });

    it('parses "in 5 min" (short unit) → 5', () => {
      expect(parseRelativeMinutes('on my way, in 5 min')).toBe(5);
    });

    it('rejects relative time over 24h sanity ceiling', () => {
      // 25h = 1500 min — over the RELATIVE_TIME_MAX_MINUTES guard.
      expect(parseRelativeMinutes('arriving in 25 hours')).toBeNull();
    });

    it('rejects zero / negative minutes', () => {
      expect(parseRelativeMinutes('arriving in 0 minutes')).toBeNull();
    });

    it('returns null when no relative-time phrase', () => {
      expect(parseRelativeMinutes('see you next week')).toBeNull();
    });

    it('"I am coming in 15 minutes" → arrival event with 5-min lead', () => {
      const before = Date.now();
      const input: ExtractionInput = {
        item_id: 'arrive-001',
        type: 'message',
        timestamp: Math.floor(before / 1000),
        summary: 'I am coming in 15 minutes',
        body: '',
      };
      const events = extractEvents(input);
      const after = Date.now();

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('arrival');
      expect(events[0].source_item_id).toBe('arrive-001');

      // fire_at should be ~ now + 10min (15min arrival - 5min lead).
      const fireAt = new Date(events[0].fire_at).getTime();
      const expectedMin = before + 10 * 60 * 1000 - 1000; // -1s for fudge
      const expectedMax = after + 10 * 60 * 1000 + 1000; //  +1s for fudge
      expect(fireAt).toBeGreaterThanOrEqual(expectedMin);
      expect(fireAt).toBeLessThanOrEqual(expectedMax);
    });

    it('"on my way, be there in 30 minutes" → 30 - 5 lead', () => {
      const before = Date.now();
      const events = extractEvents({
        item_id: 'arrive-002',
        type: 'message',
        timestamp: Math.floor(before / 1000),
        summary: 'on my way, be there in 30 minutes',
        body: '',
      });
      const after = Date.now();

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('arrival');
      const fireAt = new Date(events[0].fire_at).getTime();
      expect(fireAt).toBeGreaterThanOrEqual(before + 25 * 60 * 1000 - 1000);
      expect(fireAt).toBeLessThanOrEqual(after + 25 * 60 * 1000 + 1000);
    });

    it('"arriving in 1 hour" → 60 - 5 = 55 minutes from now', () => {
      const before = Date.now();
      const events = extractEvents({
        item_id: 'arrive-003',
        type: 'message',
        timestamp: Math.floor(before / 1000),
        summary: 'arriving in 1 hour',
        body: '',
      });
      const after = Date.now();

      expect(events).toHaveLength(1);
      const fireAt = new Date(events[0].fire_at).getTime();
      expect(fireAt).toBeGreaterThanOrEqual(before + 55 * 60 * 1000 - 1000);
      expect(fireAt).toBeLessThanOrEqual(after + 55 * 60 * 1000 + 1000);
    });

    it('imminent arrival ("in 2 minutes") clamps to now + 1 min floor', () => {
      const before = Date.now();
      const events = extractEvents({
        item_id: 'arrive-004',
        type: 'message',
        timestamp: Math.floor(before / 1000),
        summary: 'on my way, be there in 2 minutes',
        body: '',
      });

      expect(events).toHaveLength(1);
      const fireAt = new Date(events[0].fire_at).getTime();
      // Lead time would put fire_at in the past; min-future floor (~+1min)
      // saves us from the planner's past-event filter.
      expect(fireAt).toBeGreaterThan(before);
      expect(fireAt).toBeGreaterThanOrEqual(before + 60 * 1000 - 1000);
    });

    it('arrival language without relative time → no event', () => {
      // "on my way" alone → ambiguous, don't fabricate a time.
      const events = extractEvents({
        item_id: 'arrive-005',
        type: 'message',
        timestamp: Math.floor(Date.now() / 1000),
        summary: 'on my way',
        body: '',
      });
      expect(events).toEqual([]);
    });

    it('relative time without arrival language → no arrival event', () => {
      // "in 15 minutes" alone (no arrive verb) shouldn't be claimed by
      // the arrival path — it's just a standalone time-of-day reference.
      const events = extractEvents({
        item_id: 'arrive-006',
        type: 'note',
        timestamp: Math.floor(Date.now() / 1000),
        summary: 'in 15 minutes',
        body: '',
      });
      expect(events).toEqual([]);
    });

    it('arrival path takes priority over date-keyword path when both match', () => {
      // Body has both arrival language AND a calendar date. Arrival is
      // more time-critical → it wins (single event, kind=arrival).
      const events = extractEvents({
        item_id: 'arrive-007',
        type: 'message',
        timestamp: Math.floor(Date.now() / 1000),
        summary: "I'm coming in 10 minutes — also Emma's birthday March 15",
        body: '',
      });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('arrival');
    });

    it('uses the message text as the reminder message', () => {
      const events = extractEvents({
        item_id: 'arrive-008',
        type: 'message',
        timestamp: Math.floor(Date.now() / 1000),
        summary: 'I am coming in 15 minutes',
        body: '',
      });
      expect(events[0].message).toBe('I am coming in 15 minutes');
    });

    it('exposes ARRIVAL_LEAD_MS as the documented 5 minutes', () => {
      // Pin the public contract so any future change is intentional —
      // the prompt + tests both reference this 5-min figure.
      expect(ARRIVAL_LEAD_MS).toBe(5 * 60 * 1000);
    });
  });

  describe('isExtractedEventKind (LLM trust boundary)', () => {
    it('accepts every canonical kind', () => {
      for (const kind of EXTRACTED_EVENT_KINDS) {
        expect(isExtractedEventKind(kind)).toBe(true);
      }
    });

    it('rejects unknown strings (the bug class this guard closes)', () => {
      expect(isExtractedEventKind('follow_up')).toBe(false);
      expect(isExtractedEventKind('task')).toBe(false);
      expect(isExtractedEventKind('anniversary')).toBe(false);
      expect(isExtractedEventKind('')).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(isExtractedEventKind(undefined)).toBe(false);
      expect(isExtractedEventKind(null)).toBe(false);
      expect(isExtractedEventKind(42)).toBe(false);
      expect(isExtractedEventKind({ kind: 'birthday' })).toBe(false);
    });
  });

  describe('contract: every kind the extractor emits is in EXTRACTED_EVENT_KINDS', () => {
    // Drift detector for the deterministic path. If a future change
    // adds a new internal kind to extractEvents() / classifyEventKind()
    // / extractArrivalEvent() without listing it in
    // EXTRACTED_EVENT_KINDS, the guard at the LLM boundary would also
    // reject it, downstream consolidation logic would treat it as
    // 'reminder' priority 0, and the UI would render the wrong icon.
    // Lock them together via this iteration test — anchored against
    // a representative input per kind.
    const samples: Array<{ name: string; input: ExtractionInput; expectedKind: string }> = [
      {
        name: 'birthday',
        input: {
          item_id: 'k-birthday',
          type: 'note',
          timestamp: 1700000000,
          summary: 'Emma birthday March 15, 2099',
          body: '',
        },
        expectedKind: 'birthday',
      },
      {
        name: 'payment_due',
        input: {
          item_id: 'k-payment',
          type: 'email',
          timestamp: 1700000000,
          summary: 'Invoice #1 due March 20, 2099',
          body: '',
        },
        expectedKind: 'payment_due',
      },
      {
        name: 'appointment',
        input: {
          item_id: 'k-appt',
          type: 'note',
          timestamp: 1700000000,
          summary: 'Dentist appointment March 21, 2099',
          body: '',
        },
        expectedKind: 'appointment',
      },
      {
        name: 'deadline',
        input: {
          item_id: 'k-deadline',
          type: 'note',
          timestamp: 1700000000,
          summary: 'Project deadline March 22, 2099',
          body: '',
        },
        expectedKind: 'deadline',
      },
      {
        name: 'arrival',
        input: {
          item_id: 'k-arrival',
          type: 'message',
          timestamp: Math.floor(Date.now() / 1000),
          summary: 'I am coming in 15 minutes',
          body: '',
        },
        expectedKind: 'arrival',
      },
    ];

    for (const sample of samples) {
      it(`extractor emits canonical kind for ${sample.name}`, () => {
        const events = extractEvents(sample.input);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].kind).toBe(sample.expectedKind);
        expect(isExtractedEventKind(events[0].kind)).toBe(true);
      });
    }
  });
});
