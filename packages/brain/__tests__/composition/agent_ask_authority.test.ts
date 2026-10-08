/**
 * REAL_LIFE_FIXES §0.1 B + §3 on the Brain side: an agent/device ask reads
 * only under Core's ask authority, raises at most one card for a persona it
 * names, never raises one from a fan-out, keeps its authority and session
 * across both resume paths, and is refused outright without an authority.
 */

import { createPersona, resetPersonaState } from '@dina/core';

import { AskApprovalResumer, type ResumeContext } from '../../src/ask/ask_approval_resumer';
import { AskRegistry, InMemoryAskAdapter, type AskEvent } from '../../src/ask/ask_registry';
import { buildAgenticExecuteFn } from '../../src/composition/ask_coordinator';
import {
  createCoreAccessCheck,
  createCoreAccessGuard,
  type CoreAccessClient,
} from '../../src/composition/persona_guard';
import { ToolRegistry } from '../../src/reasoning/tool_registry';
import { createListPersonasTool, createVaultSearchTool } from '../../src/reasoning/vault_tool';
import {
  setAccessiblePersonas,
  vaultReadBackendForAuthority,
} from '../../src/vault_context/assembly';

import type { AskExecuteFn } from '../../src/ask/ask_handler';
import type { AgenticAskPipeline } from '../../src/composition/agentic_ask';

const AUTH = 'aa-test-authority';

/** A fake Core: `allowed` personas read freely; the rest need a card. */
function fakeCore(allowed: string[]) {
  const calls = {
    check: [] as string[][],
    request: [] as string[],
    reads: [] as { persona: string; askAuthority?: string }[],
  };
  const core: CoreAccessClient & Parameters<typeof vaultReadBackendForAuthority>[0] = {
    async agentPersonaAccessCheck(_a, personas) {
      calls.check.push(personas);
      return Object.fromEntries(personas.map((p) => [p, allowed.includes(p) ? 'allowed' : 'gated']));
    },
    async agentPersonaAccessRequest(_a, persona) {
      calls.request.push(persona);
      return allowed.includes(persona)
        ? { decision: 'allowed' as const }
        : { decision: 'approval_required' as const, taskId: `card-${persona}` };
    },
    async vaultQuery(persona, query) {
      calls.reads.push({ persona, ...(query.askAuthority ? { askAuthority: query.askAuthority } : {}) });
      return { items: [{ id: `${persona}-1`, summary: `${persona} note` }], count: 1 } as never;
    },
    async vaultGet() {
      return null;
    },
    async vaultList(persona, opts) {
      calls.reads.push({ persona, ...(opts?.askAuthority ? { askAuthority: opts.askAuthority } : {}) });
      return { items: [{ id: `${persona}-1`, summary: `${persona} note`, type: 'note' }], count: 1 };
    },
    async vaultItemsForPerson() {
      return { items: [], count: 0 } as never;
    },
  };
  return { core, calls };
}

beforeEach(() => {
  resetPersonaState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  createPersona('finance', 'locked');
  setAccessiblePersonas(['general', 'health', 'finance']);
});

afterEach(() => {
  resetPersonaState();
  setAccessiblePersonas(['general']);
});

function agentVaultSearch(core: ReturnType<typeof fakeCore>['core']) {
  return createVaultSearchTool({
    personaGuard: createCoreAccessGuard({ coreClient: core, askAuthority: AUTH }),
    accessCheck: createCoreAccessCheck({ coreClient: core, askAuthority: AUTH }),
    readBackend: vaultReadBackendForAuthority(core, AUTH),
  });
}

describe('vault_search for an agent ask (§3.4)', () => {
  it('a fan-out searches only what Core allows, names the rest, and raises no card', async () => {
    const { core, calls } = fakeCore(['general']);
    const out = (await agentVaultSearch(core).execute({ query: 'gate code' })) as {
      personas_searched: string[];
      gated_personas?: string[];
    };
    expect(out.personas_searched).toEqual(['general']);
    expect(out.gated_personas).toEqual(['health', 'finance']);
    expect(calls.request).toEqual([]);
    expect(calls.reads.map((r) => r.persona)).toEqual(['general']);
  });

  it('every read carries the authority', async () => {
    const { core, calls } = fakeCore(['general', 'health']);
    await agentVaultSearch(core).execute({ query: 'anything' });
    expect(calls.reads.length).toBeGreaterThan(0);
    expect(calls.reads.every((r) => r.askAuthority === AUTH)).toBe(true);
  });

  it('naming a gated persona first searches the open vaults, with no card', async () => {
    const { core, calls } = fakeCore(['general']);
    const out = (await agentVaultSearch(core).execute({ query: 'LDL', persona: 'health' })) as {
      personas_searched: string[];
      note?: string;
    };
    expect(out.personas_searched).toEqual(['general']);
    expect(out.note).toMatch(/"health" needs the owner's approval/);
    expect(calls.request).toEqual([]);
  });

  it('naming it again in the same ask raises exactly one card for it', async () => {
    const { core, calls } = fakeCore(['general']);
    const tool = agentVaultSearch(core);
    await tool.execute({ query: 'LDL', persona: 'health' });
    const readsAfterOpen = [...calls.reads];
    await expect(tool.execute({ query: 'LDL', persona: 'health' })).rejects.toMatchObject({ approvalId: 'card-health' });
    expect(calls.request).toEqual(['health']);
    expect(calls.reads).toEqual(readsAfterOpen);
  });

  it('when Core cannot answer the check, nothing is searched (fail closed)', async () => {
    const { core, calls } = fakeCore(['general']);
    core.agentPersonaAccessCheck = async () => {
      throw new Error('core down');
    };
    const out = (await agentVaultSearch(core).execute({ query: 'x' })) as {
      personas_searched: string[];
    };
    expect(out.personas_searched).toEqual([]);
    expect(calls.reads).toEqual([]);
  });

  it('a refusal from Core blocks the read', async () => {
    const { core } = fakeCore([]);
    core.agentPersonaAccessRequest = async () => ({ decision: 'denied' as const });
    const tool = agentVaultSearch(core);
    await tool.execute({ query: 'x' }); // the open fan-out (nothing is open)
    await expect(tool.execute({ query: 'x', persona: 'general' })).rejects.toThrow(/not available/);
  });
});

describe('list_personas for an agent ask (§3.5)', () => {
  it('previews only allowed personas; gated ones show no content', async () => {
    const { core } = fakeCore(['general']);
    const tool = createListPersonasTool({
      accessCheck: createCoreAccessCheck({ coreClient: core, askAuthority: AUTH }),
      readBackend: vaultReadBackendForAuthority(core, AUTH),
    });
    const out = (await tool.execute({})) as {
      personas: { name: string; status?: string; recent_summaries?: string[] }[];
    };
    const by = Object.fromEntries(out.personas.map((p) => [p.name, p]));
    expect(by.general?.recent_summaries).toEqual(['general note']);
    expect(by.health).toEqual({ name: 'health', status: 'gated' });
    expect(by.finance).toEqual({ name: 'finance', status: 'gated' });
  });
});

describe('an ask from anyone but the owner needs Core authority (§0.1 B)', () => {
  function pipeline(): AgenticAskPipeline {
    return {
      provider: {
        chat: async () => {
          throw new Error('the model must not be called');
        },
      } as never,
      tools: new ToolRegistry(),
      buildToolsForAsk: () => new ToolRegistry(),
      ownerDid: 'did:plc:owner',
      router: {} as never,
      handlerOptions: {},
    } as AgenticAskPipeline;
  }

  it('refuses a non-owner ask without an authority before any read or model call', async () => {
    const exec = buildAgenticExecuteFn({ pipeline: pipeline(), systemPrompt: 'x' });
    const out = await exec({ id: 'a1', question: 'my LDL?', requesterDid: 'did:key:z6MkStranger' });
    expect(out).toMatchObject({ kind: 'failure', failure: { kind: 'missing_ask_authority' } });
  });
});

describe('both resume paths keep the session and authority (§3.4)', () => {
  it('Pattern B re-runs with the same session and authority', async () => {
    const seen: Parameters<AskExecuteFn>[0][] = [];
    let resumer: AskApprovalResumer | null = null;
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      onEvent: (e: AskEvent) => resumer?.handle(e),
    });
    resumer = new AskApprovalResumer({
      registry,
      executeFn: async (input) => {
        seen.push(input);
        return { kind: 'answer', answer: { text: 'ok' } };
      },
    });
    await registry.enqueue({
      id: 'ask-b',
      question: 'q',
      requesterDid: 'did:key:agent',
      sessionId: 'sess-1',
      askAuthority: AUTH,
    });
    await registry.markPendingApproval('ask-b', 'card-health');
    await registry.resumeAfterApproval('ask-b');
    await new Promise((r) => setImmediate(r));
    expect(seen[0]).toMatchObject({ sessionId: 'sess-1', askAuthority: AUTH });
  });

  it('Pattern A resumes with the same session and authority', async () => {
    const seen: ResumeContext[] = [];
    let resumer: AskApprovalResumer | null = null;
    const registry = new AskRegistry({
      adapter: new InMemoryAskAdapter(),
      onEvent: (e: AskEvent) => resumer?.handle(e),
    });
    resumer = new AskApprovalResumer({
      registry,
      resumeFromPausedFn: async (_state, ctx) => {
        seen.push(ctx);
        return { finishReason: 'completed', answer: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } } as never;
      },
    });
    await registry.enqueue({
      id: 'ask-a',
      question: 'q',
      requesterDid: 'did:key:agent',
      sessionId: 'sess-2',
      askAuthority: AUTH,
    });
    const paused = JSON.stringify({ transcript: [], iteration: 1, toolCallsUsed: 1, pendingToolCall: { id: 't', name: 'vault_search', arguments: {} } });
    await registry.markPendingApproval('ask-a', 'card-health', paused);
    await registry.resumeAfterApproval('ask-a');
    await new Promise((r) => setImmediate(r));
    expect(seen[0]).toMatchObject({ sessionId: 'sess-2', askAuthority: AUTH });
  });
});

describe('owner chat turns carry the conversation (REAL_LIFE_FIXES §1)', () => {
  it('a follow-up reaches the model with the turns before it; agent asks get none', async () => {
    const { addMessage, resetThreads } = await import('../../src/chat/thread');
    resetThreads();
    addMessage('main', 'user', 'Any dentist slots tomorrow?');
    addMessage('main', 'dina', 'Albert has 16:00 and 17:30.');
    addMessage('main', 'user', 'Book the second one');

    const seen: { role: string; content: string }[][] = [];
    const pipe = {
      provider: {
        name: 'fake',
        chat: async (messages: { role: string; content: string }[]) => {
          seen.push(messages);
          return { content: 'Booking 17:30.', toolCalls: [], model: 'fake', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' };
        },
      } as never,
      tools: new ToolRegistry(),
      buildToolsForAsk: () => new ToolRegistry(),
      ownerDid: 'did:plc:owner',
      router: {} as never,
      handlerOptions: {},
    } as AgenticAskPipeline;

    const exec = buildAgenticExecuteFn({ pipeline: pipe, systemPrompt: 'x' });
    await exec({ id: 'o1', question: 'Book the second one', requesterDid: 'did:plc:owner', conversation: 'main' });
    const sent = seen[0]!.map((m) => `${m.role}:${m.content}`);
    expect(sent).toEqual([
      'user:Any dentist slots tomorrow?',
      'assistant:Albert has 16:00 and 17:30.',
      'user:Book the second one',
    ]);

    seen.length = 0;
    await exec({
      id: 'a2',
      question: 'Book the second one',
      requesterDid: 'did:key:agent',
      askAuthority: AUTH,
      conversation: 'main',
    });
    expect(seen[0]!.map((m) => m.content)).toEqual(['Book the second one']);
    resetThreads();
  });
});
