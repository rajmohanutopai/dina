/**
 * T2B.17 — Vault context assembly: tool execution, reasoning agent, user origin.
 *
 * Category B: contract test.
 *
 * Source: brain/tests/test_vault_context.py
 */

import {
  assembleContext,
  executeToolSearch,
  runReasoningAgent,
  getToolDeclarations,
  propagateUserOrigin,
  setAccessiblePersonas,
  registerReasoningProvider,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import type { LLMMessage } from '../../src/vault_context/assembly';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { createPersona, resetPersonaState, openPersona } from '../../../core/src/persona/service';
import { addContact, resetContactDirectory } from '../../../core/src/contacts/directory';
import { createReminder, resetReminderState } from '../../../core/src/reminders/service';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Vault Context Assembly', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
    setAccessiblePersonas(['general']);
    resetReasoningProvider();
  });

  describe('assembleContext', () => {
    it('gathers items from accessible personas', async () => {
      storeItem('general', makeVaultItem({ summary: 'Emma birthday March 15', body: '' }));
      const ctx = await assembleContext('Emma birthday');
      expect(ctx.items.length).toBeGreaterThan(0);
      expect(ctx.items[0].content_l0).toContain('Emma');
    });

    it('respects maxTokens budget', async () => {
      for (let i = 0; i < 20; i++) {
        storeItem(
          'general',
          makeVaultItem({ summary: `Item ${i} about budget topic`, body: 'x'.repeat(500) }),
        );
      }
      const ctx = await assembleContext('budget', 100);
      expect(ctx.tokenEstimate).toBeLessThanOrEqual(200);
      expect(ctx.items.length).toBeLessThan(20);
    });

    it('returns token estimate', async () => {
      storeItem('general', makeVaultItem({ summary: 'Token test item', body: '' }));
      const ctx = await assembleContext('token');
      expect(ctx.tokenEstimate).toBeGreaterThan(0);
    });

    it('lists which personas were searched', async () => {
      const ctx = await assembleContext('test');
      expect(ctx.personas).toContain('general');
    });

    it('excludes closed/locked persona results', async () => {
      storeItem('health', makeVaultItem({ summary: 'Lab results from doctor', body: '' }));
      setAccessiblePersonas(['general']);
      const ctx = await assembleContext('lab results');
      expect(ctx.items).toHaveLength(0);
    });

    it('includes results from multiple accessible personas', async () => {
      storeItem('general', makeVaultItem({ summary: 'General meeting notes', body: '' }));
      storeItem('work', makeVaultItem({ summary: 'Work meeting agenda', body: '' }));
      setAccessiblePersonas(['general', 'work']);
      const ctx = await assembleContext('meeting');
      expect(ctx.items.length).toBe(2);
    });

    it('returns empty when no matches', async () => {
      const ctx = await assembleContext('nonexistent topic xyz');
      expect(ctx.items).toHaveLength(0);
    });
  });

  describe('executeToolSearch', () => {
    it('searches a specific persona', async () => {
      storeItem('general', makeVaultItem({ summary: 'Team meeting Thursday', body: '' }));
      const items = await executeToolSearch('general', 'meeting', 10);
      expect(items.length).toBe(1);
      expect(items[0].persona).toBe('general');
    });

    it('returns items with scores', async () => {
      storeItem('general', makeVaultItem({ summary: 'Score test', body: '' }));
      const items = await executeToolSearch('general', 'score');
      expect(items[0].score).toBeGreaterThan(0);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        storeItem('general', makeVaultItem({ summary: `Limit test ${i}`, body: '' }));
      }
      const items = await executeToolSearch('general', 'limit', 5);
      expect(items.length).toBe(5);
    });

    it('returns content_l0 from item summary', async () => {
      storeItem(
        'general',
        makeVaultItem({ summary: 'Alice birthday', content_l0: 'Birthday of Alice' }),
      );
      const items = await executeToolSearch('general', 'birthday');
      expect(items[0].content_l0).toBeTruthy();
    });

    it('includes content_l1 for top 5 results only', async () => {
      for (let i = 0; i < 8; i++) {
        storeItem(
          'general',
          makeVaultItem({
            summary: `Progressive item ${i}`,
            body: '',
            content_l1: `Detail for item ${i}`,
          }),
        );
      }
      const items = await executeToolSearch('general', 'progressive', 8);
      expect(items[0].content_l1).toBeTruthy();
      expect(items[4].content_l1).toBeTruthy();
      expect(items[5].content_l1).toBeUndefined();
    });

    it('returns empty for no matches', async () => {
      expect(await executeToolSearch('general', 'nonexistent')).toHaveLength(0);
    });
  });

  describe('runReasoningAgent', () => {
    it('returns context-based answer without LLM provider', async () => {
      storeItem('general', makeVaultItem({ summary: 'Emma birthday March 15', body: '' }));
      const ctx = await assembleContext('Emma birthday');
      const result = await runReasoningAgent("When is Emma's birthday?", ctx);
      expect(result.answer).toContain('Emma');
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.turnsUsed).toBe(0);
    });

    it('returns "no information" for empty context', async () => {
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      const result = await runReasoningAgent('Unknown topic', ctx);
      expect(result.answer).toContain("don't have");
      expect(result.turnsUsed).toBe(0);
    });

    it('uses LLM provider when registered (no tool calls)', async () => {
      registerReasoningProvider(async (messages: LLMMessage[]) => ({
        role: 'assistant' as const,
        content: "Emma's birthday is March 15th.",
      }));
      const ctx = {
        items: [
          { id: 'item-1', content_l0: 'Emma birthday March 15', score: 1, persona: 'general' },
        ],
        tokenEstimate: 10,
        personas: ['general'],
      };
      const result = await runReasoningAgent("When is Emma's birthday?", ctx);
      expect(result.answer).toBe("Emma's birthday is March 15th.");
      expect(result.turnsUsed).toBe(1);
    });

    it('executes tool calls in multi-turn loop', async () => {
      storeItem('general', makeVaultItem({ summary: 'Budget report Q4', body: '' }));
      let turn = 0;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        turn++;
        if (turn === 1) {
          return {
            role: 'assistant' as const,
            content: '',
            toolCalls: [
              { name: 'vault_search', args: { persona: 'general', query: 'budget', limit: 5 } },
            ],
          };
        }
        return { role: 'assistant' as const, content: 'The Q4 budget report is available.' };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      const result = await runReasoningAgent('Find the budget report', ctx);
      expect(result.answer).toContain('budget report');
      expect(result.turnsUsed).toBe(2);
    });

    it('respects maxTurns limit', async () => {
      registerReasoningProvider(async () => ({
        role: 'assistant' as const,
        content: 'Still thinking...',
        toolCalls: [{ name: 'vault_search', args: { persona: 'general', query: 'x' } }],
      }));
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      const result = await runReasoningAgent('complex query', ctx, 3);
      expect(result.turnsUsed).toBe(3);
    });

    it('tracks sources from tool call results', async () => {
      storeItem('general', makeVaultItem({ id: 'src-001', summary: 'Source item', body: '' }));
      let turn = 0;
      registerReasoningProvider(async () => {
        turn++;
        if (turn === 1) {
          return {
            role: 'assistant' as const,
            content: '',
            toolCalls: [{ name: 'vault_search', args: { persona: 'general', query: 'source' } }],
          };
        }
        return { role: 'assistant' as const, content: 'Found it.' };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      const result = await runReasoningAgent('Find source', ctx);
      expect(result.sources).toContain('src-001');
    });
  });

  describe('getToolDeclarations', () => {
    it('returns 7 tools', () => {
      expect(getToolDeclarations().length).toBe(7);
    });

    it('includes all required tools', () => {
      const names = getToolDeclarations().map((t) => t.name);
      expect(names).toContain('list_personas');
      expect(names).toContain('vault_search');
      expect(names).toContain('browse_vault');
      expect(names).toContain('vault_read');
      expect(names).toContain('contact_lookup');
      expect(names).toContain('reminder_check');
      expect(names).toContain('search_trust_network');
    });

    it('every tool has name and description', () => {
      for (const tool of getToolDeclarations()) {
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe('tool execution via reasoning agent', () => {
    beforeEach(() => {
      resetPersonaState();
      resetContactDirectory();
      resetReminderState();
      createPersona('general', 'default');
      createPersona('health', 'sensitive');
      openPersona('general');
      openPersona('health');
      setAccessiblePersonas(['general', 'health']);
    });

    it('list_personas returns available personas', async () => {
      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        // Check if we already got a tool response
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Done.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'list_personas', args: {} }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('List my personas', ctx);
      expect(Array.isArray(toolResult)).toBe(true);
      const personas = toolResult as Array<{ name: string; tier: string; accessible: boolean }>;
      expect(personas.find((p) => p.name === 'general')).toBeDefined();
      expect(personas.find((p) => p.name === 'health')).toBeDefined();
    });

    it('browse_vault returns recent items without search query', async () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Recent note A',
          body: '',
          created_at: Date.now(),
        }),
      );
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Recent note B',
          body: '',
          created_at: Date.now(),
        }),
      );

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Found recent items.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'browse_vault', args: { persona: 'general', limit: 5 } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Show recent items', ctx);
      expect(Array.isArray(toolResult)).toBe(true);
      expect((toolResult as unknown[]).length).toBeGreaterThanOrEqual(2);
    });

    it('contact_lookup finds by name', async () => {
      addContact('did:plc:alice', 'Alice', 'trusted', 'full', 'friend');

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Found Alice.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'contact_lookup', args: { query: 'Alice' } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Who is Alice?', ctx);
      expect(toolResult).toBeDefined();
      expect((toolResult as any).name).toBe('Alice');
      expect((toolResult as any).trust).toBe('trusted');
      expect((toolResult as any).relationship).toBe('friend');
    });

    it('contact_lookup finds by DID', async () => {
      addContact('did:plc:bob', 'Bob');

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Found Bob.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'contact_lookup', args: { query: 'did:plc:bob' } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Look up bob', ctx);
      expect((toolResult as any).name).toBe('Bob');
    });

    it('contact_lookup returns null for unknown contact', async () => {
      let toolResult: unknown = 'not_set';
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Not found.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'contact_lookup', args: { query: 'Unknown Person' } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Who is Unknown Person?', ctx);
      expect(toolResult).toBeNull();
    });

    it('reminder_check returns upcoming reminders', async () => {
      const futureTime = Date.now() + 2 * 24 * 60 * 60 * 1000; // 2 days from now
      createReminder({
        message: 'Call dentist',
        due_at: futureTime,
        persona: 'general',
        kind: 'appointment',
      });

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Found reminder.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'reminder_check', args: { query: 'dentist', days_ahead: 7 } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Any upcoming dentist appointments?', ctx);
      expect(Array.isArray(toolResult)).toBe(true);
      expect((toolResult as any[]).length).toBe(1);
      expect((toolResult as any[])[0].message).toContain('dentist');
    });

    it('reminder_check with no query returns all pending', async () => {
      const futureTime1 = Date.now() + 1 * 24 * 60 * 60 * 1000;
      const futureTime2 = Date.now() + 2 * 24 * 60 * 60 * 1000;
      createReminder({ message: 'Task A', due_at: futureTime1, persona: 'general', kind: 'task' });
      createReminder({ message: 'Task B', due_at: futureTime2, persona: 'general', kind: 'task' });

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Found reminders.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'reminder_check', args: { query: '', days_ahead: 3 } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('What reminders do I have?', ctx);
      expect((toolResult as any[]).length).toBe(2);
    });

    it('vault_search respects persona accessibility', async () => {
      setAccessiblePersonas(['general']); // health NOT accessible
      storeItem('health', makeVaultItem({ summary: 'Secret health data' }));

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Done.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            { name: 'vault_search', args: { persona: 'health', query: 'secret', limit: 10 } },
          ],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Search health vault', ctx);
      expect(Array.isArray(toolResult)).toBe(true);
      expect((toolResult as any[]).length).toBe(0); // blocked by accessibility check
    });

    it('browse_vault respects persona accessibility', async () => {
      setAccessiblePersonas(['general']); // health NOT accessible

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Done.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'browse_vault', args: { persona: 'health', limit: 5 } }],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Browse health vault', ctx);
      expect(Array.isArray(toolResult)).toBe(true);
      expect((toolResult as any[]).length).toBe(0); // health not accessible
    });

    it('search_trust_network returns trust data for known contacts', async () => {
      addContact('did:plc:vendor', 'Acme Corp', 'trusted', 'full', 'colleague');

      let toolResult: unknown = null;
      registerReasoningProvider(async (messages: LLMMessage[]) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg) {
          toolResult = JSON.parse(toolMsg.content);
          return { role: 'assistant' as const, content: 'Found trust data.' };
        }
        return {
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            { name: 'search_trust_network', args: { query: 'Acme', type: 'entity_reviews' } },
          ],
        };
      });
      const ctx = { items: [], tokenEstimate: 0, personas: ['general'] };
      await runReasoningAgent('Is Acme Corp trustworthy?', ctx);
      expect(toolResult).toBeDefined();
      expect((toolResult as any).totalReviews).toBeGreaterThanOrEqual(1);
      expect((toolResult as any).aggregateScore).not.toBeNull();
    });
  });

  describe('propagateUserOrigin', () => {
    it('tracks device owner as "user"', () => expect(propagateUserOrigin('user')).toBe('user'));
    it('"self" normalizes to "user"', () => expect(propagateUserOrigin('self')).toBe('user'));
    it('"owner" normalizes to "user"', () => expect(propagateUserOrigin('owner')).toBe('user'));
    it('DID origins pass through', () =>
      expect(propagateUserOrigin('did:key:z6MkAgent')).toBe('did:key:z6MkAgent'));
    it('did:plc origins pass through', () =>
      expect(propagateUserOrigin('did:plc:abc123')).toBe('did:plc:abc123'));
    it('system triggers normalize to "system"', () => {
      expect(propagateUserOrigin('system')).toBe('system');
      expect(propagateUserOrigin('cron')).toBe('system');
    });
    it('empty string defaults to "system"', () => expect(propagateUserOrigin('')).toBe('system'));
    it('whitespace-only defaults to "system"', () =>
      expect(propagateUserOrigin('   ')).toBe('system'));
    it('unknown origins default to "system"', () =>
      expect(propagateUserOrigin('unknown-thing')).toBe('system'));
    it('trims whitespace', () => expect(propagateUserOrigin('  user  ')).toBe('user'));
  });
});
