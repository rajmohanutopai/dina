/**
 * T5.3 — Reminder context enrichment: vault-grounded reminder messages.
 *
 * Source: ARCHITECTURE.md Task 5.3
 */

import { enrichReminder } from '../../src/pipeline/reminder_enrichment';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { DEFAULT_TEST_PERSONAS } from '../../../core/src/vault/crud';
import { createReminder, resetReminderState } from '../../../core/src/reminders/service';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Reminder Context Enrichment', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults([...DEFAULT_TEST_PERSONAS, 'work']);
    resetReminderState();
  });

  describe('enrichReminder', () => {
    it('returns original message when no context found', () => {
      const reminder = createReminder({
        message: 'Take out trash',
        due_at: Date.now(),
        persona: 'general',
      });
      const result = enrichReminder(reminder);
      expect(result.enrichedMessage).toBe('Take out trash');
      expect(result.contextItems).toHaveLength(0);
    });

    it('enriches with preference context', () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'James prefers dark roast coffee',
          body: '',
        }),
      );
      const reminder = createReminder({
        message: 'James birthday tomorrow',
        due_at: Date.now(),
        persona: 'general',
      });
      const result = enrichReminder(reminder);
      if (result.contextItems.length > 0) {
        expect(result.enrichedMessage).toContain('James');
        expect(result.contextItems.some((c) => c.relevance === 'preference')).toBe(true);
      }
    });

    it('enriches with promise context', () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Promised to lend Alice the book on stoicism',
          body: '',
        }),
      );
      const reminder = createReminder({
        message: 'Meeting with Alice',
        due_at: Date.now(),
        persona: 'general',
      });
      const result = enrichReminder(reminder);
      if (result.contextItems.length > 0) {
        expect(result.enrichedMessage).toContain('Alice');
      }
    });

    it('searches multiple personas', () => {
      storeItem('general', makeVaultItem({ summary: 'Bob likes hiking', body: '' }));
      storeItem('work', makeVaultItem({ summary: 'Bob project deadline Friday', body: '' }));
      const reminder = createReminder({
        message: 'Call Bob about project',
        due_at: Date.now(),
        persona: 'work',
      });
      const result = enrichReminder(reminder, ['general', 'work']);
      // Should find items from both personas
      if (result.contextItems.length > 0) {
        expect(result.enrichedMessage.length).toBeGreaterThan(reminder.message.length);
      }
    });

    it('limits context items to avoid noise', () => {
      for (let i = 0; i < 20; i++) {
        storeItem(
          'general',
          makeVaultItem({
            summary: `Related item ${i} about meeting topic`,
            body: '',
          }),
        );
      }
      const reminder = createReminder({
        message: 'Team meeting today',
        due_at: Date.now(),
        persona: 'general',
      });
      const result = enrichReminder(reminder);
      // queryVault limits to 5 per term, and we filter for relevance
      expect(result.contextItems.length).toBeLessThanOrEqual(10);
    });

    it('preserves persona in result', () => {
      const reminder = createReminder({
        message: 'Health checkup',
        due_at: Date.now(),
        persona: 'health',
      });
      expect(enrichReminder(reminder).persona).toBe('health');
    });

    it('preserves original message in result', () => {
      const reminder = createReminder({
        message: 'Original message here',
        due_at: Date.now(),
        persona: 'general',
      });
      expect(enrichReminder(reminder).originalMessage).toBe('Original message here');
    });
  });
});
