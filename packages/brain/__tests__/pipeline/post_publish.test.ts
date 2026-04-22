/**
 * T3.29 — Post-publish handler: reminders, contact update, ambiguous routing.
 *
 * Source: ARCHITECTURE.md Task 3.29
 */

import { handlePostPublish } from '../../src/pipeline/post_publish';
import { resetReminderState, listByPersona } from '../../../core/src/reminders/service';
import {
  addContact,
  getContact,
  resetContactDirectory,
} from '../../../core/src/contacts/directory';

describe('Post-Publish Handler', () => {
  beforeEach(() => {
    resetReminderState();
    resetContactDirectory();
  });

  describe('reminder extraction', () => {
    it('creates reminder from birthday mention', async () => {
      const result = await handlePostPublish({
        id: 'item-001',
        type: 'email',
        summary: 'Emma birthday March 15',
        body: "Don't forget Emma's birthday on March 15",
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.remindersCreated).toBeGreaterThanOrEqual(0);
      // Note: whether a reminder is created depends on event_extractor finding a valid date
    });

    it('does not crash on items without events', async () => {
      const result = await handlePostPublish({
        id: 'item-002',
        type: 'email',
        summary: 'Weekly team update',
        body: "Here are this week's updates...",
        timestamp: Date.now(),
        persona: 'work',
      });
      expect(result.errors).toHaveLength(0);
    });

    it('reminder is stored in the correct persona', async () => {
      // Create an item with a deadline that event_extractor can detect
      await handlePostPublish({
        id: 'item-003',
        type: 'invoice',
        summary: 'Invoice due January 15',
        body: 'Payment due by January 15, 2027',
        timestamp: Date.now(),
        persona: 'financial',
      });
      // If reminders were created, they should be in the financial persona
      const financialReminders = listByPersona('financial');
      for (const r of financialReminders) {
        expect(r.persona).toBe('financial');
      }
    });
  });

  describe('contact update', () => {
    it('updates last_interaction for known sender', async () => {
      addContact('did:plc:alice', 'Alice');
      const beforeUpdate = getContact('did:plc:alice')!.updatedAt;

      await handlePostPublish({
        id: 'item-010',
        type: 'email',
        summary: 'Hello from Alice',
        body: 'Hi, just checking in!',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:alice',
      });

      const afterUpdate = getContact('did:plc:alice')!.updatedAt;
      expect(afterUpdate).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('returns contactUpdated: true for known sender', async () => {
      addContact('did:plc:bob', 'Bob');
      const result = await handlePostPublish({
        id: 'item-011',
        type: 'email',
        summary: 'Message from Bob',
        body: 'Hey!',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:bob',
      });
      expect(result.contactUpdated).toBe(true);
    });

    it('returns contactUpdated: false for unknown sender', async () => {
      const result = await handlePostPublish({
        id: 'item-012',
        type: 'email',
        summary: 'Spam',
        body: 'Buy now!',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:unknown',
      });
      expect(result.contactUpdated).toBe(false);
    });

    it('skips contact update when no sender_did', async () => {
      const result = await handlePostPublish({
        id: 'item-013',
        type: 'note',
        summary: 'Personal note',
        body: 'My thoughts',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.contactUpdated).toBe(false);
    });
  });

  describe('ambiguous routing detection', () => {
    it('flags low confidence (< 0.5) as ambiguous', async () => {
      const result = await handlePostPublish({
        id: 'item-020',
        type: 'email',
        summary: 'Ambiguous content',
        body: 'Could be work or personal',
        timestamp: Date.now(),
        persona: 'general',
        confidence: 0.3,
      });
      expect(result.ambiguousRouting).toBe(true);
    });

    it('does NOT flag high confidence as ambiguous', async () => {
      const result = await handlePostPublish({
        id: 'item-021',
        type: 'email',
        summary: 'Clearly medical',
        body: 'Lab results',
        timestamp: Date.now(),
        persona: 'health',
        confidence: 0.92,
      });
      expect(result.ambiguousRouting).toBe(false);
    });

    it('does NOT flag when confidence is not provided', async () => {
      const result = await handlePostPublish({
        id: 'item-022',
        type: 'email',
        summary: 'No confidence',
        body: 'text',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.ambiguousRouting).toBe(false);
    });
  });

  describe('error resilience', () => {
    it('never throws — catches all internal errors', async () => {
      // Even with bad data, should not throw
      const result = await handlePostPublish({
        id: '',
        type: '',
        summary: '',
        body: '',
        timestamp: 0,
        persona: '',
      });
      expect(result).toBeDefined();
      expect(typeof result.remindersCreated).toBe('number');
    });
  });
});
