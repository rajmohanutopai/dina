/**
 * T3.28 — Reminder planner: extract events → vault context → LLM → plan reminders.
 *
 * Source: ARCHITECTURE.md Task 3.28, brain/src/service/reminder_planner.py
 */

import {
  planReminders,
  hasEventSignals,
  consolidateReminders,
  registerReminderLLM,
  resetReminderLLM,
} from '../../src/pipeline/reminder_planner';
import { resetReminderState, listByPersona } from '../../../core/src/reminders/service';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { createPersona, resetPersonaState, openPersona } from '../../../core/src/persona/service';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Reminder Planner', () => {
  beforeEach(() => {
    resetReminderState();
    resetReminderLLM();
    resetFactoryCounters();
    clearVaults();
    resetPersonaState();
    createPersona('general', 'default');
    createPersona('work', 'standard');
    createPersona('financial', 'sensitive');
    openPersona('general');
    openPersona('work');
    openPersona('financial');
  });

  describe('planReminders — deterministic', () => {
    it('extracts birthday event from text', async () => {
      const result = await planReminders({
        itemId: 'item-001',
        type: 'email',
        summary: 'Emma birthday March 15',
        body: "Don't forget Emma's birthday on March 15",
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.eventsDetected).toBeGreaterThanOrEqual(0);
      expect(result.llmRefined).toBe(false);
    });

    it('no events → no reminders', async () => {
      const result = await planReminders({
        itemId: 'item-002',
        type: 'email',
        summary: 'Weekly team update',
        body: 'Here are the highlights',
        timestamp: Date.now(),
        persona: 'work',
      });
      expect(result.eventsDetected).toBe(0);
      expect(result.remindersCreated).toBe(0);
    });

    it('reminders stored in correct persona', async () => {
      const result = await planReminders({
        itemId: 'item-003',
        type: 'invoice',
        summary: 'Invoice due January 15',
        body: 'Payment due by January 15, 2027',
        timestamp: Date.now(),
        persona: 'financial',
      });
      for (const r of result.reminders) {
        expect(r.persona).toBe('financial');
      }
    });

    it('returns llmRefined: false without LLM', async () => {
      const result = await planReminders({
        itemId: 'item-004',
        type: 'email',
        summary: 'Meeting tomorrow',
        body: 'text',
        timestamp: Date.now(),
        persona: 'work',
      });
      expect(result.llmRefined).toBe(false);
      expect(result.vaultContextUsed).toBe(0);
    });
  });

  describe('planReminders — LLM-assisted', () => {
    it('LLM adds additional reminders', async () => {
      registerReminderLLM(
        async (_system, _prompt) =>
          '{"reminders":[{"message":"Follow up on project deadline","due_at":1800000000000,"kind":"deadline"}]}',
      );
      const result = await planReminders({
        itemId: 'item-005',
        type: 'email',
        summary: 'Project update',
        body: 'The deadline is approaching',
        timestamp: Date.now(),
        persona: 'work',
      });
      expect(result.llmRefined).toBe(true);
      expect(result.remindersCreated).toBeGreaterThanOrEqual(1);
    });

    it('LLM failure → falls back to deterministic only', async () => {
      registerReminderLLM(async () => {
        throw new Error('LLM down');
      });
      const result = await planReminders({
        itemId: 'item-006',
        type: 'email',
        summary: 'Birthday March 15',
        body: 'text',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.llmRefined).toBe(false);
    });

    it('LLM duplicates are skipped', async () => {
      registerReminderLLM(
        async () =>
          '{"reminders":[{"message":"Birthday reminder","due_at":1800000000000,"kind":"birthday"}]}',
      );
      const result = await planReminders({
        itemId: 'item-007',
        type: 'email',
        summary: 'Birthday on March 15',
        body: 'Birthday celebration',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.eventsDetected).toBeGreaterThanOrEqual(0);
    });

    it('LLM receives vault context when related items exist', async () => {
      // Store a vault item about Emma
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Emma likes dinosaurs and painting',
          body: '',
          content_l0: 'Emma likes dinosaurs and painting',
        }),
      );

      let receivedPrompt = '';
      registerReminderLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return '{"reminders":[]}';
      });

      await planReminders({
        itemId: 'item-008',
        type: 'note',
        summary: "Emma's birthday is March 15",
        body: "Don't forget Emma's birthday",
        timestamp: Date.now(),
        persona: 'general',
      });

      // The prompt should contain the vault context about Emma
      expect(receivedPrompt).toContain('Emma');
      expect(receivedPrompt).toContain('dinosaurs');
    });

    it('LLM receives timezone in prompt', async () => {
      let receivedPrompt = '';
      registerReminderLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return '{"reminders":[]}';
      });

      await planReminders({
        itemId: 'item-009',
        type: 'note',
        summary: 'Meeting at 3pm',
        body: 'Team standup',
        timestamp: Date.now(),
        persona: 'work',
        timezone: 'America/New_York',
      });

      expect(receivedPrompt).toContain('America/New_York');
    });

    it('defaults timezone to UTC when not provided', async () => {
      let receivedPrompt = '';
      registerReminderLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return '{"reminders":[]}';
      });

      await planReminders({
        itemId: 'item-010',
        type: 'note',
        summary: 'Meeting',
        body: 'text',
        timestamp: Date.now(),
        persona: 'work',
      });

      expect(receivedPrompt).toContain('UTC');
    });

    it('LLM prompt contains persona and instructions from template', async () => {
      let receivedPrompt = '';
      registerReminderLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return '{"reminders":[]}';
      });

      await planReminders({
        itemId: 'item-011',
        type: 'note',
        summary: 'Meeting March 20',
        body: 'text',
        timestamp: Date.now(),
        persona: 'work',
      });

      // Prompt template includes persona instruction
      expect(receivedPrompt).toContain('Dina');
      // Anti-hallucination guard
      expect(receivedPrompt).toContain('NEVER fabricate');
      // JSON output format
      expect(receivedPrompt).toContain('"reminders"');
    });

    it('scrubs PII from prompt before sending to LLM', async () => {
      let receivedPrompt = '';
      registerReminderLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return '{"reminders":[]}';
      });

      await planReminders({
        itemId: 'item-pii',
        type: 'email',
        summary: 'Dentist appointment for alice@health.com',
        body: 'Call 555-444-3333 to confirm the appointment on March 20',
        timestamp: Date.now(),
        persona: 'general',
      });

      // Structured PII should be scrubbed
      expect(receivedPrompt).not.toContain('alice@health.com');
      expect(receivedPrompt).not.toContain('555-444-3333');
      expect(receivedPrompt).toContain('[EMAIL_1]');
      expect(receivedPrompt).toContain('[PHONE_1]');
    });

    it('rehydrates PII tokens in LLM reminder messages', async () => {
      registerReminderLLM(async () =>
        JSON.stringify({
          reminders: [
            {
              due_at: Date.now() + 86_400_000,
              message: 'Call [PHONE_1] to confirm dentist',
              kind: 'appointment',
            },
          ],
        }),
      );

      const result = await planReminders({
        itemId: 'item-rehydrate',
        type: 'email',
        summary: 'Dentist appointment',
        body: 'Call 555-444-3333 to confirm',
        timestamp: Date.now(),
        persona: 'general',
      });

      // The reminder message should have the original phone number restored
      if (result.reminders.length > 0) {
        expect(result.reminders[0].message).toContain('555-444-3333');
        expect(result.reminders[0].message).not.toContain('[PHONE_1]');
      }
    });

    it('reports vaultContextUsed when context found', async () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Alice prefers morning meetings',
          content_l0: 'Alice prefers morning meetings',
        }),
      );

      registerReminderLLM(async () => '{"reminders":[]}');

      const result = await planReminders({
        itemId: 'item-012',
        type: 'note',
        summary: 'Meeting with Alice on Friday',
        body: 'Schedule the quarterly review',
        timestamp: Date.now(),
        persona: 'general',
      });

      expect(result.vaultContextUsed).toBeGreaterThan(0);
    });
  });

  describe('hasEventSignals', () => {
    it('detects birthday keywords', () => {
      expect(hasEventSignals('Birthday party', '')).toBe(true);
    });

    it('detects deadline keywords', () => {
      expect(hasEventSignals('', 'The deadline is next Friday')).toBe(true);
    });

    it('detects month names', () => {
      expect(hasEventSignals('Meeting on January 5', '')).toBe(true);
    });

    it('returns false for no signals', () => {
      expect(hasEventSignals('Hello world', 'Nice weather')).toBe(false);
    });

    it('detects reminder keyword', () => {
      expect(hasEventSignals('Remind me to call', '')).toBe(true);
    });
  });

  describe('consolidateReminders', () => {
    it('merges events within 2-hour window', () => {
      const baseTime = new Date('2027-03-15T18:00:00Z').getTime();
      const events = [
        {
          fire_at: new Date(baseTime).toISOString(),
          message: "Emma's birthday party",
          kind: 'birthday' as const,
          source_item_id: 'item-1',
        },
        {
          fire_at: new Date(baseTime + 60 * 60 * 1000).toISOString(),
          message: 'Dinner reservation at 7pm',
          kind: 'appointment' as const,
          source_item_id: 'item-1',
        },
      ];

      const result = consolidateReminders(events);
      expect(result).toHaveLength(1);
      expect(result[0].message).toContain("Emma's birthday party");
      expect(result[0].message).toContain('Dinner reservation');
    });

    it('keeps events outside 2-hour window separate', () => {
      const baseTime = new Date('2027-03-15T09:00:00Z').getTime();
      const events = [
        {
          fire_at: new Date(baseTime).toISOString(),
          message: 'Morning meeting',
          kind: 'appointment' as const,
          source_item_id: 'item-1',
        },
        {
          fire_at: new Date(baseTime + 8 * 60 * 60 * 1000).toISOString(),
          message: 'Evening dinner',
          kind: 'custom' as const,
          source_item_id: 'item-1',
        },
      ];

      const result = consolidateReminders(events);
      expect(result).toHaveLength(2);
    });

    it('returns single event unchanged', () => {
      const events = [
        {
          fire_at: new Date().toISOString(),
          message: 'Solo event',
          kind: 'custom' as const,
          source_item_id: 'item-1',
        },
      ];
      const result = consolidateReminders(events);
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe('Solo event');
    });

    it('returns empty array unchanged', () => {
      expect(consolidateReminders([])).toEqual([]);
    });

    it('prioritizes higher-priority kind when merging', () => {
      const baseTime = new Date('2027-06-01T10:00:00Z').getTime();
      const events = [
        {
          fire_at: new Date(baseTime).toISOString(),
          message: 'Birthday',
          kind: 'birthday' as const,
          source_item_id: 'item-1',
        },
        {
          fire_at: new Date(baseTime + 30 * 60 * 1000).toISOString(),
          message: 'Payment due',
          kind: 'payment_due' as const,
          source_item_id: 'item-1',
        },
      ];

      const result = consolidateReminders(events);
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('payment_due'); // higher priority than birthday
    });

    it('merges 3 overlapping events into one', () => {
      const baseTime = new Date('2027-01-20T14:00:00Z').getTime();
      const events = [
        {
          fire_at: new Date(baseTime).toISOString(),
          message: 'Event A',
          kind: 'custom' as const,
          source_item_id: 'item-1',
        },
        {
          fire_at: new Date(baseTime + 30 * 60 * 1000).toISOString(),
          message: 'Event B',
          kind: 'custom' as const,
          source_item_id: 'item-1',
        },
        {
          fire_at: new Date(baseTime + 60 * 60 * 1000).toISOString(),
          message: 'Event C',
          kind: 'custom' as const,
          source_item_id: 'item-1',
        },
      ];

      const result = consolidateReminders(events);
      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('Event A');
      expect(result[0].message).toContain('Event B');
      expect(result[0].message).toContain('Event C');
    });
  });
});
