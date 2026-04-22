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
});
