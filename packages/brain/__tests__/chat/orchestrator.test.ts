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
  setRememberDrainHook,
  resetRememberDrainHook,
  setAskCommandHandler,
  resetAskCommandHandler,
} from '../../src/chat/orchestrator';
import { getThread, resetThreads } from '../../src/chat/thread';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { resetStagingState, inboxSize } from '../../../core/src/staging/service';
import { setAccessiblePersonas } from '../../src/vault_context/assembly';
import { resetReasoningLLM } from '../../src/pipeline/chat_reasoning';
import { createReminder, resetReminderState } from '../../../core/src/reminders/service';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Chat Orchestrator', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    clearVaults();
    resetStagingState();
    resetReasoningLLM();
    resetFactoryCounters();
    resetRememberDrainHook();
    resetReminderState();
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

    it('drain-hook flow: replies "Stored in <persona> vault." with reminder list (Python parity)', async () => {
      // Reminder planner uses the staging row's id as `source_item_id`
      // on generated reminders, so the orchestrator can filter by the
      // staging id it already has from ingest(). We simulate the drain
      // result by (a) installing a hook that just reports the persona
      // and (b) pre-creating a reminder with the staging id we predict
      // ingest() will emit — captured inline via the hook callback.
      const dueAt = Date.UTC(new Date().getUTCFullYear() + 1, 10, 7, 9, 0); // Nov 7
      setRememberDrainHook(async (stagingId) => {
        createReminder({
          message: "It is Emma's birthday today",
          due_at: dueAt,
          persona: 'general',
          kind: 'birthday',
          source_item_id: stagingId,
          source: 'reminder_planner',
        });
        return { persona: 'general' };
      });

      const result = await handleChat("/remember Emma's birthday is on Nov 7th");
      expect(result.intent).toBe('remember');
      expect(result.response).toContain('Stored in General vault.');
      expect(result.response).toContain('Reminders set:');
      expect(result.response).toContain('🎂');
      expect(result.response).toContain("Emma's birthday today");
    });

    it('drain-hook flow without temporal event: only the persona ack (no Reminders set: section)', async () => {
      setRememberDrainHook(async () => ({ persona: 'general' }));

      const result = await handleChat('/remember Alonso prefers cold brew');
      expect(result.response).toContain('Stored in General vault.');
      expect(result.response).not.toContain('Reminders set:');
    });

    it('drain-hook returning null persona: legacy "Got it" ack (drain not resolved yet)', async () => {
      setRememberDrainHook(async () => ({ persona: null }));

      const result = await handleChat('/remember edge case');
      expect(result.response).toContain("Got it — I'll remember that");
      expect(result.response).not.toContain('Stored in');
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

  describe('/task', () => {
    afterEach(() => resetAskCommandHandler());

    it('routes to the agentic-loop handler with a delegate-to-agent directive', async () => {
      // Capture the query the handler received so we can assert the
      // directive was prepended. The handler stub returns a synthetic
      // reply — the real agentic loop calls `delegate_to_agent`, but
      // that's covered in the tool's own unit tests.
      const seen: string[] = [];
      setAskCommandHandler(async (query) => {
        seen.push(query);
        return { response: 'agent dispatched', sources: [], serviceQueries: [] };
      });

      const result = await handleChat('/task fetch my unread email');
      expect(result.intent).toBe('task');
      expect(result.response).toBe('agent dispatched');
      expect(seen).toHaveLength(1);
      // Directive must contain the tool name + the original payload.
      expect(seen[0]).toMatch(/delegate_to_agent/);
      expect(seen[0]).toMatch(/TASK MODE/);
      expect(seen[0]).toMatch(/fetch my unread email/);
    });

    it('empty payload asks what to do (does not invoke the handler)', async () => {
      const seen: string[] = [];
      setAskCommandHandler(async (query) => {
        seen.push(query);
        return { response: 'unexpected', sources: [], serviceQueries: [] };
      });
      const result = await handleChat('/task');
      expect(result.intent).toBe('task');
      expect(result.response).toMatch(/paired agent/i);
      expect(seen).toHaveLength(0);
    });

    it('user-visible message in the thread is the original (no directive leak)', async () => {
      setAskCommandHandler(async () => ({
        response: 'ok',
        sources: [],
        serviceQueries: [],
      }));
      await handleChat('/task list my pull requests', 'task-thread');
      const thread = getThread('task-thread');
      const userMsg = thread.find((m) => m.type === 'user');
      // The thread shows what the user typed — never the wrapped
      // directive — so the chat UI stays clean.
      expect(userMsg?.content).toBe('/task list my pull requests');
      expect(userMsg?.content ?? '').not.toMatch(/TASK MODE/);
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
