/**
 * `createCoordinatorAskHandler` — bridge tests for 5.21-H.
 *
 * Pins:
 *   - fast_path/complete on first turn → handler returns the answer
 *     synchronously (no late-thread post).
 *   - fast_path/failed on first turn → handler returns the failure
 *     message synchronously.
 *   - pending_approval → handler returns placeholder; on operator
 *     approval, the bridge fires `addDinaResponse` with the resumed
 *     answer.
 *   - async (202-shape, fast-path window elapsed) → handler returns
 *     "Working on it…" placeholder; on background completion, the
 *     bridge fires `addDinaResponse`.
 *   - Failure during pending_approval (operator deny) → bridge fires
 *     `addDinaResponse` with the failure note.
 *   - dispose() unsubscribes — events after dispose don't post to the
 *     thread.
 */

import { ApprovalManager } from '../../../core/src/approval/manager';
import {
  createPersona,
  resetPersonaState,
} from '../../../core/src/persona/service';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import { clearVaults, storeItem } from '../../../core/src/vault/crud';
import {
  buildAgenticAskPipeline,
  type BuildAgenticAskPipelineInput,
} from '../../src/composition/agentic_ask';
import {
  buildAgenticExecuteFn,
  createAskCoordinator,
} from '../../src/composition/ask_coordinator';
import { createCoordinatorAskHandler } from '../../src/composition/coordinator_ask_handler';
import { getAskApprovalGateway } from '../../src/composition/ask_gateway_registry';
import { getThread, resetThreads } from '../../src/chat/thread';
import type {
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';
import { resetReminderLLM } from '../../src/pipeline/reminder_planner';
import { resetIdentityExtractor } from '../../src/pipeline/identity_extraction';

const REQUESTER = 'did:key:zBridgeTester';
const SYSTEM_PROMPT = 'You answer with vault data.';
const THREAD = 'main';

function makeScripted(): { provider: LLMProvider; push: (...rs: ChatResponse[]) => void } {
  const queue: ChatResponse[] = [];
  return {
    push: (...rs) => {
      queue.push(...rs);
    },
    provider: {
      name: 'scripted',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      chat: async () => {
        const next = queue.shift();
        if (!next) throw new Error('makeScripted: no responses queued');
        return next;
      },
      stream: () => {
        throw new Error('not used');
      },
      embed: async () => {
        throw new Error('not used');
      },
    },
  };
}

function toolCallResp(call: ToolCall): ChatResponse {
  return {
    content: '',
    toolCalls: [call],
    model: 'scripted',
    usage: { inputTokens: 5, outputTokens: 5 },
    finishReason: 'tool_use',
  };
}

function answerResp(text: string): ChatResponse {
  return {
    content: text,
    toolCalls: [],
    model: 'scripted',
    usage: { inputTokens: 5, outputTokens: 5 },
    finishReason: 'end',
  };
}

function fakeAppView(): BuildAgenticAskPipelineInput['appViewClient'] {
  return {
    async searchServices() {
      return [];
    },
    async isDiscoverable() {
      return { isDiscoverable: false, capabilities: [] };
    },
    async resolveTrust() {
      return {} as never;
    },
    async searchTrust() {
      return {} as never;
    },
  };
}

function fakeOrchestrator(): BuildAgenticAskPipelineInput['orchestratorHandle'] {
  return {
    async issueQueryToDID() {
      return {
        queryId: 'noop',
        taskId: 'noop',
        toDID: 'did:plc:noop',
        serviceName: 'noop',
        deduped: false,
      };
    },
  };
}

function fakeCoreClient(): BuildAgenticAskPipelineInput['coreClient'] {
  return {
    async findContactsByPreference() {
      return [];
    },
  };
}

function buildCoord(llm: LLMProvider, am: ApprovalManager, fastPathMs: number) {
  const pipeline = buildAgenticAskPipeline({
    llm,
    providerName: 'gemini',
    appViewClient: fakeAppView(),
    orchestratorHandle: fakeOrchestrator(),
    coreClient: fakeCoreClient(),
    cloudConsentGranted: true,
    approvalManager: am,
  });
  return createAskCoordinator({
    pipeline,
    approvalManager: am,
    executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
    systemPrompt: SYSTEM_PROMPT,
    fastPathMs,
  });
}

beforeEach(() => {
  resetPersonaState();
  resetReasoningProvider();
  clearVaults();
  setAccessiblePersonas([]);
  resetThreads();
});

afterEach(() => {
  resetReminderLLM();
  resetIdentityExtractor();
});

describe('createCoordinatorAskHandler — synchronous outcomes', () => {
  it('fast_path/complete returns answer synchronously, no late-thread post', async () => {
    const llm = makeScripted();
    llm.push(answerResp('forty two'));

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 5_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });

    try {
      const r = await handler('what is the meaning of life?');
      expect(r.response).toBe('forty two');
      expect(r.sources).toEqual([]);
      // Thread untouched — synchronous reply lives in the orchestrator's
      // own user→dina path, the bridge only posts late answers.
      expect(getThread(THREAD)).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('submission crash inside coordinator surfaces a failure response', async () => {
    const llm = makeScripted();
    // No responses queued — first chat call will throw.

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 5_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });

    try {
      const r = await handler('this will crash');
      // executeFn catches the LLM throw, returns a failure outcome →
      // handler responds with fast_path/failed → bridge formats it.
      expect(r.response).toMatch(/\/ask failed/);
      expect(r.sources).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe('createCoordinatorAskHandler — pending_approval deferred delivery', () => {
  it('writes an approval-typed message with metadata, then posts the answer on approve', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);
    storeItem('health', { type: 'note', summary: 'BP', body: '120/80' });

    const llm = makeScripted();
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
      answerResp('Your BP was 120/80.'),
    );

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 1_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });

    try {
      const r = await handler('what was my BP?', { threadId: THREAD });
      // Synchronous reply is empty — the approval card IS the user-
      // facing response so the orchestrator must NOT also post a `dina`
      // bubble for this turn.
      expect(r.response).toBe('');

      // Bridge wrote one approval-typed message into the thread with
      // structured metadata for the inline card renderer.
      const beforeApprove = getThread(THREAD);
      expect(beforeApprove).toHaveLength(1);
      const card = beforeApprove[0]!;
      expect(card.type).toBe('approval');
      expect(card.content).toMatch(/health/);
      expect(card.content).toMatch(/\/approve appr-/);
      expect(card.metadata).toMatchObject({
        kind: 'ask_approval',
        persona: 'health',
        requesterDid: REQUESTER,
      });
      expect(typeof card.metadata?.askId).toBe('string');
      expect(typeof card.metadata?.approvalId).toBe('string');

      // Operator approves → registry resumes → bridge fires.
      const pending = am.listPending();
      expect(pending).toHaveLength(1);
      const approval = await coord.gateway.approve(pending[0]!.id);
      expect(approval.ok).toBe(true);

      // Flush microtasks so the resumer + bridge settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const thread = getThread(THREAD);
      // Approval card + late dina answer.
      expect(thread.map((m) => m.type)).toEqual(['approval', 'dina']);
      expect(thread[1]?.content).toBe('Your BP was 120/80.');
    } finally {
      dispose();
    }
  });

  it('formatResumeHeader prepends a system message before the late answer', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);
    storeItem('health', { type: 'note', summary: 'BP', body: '120/80' });

    const llm = makeScripted();
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
      answerResp('Your BP was 120/80.'),
    );

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 1_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
      formatResumeHeader: ({ approvalId }) =>
        `Operator approved (${approvalId}). Continuing:`,
    });

    try {
      await handler('what was my BP?', { threadId: THREAD });
      const pending = am.listPending();
      await coord.gateway.approve(pending[0]!.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const thread = getThread(THREAD);
      // approval card → system header → dina answer.
      expect(thread.map((m) => m.type)).toEqual(['approval', 'system', 'dina']);
      expect(thread[1]?.content).toMatch(/Operator approved/);
      expect(thread[2]?.content).toBe('Your BP was 120/80.');
    } finally {
      dispose();
    }
  });

  it('on operator deny, bridge posts the failure note via addDinaResponse', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);

    const llm = makeScripted();
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
    );

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 1_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });

    try {
      await handler('what was my BP?', { threadId: THREAD });
      const pending = am.listPending();
      await coord.gateway.deny(pending[0]!.id, 'no thanks');

      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const thread = getThread(THREAD);
      // approval card + late dina failure note.
      expect(thread.map((m) => m.type)).toEqual(['approval', 'dina']);
      expect(thread[1]?.content).toMatch(/\/ask failed/);
    } finally {
      dispose();
    }
  });
});

describe('createCoordinatorAskHandler — async window deferral', () => {
  it('posts an ask_pending placeholder, then patches it in place when the answer arrives', async () => {
    const llm = makeScripted();
    // Hold the LLM until we approve with a manual gate.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowProvider: LLMProvider = {
      ...llm.provider,
      chat: async () => {
        await gate;
        return answerResp('late answer');
      },
    };

    const am = new ApprovalManager();
    // fastPathMs=1 → effectively forces async path.
    const coord = buildCoord(slowProvider, am, 1);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });

    try {
      const responsePromise = handler('slow question');
      const r = await responsePromise;
      // The handler returns an empty response — its contract is "I
      // posted my own placeholder; orchestrator, don't post a
      // duplicate". The placeholder lives in the thread already.
      expect(r.response).toBe('');

      // Placeholder is in the thread, lifecycle status `pending`.
      const beforeThread = getThread(THREAD);
      expect(beforeThread).toHaveLength(1);
      expect(beforeThread[0]?.content).toMatch(/Working on it/);
      expect(beforeThread[0]?.metadata?.lifecycle).toMatchObject({
        kind: 'ask_pending',
        status: 'pending',
      });

      // Now release the LLM; background execution finishes; the bridge
      // patches the placeholder in place — no second bubble appended.
      release();
      // Give the event loop a few microtasks to settle.
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const thread = getThread(THREAD);
      expect(thread).toHaveLength(1);
      expect(thread[0]?.content).toBe('late answer');
      expect(thread[0]?.metadata?.lifecycle).toMatchObject({
        kind: 'ask_pending',
        status: 'complete',
      });
    } finally {
      dispose();
    }
  });
});

describe('createCoordinatorAskHandler — multi-thread routing', () => {
  it('captures the per-call threadId and posts late answers there, not the default', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);
    storeItem('health', { type: 'note', summary: 'BP', body: '120/80' });

    const llm = makeScripted();
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
      answerResp('Your BP was 120/80.'),
    );

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 1_000);
    // Default thread is 'main'; the user is asking from a per-persona
    // thread '/health'. Late delivery must hit '/health', not 'main'.
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
      defaultThreadId: 'main',
    });

    try {
      await handler('what was my BP?', { threadId: '/health' });
      const pending = am.listPending();
      await coord.gateway.approve(pending[0]!.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Routed to the per-call thread, not the default. The thread now
      // shows: approval card (synchronous), then late dina answer.
      const healthThread = getThread('/health');
      expect(healthThread.map((m) => m.type)).toEqual(['approval', 'dina']);
      expect(healthThread[1]?.content).toBe('Your BP was 120/80.');
      expect(getThread('main')).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('falls back to defaultThreadId when no context is supplied (legacy callers)', async () => {
    const llm = makeScripted();
    llm.push(answerResp('forty two'));

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 5_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
      defaultThreadId: 'fallback-thread',
    });

    try {
      // No context arg — synchronous answer doesn't touch the thread,
      // but the path still resolves without crashing.
      const r = await handler('what is the meaning of life?');
      expect(r.response).toBe('forty two');
    } finally {
      dispose();
    }
  });
});

describe('createCoordinatorAskHandler — gateway singleton', () => {
  it('installs the coordinator.gateway as the module-level singleton on construction; clears on dispose', () => {
    const llm = makeScripted();
    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 5_000);

    expect(getAskApprovalGateway()).toBeNull();
    const { dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });
    expect(getAskApprovalGateway()).toBe(coord.gateway);
    dispose();
    expect(getAskApprovalGateway()).toBeNull();
  });
});

describe('createCoordinatorAskHandler — lifecycle', () => {
  it('rejects construction without coordinator', () => {
    expect(() =>
      createCoordinatorAskHandler({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        coordinator: undefined as any,
        requesterDid: REQUESTER,
      }),
    ).toThrow('coordinator is required');
  });

  it('rejects empty requesterDid', () => {
    const llm = makeScripted();
    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 1_000);
    expect(() =>
      createCoordinatorAskHandler({
        coordinator: coord,
        requesterDid: '   ',
      }),
    ).toThrow('requesterDid');
  });

  it('dispose() unsubscribes — events after dispose do not post to thread', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);
    storeItem('health', { type: 'note', summary: 'BP', body: '120/80' });

    const llm = makeScripted();
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
      answerResp('Your BP was 120/80.'),
    );

    const am = new ApprovalManager();
    const coord = buildCoord(llm.provider, am, 1_000);
    const { handler, dispose } = createCoordinatorAskHandler({
      coordinator: coord,
      requesterDid: REQUESTER,
    });

    await handler('what was my BP?', { threadId: THREAD });
    // The bridge already wrote an approval card synchronously. After
    // dispose, the registry event still fires when the gateway
    // approves, but the bridge no longer listens — no late `dina`
    // bubble should appear.
    expect(getThread(THREAD).map((m) => m.type)).toEqual(['approval']);
    dispose();

    const pending = am.listPending();
    await coord.gateway.approve(pending[0]!.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Still only the approval card — no late delivery.
    expect(getThread(THREAD).map((m) => m.type)).toEqual(['approval']);
  });
});
