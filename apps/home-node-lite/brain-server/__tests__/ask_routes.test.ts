/**
 * `/api/v1/ask` Fastify route binding — task 5.21-F.
 *
 * Drives the routes through `app.inject(...)` so no real socket is
 * opened. Wires a real `AskCoordinator` with a scripted LLM provider,
 * the in-memory `ApprovalManager`, and a real persona / vault setup —
 * proves the full Pattern A chain (submit → 200 pending_approval →
 * approve → status complete) end-to-end behind HTTP.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { ApprovalManager } from '@dina/core/src/approval/manager';
import {
  createPersona,
  resetPersonaState,
} from '@dina/core/src/persona/service';
import {
  buildAgenticAskPipeline,
  type BuildAgenticAskPipelineInput,
} from '@dina/brain/src/composition/agentic_ask';
import {
  buildAgenticExecuteFn,
  createAskCoordinator,
} from '@dina/brain/src/composition/ask_coordinator';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '@dina/brain/src/vault_context/assembly';
import { clearVaults, storeItem } from '@dina/core/src/vault/crud';
import { resetReminderLLM } from '@dina/brain/src/pipeline/reminder_planner';
import { resetIdentityExtractor } from '@dina/brain/src/pipeline/identity_extraction';
import type {
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '@dina/brain/src/llm/adapters/provider';

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

interface Harness {
  app: FastifyInstance;
  approvalManager: ApprovalManager;
  push: (...rs: ChatResponse[]) => void;
  close: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const llm = makeScripted();
  const approvalManager = new ApprovalManager();
  const pipeline = buildAgenticAskPipeline({
    llm: llm.provider,
    providerName: 'gemini',
    appViewClient: fakeAppView(),
    orchestratorHandle: fakeOrchestrator(),
    coreClient: fakeCoreClient(),
    cloudConsentGranted: true,
    approvalManager,
  });
  const coordinator = createAskCoordinator({
    pipeline,
    approvalManager,
    executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
    systemPrompt: SYSTEM_PROMPT,
    fastPathMs: 1_000,
  });

  const app = Fastify({ logger: false });
  registerAskRoutes(app, { coordinator });
  await app.ready();

  return {
    app,
    approvalManager,
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

      // Approval was consumed.
      expect(h.approvalManager.getRequest(`appr-${askId}-health`)).toBeUndefined();
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
