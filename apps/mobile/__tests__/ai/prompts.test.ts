/**
 * Prompt registry tests — validates prompt templates match main Dina patterns.
 *
 * These tests verify:
 * 1. All prompts contain required rules and constraints
 * 2. Prompt builders produce valid system/user pairs
 * 3. Classification prompt includes persona list
 * 4. Four Laws are embedded in chat prompts
 */

import {
  PROMPT_PERSONA_CLASSIFY_SYSTEM,
  PROMPT_VAULT_CONTEXT_SYSTEM,
  PROMPT_CHAT_SYSTEM,
  PROMPT_REMINDER_PLANNER_SYSTEM,
  PROMPT_REMEMBER_ACK_SYSTEM,
  DEFAULT_PERSONAS,
  buildClassifyPrompt,
  buildVaultContextPrompt,
  buildChatPrompt,
  buildReminderPrompt,
  buildRememberAckPrompt,
} from '../../src/ai/prompts';

describe('Prompt Registry', () => {
  describe('PROMPT_PERSONA_CLASSIFY_SYSTEM', () => {
    it('includes classification rules', () => {
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('data classifier');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('primary purpose');
    });

    it('includes common patterns from main Dina', () => {
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('Social facts');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('health');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('finance');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('work');
    });

    it('includes temporal event detection', () => {
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('has_event');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('event_hint');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('temporal');
    });

    it('requires JSON response format', () => {
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('"primary"');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('"confidence"');
    });

    it('includes doctor disambiguation examples', () => {
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('Dr. Smith for lunch');
      expect(PROMPT_PERSONA_CLASSIFY_SYSTEM).toContain('blood test results');
    });
  });

  describe('PROMPT_VAULT_CONTEXT_SYSTEM', () => {
    it('identifies as Dina sovereign AI', () => {
      expect(PROMPT_VAULT_CONTEXT_SYSTEM).toContain('sovereign personal AI');
    });

    it('includes fabrication ban', () => {
      expect(PROMPT_VAULT_CONTEXT_SYSTEM).toContain('Never fabricate');
    });

    it('includes recommendation ban', () => {
      expect(PROMPT_VAULT_CONTEXT_SYSTEM).toContain('Never recommend');
      expect(PROMPT_VAULT_CONTEXT_SYSTEM).toContain('training data');
    });

    it('includes trust rules', () => {
      expect(PROMPT_VAULT_CONTEXT_SYSTEM).toContain('trust');
      expect(PROMPT_VAULT_CONTEXT_SYSTEM).toContain('unverified');
    });
  });

  describe('PROMPT_CHAT_SYSTEM', () => {
    it('embeds the Four Laws', () => {
      expect(PROMPT_CHAT_SYSTEM).toContain('Silence First');
      expect(PROMPT_CHAT_SYSTEM).toContain('Verified Truth');
      expect(PROMPT_CHAT_SYSTEM).toContain('Cart Handover');
      expect(PROMPT_CHAT_SYSTEM).toContain('Never Replace a Human');
    });

    it('bans emojis', () => {
      expect(PROMPT_CHAT_SYSTEM).toContain('Never use emojis');
    });

    it('identifies as sovereign on-device AI', () => {
      expect(PROMPT_CHAT_SYSTEM).toContain('sovereign');
      expect(PROMPT_CHAT_SYSTEM).toContain('device');
    });
  });

  describe('PROMPT_REMINDER_PLANNER_SYSTEM', () => {
    it('includes birthday example', () => {
      expect(PROMPT_REMINDER_PLANNER_SYSTEM).toContain('birthday');
      expect(PROMPT_REMINDER_PLANNER_SYSTEM).toContain('gift');
    });

    it('bans emotional tone', () => {
      expect(PROMPT_REMINDER_PLANNER_SYSTEM).toContain('never emotional');
      expect(PROMPT_REMINDER_PLANNER_SYSTEM).toContain('No cheerleading');
    });

    it('requires JSON response', () => {
      expect(PROMPT_REMINDER_PLANNER_SYSTEM).toContain('"reminders"');
      expect(PROMPT_REMINDER_PLANNER_SYSTEM).toContain('"fire_at"');
    });
  });

  describe('DEFAULT_PERSONAS', () => {
    it('includes all four persona types', () => {
      expect(DEFAULT_PERSONAS).toContain('general');
      expect(DEFAULT_PERSONAS).toContain('health');
      expect(DEFAULT_PERSONAS).toContain('finance');
      expect(DEFAULT_PERSONAS).toContain('work');
    });
  });

  describe('buildClassifyPrompt', () => {
    it('injects persona list into system prompt', () => {
      const { system, user } = buildClassifyPrompt("Emma's birthday is March 15");
      expect(system).toContain('general');
      expect(system).toContain('health');
      expect(system).not.toContain('{personas}');
      expect(user).toContain("Emma's birthday");
    });
  });

  describe('buildVaultContextPrompt', () => {
    it('injects memories into system prompt', () => {
      const memories = [
        {
          content: "Emma's birthday is March 15",
          category: 'general',
          created_at: '2026-04-12T10:00:00Z',
        },
      ];
      const { system, prompt } = buildVaultContextPrompt("When is Emma's birthday?", memories);
      expect(system).toContain("Emma's birthday");
      expect(system).toContain('[general]');
      expect(system).not.toContain('{vault_context}');
      expect(prompt).toContain('birthday');
    });

    it('handles empty memories', () => {
      const { system } = buildVaultContextPrompt('test', []);
      expect(system).toContain('no stored memories');
    });
  });

  describe('buildChatPrompt', () => {
    it('injects memory context', () => {
      const memories = [{ content: 'Alice likes tea' }];
      const { system } = buildChatPrompt('Hello', memories);
      expect(system).toContain('Alice likes tea');
      expect(system).not.toContain('{memory_context}');
    });
  });

  describe('buildReminderPrompt', () => {
    it('injects content and today date', () => {
      const { system } = buildReminderPrompt("Emma's birthday is March 15");
      expect(system).toContain("Emma's birthday");
      expect(system).not.toContain('{content}');
      expect(system).not.toContain('{today}');
    });
  });

  describe('buildRememberAckPrompt', () => {
    it('injects classification and reminder info', () => {
      const { system, prompt } = buildRememberAckPrompt(
        "Emma's birthday",
        'Classified as: general',
        'Reminder set for 2027-03-15',
      );
      expect(system).toContain('general');
      expect(system).toContain('Reminder set');
      expect(prompt).toContain("Emma's birthday");
    });
  });
});
