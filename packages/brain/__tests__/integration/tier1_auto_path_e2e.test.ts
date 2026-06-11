/**
 * Tier 1 AUTO path, composed end-to-end (docs/SERVICE_PROVIDER_TIERS.md):
 *
 *   ServiceHandler.handleQuery (real)  →  workflow repo (real, in-memory)
 *     →  LocalDelegationRunner (real, default 'dina.local' exact filter)
 *     →  makeTier1CapabilityRunner (real)  →  scripted LLM
 *     →  WorkflowService.complete (real)
 *
 * Every unit has its own suite with hand-built inputs; THIS test exists
 * for the wiring/payload-shape bug class (per the contract-tests rule):
 * a renamed payload field between the handler and the tier1 runner —
 * service_uri, ttl_seconds, operator_approved — passes every unit suite
 * and only dies here (or live).
 */

import { WorkflowService, InMemoryWorkflowRepository, LocalDelegationRunner } from '@dina/core';


import { ServiceHandler } from '../../src/service/service_handler';
import { makeTier1CapabilityRunner } from '../../src/service/tier1_runner';

import type { ChatOptions, ChatResponse, LLMProvider } from '../../src/llm/adapters/provider';
import type { ServiceHandlerCoreClient } from '../../src/service/service_handler';
import type { ServiceConfig, WorkflowTask, WorkflowTaskState } from '@dina/core';

const REQUESTER = 'did:plc:customer';
const NOW_MS = 1_750_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const SALON_CONFIG: ServiceConfig = {
  isDiscoverable: true,
  discoverability: 'public',
  status: 'active',
  name: "Alonso's Salon",
  capabilities: {
    appointment_availability: {
      responsePolicy: 'auto',
      category: 'appointments',
      instruction: 'Use my appointment notes to answer haircut availability.',
      instructionUpdatedAt: NOW_MS - 60_000,
    },
  },
};

const VALID_RESULT = {
  status: 'ok',
  slots: [{ time: '4:30 PM' }, { time: '5:15 PM' }],
};

function scriptedLLM(script: Partial<ChatResponse>[]): { provider: LLMProvider; systems: string[] } {
  let i = 0;
  const systems: string[] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(_messages, options?: ChatOptions) {
      systems.push(options?.systemPrompt ?? '');
      const step = script[i] ?? { content: '(end)', toolCalls: [] };
      i++;
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        model: 'test',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: 'end',
      };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('not used');
    },
    async embed() {
      throw new Error('not used');
    },
  };
  return { provider, systems };
}

interface CreateInput {
  id: string;
  kind: string;
  payload: string;
  description?: string;
  correlationId?: string;
  origin?: string;
  initialState?: string;
  expiresAtSec?: number;
  requestedRunner?: string;
}

function handlerClient(service: WorkflowService): ServiceHandlerCoreClient {
  return {
    async createWorkflowTask(input: CreateInput) {
      const task = service.create({
        id: input.id,
        kind: input.kind as WorkflowTask['kind'],
        payload: input.payload,
        description: input.description ?? '',
        correlationId: input.correlationId,
        origin: input.origin,
        initialState: input.initialState as WorkflowTaskState | undefined,
        expiresAtSec: input.expiresAtSec,
        requestedRunner: input.requestedRunner,
      });
      return { task, deduped: false };
    },
    async cancelWorkflowTask(id: string, reason?: string) {
      return service.cancel(id, reason ?? '');
    },
  } as unknown as ServiceHandlerCoreClient;
}

describe('Tier 1 auto path — handleQuery → dina.local claim → runCapability → complete', () => {
  it('a stranger query is answered by the in-process runtime, end to end', async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({ repository: repo, nowMsFn: () => NOW_MS });
    const handler = new ServiceHandler({
      coreClient: handlerClient(service),
      readConfig: () => SALON_CONFIG,
      nowSecFn: () => NOW_SEC,
      generateUUID: () => 'auto1',
    });

    // 1. Inbound auto-policy query → delegation lands on the reserved lane.
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-auto-1',
      capability: 'appointment_availability',
      params: { service: 'haircut', time_after: '4pm' },
      ttl_seconds: 120,
    });
    const task = repo.getById('svc-exec-auto1');
    expect(task).not.toBeNull();
    expect(task!.requested_runner).toBe('dina.local');
    expect(task!.status).toBe('queued');

    // 2. The REAL tier1 runner glue + a scripted LLM, claimed by the REAL
    //    LocalDelegationRunner on its default exact-match filter.
    const { provider, systems } = scriptedLLM([
      { content: JSON.stringify(VALID_RESULT), toolCalls: [] },
    ]);
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: 'did:plc:provider-self',
      nowMsFn: () => NOW_MS,
      runner: makeTier1CapabilityRunner({
        getLLM: () => provider,
        nowMsFn: () => NOW_MS,
        readConfig: () => SALON_CONFIG,
      }),
    });
    await runner.runTick();

    // 3. The task completed with the schema-valid result; the provider's
    //    instruction reached the model verbatim.
    const done = repo.getById('svc-exec-auto1');
    expect(done!.status).toBe('completed');
    expect(JSON.parse(done!.result ?? 'null')).toEqual(VALID_RESULT);
    expect(systems[0]).toContain('Use my appointment notes');
    expect(systems[0]).toContain("Alonso's Salon");
    // Auto path: the operator never approved anything — the prompt must
    // NOT claim they did.
    expect(systems[0]).not.toContain('PERSONALLY REVIEWED AND APPROVED');
  });

  it('an untagged free_form_task delegation in the same queue is NEVER touched by the Tier 1 runner', async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({ repository: repo, nowMsFn: () => NOW_MS });

    // The user's delegate_to_agent task — no requested_runner, meant for
    // the paired external agent.
    service.create({
      id: 'free-1',
      kind: 'delegation',
      payload: JSON.stringify({ type: 'free_form_task', description: 'buy milk' }),
      description: 'free form',
      initialState: 'queued',
    });

    const { provider } = scriptedLLM([]);
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: 'did:plc:provider-self',
      nowMsFn: () => NOW_MS,
      runner: makeTier1CapabilityRunner({
        getLLM: () => provider,
        nowMsFn: () => NOW_MS,
        readConfig: () => SALON_CONFIG,
      }),
    });
    await runner.runTick();

    // Still queued for the real agent — not claimed, not failed.
    const untouched = repo.getById('free-1');
    expect(untouched!.status).toBe('queued');
    expect(untouched!.agent_did).toBeUndefined();
  });
});
