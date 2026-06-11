/**
 * Tier 1 capability runtime (`runCapability`) — instruction + params +
 * vault search → schema-constrained JSON (docs/SERVICE_PROVIDER_TIERS.md).
 *
 * Driven by a scripted LLMProvider (same pattern as agentic_loop.test).
 * Covers: happy path, fence-tolerant parsing, schema-validation gate,
 * native-structured-output synthesis retry, hard failure after retry,
 * as-of prompt discipline, operator-approved prompt discipline,
 * provider-missing + empty-instruction errors.
 */

import {
  AppointmentAvailabilityResultSchema,
  AppointmentBookResultSchema,
} from '../../src/service/capabilities/appointment';
import {
  buildCapabilityRuntime,
  renderInstructionAge,
  extractJSONObject,
 defaultTier1PersonaScope } from '../../src/service/capability_runtime';
import { setAccessiblePersonas, resetReasoningProvider } from '../../src/vault_context/assembly';

import type { ChatOptions, ChatResponse, LLMProvider , ToolCall } from '../../src/llm/adapters/provider';

interface RecordedCall {
  system: string;
  lastUser: string;
  responseSchema: Record<string, unknown> | undefined;
}

function scriptedProvider(script: Partial<ChatResponse>[]): {
  provider: LLMProvider;
  calls: RecordedCall[];
} {
  let i = 0;
  const calls: RecordedCall[] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(messages, options?: ChatOptions) {
      calls.push({
        system: options?.systemPrompt ?? '',
        lastUser: messages[messages.length - 1]?.content ?? '',
        responseSchema: options?.responseSchema,
      });
      const step = script[i] ?? { content: '(end of script)', toolCalls: [] };
      i++;
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 20 },
        finishReason: (step.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end',
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
  return { provider, calls };
}

const NOW = 1_750_000_000_000;

const SALON_ARGS = {
  capability: 'appointment_availability',
  params: { service: 'haircut', date: 'today', time_after: '4pm' },
  instruction:
    'Use my appointment notes to answer haircut availability questions. If someone wants to book, ask me first.',
  instructionUpdatedAt: NOW - 2 * 3_600_000, // 2 hours ago
  resultSchema: AppointmentAvailabilityResultSchema as unknown as Record<string, unknown>,
  serviceName: "Maya's Salon",
};

const VALID_AVAILABILITY = {
  status: 'ok',
  slots: [{ time: '4:30 PM' }, { time: '5:15 PM' }],
  date: 'today',
  as_of: 'this morning',
};

describe('buildCapabilityRuntime — happy path', () => {
  it('returns the parsed result when the first answer validates', async () => {
    const { provider, calls } = scriptedProvider([
      { content: JSON.stringify(VALID_AVAILABILITY), toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    const result = await runtime.run(SALON_ARGS);
    expect(result).toEqual(VALID_AVAILABILITY);
    expect(calls).toHaveLength(1); // no retry needed
  });

  it('tolerates code fences + prose drift around the JSON', async () => {
    const { provider } = scriptedProvider([
      {
        content: '```json\n' + JSON.stringify(VALID_AVAILABILITY) + '\n```',
        toolCalls: [],
      },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await expect(runtime.run(SALON_ARGS)).resolves.toEqual(VALID_AVAILABILITY);
  });
});

describe('buildCapabilityRuntime — prompt discipline', () => {
  it('embeds the instruction verbatim + the as-of age + the service name', async () => {
    const { provider, calls } = scriptedProvider([
      { content: JSON.stringify(VALID_AVAILABILITY), toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run(SALON_ARGS);
    const sys = calls[0].system;
    expect(sys).toContain(SALON_ARGS.instruction);
    expect(sys).toContain('2 hours ago');
    expect(sys).toContain("Maya's Salon");
    // The privacy hard-rule must always ride along.
    expect(sys).toContain('EXTERNAL requester');
    // Params reach the model verbatim.
    expect(calls[0].lastUser).toContain('"time_after":"4pm"');
  });

  it('tells the model the operator already approved (review-policy second leg)', async () => {
    const booked = { status: 'confirmed', time: '4:30 PM', message: 'Booked for 4:30.' };
    const { provider, calls } = scriptedProvider([
      { content: JSON.stringify(booked), toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run({
      ...SALON_ARGS,
      capability: 'appointment_book',
      params: { service: 'haircut', time: '4:30 PM', date: 'today' },
      resultSchema: AppointmentBookResultSchema as unknown as Record<string, unknown>,
      operatorApproved: true,
    });
    expect(calls[0].system).toContain('PERSONALLY REVIEWED AND APPROVED');
  });

  it('omits the approved block on the auto path', async () => {
    const { provider, calls } = scriptedProvider([
      { content: JSON.stringify(VALID_AVAILABILITY), toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run(SALON_ARGS);
    expect(calls[0].system).not.toContain('PERSONALLY REVIEWED AND APPROVED');
  });
});

describe('buildCapabilityRuntime — schema gate + synthesis retry', () => {
  it('retries ONCE through native structured output when the first answer fails the schema', async () => {
    const invalid = { status: 'maybe', slots: 'four-thirty' }; // enum + type violations
    const { provider, calls } = scriptedProvider([
      { content: JSON.stringify(invalid), toolCalls: [] },
      { content: JSON.stringify(VALID_AVAILABILITY), toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    const result = await runtime.run(SALON_ARGS);
    expect(result).toEqual(VALID_AVAILABILITY);
    expect(calls).toHaveLength(2);
    // The retry call must use NATIVE structured output…
    expect(calls[1].responseSchema).toEqual(SALON_ARGS.resultSchema);
    // …and carry the validation error so the model knows what to fix.
    expect(calls[1].lastUser).toContain('status');
  });

  it('fails the task (throws) when the retry is still schema-invalid', async () => {
    const invalid = { status: 'maybe' };
    const { provider } = scriptedProvider([
      { content: JSON.stringify(invalid), toolCalls: [] },
      { content: JSON.stringify(invalid), toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await expect(runtime.run(SALON_ARGS)).rejects.toThrow(/schema validation after retry/);
  });

  it('fails when the model never emits JSON at all', async () => {
    const { provider } = scriptedProvider([
      { content: 'Sure! There are slots at 4:30 and 5:15.', toolCalls: [] },
      { content: 'Apologies — 4:30 and 5:15 are free today.', toolCalls: [] },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await expect(runtime.run(SALON_ARGS)).rejects.toThrow(/schema validation after retry/);
  });
});

describe('buildCapabilityRuntime — hard preconditions', () => {
  it('throws a clear error when no LLM is configured', async () => {
    const runtime = buildCapabilityRuntime({ getLLM: () => null, nowMsFn: () => NOW });
    await expect(runtime.run(SALON_ARGS)).rejects.toThrow(/no AI provider configured/);
  });

  it('throws when the instruction is empty', async () => {
    const { provider } = scriptedProvider([]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await expect(runtime.run({ ...SALON_ARGS, instruction: '  ' })).rejects.toThrow(
      /instruction is empty/,
    );
  });
});

describe('renderInstructionAge', () => {
  it('renders human spans', () => {
    expect(renderInstructionAge(NOW - 30_000, NOW)).toBe('moments ago');
    expect(renderInstructionAge(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(renderInstructionAge(NOW - 3 * 3_600_000, NOW)).toBe('3 hours ago');
    expect(renderInstructionAge(NOW - 72 * 3_600_000, NOW)).toBe('3 days ago');
  });

  it('handles missing / bogus timestamps', () => {
    expect(renderInstructionAge(undefined, NOW)).toBe('at an unknown time');
    expect(renderInstructionAge(0, NOW)).toBe('at an unknown time');
    expect(renderInstructionAge(NOW + 1000, NOW)).toBe('at an unknown time');
  });
});

describe('extractJSONObject', () => {
  it('parses bare, fenced, and prose-wrapped objects', () => {
    expect(extractJSONObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJSONObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJSONObject('Here you go: {"a":1} — done.')).toEqual({ a: 1 });
  });

  it('returns null for non-JSON', () => {
    expect(extractJSONObject('no object here')).toBeNull();
    expect(extractJSONObject('{broken')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tier 1 vault scope (P1 security fix): external service queries must never
// read sensitive/locked personas — mobile auto-opens them for the OWNER, so
// "accessible" is not a privacy boundary for stranger-driven executions.
// ---------------------------------------------------------------------------


import { clearVaults, storeItem, createPersona, resetPersonaState } from '@dina/core';


function vaultScriptedProvider(script: { content: string; toolCalls?: ToolCall[] }[]): {
  provider: LLMProvider;
  allMessages: string[][];
} {
  let i = 0;
  const allMessages: string[][] = [];
  const provider: LLMProvider = {
    name: 'test',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    async chat(messages) {
      allMessages.push(messages.map((m) => `${m.role}:${m.content}`));
      const step = script[i] ?? { content: '(end)', toolCalls: [] };
      i++;
      return {
        content: step.content,
        toolCalls: step.toolCalls ?? [],
        model: 'test',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: (step.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end',
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
  return { provider, allMessages };
}

describe('Tier 1 vault scope — the runtime never reads sensitive personas', () => {
  beforeEach(() => {
    clearVaults();
    resetPersonaState();
    resetReasoningProvider();
    createPersona('general', 'default');
    createPersona('health', 'sensitive');
    createPersona('financial', 'locked');
    // Mobile auto-opens sensitive personas for the OWNER — replicate that.
    setAccessiblePersonas(['general', 'health']);
    storeItem('general', {
      type: 'user_memory',
      summary: 'salon slots 4:30 PM and 5:15 PM',
      body: 'salon slots 4:30 PM and 5:15 PM',
    });
    storeItem('health', {
      type: 'user_memory',
      summary: 'HbA1c 5.9 salon-day clinic note',
      body: 'HbA1c 5.9 salon-day clinic note',
    });
  });

  it('defaultTier1PersonaScope excludes sensitive + locked tiers', () => {
    expect(defaultTier1PersonaScope()).toEqual(['general']);
  });

  it('a vault_search issued during a Tier 1 run returns ONLY in-scope rows — even when the (attacker-steerable) model searches for the sensitive content by name', async () => {
    const { provider, allMessages } = vaultScriptedProvider([
      // The model — steered by hostile params — asks for the health data.
      { content: '', toolCalls: [{ id: 't1', name: 'vault_search', arguments: { query: 'HbA1c salon' } }] },
      { content: JSON.stringify(VALID_AVAILABILITY) },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run(SALON_ARGS);

    // The tool-result message fed back to the model must contain the
    // general-persona row only — never the health row.
    const toolFeedback = allMessages
      .flat()
      .filter((m) => m.startsWith('tool:'))
      .join('\n');
    expect(toolFeedback).toContain('salon slots');
    // The QUERY echo legitimately contains the attacker's words — the
    // CONTENT marker ('clinic note') and the persona row are what must
    // never appear.
    expect(toolFeedback).not.toContain('clinic note');
    expect(toolFeedback).not.toContain('"persona":"health"');
  });

  it('a NAMED sensitive persona is silently refused inside the run', async () => {
    const { provider, allMessages } = vaultScriptedProvider([
      { content: '', toolCalls: [{ id: 't1', name: 'vault_search', arguments: { query: 'HbA1c', persona: 'health' } }] },
      { content: JSON.stringify(VALID_AVAILABILITY) },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run(SALON_ARGS);
    const toolFeedback = allMessages
      .flat()
      .filter((m) => m.startsWith('tool:'))
      .join('\n');
    expect(toolFeedback).toContain('"accessible":false');
    expect(toolFeedback).not.toContain('clinic note');
  });
});

describe('Tier 1 vault scope — per-listing persona pin (narrowing only)', () => {
  beforeEach(() => {
    clearVaults(['general', 'work', 'health']);
    resetPersonaState();
    resetReasoningProvider();
    createPersona('general', 'default');
    createPersona('work', 'standard');
    createPersona('health', 'sensitive');
    setAccessiblePersonas(['general', 'work', 'health']);
    storeItem('general', {
      type: 'user_memory',
      summary: 'misc personal fact about ferrets',
      body: 'misc personal fact about ferrets',
    });
    storeItem('work', {
      type: 'user_memory',
      summary: 'salon slots 4:30 PM and 5:15 PM',
      body: 'salon slots 4:30 PM and 5:15 PM',
    });
  });

  it('a pinned listing reads ONLY its designated persona', async () => {
    const { provider, allMessages } = vaultScriptedProvider([
      { content: '', toolCalls: [{ id: 't1', name: 'vault_search', arguments: { query: 'salon ferrets' } }] },
      { content: JSON.stringify(VALID_AVAILABILITY) },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run({ ...SALON_ARGS, allowedPersonas: ['work'] });
    const toolFeedback = allMessages
      .flat()
      .filter((m) => m.startsWith('tool:'))
      .join('\n');
    expect(toolFeedback).toContain('salon slots');
    // The general persona is IN the tier scope but OUT of the pin. (The
    // CONTENT marker, not the query echo, is the leak signal.)
    expect(toolFeedback).not.toContain('misc personal fact');
    expect(toolFeedback).not.toContain('"persona":"general"');
    expect(toolFeedback).toContain('"personas_searched":["work"]');
  });

  it('pinning a SENSITIVE persona yields an empty scope — never access', async () => {
    storeItem('health', {
      type: 'user_memory',
      summary: 'HbA1c clinic note',
      body: 'HbA1c clinic note',
    });
    const { provider, allMessages } = vaultScriptedProvider([
      { content: '', toolCalls: [{ id: 't1', name: 'vault_search', arguments: { query: 'clinic' } }] },
      { content: JSON.stringify(VALID_AVAILABILITY) },
    ]);
    const runtime = buildCapabilityRuntime({ getLLM: () => provider, nowMsFn: () => NOW });
    await runtime.run({ ...SALON_ARGS, allowedPersonas: ['health'] });
    const toolFeedback = allMessages
      .flat()
      .filter((m) => m.startsWith('tool:'))
      .join('\n');
    // Intersection with the tier scope is EMPTY: nothing searched,
    // nothing leaked.
    expect(toolFeedback).toContain('"personas_searched":[]');
    expect(toolFeedback).not.toContain('clinic note');
  });
});
