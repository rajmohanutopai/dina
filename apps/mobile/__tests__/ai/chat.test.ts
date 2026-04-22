/**
 * AI Chat service tests — intent routing, memory integration, reminder creation.
 *
 * Tests the processMessage orchestrator without requiring a real LLM.
 * When no provider is configured, it falls back to local vault operations.
 */

import { processMessage, setActiveProvider, parseDuration } from '../../src/ai/chat';
import {
  resetMemories,
  getMemoryCount,
  getUpcomingReminders,
  searchMemories,
} from '../../src/ai/memory';
import {
  createReminder,
  getReminder,
  resetReminderState,
  getByShortId,
} from '../../../core/src/reminders/service';

describe('AI Chat Service', () => {
  beforeEach(() => {
    resetMemories();
    resetReminderState();
    setActiveProvider(null); // no LLM — local fallback
  });

  describe('/help', () => {
    it('returns help text with memory count', async () => {
      const res = await processMessage('/help');
      expect(res.action).toBe('help');
      expect(res.text).toContain('Remember');
      expect(res.text).toContain('Ask');
      expect(res.memoryCount).toBe(0);
    });
  });

  describe('/remember', () => {
    it('stores a memory and confirms', async () => {
      const res = await processMessage("/remember Emma's birthday is March 15");
      expect(res.action).toBe('remember');
      expect(res.text).toContain('remember');
      expect(res.memoryCount).toBe(1);
      expect(getMemoryCount()).toBe(1);
    });

    it('extracts date and creates reminder', async () => {
      const res = await processMessage('/remember Dentist appointment on December 25, 2030');
      expect(res.action).toBe('remember');
      expect(res.reminderDate).toBe('2030-12-25');

      const reminders = getUpcomingReminders();
      expect(reminders).toHaveLength(1);
      expect(reminders[0].content).toContain('Dentist');
    });

    it('creates reminder for "tomorrow"', async () => {
      const res = await processMessage('/remember Call plumber tomorrow');
      expect(res.reminderDate).not.toBeNull();
      expect(getUpcomingReminders().length).toBeGreaterThanOrEqual(1);
    });

    it('handles memory without date — no reminder', async () => {
      const res = await processMessage('/remember Alice prefers tea');
      expect(res.action).toBe('remember');
      expect(res.reminderDate).toBeNull();
      expect(getUpcomingReminders()).toHaveLength(0);
    });

    it('handles bare /remember with trailing space as chat', async () => {
      // "/remember " trims to "/remember" which doesn't match "/remember " prefix
      // so it's treated as general chat
      const res = await processMessage('/remember ');
      expect(res.action).toBe('chat');
    });

    it('stores multiple memories', async () => {
      await processMessage('/remember fact one');
      await processMessage('/remember fact two');
      await processMessage('/remember fact three');
      expect(getMemoryCount()).toBe(3);
    });
  });

  describe('/ask', () => {
    it('finds stored memory', async () => {
      await processMessage("/remember Emma's birthday is March 15");
      const res = await processMessage('/ask birthday');
      expect(res.action).toBe('ask');
      expect(res.text).toContain('March 15');
      expect(res.sources).toBeGreaterThan(0);
    });

    it('reports no matches for unknown query', async () => {
      const res = await processMessage('/ask xyzzy');
      expect(res.text).toContain("don't have");
    });

    it('handles bare /ask with trailing space as chat', async () => {
      const res = await processMessage('/ask ');
      expect(res.action).toBe('chat');
    });

    it('searches across multiple memories', async () => {
      await processMessage('/remember Bob likes coffee');
      await processMessage('/remember Alice likes tea');
      await processMessage('/remember Bob has a cat');

      const res = await processMessage('/ask Bob');
      expect(res.sources).toBeGreaterThanOrEqual(2);
    });
  });

  describe('general chat (no LLM)', () => {
    it('prompts user to configure provider', async () => {
      const res = await processMessage('Hello Dina');
      expect(res.action).toBe('chat');
      expect(res.text).toContain('Settings');
    });
  });

  describe('remember → ask roundtrip', () => {
    it('stores then retrieves in sequence', async () => {
      await processMessage("/remember Emma's birthday is March 15");
      await processMessage("/remember Bob's phone is 555-1234");

      const res = await processMessage('/ask Emma');
      expect(res.text).toContain('March 15');
      expect(res.sources).toBe(1);
    });

    it('remember with date creates reminder, ask finds it', async () => {
      await processMessage('/remember Doctor appointment January 10, 2031');

      // Ask should find it
      const askRes = await processMessage('/ask doctor');
      expect(askRes.text).toContain('Doctor');

      // Reminder should exist
      const reminders = getUpcomingReminders();
      expect(reminders).toHaveLength(1);
      expect(reminders[0].reminder_date).toBe('2031-01-10');
    });
  });

  describe('reminder commands via short_id', () => {
    it('/snooze snoozes a reminder by short_id', async () => {
      const reminder = createReminder({
        message: 'Call dentist',
        due_at: Date.now() + 60_000,
        persona: 'general',
      });

      const res = await processMessage(`/snooze ${reminder.short_id} 2h`);
      expect(res.text).toContain('Snoozed');
      expect(res.text).toContain('Call dentist');

      const updated = getReminder(reminder.id);
      expect(updated!.status).toBe('snoozed');
    });

    it('/complete marks a reminder done', async () => {
      const reminder = createReminder({
        message: 'Buy groceries',
        due_at: Date.now() + 60_000,
        persona: 'general',
      });

      const res = await processMessage(`/complete ${reminder.short_id}`);
      expect(res.text).toContain('Completed');

      const updated = getReminder(reminder.id);
      expect(updated!.completed).toBe(1);
    });

    it('/dismiss deletes a reminder', async () => {
      const reminder = createReminder({
        message: 'Optional task',
        due_at: Date.now() + 60_000,
        persona: 'general',
      });

      const res = await processMessage(`/dismiss ${reminder.short_id}`);
      expect(res.text).toContain('Dismissed');

      expect(getReminder(reminder.id)).toBeNull();
    });

    it('returns error for unknown short_id', async () => {
      const res = await processMessage('/snooze zzzz');
      expect(res.text).toContain('No reminder found');
    });

    it('/snooze defaults to 1 hour without duration', async () => {
      const now = Date.now();
      const reminder = createReminder({
        message: 'Quick task',
        due_at: now + 60_000,
        persona: 'general',
      });

      await processMessage(`/snooze ${reminder.short_id}`);
      const updated = getReminder(reminder.id);
      // Should be snoozed by ~1 hour (3_600_000 ms)
      expect(updated!.due_at).toBeGreaterThan(now + 3_500_000);
    });
  });

  describe('parseDuration', () => {
    it('parses minutes', () => expect(parseDuration('30m')).toBe(30 * 60 * 1000));
    it('parses hours', () => expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000));
    it('parses days', () => expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000));
    it('defaults to 1h for invalid', () => expect(parseDuration('invalid')).toBe(60 * 60 * 1000));
    it('case insensitive', () => expect(parseDuration('2H')).toBe(2 * 60 * 60 * 1000));
  });
});
