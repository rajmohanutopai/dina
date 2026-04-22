/**
 * T3.26 — Event processing: dispatch events to appropriate handlers.
 *
 * Source: ARCHITECTURE.md Task 3.26
 */

import {
  processEvent,
  processEvents,
  type EventInput,
  type EventResult,
} from '../../src/pipeline/event_processor';

describe('Event Processor', () => {
  describe('approval_needed', () => {
    it('creates an approval request payload', async () => {
      const result = await processEvent({
        event: 'approval_needed',
        data: {
          action: 'unlock_persona',
          requester_did: 'did:key:z6MkBrain',
          persona: 'health',
          reason: 'Need access to health records',
        },
      });

      expect(result.handled).toBe(true);
      expect(result.event).toBe('approval_needed');
      const r = result.result as any;
      expect(r.type).toBe('approval_request');
      expect(r.action).toBe('unlock_persona');
      expect(r.requester_did).toBe('did:key:z6MkBrain');
      expect(r.persona).toBe('health');
    });

    it('rejects missing action', async () => {
      const result = await processEvent({
        event: 'approval_needed',
        data: { requester_did: 'did:key:z6Mk' },
      });

      expect(result.handled).toBe(false);
      expect(result.error).toContain('action is required');
    });

    it('defaults persona to general', async () => {
      const result = await processEvent({
        event: 'approval_needed',
        data: { action: 'test', requester_did: 'did:key:z6Mk' },
      });

      expect(result.handled).toBe(true);
      expect((result.result as any).persona).toBe('general');
    });
  });

  describe('reminder_fired', () => {
    it('classifies priority and creates notification payload', async () => {
      const result = await processEvent({
        event: 'reminder_fired',
        data: {
          message: 'Call the dentist',
          persona: 'health',
          source: 'reminder',
        },
      });

      expect(result.handled).toBe(true);
      const r = result.result as any;
      expect(r.type).toBe('notification');
      expect(r.title).toBe('Reminder');
      expect(r.body).toBe('Call the dentist');
      expect(r.persona).toBe('health');
      // Reminders are Tier 2 (solicited) by default
      expect(r.tier).toBe(2);
      expect(r.priority).toBe('default');
      expect(r.interrupt).toBe(false);
    });

    it('classifies security-related reminder as Tier 1', async () => {
      const result = await processEvent({
        event: 'reminder_fired',
        data: {
          message: 'Security alert: Review unusual login',
          persona: 'general',
          source: 'security',
        },
      });

      const r = result.result as any;
      expect(r.tier).toBe(1);
      expect(r.priority).toBe('high');
      expect(r.interrupt).toBe(true);
    });

    it('rejects missing message', async () => {
      const result = await processEvent({
        event: 'reminder_fired',
        data: { persona: 'general' },
      });

      expect(result.handled).toBe(false);
      expect(result.error).toContain('message is required');
    });
  });

  describe('post_publish', () => {
    it('runs post-publish handler on stored item', async () => {
      const result = await processEvent({
        event: 'post_publish',
        data: {
          id: 'item-1',
          type: 'email',
          summary: 'Meeting with Alice tomorrow at 3pm',
          body: "Hi, let's meet tomorrow at 3pm.",
          timestamp: Date.now(),
          persona: 'work',
        },
      });

      expect(result.handled).toBe(true);
      const r = result.result as any;
      expect(r).toBeDefined();
      expect(typeof r.remindersCreated).toBe('number');
      expect(typeof r.contactUpdated).toBe('boolean');
      expect(typeof r.ambiguousRouting).toBe('boolean');
    });

    it('rejects missing id', async () => {
      const result = await processEvent({
        event: 'post_publish',
        data: { summary: 'test' },
      });

      expect(result.handled).toBe(false);
      expect(result.error).toContain('id and summary are required');
    });

    it('rejects missing summary', async () => {
      const result = await processEvent({
        event: 'post_publish',
        data: { id: 'item-1' },
      });

      expect(result.handled).toBe(false);
    });
  });

  describe('persona_unlocked', () => {
    it('creates drain request for persona', async () => {
      const result = await processEvent({
        event: 'persona_unlocked',
        data: { persona: 'health' },
      });

      expect(result.handled).toBe(true);
      const r = result.result as any;
      expect(r.type).toBe('drain_request');
      expect(r.persona).toBe('health');
    });

    it('rejects missing persona', async () => {
      const result = await processEvent({
        event: 'persona_unlocked',
        data: {},
      });

      expect(result.handled).toBe(false);
      expect(result.error).toContain('persona is required');
    });
  });

  describe('staging_batch', () => {
    it('creates batch trigger with default limit', async () => {
      const result = await processEvent({
        event: 'staging_batch',
        data: {},
      });

      expect(result.handled).toBe(true);
      const r = result.result as any;
      expect(r.type).toBe('batch_trigger');
      expect(r.limit).toBe(10);
    });

    it('accepts custom limit', async () => {
      const result = await processEvent({
        event: 'staging_batch',
        data: { limit: 25 },
      });

      expect((result.result as any).limit).toBe(25);
    });
  });

  describe('unknown event', () => {
    it('returns handled=false for unknown event type', async () => {
      const result = await processEvent({
        event: 'unknown_event' as any,
        data: {},
      });

      expect(result.handled).toBe(false);
      expect(result.error).toContain('Unknown event type');
    });
  });

  describe('processEvents (batch)', () => {
    it('processes multiple events and returns results for each', async () => {
      const inputs: EventInput[] = [
        { event: 'approval_needed', data: { action: 'test', requester_did: 'did:key:z6Mk' } },
        { event: 'staging_batch', data: { limit: 5 } },
        { event: 'persona_unlocked', data: { persona: 'work' } },
      ];

      const results = await processEvents(inputs);

      expect(results).toHaveLength(3);
      expect(results[0].event).toBe('approval_needed');
      expect(results[0].handled).toBe(true);
      expect(results[1].event).toBe('staging_batch');
      expect(results[1].handled).toBe(true);
      expect(results[2].event).toBe('persona_unlocked');
      expect(results[2].handled).toBe(true);
    });

    it('handles mix of success and failure', async () => {
      const inputs: EventInput[] = [
        { event: 'approval_needed', data: { action: 'test', requester_did: 'did:key:z6Mk' } },
        { event: 'approval_needed', data: {} }, // missing action → error
      ];

      const results = await processEvents(inputs);

      expect(results[0].handled).toBe(true);
      expect(results[1].handled).toBe(false);
      expect(results[1].error).toContain('action is required');
    });
  });
});
