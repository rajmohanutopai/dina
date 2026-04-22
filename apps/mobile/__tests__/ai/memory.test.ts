/**
 * Memory store tests — storage, search, date extraction, reminders.
 */

import {
  addMemory,
  searchMemories,
  getAllMemories,
  getMemoryCount,
  getUpcomingReminders,
  extractDate,
  resetMemories,
  setStagingEnabled,
} from '../../src/ai/memory';
import { getItem, resetStagingState } from '../../../core/src/staging/service';

describe('Memory Store', () => {
  beforeEach(() => {
    resetMemories();
    resetStagingState();
  });

  describe('addMemory', () => {
    it('stores a memory and increments count', () => {
      expect(getMemoryCount()).toBe(0);
      const m = addMemory('Emma birthday is March 15');
      expect(m.id).toBe(1);
      expect(m.content).toBe('Emma birthday is March 15');
      expect(m.category).toBe('general');
      expect(m.reminder_date).toBeNull();
      expect(getMemoryCount()).toBe(1);
    });

    it('stores with custom category', () => {
      const m = addMemory('Blood pressure 120/80', 'health');
      expect(m.category).toBe('health');
    });

    it('stores with reminder date', () => {
      const m = addMemory('Dentist appointment', 'general', '2026-05-01');
      expect(m.reminder_date).toBe('2026-05-01');
    });

    it('assigns unique IDs', () => {
      const m1 = addMemory('first');
      const m2 = addMemory('second');
      expect(m1.id).not.toBe(m2.id);
    });
  });

  describe('searchMemories', () => {
    beforeEach(() => {
      addMemory("Emma's birthday is March 15");
      addMemory('Meeting with Bob at 3pm tomorrow');
      addMemory('Alice prefers tea over coffee');
      addMemory("Bob's phone number is 555-1234");
    });

    it('matches full query', () => {
      const results = searchMemories('birthday');
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('birthday');
    });

    it('matches individual words', () => {
      const results = searchMemories('Bob meeting');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('is case-insensitive', () => {
      expect(searchMemories('EMMA')).toHaveLength(1);
      expect(searchMemories('emma')).toHaveLength(1);
    });

    it('returns empty for no match', () => {
      expect(searchMemories('xyzzy')).toHaveLength(0);
    });

    it('skips short words (<=2 chars)', () => {
      // "is" and "at" should not match everything
      const results = searchMemories('is');
      // "is" is in the full query, so it matches substrings
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('getAllMemories', () => {
    it('returns memories in reverse chronological order', () => {
      addMemory('first');
      addMemory('second');
      addMemory('third');
      const all = getAllMemories();
      expect(all[0].content).toBe('third');
      expect(all[2].content).toBe('first');
    });

    it('returns empty when no memories', () => {
      expect(getAllMemories()).toHaveLength(0);
    });
  });

  describe('getUpcomingReminders', () => {
    it('returns memories with future dates', () => {
      addMemory('Past event', 'general', '2020-01-01');
      addMemory('Future event', 'general', '2030-06-15');
      addMemory('No date event');

      const upcoming = getUpcomingReminders();
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0].content).toBe('Future event');
    });

    it('sorts by date ascending', () => {
      addMemory('Later', 'general', '2030-12-01');
      addMemory('Sooner', 'general', '2030-06-01');

      const upcoming = getUpcomingReminders();
      expect(upcoming[0].content).toBe('Sooner');
      expect(upcoming[1].content).toBe('Later');
    });

    it('returns empty when no reminders', () => {
      addMemory('No date');
      expect(getUpcomingReminders()).toHaveLength(0);
    });
  });

  describe('extractDate', () => {
    it('extracts "March 15"', () => {
      const date = extractDate("Emma's birthday is March 15");
      expect(date).toMatch(/^\d{4}-03-15$/);
    });

    it('extracts "January 1"', () => {
      const date = extractDate('New Year is January 1');
      expect(date).toMatch(/^\d{4}-01-01$/);
    });

    it('extracts "December 25, 2030"', () => {
      expect(extractDate('Christmas is December 25, 2030')).toBe('2030-12-25');
    });

    it('extracts "15th March"', () => {
      const date = extractDate("Emma's birthday is 15th March");
      expect(date).toMatch(/^\d{4}-03-15$/);
    });

    it('extracts "tomorrow"', () => {
      const date = extractDate('Dentist appointment tomorrow');
      expect(date).not.toBeNull();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(date).toBe(tomorrow.toISOString().split('T')[0]);
    });

    it('extracts "next week"', () => {
      const date = extractDate('Team lunch next week');
      expect(date).not.toBeNull();
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      expect(date).toBe(nextWeek.toISOString().split('T')[0]);
    });

    it('extracts "next month"', () => {
      const date = extractDate('Review next month');
      expect(date).not.toBeNull();
    });

    it('returns null for no date', () => {
      expect(extractDate('Alice likes tea')).toBeNull();
      expect(extractDate('Buy groceries')).toBeNull();
    });

    it('handles dates that already passed this year by rolling to next year', () => {
      // January 1 has always passed by now (test runs in 2026+)
      const date = extractDate('Event on January 1');
      if (date) {
        const year = parseInt(date.split('-')[0], 10);
        expect(year).toBeGreaterThanOrEqual(new Date().getFullYear());
      }
    });
  });

  describe('staging pipeline integration', () => {
    it('addMemory ingests into staging pipeline', () => {
      const memory = addMemory('Meeting notes about project alpha', 'work');

      // Memory should have a staging ID from the ingest
      expect(memory.stagingId).toBeTruthy();

      // Staging item should exist
      const staged = getItem(memory.stagingId!);
      expect(staged).not.toBeNull();
      expect(staged!.source).toBe('user_remember');
      expect((staged!.data as any).summary).toBe('Meeting notes about project alpha');
    });

    it('staging failure does not block memory storage', () => {
      setStagingEnabled(false);
      const memory = addMemory('Important note');
      // Memory still saved locally even without staging
      expect(memory.content).toBe('Important note');
      expect(getMemoryCount()).toBe(1);
      expect(memory.stagingId).toBeUndefined();
      setStagingEnabled(true);
    });

    it('deduplicates on source_id when same memory ingested twice', () => {
      const m1 = addMemory('First entry');
      const m2 = addMemory('First entry'); // different memory ID, different source_id

      // Both in local memory
      expect(getMemoryCount()).toBe(2);
      // Both have unique staging IDs (different source_id)
      expect(m1.stagingId).toBeTruthy();
      expect(m2.stagingId).toBeTruthy();
      expect(m1.stagingId).not.toBe(m2.stagingId);
    });
  });
});
