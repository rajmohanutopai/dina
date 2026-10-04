/**
 * A2A M1b, Brain's side of the release log (design §4.2): every vault read an
 * owner conversation makes names that conversation, on both read paths (the
 * server's HTTP backend and the phone's in-process calls); the owner's words
 * are recorded before any model sees the turn; the conversation survives an
 * approval pause; and every thread name becomes a session id Core accepts.
 */

import {
  InProcessTransport,
  clearVaults,
  createCoreRouter,
  createPersona,
  resetPersonaState,
  setVaultReleaseRecorder,
  storeItem,
  type ReleaseContext,
} from '@dina/core';
import { MockCoreClient, makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

import { askConversation, releaseSessionId } from '../../src/a2a/conversation';
import { InMemoryAskAdapter } from '../../src/ask/ask_registry';
import { handleChat, resetAskCommandHandler, setAskCommandHandler, setOwnerTurnRecorder } from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';
import { buildAgenticExecuteFn } from '../../src/composition/ask_coordinator';
import { createCoordinatorAskHandler } from '../../src/composition/coordinator_ask_handler';
import { IntentClassifier } from '../../src/reasoning/intent_classifier';
import { ToolRegistry } from '../../src/reasoning/tool_registry';
import {
  createBrowseVaultTool,
  createGetFullContentTool,
  createListPersonasTool,
  createVaultSearchTool,
} from '../../src/reasoning/vault_tool';
import { setAccessiblePersonas, setVaultReadBackend, vaultReadBackendFromCore } from '../../src/vault_context/assembly';

describe('session ids', () => {
  it('names a chat thread, or the ask alone', () => {
    expect(askConversation('ask-1', 'main')).toEqual({ releaseSession: 'chat:main', replyTo: 'main' });
    expect(askConversation('ask-1', undefined)).toEqual({ releaseSession: 'ask:ask-1' });
  });

  it('digests a thread name Core would refuse, and one that spells the digest mark', () => {
    for (const thread of ['did:web:example.com%3A8443', 'a'.repeat(200), 'h-0123', 'two words']) {
      const id = releaseSessionId('chat', thread);
      expect(id).toMatch(/^chat:h-[0-9a-f]{40}$/);
    }
    expect(releaseSessionId('chat', 'did:plc:abc')).toBe('chat:did:plc:abc');
    expect(releaseSessionId('chat', 'a b')).not.toBe(releaseSessionId('chat', 'a_b'));
  });
});

describe('the owner’s words are recorded before any model sees the turn', () => {
  afterEach(() => {
    setOwnerTurnRecorder(null);
    resetAskCommandHandler();
    resetThreads();
  });

  it('records first, then routes; the payload of a composer lane, not its prefix', async () => {
    const order: string[] = [];
    const turns: { releaseSession: string; text: string; turnId: string }[] = [];
    setOwnerTurnRecorder(async (input) => {
      order.push('record');
      turns.push(input);
      return true;
    });
    setAskCommandHandler(async () => {
      order.push('ask');
      return { response: 'ok', sources: [] };
    });
    await handleChat('/ask Book Dr. Rao for Tuesday', 'main');
    await handleChat('and Friday?', 'main');
    expect(order).toEqual(['record', 'ask', 'record', 'ask']);
    expect(turns.map((t) => [t.releaseSession, t.text])).toEqual([
      ['chat:main', 'Book Dr. Rao for Tuesday'],
      ['chat:main', 'and Friday?'],
    ]);
    expect(new Set(turns.map((t) => t.turnId)).size).toBe(2);
  });

  it('goes on chatting when Core cannot record the turn (its words just stay unprovable)', async () => {
    setOwnerTurnRecorder(async () => {
      throw new Error('ECONNREFUSED');
    });
    setAskCommandHandler(async () => ({ response: 'answered', sources: [] }));
    const out = await handleChat('hello', 'main');
    expect(JSON.stringify(out)).toContain('answered');
  });
});

describe('the chat path hands its thread to the coordinator', () => {
  it('as the ask’s conversation', async () => {
    const seen: unknown[] = [];
    const coordinator = {
      handleAsk: async (req: unknown) => {
        seen.push(req);
        return { status: 200, body: { status: 'complete', request_id: 'a1', answer: { text: 'ok' } } };
      },
      subscribe: () => () => undefined,
    };
    const { handler } = createCoordinatorAskHandler({ coordinator: coordinator as never, requesterDid: 'did:plc:owner' });
    await handler('question', { threadId: 'trip-planning' });
    expect(seen[0]).toMatchObject({ question: 'question', conversation: 'trip-planning' });
  });
});

describe('an ask record keeps its conversation across an approval pause', () => {
  it('round-trips through the registry adapter', async () => {
    const adapter = new InMemoryAskAdapter();
    const record = {
      id: 'a1',
      question: 'q',
      requesterDid: 'did:plc:owner',
      status: 'pending_approval' as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineMs: 2,
      conversation: 'main',
    };
    await adapter.insert(record as never);
    expect((await adapter.get('a1'))?.conversation).toBe('main');
  });
});

describe('the vault tools name the conversation on both read paths', () => {
  const CTX = 'chat:main';

  describe('the server: through Core’s HTTP surface', () => {
    const calls: { method: string; args: unknown[] }[] = [];
    beforeEach(() => {
      calls.length = 0;
      setAccessiblePersonas(['general']);
      setVaultReadBackend({
        vaultQuery: async (...args) => {
          calls.push({ method: 'vaultQuery', args });
          return { items: [], count: 0 };
        },
        vaultGet: async (...args) => {
          calls.push({ method: 'vaultGet', args });
          return { id: 'i1', summary: 's' } as never;
        },
        vaultList: async (...args) => {
          calls.push({ method: 'vaultList', args });
          return { items: [], count: 0 };
        },
      });
    });
    afterEach(() => setVaultReadBackend(null));

    it('search, browse and get each pass the release session where Core reads it', async () => {
      await createVaultSearchTool({ releaseSession: CTX }).execute({ query: 'dentist', persona: 'general' });
      await createBrowseVaultTool({ releaseSession: CTX }).execute({ persona: 'general' });
      await createGetFullContentTool({ releaseSession: CTX }).execute({ persona: 'general', item_id: 'i1' });
      expect(calls).toEqual([
        { method: 'vaultQuery', args: ['general', expect.objectContaining({ text: 'dentist', releaseSession: CTX })] },
        { method: 'vaultList', args: ['general', expect.objectContaining({ releaseSession: CTX })] },
        { method: 'vaultGet', args: ['general', 'i1', { releaseSession: CTX }] },
      ]);
    });
  });

  describe('the phone: in process, below the router', () => {
    const released: [ReleaseContext, string, string[]][] = [];
    beforeEach(() => {
      released.length = 0;
      resetFactoryCounters();
      clearVaults();
      resetPersonaState();
      createPersona('general', 'default');
      storeItem('general', makeVaultItem({ id: 'n1', summary: 'Dentist is Dr. Rao', body: 'Dr. Rao, Tuesday.' }));
      setAccessiblePersonas(['general']);
      setVaultReleaseRecorder({
        items: (ctx, persona, items) => released.push([ctx, persona, items.map((i) => i.id)]),
        topics: () => undefined,
      });
    });
    afterEach(() => {
      setVaultReleaseRecorder(null);
      resetPersonaState();
    });

    it('search, browse, list and get each record a release into the conversation', async () => {
      await createVaultSearchTool({ releaseSession: CTX }).execute({ query: 'dentist', persona: 'general' });
      await createBrowseVaultTool({ releaseSession: CTX }).execute({ persona: 'general' });
      await createListPersonasTool({ releaseSession: CTX }).execute({});
      await createGetFullContentTool({ releaseSession: CTX }).execute({ persona: 'general', item_id: 'n1' });
      expect(released).toHaveLength(4);
      for (const [ctx, persona, ids] of released) {
        expect(ctx).toEqual({ sessionId: CTX, audience: 'brain' });
        expect([persona, ids]).toEqual(['general', ['n1']]);
      }
    });

    it('a tool built without a conversation records nothing', async () => {
      await createVaultSearchTool().execute({ query: 'dentist', persona: 'general' });
      await createGetFullContentTool().execute({ persona: 'general', item_id: 'n1' });
      expect(released).toEqual([]);
    });
  });
});

describe('both read paths release the same items into the conversation', () => {
  const releasedVia: Record<string, [string, string[]][]> = {};

  async function readAll(label: string): Promise<void> {
    releasedVia[label] = [];
    setVaultReleaseRecorder({
      items: (ctx, persona, items) => {
        if (ctx.sessionId === 'chat:main') releasedVia[label]?.push([persona, items.map((i) => i.id).sort()]);
      },
      topics: () => undefined,
    });
    await createVaultSearchTool({ releaseSession: 'chat:main' }).execute({ query: 'dentist', persona: 'general' });
    await createBrowseVaultTool({ releaseSession: 'chat:main' }).execute({ persona: 'general' });
    await createGetFullContentTool({ releaseSession: 'chat:main' }).execute({ persona: 'general', item_id: 'n3' });
  }

  beforeEach(() => {
    resetFactoryCounters();
    clearVaults();
    resetPersonaState();
    createPersona('general', 'default');
    for (let i = 0; i < 12; i += 1) {
      storeItem('general', makeVaultItem({ id: `n${i}`, summary: `Dentist visit ${i}`, body: `Visit ${i}.`, timestamp: 1000 + i }));
    }
    setAccessiblePersonas(['general']);
  });
  afterEach(() => {
    setVaultReleaseRecorder(null);
    setVaultReadBackend(null);
    resetPersonaState();
  });

  it('through Core’s routes (the server) and by direct calls (the phone)', async () => {
    // The same router the server serves: Brain's reads arrive as Core's routes see them.
    const core = new InProcessTransport(createCoreRouter());
    setVaultReadBackend({
      vaultQuery: (persona, query) => core.vaultQuery(persona, query),
      vaultGet: (persona, id, opts) => core.vaultGet(persona, id, opts),
      vaultList: (persona, opts) => core.vaultList(persona, opts),
    });
    await readAll('server');
    setVaultReadBackend(null);
    await readAll('phone');
    expect(releasedVia.server?.length).toBe(3);
    expect(releasedVia.phone).toEqual(releasedVia.server);
  });
});

describe('the coordinator hands the conversation to everything that reads for an ask', () => {
  it('the tool registry, the intent classifier and the pre-flight retrieval', async () => {
    const seen: { tools?: unknown; classify?: unknown; preFlight?: unknown } = {};
    const pipeline = {
      provider: {
        chat: async () => {
          throw new Error('stop after wiring');
        },
      },
      tools: undefined,
      buildToolsForAsk: (ctx: unknown) => {
        seen.tools = ctx;
        return new ToolRegistry();
      },
      router: {},
      handlerOptions: {
        intentClassifier: {
          classify: async (_q: string, opts: unknown) => {
            seen.classify = opts;
            return IntentClassifier.default();
          },
        },
      },
    };
    const execute = buildAgenticExecuteFn({
      pipeline: pipeline as never,
      systemPrompt: 'system',
      preFlight: async (_question, ctx) => {
        seen.preFlight = ctx;
        return null;
      },
    });
    await execute({ id: 'ask-1', question: 'Book a table', requesterDid: 'did:plc:owner', conversation: 'trip' });
    expect(seen.tools).toMatchObject({ askId: 'ask-1', releaseSession: 'chat:trip', replyTo: 'trip' });
    expect(seen.classify).toEqual({ releaseSession: 'chat:trip' });
    expect(seen.preFlight).toMatchObject({ releaseSession: 'chat:trip' });

    await execute({ id: 'ask-2', question: 'From an agent', requesterDid: 'did:key:agent' });
    expect(seen.tools).toMatchObject({ askId: 'ask-2', releaseSession: 'ask:ask-2' });
    expect((seen.tools as { replyTo?: string }).replyTo).toBeUndefined();
  });
});

describe('the server’s vault backend passes the conversation through', () => {
  it('every read, every argument (the boot installs exactly this)', async () => {
    const core = new MockCoreClient();
    const backend = vaultReadBackendFromCore(core);
    await backend.vaultQuery('general', { text: 'x', releaseSession: 'chat:main' });
    await backend.vaultGet('general', 'i1', { releaseSession: 'chat:main' });
    await backend.vaultList('general', { limit: 2, releaseSession: 'chat:main' });
    await backend.vaultItemsForPerson('general', 'p1', 3, { releaseSession: 'chat:main' });
    expect(core.calls.map((c) => [c.method, c.args])).toEqual([
      ['vaultQuery', ['general', { text: 'x', releaseSession: 'chat:main' }]],
      ['vaultGet', ['general', 'i1', { releaseSession: 'chat:main' }]],
      ['vaultList', ['general', { limit: 2, releaseSession: 'chat:main' }]],
      ['vaultItemsForPerson', ['general', 'p1', 3, { releaseSession: 'chat:main' }]],
    ]);
  });
});
