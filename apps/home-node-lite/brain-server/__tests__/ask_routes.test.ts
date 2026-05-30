/**
 * `/api/v1/ask` Fastify route binding — task 5.21-F.
 *
 * Drives the routes through `app.inject(...)` so no real socket is
 * opened. Wires a real `AskCoordinator` with a scripted LLM provider,
 * an in-memory workflow-task coreClient stub, and a real persona /
 * vault setup — proves the full Pattern A chain (submit → 200
 * pending_approval → approve → status complete) end-to-end behind HTTP.
 *
 * The coreClient stub mirrors the pattern in
 * `packages/brain/__tests__/composition/ask_coordinator.test.ts` —
 * a single object satisfies both `BuildAgenticAskPipelineInput['coreClient']`
 * (the find-preferred-provider surface) and `AskCoordinatorCoreClient`
 * (the workflow-task surface) so one wiring serves both.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import {
  buildAgenticAskPipeline,
  buildAgenticExecuteFn,
  createAskCoordinator,
  resetIdentityExtractor,
  resetReasoningProvider,
  resetReminderLLM,
  setAccessiblePersonas,
  type AskCoordinatorCoreClient,
  type BuildAgenticAskPipelineInput,
  type ChatResponse,
  type LLMProvider,
  type ToolCall,
} from '@dina/brain';
import {
  clearVaults,
  createPersona,
  resetPersonaState,
  storeItem,
  type CreateWorkflowTaskInput,
  type WorkflowTask,
} from '@dina/core';

import { registerAskRoutes } from '../src/routes/ask';

const REQUESTER = 'did:key:zRouteTester';
const SYSTEM_PROMPT = 'You answer the user.';

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
    usage: { inputTokens: 10, outputTokens: 10 },
    finishReason: 'tool_use',
  };
}

function answerResp(text: string): ChatResponse {
  return {
    content: text,
    toolCalls: [],
    model: 'scripted',
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: 'end',
  };
}

function fakeAppView(): BuildAgenticAskPipelineInput['appViewClient'] {
  return {
    async searchServices() {
      return [];
    },
    async searchCapabilities() {
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

interface FakeTaskRecord {
  id: string;
  status: string;
  payload: string;
}

/** In-memory `AskCoordinatorCoreClient` — same shape the brain package's
 *  own coordinator tests use. Implements both the find-preferred-provider
 *  surface (pipeline input) and the workflow-task surface (coordinator)
 *  in one object so a single wiring drives both. */
function makeFakeCoreClient(): AskCoordinatorCoreClient &
  BuildAgenticAskPipelineInput['coreClient'] {
  const tasks = new Map<string, FakeTaskRecord>();
  const setStatus = (id: string, status: string): void => {
    const t = tasks.get(id);
    if (t) t.status = status;
  };
  return {
    async findContactsByPreference() {
      return [];
    },
    async createWorkflowTask(input: CreateWorkflowTaskInput) {
      if (tasks.has(input.id)) {
        throw new Error(`fakeCoreClient: duplicate task id ${input.id}`);
      }
      const t: FakeTaskRecord = {
        id: input.id,
        status: input.initialState ?? 'pending_approval',
        payload: input.payload,
      };
      tasks.set(input.id, t);
      return { task: t as unknown as WorkflowTask, deduped: false };
    },
    async getWorkflowTask(id: string) {
      return (tasks.get(id) as unknown as WorkflowTask) ?? null;
    },
    async completeWorkflowTask(id: string) {
      setStatus(id, 'completed');
      return tasks.get(id) as unknown as WorkflowTask;
    },
    async approveWorkflowTask(id: string) {
      setStatus(id, 'queued');
      return tasks.get(id) as unknown as WorkflowTask;
    },
    async cancelWorkflowTask(id: string) {
      setStatus(id, 'cancelled');
      return tasks.get(id) as unknown as WorkflowTask;
    },
  };
}

interface Harness {
  app: FastifyInstance;
  push: (...rs: ChatResponse[]) => void;
  close: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const llm = makeScripted();
  const coreClient = makeFakeCoreClient();
  const pipeline = buildAgenticAskPipeline({
    llm: llm.provider,
    providerName: 'gemini',
    appViewClient: fakeAppView(),
    orchestratorHandle: fakeOrchestrator(),
    coreClient,
    cloudConsentGranted: true,
  });
  const coordinator = createAskCoordinator({
    pipeline,
    coreClient,
    executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
    systemPrompt: SYSTEM_PROMPT,
    fastPathMs: 1_000,
  });

  const app = Fastify({ logger: false });
  registerAskRoutes(app, { coordinator });
  await app.ready();

  return {
    app,
    push: llm.push,
    close: () => app.close(),
  };
}

beforeEach(() => {
  resetPersonaState();
  resetReasoningProvider();
  clearVaults();
  setAccessiblePersonas([]);
});

afterEach(() => {
  resetReminderLLM();
  resetIdentityExtractor();
});

describe('POST /api/v1/ask — input validation', () => {
  it('rejects missing question with 400', async () => {
    const h = await buildHarness();
    try {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { requesterDid: REQUESTER },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: 'question must be a non-empty string' });
    } finally {
      await h.close();
    }
  });

  it('rejects empty requesterDid with 400', async () => {
    const h = await buildHarness();
    try {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'hi', requesterDid: '   ' },
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });

  it('rejects non-numeric ttlMs with 400', async () => {
    const h = await buildHarness();
    try {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'hi', requesterDid: REQUESTER, ttlMs: 'forever' },
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/v1/ask — fast-path completion', () => {
  it('returns 200 + complete on a synchronous answer', async () => {
    const h = await buildHarness();
    h.push(answerResp('forty two'));
    try {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'meaning of life', requesterDid: REQUESTER },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.status).toBe('complete');
      expect(body.answer).toEqual({ text: 'forty two' });
      expect(body.request_id).toBeDefined();
    } finally {
      await h.close();
    }
  });

  it('uses the X-Request-Id header as the ask id (lowercased per inboundRequestId convention)', async () => {
    const h = await buildHarness();
    h.push(answerResp('hi'));
    try {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'hi', requesterDid: REQUESTER },
        headers: { 'x-request-id': '01HKJZ1MY3DXZTABC' },
      });
      expect(r.statusCode).toBe(200);
      // The validator (`inboundRequestId`) trims + lowercases.
      // Header values cross-system are case-fragile anyway; the
      // lowercase form is the canonical id used downstream.
      expect(r.json().request_id).toBe('01hkjz1my3dxztabc');
    } finally {
      await h.close();
    }
  });
});

describe('Pattern A end-to-end through HTTP routes', () => {
  it('submit → 200 pending_approval → approve → status complete', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);
    storeItem('health', { type: 'note', summary: 'BP', body: '120/80' });

    const h = await buildHarness();
    h.push(
      // Pattern A primary path: 1 chat call to bail, 1 chat call on
      // resume to answer (vault data already in resumed transcript).
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
      answerResp('Your BP was 120/80.'),
    );

    try {
      // Submit.
      const submit = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'what was my BP?', requesterDid: REQUESTER },
      });
      expect(submit.statusCode).toBe(200);
      const submitBody = submit.json();
      expect(submitBody.status).toBe('pending_approval');
      const askId: string = submitBody.request_id;
      expect(submitBody.approval_id).toBe(`appr-${askId}-health`);

      // Status before approval — still pending.
      const pending = await h.app.inject({
        method: 'GET',
        url: `/api/v1/ask/${askId}/status`,
      });
      expect(pending.statusCode).toBe(200);
      expect(pending.json().status).toBe('pending_approval');

      // Operator approves.
      const approve = await h.app.inject({
        method: 'POST',
        url: `/api/v1/ask/${askId}/approve`,
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json()).toEqual({
        ok: true,
        request_id: askId,
        approval_id: `appr-${askId}-health`,
      });

      // Microtask flush so the resume settles.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Status after approval — complete.
      const final = await h.app.inject({
        method: 'GET',
        url: `/api/v1/ask/${askId}/status`,
      });
      expect(final.statusCode).toBe(200);
      const finalBody = final.json();
      expect(finalBody.status).toBe('complete');
      expect(finalBody.answer).toEqual({ text: 'Your BP was 120/80.' });
    } finally {
      await h.close();
    }
  });

  it('submit → 200 pending_approval → deny → status failed', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);

    const h = await buildHarness();
    h.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
    );

    try {
      const submit = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'what was my BP?', requesterDid: REQUESTER },
      });
      expect(submit.statusCode).toBe(200);
      const askId: string = submit.json().request_id;

      const deny = await h.app.inject({
        method: 'POST',
        url: `/api/v1/ask/${askId}/deny`,
        payload: { reason: 'no thanks' },
      });
      expect(deny.statusCode).toBe(200);
      expect(deny.json().ok).toBe(true);

      const final = await h.app.inject({
        method: 'GET',
        url: `/api/v1/ask/${askId}/status`,
      });
      expect(final.statusCode).toBe(200);
      expect(final.json().status).toBe('failed');
    } finally {
      await h.close();
    }
  });
});

describe('Status + approval edge cases', () => {
  it('GET /api/v1/ask/:id/status returns 404 for unknown id', async () => {
    const h = await buildHarness();
    try {
      const r = await h.app.inject({
        method: 'GET',
        url: '/api/v1/ask/does-not-exist/status',
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe('not_found');
    } finally {
      await h.close();
    }
  });

  it('POST /:id/approve returns 404 for unknown id', async () => {
    const h = await buildHarness();
    try {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask/ghost/approve',
      });
      expect(r.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('POST /:id/approve returns 404 when ask exists but has no pending approval', async () => {
    const h = await buildHarness();
    h.push(answerResp('done')); // submit answers immediately, no approval needed
    try {
      const submit = await h.app.inject({
        method: 'POST',
        url: '/api/v1/ask',
        payload: { question: 'hi', requesterDid: REQUESTER },
      });
      expect(submit.statusCode).toBe(200);
      expect(submit.json().status).toBe('complete');
      const askId: string = submit.json().request_id;

      const approve = await h.app.inject({
        method: 'POST',
        url: `/api/v1/ask/${askId}/approve`,
      });
      expect(approve.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
