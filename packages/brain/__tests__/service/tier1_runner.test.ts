/**
 * Tier 1 runner glue — workflow task → (instruction, schema) →
 * runCapability. Execution-time config resolution, alias-aware lookup,
 * multi-listing rkey routing, operator_approved threading, and the
 * fail-loud paths (no listing / no instruction).
 */

import { AppointmentAvailabilityResultSchema } from '../../src/service/capabilities/appointment';
import { makeTier1CapabilityRunner } from '../../src/service/tier1_runner';

import type { ChatOptions, ChatResponse, LLMProvider } from '../../src/llm/adapters/provider';
import type { WorkflowTask } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

const NOW = 1_750_000_000_000;

function scriptedProvider(script: Partial<ChatResponse>[]): {
  provider: LLMProvider;
  systems: string[];
} {
  let i = 0;
  const systems: string[] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(_messages, options?: ChatOptions) {
      systems.push(options?.systemPrompt ?? '');
      const step = script[i] ?? { content: '(end of script)', toolCalls: [] };
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

const VALID = {
  status: 'ok',
  slots: [{ time: '4:30 PM' }],
};

function salonConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    isDiscoverable: true,
    discoverability: 'public',
    status: 'active',
    name: "Maya's Salon",
    capabilities: {
      appointment_availability: {
        responsePolicy: 'auto',
        category: 'appointments',
        instruction: 'Answer from my notes.',
        instructionUpdatedAt: NOW - 60_000,
      },
    },
    ...overrides,
  };
}

function task(id: string, payload: Record<string, unknown>): WorkflowTask {
  return {
    id,
    kind: 'delegation',
    status: 'running',
    priority: 'normal',
    description: 'test',
    // Production payloads (built by the codec) always carry the identity
    // fields — the codec parse REQUIRES them.
    payload: JSON.stringify({
      type: 'service_query_execution',
      from_did: 'did:plc:customer',
      query_id: `q-${id}`,
      capability: 'appointment_availability',
      ...payload,
    }),
    policy: '{}',
    result_summary: '',
    created_at: NOW,
    updated_at: NOW,
  } as WorkflowTask;
}

describe('makeTier1CapabilityRunner', () => {
  it('resolves the self listing, runs the capability, returns the result', async () => {
    const { provider } = scriptedProvider([{ content: JSON.stringify(VALID), toolCalls: [] }]);
    const seenRkeys: string[] = [];
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: (rkey) => {
        seenRkeys.push(rkey);
        return salonConfig();
      },
    });
    const result = await runner('appointment_availability', { service: 'haircut' }, task('t1', {}));
    expect(result).toEqual(VALID);
    expect(seenRkeys).toEqual(['self']); // no service_uri → default listing
  });

  it('routes a multi-listing service_uri to its rkey', async () => {
    const { provider } = scriptedProvider([{ content: JSON.stringify(VALID), toolCalls: [] }]);
    const seenRkeys: string[] = [];
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: (rkey) => {
        seenRkeys.push(rkey);
        return salonConfig();
      },
    });
    await runner(
      'appointment_availability',
      {},
      task('t2', {
        service_uri: 'at://did:plc:salon123/com.dinakernel.service.profile/branch-2',
      }),
    );
    expect(seenRkeys).toEqual(['branch-2']);
  });

  it('resolves an ALIAS query against the canonical-keyed config', async () => {
    const { provider } = scriptedProvider([{ content: JSON.stringify(VALID), toolCalls: [] }]);
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => salonConfig(),
    });
    await expect(runner('appointment_slots', {}, task('t3', {}))).resolves.toEqual(VALID);
  });

  it('prefers the listing\'s PUBLISHED result schema over the registry default', async () => {
    // Published schema demands a field the registry schema doesn't —
    // a registry-validated answer must now FAIL, proving the published
    // schema was the one enforced.
    const published = {
      type: 'object',
      required: ['status', 'salon_signature'],
      properties: {
        status: { type: 'string' },
        salon_signature: { type: 'string' },
        slots: AppointmentAvailabilityResultSchema.properties.slots,
      },
    } as Record<string, unknown>;
    const { provider } = scriptedProvider([
      { content: JSON.stringify(VALID), toolCalls: [] }, // valid per registry, invalid per published
      { content: JSON.stringify(VALID), toolCalls: [] }, // retry still invalid
    ]);
    const config = salonConfig({
      capabilitySchemas: {
        appointment_availability: {
          params: { type: 'object' },
          result: published,
          schemaHash: 'deadbeef',
        },
      },
    });
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => config,
    });
    await expect(runner('appointment_availability', {}, task('t4', {}))).rejects.toThrow(
      /salon_signature|schema validation/,
    );
  });

  it('threads operator_approved from the task payload into the prompt', async () => {
    const { provider, systems } = scriptedProvider([
      { content: JSON.stringify({ status: 'confirmed', time: '4:30 PM' }), toolCalls: [] },
    ]);
    const config = salonConfig();
    config.capabilities.appointment_book = {
      responsePolicy: 'review',
      category: 'appointments',
      instruction: 'If someone wants to book, ask me first.',
      instructionUpdatedAt: NOW - 60_000,
    };
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => config,
    });
    await runner(
      'appointment_book',
      { time: '4:30 PM' },
      task('svc-exec-from-approval-1', { operator_approved: true }),
    );
    expect(systems[0]).toContain('PERSONALLY REVIEWED AND APPROVED');
  });

  it('fails loud when the capability has no instruction (agent-lane task misrouted)', async () => {
    const { provider } = scriptedProvider([]);
    const config = salonConfig();
    config.capabilities.appointment_availability = {
      mcpServer: 'openclaw',
      mcpTool: 'appointment_availability',
      responsePolicy: 'auto',
      category: 'appointments',
    };
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => config,
    });
    await expect(runner('appointment_availability', {}, task('t5', {}))).rejects.toThrow(
      /no instruction/,
    );
  });

  it('fails loud when the listing is missing or not active', async () => {
    const { provider } = scriptedProvider([]);
    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => null,
    });
    await expect(runner('appointment_availability', {}, task('t6', {}))).rejects.toThrow(
      /not configured/,
    );

    const paused = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => salonConfig({ status: 'paused' }),
    });
    await expect(paused('appointment_availability', {}, task('t7', {}))).rejects.toThrow(
      /not configured|not active/,
    );
  });
});

describe('makeTier1CapabilityRunner — per-listing vault pin', () => {
  it("threads the listing's vaultPersona into the run as the per-run scope pin", async () => {
    // The pin reaches the runtime as RunCapabilityArgs.allowedPersonas;
    // observable end-to-end via the vault tool's personas_searched in
    // capability_runtime.test.ts. Here we pin the THREADING: a config
    // with vaultPersona must constrain the run — proven by giving the
    // scripted model a vault_search call and asserting the tool's
    // searched set. (Personas registered via the registry so the tier
    // intersection has something to intersect with.)
    const { clearVaults, storeItem, createPersona, resetPersonaState } = await import('@dina/core');
    const { setAccessiblePersonas, resetReasoningProvider } = await import(
      '../../src/vault_context/assembly'
    );
    clearVaults(['general', 'work']);
    resetPersonaState();
    resetReasoningProvider();
    createPersona('general', 'default');
    createPersona('work', 'standard');
    setAccessiblePersonas(['general', 'work']);
    storeItem('work', { type: 'user_memory', summary: 'salon notes', body: 'salon notes' });

    let searched: string[] = [];
    const provider: LLMProvider = {
      name: 'test',
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsEmbedding: false,
      async chat(messages) {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg !== undefined) {
          const parsed = JSON.parse(toolMsg.content) as {
            result?: { personas_searched?: string[] };
          };
          searched = parsed.result?.personas_searched ?? [];
          return {
            content: JSON.stringify(VALID),
            toolCalls: [],
            model: 'test',
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: 'end',
          };
        }
        return {
          content: '',
          toolCalls: [{ id: 't1', name: 'vault_search', arguments: { query: 'salon' } }],
          model: 'test',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'tool_use',
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

    const runner = makeTier1CapabilityRunner({
      getLLM: () => provider,
      nowMsFn: () => NOW,
      readConfig: () => salonConfig({ vaultPersona: 'work' }),
    });
    await runner('appointment_availability', {}, task('t-pin', {}));
    expect(searched).toEqual(['work']);
  });
});
