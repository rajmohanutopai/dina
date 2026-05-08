/**
 * `createAskCoordinator` — composer tests for 5.21-F.
 *
 * Pins the Pattern A chain wiring without going through Fastify.
 * Companion file: `apps/home-node-lite/brain-server/__tests__/ask_routes.test.ts`
 * exercises the same composer behind HTTP routes.
 */

import {
  createPersona,
  resetPersonaState,
} from '@dina/core';
import type { CreateWorkflowTaskInput, WorkflowTask } from '@dina/core';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import { clearVaults, storeItem } from '@dina/core';
import {
  buildAgenticAskPipeline,
  type BuildAgenticAskPipelineInput,
} from '../../src/composition/agentic_ask';
import {
  buildAgenticExecuteFn,
  createAskCoordinator,
  workflowTaskAsSource,
  type AskCoordinatorCoreClient,
} from '../../src/composition/ask_coordinator';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ToolCall,
} from '../../src/llm/adapters/provider';
import { resetReminderLLM } from '../../src/pipeline/reminder_planner';
import { resetIdentityExtractor } from '../../src/pipeline/identity_extraction';

const REQUESTER = 'did:key:zCoordinatorTester';
const SYSTEM_PROMPT = 'You answer questions with vault tools.';

interface ScriptedCall {
  messages: ChatMessage[];
  options: ChatOptions | undefined;
}

function makeScripted(): {
  provider: LLMProvider;
  calls: ScriptedCall[];
  push: (...rs: ChatResponse[]) => void;
} {
  const calls: ScriptedCall[] = [];
  const queue: ChatResponse[] = [];
  const provider: LLMProvider = {
    name: 'scripted',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    chat: async (messages, options) => {
      calls.push({ messages, options });
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
  };
  return {
    provider,
    calls,
    push: (...rs) => {
      queue.push(...rs);
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

// ---------------------------------------------------------------------------
// Fake AskCoordinatorCoreClient — in-memory workflow task store.
// ---------------------------------------------------------------------------

interface FakeTask { id: string; status: string; payload: string }

function makeFakeCoreClient(): {
  client: AskCoordinatorCoreClient & BuildAgenticAskPipelineInput['coreClient'];
  tasks: Map<string, FakeTask>;
  setStatus: (id: string, s: string) => void;
} {
  const tasks = new Map<string, FakeTask>();
  const setStatus = (id: string, s: string) => { const t = tasks.get(id); if (t) t.status = s; };
  const client = {
    // find_preferred_provider surface
    async findContactsByPreference() { return []; },
    // workflow approval surface
    async createWorkflowTask(input: CreateWorkflowTaskInput) {
      if (tasks.has(input.id)) throw new Error(`duplicate: ${input.id}`);
      const t: FakeTask = { id: input.id, status: input.initialState ?? 'pending_approval', payload: input.payload };
      tasks.set(input.id, t);
      return { task: t as unknown as WorkflowTask, deduped: false };
    },
    async getWorkflowTask(id: string) { return (tasks.get(id) as unknown as WorkflowTask) ?? null; },
    async completeWorkflowTask(id: string) { setStatus(id, 'completed'); return tasks.get(id) as unknown as WorkflowTask; },
    async approveWorkflowTask(id: string) { setStatus(id, 'queued'); return tasks.get(id) as unknown as WorkflowTask; },
    async cancelWorkflowTask(id: string) { setStatus(id, 'cancelled'); return tasks.get(id) as unknown as WorkflowTask; },
  };
  return { client, tasks, setStatus };
}

function buildPipeline(args: { llm: LLMProvider; coreClient: BuildAgenticAskPipelineInput['coreClient'] }) {
  return buildAgenticAskPipeline({
    llm: args.llm,
    providerName: 'gemini',
    appViewClient: fakeAppView(),
    orchestratorHandle: fakeOrchestrator(),
    coreClient: args.coreClient,
    cloudConsentGranted: true,
  });
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

describe('createAskCoordinator — construction', () => {
  it('rejects pipeline without buildToolsForAsk', () => {
    const { provider } = makeScripted();
    // Manually stub a pipeline that lacks buildToolsForAsk — the coordinator
    // always rejects this, regardless of how the pipeline was built.
    const pipeline = { provider, buildToolsForAsk: undefined } as never;
    const { client } = makeFakeCoreClient();
    expect(() =>
      createAskCoordinator({
        pipeline,
        coreClient: client,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
        systemPrompt: SYSTEM_PROMPT,
      }),
    ).toThrow('pipeline.buildToolsForAsk is missing');
  });

  it('rejects empty systemPrompt', () => {
    const llm = makeScripted();
    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    expect(() =>
      createAskCoordinator({
        pipeline,
        coreClient: client,
        executeFn: async () => ({ kind: 'answer', answer: {} }),
        systemPrompt: '',
      }),
    ).toThrow('systemPrompt must be a non-empty string');
  });
});

describe('createAskCoordinator — Pattern B happy path', () => {
  it('handleAsk returns 200 + complete on a fast-path answer', async () => {
    const llm = makeScripted();
    llm.push(answerResp('General-public answer.'));

    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const coord = createAskCoordinator({
      pipeline,
      coreClient: client,
      executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
      systemPrompt: SYSTEM_PROMPT,
      fastPathMs: 5_000,
    });

    const r = await coord.handleAsk({
      question: 'what colour is the sky?',
      requesterDid: REQUESTER,
    });
    expect(r.kind).toBe('fast_path');
    if (r.kind !== 'fast_path') return;
    expect(r.body.status).toBe('complete');
    expect(r.body.answer).toEqual({ text: 'General-public answer.' });
  });
});

describe('createAskCoordinator — Pattern A end-to-end', () => {
  it('full bail → approve → resume → complete cycle through coordinator surface', async () => {
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['health']);
    storeItem('health', {
      type: 'note',
      summary: 'BP reading',
      body: '120/80',
    });

    const llm = makeScripted();
    // Pattern A primary path (5.21-G): the agentic loop suspends with
    // its full transcript at the bail point. On resume,
    // `resumeAgenticTurn` re-executes the bailing tool (which now
    // consumes the approval and reads vault data), pushes the tool
    // result onto the transcript, and continues to the next LLM
    // iteration. The LLM only chats TWICE end-to-end:
    //   1st run:    chat #1 → tool_call (bails on guard)
    //   On resume:  chat #2 → final answer (vault data already in transcript)
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'BP', persona: 'health' },
      }),
      answerResp('Your BP was 120/80.'),
    );

    const { client, tasks } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const coord = createAskCoordinator({
      pipeline,
      coreClient: client,
      executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
      systemPrompt: SYSTEM_PROMPT,
      fastPathMs: 1_000,
    });

    // Submit the ask; executeFn runs the loop, gets approval_required,
    // returns Pattern B `approval` outcome → handler stores
    // pending_approval.
    const submit = await coord.handleAsk({
      question: 'what was my BP?',
      requesterDid: REQUESTER,
    });
    expect(submit.kind).toBe('fast_path');
    if (submit.kind !== 'fast_path') return;
    expect(submit.body.status).toBe('pending_approval');
    const approvalId = submit.body.approval_id;
    expect(approvalId).toBe('appr-' + submit.body.request_id + '-health');

    // Operator approves via gateway → registry resumes → resumer
    // handles the event → executeFn (Pattern B re-run) fires again.
    // The second executeFn run hits the now-approved guard, consumes
    // it, reads the vault, and answers.
    const approveResult = await coord.gateway.approve(approvalId!);
    expect(approveResult.ok).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Status check shows complete.
    const status = await coord.handleStatus(submit.body.request_id);
    expect(status.kind).toBe('found');
    if (status.kind !== 'found') return;
    expect(status.body.status).toBe('complete');
    expect(status.body.answer).toEqual({ text: 'Your BP was 120/80.' });

    // Approval workflow task was consumed (completed) after vault read.
    expect(tasks.get(approvalId!)?.status).toBe('completed');
  });

  it('Pattern A invariant: pausedState is persisted to registry; resume calls LLM exactly once more (5.21-G)', async () => {
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

    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const coord = createAskCoordinator({
      pipeline,
      coreClient: client,
      executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
      systemPrompt: SYSTEM_PROMPT,
      fastPathMs: 1_000,
    });

    const submit = await coord.handleAsk({
      question: 'BP?',
      requesterDid: REQUESTER,
    });
    if (submit.kind !== 'fast_path' || submit.body.status !== 'pending_approval') {
      throw new Error('expected pending_approval');
    }
    const askId = submit.body.request_id;

    // 5.21-G invariant #1: pausedStateJson IS persisted to the registry.
    const parked = await coord.registry.get(askId);
    expect(parked?.pausedStateJson).toBeDefined();
    const parsed = JSON.parse(parked!.pausedStateJson!);
    expect(parsed.version).toBe(1);
    expect(parsed.persona).toBe('health');
    expect(parsed.approvalId).toBe(submit.body.approval_id);

    // After the first turn, the LLM was called exactly once.
    expect(llm.calls).toHaveLength(1);

    // Approve + flush.
    await coord.gateway.approve(submit.body.approval_id!);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // 5.21-G invariant #2: resume took the Pattern A path
    // (resumeAgenticTurn), so the LLM was called exactly ONE more
    // time — not 1+ more for a Pattern B re-run.
    expect(llm.calls).toHaveLength(2);

    // 5.21-G invariant #3: registry transitioned to complete.
    const final = await coord.registry.get(askId);
    expect(final?.status).toBe('complete');
    expect(JSON.parse(final?.answerJson ?? '{}')).toEqual({ text: 'Your BP was 120/80.' });
    // Terminal write clears pausedStateJson.
    expect(final?.pausedStateJson).toBeUndefined();
  });

  it('handleStatus returns 404 for unknown request_id', async () => {
    const llm = makeScripted();
    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const coord = createAskCoordinator({
      pipeline,
      coreClient: client,
      executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
      systemPrompt: SYSTEM_PROMPT,
    });
    const r = await coord.handleStatus('does-not-exist');
    expect(r.kind).toBe('not_found');
  });

  it('gateway.deny transitions the ask to failed with operator reason', async () => {
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

    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const coord = createAskCoordinator({
      pipeline,
      coreClient: client,
      executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT }),
      systemPrompt: SYSTEM_PROMPT,
      fastPathMs: 1_000,
    });

    const submit = await coord.handleAsk({
      question: 'what was my BP?',
      requesterDid: REQUESTER,
    });
    if (submit.kind !== 'fast_path' || submit.body.status !== 'pending_approval') {
      throw new Error('expected pending_approval');
    }
    const approvalId = submit.body.approval_id!;

    const denyResult = await coord.gateway.deny(approvalId, 'Operator chose not to allow this.');
    expect(denyResult.ok).toBe(true);

    const status = await coord.handleStatus(submit.body.request_id);
    if (status.kind !== 'found') throw new Error('expected found');
    expect(status.body.status).toBe('failed');
    expect(status.body.error).toBeDefined();
  });
});

describe('workflowTaskAsSource adapter', () => {
  it('maps null task (not found) to expired', async () => {
    const { client } = makeFakeCoreClient();
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('ghost')).toBe('expired');
  });

  it('maps pending_approval → pending', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'pending_approval', payload: '{}' });
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('a1')).toBe('pending');
  });

  it('maps queued → approved', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'queued', payload: '{}' });
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('a1')).toBe('approved');
  });

  it('maps running → approved', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'running', payload: '{}' });
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('a1')).toBe('approved');
  });

  it('maps cancelled → denied', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'cancelled', payload: '{}' });
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('a1')).toBe('denied');
  });

  it('maps failed → denied', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'failed', payload: '{}' });
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('a1')).toBe('denied');
  });

  it('maps completed → expired (already consumed)', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'completed', payload: '{}' });
    const source = workflowTaskAsSource(client);
    expect(await source.getStatus('a1')).toBe('expired');
  });

  it('approve() calls approveWorkflowTask → task transitions to queued', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'pending_approval', payload: '{}' });
    const source = workflowTaskAsSource(client);
    await source.approve('a1');
    expect(tasks.get('a1')?.status).toBe('queued');
  });

  it('deny() calls cancelWorkflowTask → task transitions to cancelled', async () => {
    const { client, tasks } = makeFakeCoreClient();
    tasks.set('a1', { id: 'a1', status: 'pending_approval', payload: '{}' });
    const source = workflowTaskAsSource(client);
    await source.deny('a1');
    expect(tasks.get('a1')?.status).toBe('cancelled');
  });
});

describe('buildAgenticExecuteFn translation', () => {
  it('translates loop completion → answer outcome', async () => {
    const llm = makeScripted();
    llm.push(answerResp('hi'));

    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const fn = buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT });

    const out = await fn({ id: 'ask-1', question: 'q', requesterDid: REQUESTER });
    expect(out).toEqual({ kind: 'answer', answer: { text: 'hi' } });
  });

  it('translates approval_required loop bail → approval outcome (Pattern B re-run path)', async () => {
    createPersona('health', 'sensitive');
    const llm = makeScripted();
    llm.push(
      toolCallResp({
        id: 'c1',
        name: 'vault_search',
        arguments: { query: 'q', persona: 'health' },
      }),
    );

    const { client } = makeFakeCoreClient();
    const pipeline = buildPipeline({ llm: llm.provider, coreClient: client });
    const fn = buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT });

    const out = await fn({ id: 'ask-1', question: 'q', requesterDid: REQUESTER });
    // 5.21-G: includes pausedStateJson so the handler can persist it.
    expect(out).toMatchObject({
      kind: 'approval',
      approvalId: 'appr-ask-1-health',
    });
    if (out.kind !== 'approval') return;
    expect(out.pausedStateJson).toBeDefined();
    const paused = JSON.parse(out.pausedStateJson!);
    expect(paused.version).toBe(1);
    expect(paused.approvalId).toBe('appr-ask-1-health');
    expect(paused.persona).toBe('health');
  });

  it('throws TypeError when pipeline lacks buildToolsForAsk', () => {
    const { provider } = makeScripted();
    // Manually stub a pipeline without buildToolsForAsk.
    const pipeline = { provider, buildToolsForAsk: undefined } as never;
    expect(() => buildAgenticExecuteFn({ pipeline, systemPrompt: SYSTEM_PROMPT })).toThrow(
      'pipeline.buildToolsForAsk is missing',
    );
  });
});
