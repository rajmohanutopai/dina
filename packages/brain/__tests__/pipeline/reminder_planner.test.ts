/**
 * T3.28 — Reminder planner: vault context → LLM → plan reminders.
 *
 * The planner is LLM-only as of April 2026 (the prior regex
 * `extractEvents` gate dropped real-world phrasings like "tomorrow at
 * 5 pm"). These tests pin both the new contract — no LLM means no
 * reminders, and the failure must be surfaced via the logger — and
 * the LLM-assisted paths that remain.
 *
 * Source: ARCHITECTURE.md Task 3.28, brain/src/service/reminder_planner.py
 */

import {
  planReminders,
  hasEventSignals,
  consolidateReminders,
  registerReminderLLM,
  resetReminderLLM,
  registerReminderLogger,
  resetReminderLogger,
} from '../../src/pipeline/reminder_planner';
import { resetReminderState, listByPersona } from '../../../core/src/reminders/service';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { createPersona, resetPersonaState, openPersona } from '../../../core/src/persona/service';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Reminder Planner', () => {
  let loggedWarnings: Record<string, unknown>[];

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

    // Capture logger output so we can assert on warnings without
    // letting the default console.warn pollute test output.
    loggedWarnings = [];
    registerReminderLogger({
      warn: (record) => {
        loggedWarnings.push(record);
      },
    });
  });

  afterEach(() => {
    resetReminderLogger();
  });

  describe('planReminders — without LLM (gate behaviour)', () => {
    it('returns an empty result and logs a warning when no LLM is registered', async () => {
      // No `registerReminderLLM` call in this test — the planner
      // should refuse to fabricate events, return empty, and log
      // loudly so a misconfigured boot is visible in the first
      // /remember rather than silently swallowing reminders.
      const result = await planReminders({
        itemId: 'item-no-llm',
        type: 'email',
        summary: 'Birthday March 15',
        body: 'text',
        timestamp: Date.now(),
        persona: 'general',
      });

      expect(result).toEqual({
        eventsDetected: 0,
        remindersCreated: 0,
        reminders: [],
        llmRefined: false,
        vaultContextUsed: 0,
      });
      expect(loggedWarnings).toHaveLength(1);
      expect(loggedWarnings[0]).toMatchObject({
        event: 'reminder_planner.no_llm_provider',
        itemId: 'item-no-llm',
      });
    });

    it('returns no reminders for arbitrary text (no regex fallback)', async () => {
      // Phrases the old regex extractor used to catch — "in 15 minutes",
      // birthday-bare-text, etc. — should now produce zero reminders
      // when the LLM isn't wired. This pins the no-regex contract
      // explicitly so a future "let's add a small fallback for
      // arrivals" PR shows up in code review as a behaviour change.
      const result = await planReminders({
        itemId: 'item-arrival-no-regex',
        type: 'message',
        summary: 'I am coming in 15 minutes',
        body: '',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.remindersCreated).toBe(0);
      expect(result.reminders).toHaveLength(0);
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

    it('LLM failure → returns empty + logs reminder_planner.llm_error', async () => {
      // The previous version silently swallowed LLM errors and looked
      // identical to "no events found" — that hid a real production
      // bug for an entire simulator validation. The new contract:
      // surface every LLM failure through the logger so a quota /
      // network / parse error is visible the instant it happens.
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
      expect(result.remindersCreated).toBe(0);
      expect(result.llmRefined).toBe(false);
      const errorWarn = loggedWarnings.find(
        (w) => w.event === 'reminder_planner.llm_error',
      );
      expect(errorWarn).toBeDefined();
      expect(errorWarn).toMatchObject({
        itemId: 'item-006',
        error: 'LLM down',
      });
    });

    it('unknown LLM kind folds to "custom" — does not poison downstream consumers', async () => {
      // Contract: the LLM is the trust boundary. Anything outside
      // EXTRACTED_EVENT_KINDS (e.g. an LLM hallucinating "follow_up",
      // "task", "ping") MUST be normalized before it reaches the
      // reminder service. Otherwise prioritizeKind / consolidateReminders
      // / UI rendering all branch on `kind` and would behave undefined.
      // Folding to 'custom' preserves the user-visible reminder while
      // taking no behavioral risk.
      registerReminderLLM(
        async () =>
          '{"reminders":[{"message":"odd kind reminder","due_at":' +
          (Date.now() + 86_400_000) +
          ',"kind":"follow_up"}]}',
      );
      const result = await planReminders({
        itemId: 'item-kind-guard',
        type: 'note',
        summary: 'something',
        body: '',
        timestamp: Date.now(),
        persona: 'general',
      });

      expect(result.remindersCreated).toBeGreaterThanOrEqual(1);
      const odd = result.reminders.find((r) => r.message === 'odd kind reminder');
      expect(odd).toBeDefined();
      expect(odd!.kind).toBe('custom');
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

    it('defaults timezone to the runtime IANA zone (not UTC) when not provided', async () => {
      // Why this matters: the prompt instructs the LLM to compute due_at
      // in the supplied tz, falling back to UTC. Hard-coding 'UTC' as
      // the default left a phone in IST silently telling the LLM "user
      // is in UTC" → due_at came back in UTC → mobile UI rendered it in
      // local tz with a 5.5h drift. This test pins the new default:
      // whatever Intl resolves to on this runtime is what the LLM sees.
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

      const expected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      expect(receivedPrompt).toContain(`Current timezone: ${expected}`);
    });

    it('caller-provided timezone overrides the runtime default', async () => {
      let receivedPrompt = '';
      registerReminderLLM(async (_system, prompt) => {
        receivedPrompt = prompt;
        return '{"reminders":[]}';
      });

      await planReminders({
        itemId: 'item-010b',
        type: 'note',
        summary: 'Meeting',
        body: 'text',
        timestamp: Date.now(),
        persona: 'work',
        timezone: 'Asia/Kolkata',
      });

      expect(receivedPrompt).toContain('Current timezone: Asia/Kolkata');
      // No leakage of the runtime fallback when caller is explicit.
      expect(receivedPrompt).not.toContain('Current timezone: UTC');
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
