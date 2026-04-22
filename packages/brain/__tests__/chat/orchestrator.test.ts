/**
 * T4.7–4.9 — Chat orchestrator: parse → route → respond → thread update.
 *
 * Source: ARCHITECTURE.md Tasks 4.7–4.9
 */

import {
  handleChat,
  setDefaultPersona,
  setDefaultProvider,
  resetChatDefaults,
} from '../../src/chat/orchestrator';
import { getThread, resetThreads } from '../../src/chat/thread';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { resetStagingState, inboxSize } from '../../../core/src/staging/service';
import { setAccessiblePersonas } from '../../src/vault_context/assembly';
import { resetReasoningLLM } from '../../src/pipeline/chat_reasoning';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Chat Orchestrator', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    clearVaults();
    resetStagingState();
    resetReasoningLLM();
    resetFactoryCounters();
    setAccessiblePersonas(['general']);
  });

  describe('/remember', () => {
    it('stores memory via staging ingest', async () => {
      const result = await handleChat("/remember Emma's birthday is March 15");
      expect(result.intent).toBe('remember');
      expect(result.response).toContain('remember');
      expect(inboxSize()).toBe(1);
    });

    it('empty payload asks what to remember', async () => {
      const result = await handleChat('/remember');
      expect(result.response).toContain('What would you like');
    });

    it('stores both user message and response in thread', async () => {
      await handleChat('/remember Test memory', 'test-thread');
      const thread = getThread('test-thread');
      expect(thread).toHaveLength(2);
      expect(thread[0].type).toBe('user');
      expect(thread[1].type).toBe('dina');
    });
  });

  describe('/ask', () => {
    it('searches vault and returns answer', async () => {
      storeItem('general', makeVaultItem({ summary: 'Alice likes dark chocolate', body: '' }));
      const result = await handleChat('/ask Alice chocolate');
      expect(result.intent).toBe('ask');
      expect(result.response).toBeTruthy();
      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('empty query asks what to know', async () => {
      const result = await handleChat('/ask');
      expect(result.response).toContain('What would you like');
    });
  });

  describe('implicit question detection', () => {
    it('question without slash → routed as ask', async () => {
      storeItem('general', makeVaultItem({ summary: 'Meeting on Thursday', body: '' }));
      const result = await handleChat('When is the meeting');
      expect(result.intent).toBe('ask');
    });

    it('question mark → routed as ask', async () => {
      const result = await handleChat('What time is the party?');
      expect(result.intent).toBe('ask');
    });
  });

  describe('/search', () => {
    it('returns vault search results (no LLM)', async () => {
      storeItem('general', makeVaultItem({ summary: 'Budget report Q4', body: '' }));
      const result = await handleChat('/search budget');
      expect(result.intent).toBe('search');
      expect(result.response).toContain('result');
      expect(result.sources.length).toBeGreaterThan(0);
    });

    it('no results → "No results found"', async () => {
      const result = await handleChat('/search nonexistent topic xyz');
      expect(result.response).toContain('No results');
    });

    it('empty query → prompt', async () => {
      const result = await handleChat('/search');
      expect(result.response).toContain('What would you like');
    });
  });

  describe('/help', () => {
    it('returns list of commands', async () => {
      const result = await handleChat('/help');
      expect(result.intent).toBe('help');
      expect(result.response).toContain('/remember');
      expect(result.response).toContain('/ask');
      expect(result.response).toContain('/search');
    });
  });

  describe('general chat (no command)', () => {
    it('statement routes through reasoning pipeline', async () => {
      const result = await handleChat('Tell me about the weather');
      expect(result.intent).toBe('chat');
      expect(result.response).toBeTruthy();
    });
  });

  describe('thread management', () => {
    it('uses default "main" thread', async () => {
      await handleChat('Hello');
      expect(getThread('main')).toHaveLength(2); // user + dina
    });

    it('supports custom thread IDs', async () => {
      await handleChat('Hi', 'custom-thread');
      expect(getThread('custom-thread')).toHaveLength(2);
      expect(getThread('main')).toHaveLength(0);
    });

    it('response includes messageId', async () => {
      const result = await handleChat('Test');
      expect(result.messageId).toMatch(/^cm-/);
    });
  });
});
