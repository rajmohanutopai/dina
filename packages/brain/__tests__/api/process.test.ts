/**
 * T2B.1 + T3.26 — Brain API /v1/process: event dispatch with handler integration.
 *
 * Source: brain/tests/test_api.py, Task 3.26
 */

import { processEvent, validateProcessEvent, isRecognizedEventType } from '../../src/api/process';
import { resetReminderState } from '../../../core/src/reminders/service';
import { resetStagingState, ingest, claim, resolve } from '../../../core/src/staging/service';
import { clearVaults, storeItem } from '../../../core/src/vault/crud';
import { resetReasoningLLM } from '../../src/pipeline/chat_reasoning';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';
import {
  resetDNDState,
  resetEscalationState,
  resetUserOverrides,
  resetQuietHoursState,
  resetBatchingState,
} from '../../src/guardian/silence';

describe('Brain API /v1/process', () => {
  beforeEach(() => {
    resetReminderState();
    resetStagingState();
    clearVaults();
    resetReasoningLLM();
    resetFactoryCounters();
    resetDNDState();
    resetEscalationState();
    resetUserOverrides();
    resetQuietHoursState();
    resetBatchingState();
  });

  describe('processEvent — dispatch', () => {
    it('reminder_fired → notify_user with tier', async () => {
      const result = await processEvent({
        type: 'reminder_fired',
        payload: { reminder_id: 'rem-001', subject: 'Meeting' },
      });
      expect(result.processed).toBe(true);
      expect(result.actions).toContain('notify_user');
      expect(result.data?.reminder_id).toBe('rem-001');
      expect(result.priority).toBeDefined();
    });

    it('vault_unlocked → drains pending staging items', async () => {
      // Set up a pending_unlock staging item
      const { id } = ingest({ source: 'gmail', source_id: 'x' });
      claim(10);
      resolve(id, 'health', false); // pending_unlock

      const result = await processEvent({
        type: 'vault_unlocked',
        payload: { persona: 'health' },
      });
      expect(result.actions).toContain('drain_pending_unlock');
      expect(result.data?.drained).toBe(1);
    });

    it('text_query → runs reasoning pipeline', async () => {
      storeItem('general', makeVaultItem({ summary: 'Alice likes chocolate', body: '' }));
      const result = await processEvent({
        type: 'text_query',
        payload: { query: 'Alice chocolate', persona: 'general', provider: 'none' },
      });
      expect(result.actions).toContain('reason');
      expect(result.data?.answer).toBeDefined();
    });

    it('post_publish → runs post-publish handler', async () => {
      const result = await processEvent({
        type: 'post_publish',
        payload: { id: 'item-1', type: 'email', summary: 'Test', body: 'text', persona: 'general' },
      });
      expect(result.actions).toContain('extract_reminders');
      expect(result.data?.remindersCreated).toBeDefined();
    });

    it('incoming_message → classifies priority', async () => {
      const result = await processEvent({
        type: 'incoming_message',
        payload: { from: 'did:plc:sancho', subject: 'Hello' },
      });
      expect(result.actions).toContain('classify_priority');
      expect(result.data?.tier).toBeDefined();
    });

    it('agent_intent → evaluates intent', async () => {
      const result = await processEvent({
        type: 'agent_intent',
        payload: { action: 'search', agent_did: 'did:key:z6Mk' },
      });
      expect(result.actions).toContain('evaluate_intent');
    });

    it('approval_needed → prompts user', async () => {
      const result = await processEvent({
        type: 'approval_needed',
        payload: { approval_id: 'apr-001' },
      });
      expect(result.actions).toContain('prompt_user');
    });
  });

  describe('processEvent — errors', () => {
    it('rejects missing type', async () => {
      await expect(processEvent({ type: '', payload: {} })).rejects.toThrow('invalid event');
    });

    it('rejects unrecognized type', async () => {
      await expect(processEvent({ type: 'invalid_xyz', payload: {} })).rejects.toThrow(
        'unrecognized',
      );
    });
  });

  describe('validateProcessEvent', () => {
    it('accepts valid event', () => {
      expect(validateProcessEvent({ type: 'reminder_fired', payload: {} }).valid).toBe(true);
    });

    it('rejects missing type', () => {
      expect(validateProcessEvent({ payload: {} }).valid).toBe(false);
    });

    it('rejects null', () => {
      expect(validateProcessEvent(null).valid).toBe(false);
    });

    it('rejects non-object', () => {
      expect(validateProcessEvent('string').valid).toBe(false);
    });
  });

  describe('isRecognizedEventType', () => {
    const recognized = [
      'reminder_fired',
      'vault_unlocked',
      'approval_needed',
      'post_publish',
      'incoming_message',
      'text_query',
      'agent_intent',
    ];

    for (const type of recognized) {
      it(`recognizes "${type}"`, () => expect(isRecognizedEventType(type)).toBe(true));
    }

    it('rejects unknown', () => expect(isRecognizedEventType('made_up')).toBe(false));
  });
});
