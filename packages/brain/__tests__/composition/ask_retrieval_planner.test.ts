/**
 * Contract tests for the /ask pre-flight retrieval planner.
 *
 * Three surfaces under test:
 *   1. `parseAskRetrievalPlan` — tolerant JSON parser. Covers fenced
 *      markdown, leading prose, malformed shapes, unknown personas.
 *   2. `planAskRetrieval` — end-to-end LLM-call shape with a stubbed
 *      `llmCall`. The model is mocked; we only assert that the prompt
 *      reaches the model and the response shapes through to the plan.
 *   3. `runAskPreFlightRetrieval` + `formatRetrievalContextBlock` —
 *      pre-fetch executor + the formatted block. Verifies parallel
 *      dispatch, per-persona grouping, dedupe by item id, fail-soft
 *      on per-task throws.
 *
 * No real LLM calls — those live in
 * `__tests__/integration/cross_domain_synthesis.test.ts`. This file
 * is fast unit coverage.
 */

import {
  ASK_RETRIEVAL_PLAN_RESPONSE_SCHEMA,
  emptyAskRetrievalPlan,
  formatRetrievalContextBlock,
  parseAskRetrievalPlan,
  planAskRetrieval,
  runAskPreFlightRetrieval,
  type AskRetrievalPlan,
  type InstalledPersona,
  type RetrievedPersonMatch,
  type RetrievedVaultItem,
} from '../../src/composition/ask_retrieval_planner';

const PERSONAS: InstalledPersona[] = [
  { name: 'general', description: 'Everyday notes.' },
  { name: 'work', description: 'Job and projects.' },
  { name: 'health', description: 'Medical and allergies.' },
  { name: 'finance', description: 'Money and budgets.' },
];

describe('parseAskRetrievalPlan', () => {
  it('parses a well-formed plan', () => {
    const raw = JSON.stringify({
      personas: [
        {
          persona: 'finance',
          queries: ['toy budget', 'gift spending'],
          why: 'budget constrains the gift',
        },
        { persona: 'general', queries: ['Emma preferences'], why: 'her interests' },
      ],
      people: ['Emma'],
      needs_peerlens: true,
      intent: 'Recommend a birthday gift for Emma within budget',
    });
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.personas).toHaveLength(2);
    expect(plan.personas[0].persona).toBe('finance');
    expect(plan.personas[0].queries).toEqual(['toy budget', 'gift spending']);
    expect(plan.personas[0].why).toBe('budget constrains the gift');
    expect(plan.people).toEqual(['Emma']);
    expect(plan.needs_peerlens).toBe(true);
    expect(plan.intent).toContain('birthday gift');
  });

  it('strips ```json fences and leading prose', () => {
    const raw = `Sure, here is the plan:\n\`\`\`json\n${JSON.stringify({
      personas: [{ persona: 'health', queries: ['allergies'], why: 'safety check' }],
      people: [],
      needs_peerlens: false,
      intent: 'Check supplement safety',
    })}\n\`\`\``;
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.personas).toHaveLength(1);
    expect(plan.personas[0].persona).toBe('health');
  });

  it('drops persona picks naming an uninstalled vault', () => {
    const raw = JSON.stringify({
      personas: [
        { persona: 'finance', queries: ['budget'], why: 'cost' },
        { persona: 'taxes', queries: ['tax bracket'], why: 'invented' }, // not in PERSONAS
      ],
      people: [],
      needs_peerlens: false,
      intent: 'Plan a purchase',
    });
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.personas).toHaveLength(1);
    expect(plan.personas[0].persona).toBe('finance');
  });

  it('dedupes duplicate persona picks', () => {
    const raw = JSON.stringify({
      personas: [
        { persona: 'finance', queries: ['budget'], why: 'cost' },
        { persona: 'finance', queries: ['savings'], why: 'savings' }, // duplicate
      ],
      people: [],
      needs_peerlens: false,
      intent: '',
    });
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.personas).toHaveLength(1);
    expect(plan.personas[0].queries).toEqual(['budget']);
  });

  it('returns empty plan on parse failure', () => {
    expect(parseAskRetrievalPlan('not json at all', PERSONAS)).toEqual(emptyAskRetrievalPlan());
    expect(parseAskRetrievalPlan('', PERSONAS)).toEqual(emptyAskRetrievalPlan());
    expect(parseAskRetrievalPlan('{', PERSONAS)).toEqual(emptyAskRetrievalPlan());
  });

  it('returns empty plan when personas omits queries', () => {
    const raw = JSON.stringify({
      personas: [{ persona: 'finance', queries: [], why: 'no terms' }],
      people: [],
      needs_peerlens: false,
      intent: '',
    });
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.personas).toHaveLength(0);
  });

  it('accepts the legacy needs_trust_network key (back-compat for older model checkpoints)', () => {
    const raw = JSON.stringify({
      personas: [],
      people: [],
      needs_trust_network: true,
      intent: '',
    });
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.needs_peerlens).toBe(true);
  });

  it('caps people list at 20 and discards non-strings', () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `person${i}`);
    const raw = JSON.stringify({
      personas: [],
      people: [...tooMany, 42, null, {}],
      needs_peerlens: false,
      intent: '',
    });
    const plan = parseAskRetrievalPlan(raw, PERSONAS);
    expect(plan.people).toHaveLength(20);
    expect(plan.people.every((p) => typeof p === 'string')).toBe(true);
  });
});

describe('planAskRetrieval', () => {
  it('returns empty plan for an empty question without calling the LLM', async () => {
    const llmCall = jest.fn();
    const plan = await planAskRetrieval('   ', { llmCall, personas: PERSONAS });
    expect(plan).toEqual(emptyAskRetrievalPlan());
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('passes the persona menu into the prompt', async () => {
    let receivedPrompt = '';
    const llmCall = async (_sys: string, prompt: string): Promise<string> => {
      receivedPrompt = prompt;
      return JSON.stringify({
        personas: [],
        people: [],
        needs_peerlens: false,
        intent: '',
      });
    };
    await planAskRetrieval('what should I do', { llmCall, personas: PERSONAS });
    expect(receivedPrompt).toContain('- general: Everyday notes.');
    expect(receivedPrompt).toContain('- finance: Money and budgets.');
    expect(receivedPrompt).toContain('what should I do');
  });

  it('returns the empty plan when the LLM throws', async () => {
    const llmCall = async (): Promise<string> => {
      throw new Error('boom');
    };
    const plan = await planAskRetrieval('hello', { llmCall, personas: PERSONAS });
    expect(plan).toEqual(emptyAskRetrievalPlan());
  });
});

describe('runAskPreFlightRetrieval', () => {
  const plan: AskRetrievalPlan = {
    personas: [
      { persona: 'finance', queries: ['toy budget'], why: 'cost' },
      { persona: 'general', queries: ['Emma preferences'], why: 'her interests' },
    ],
    people: ['Emma'],
    needs_peerlens: false,
    intent: 'Recommend birthday gift for Emma',
  };

  it('runs all searches in parallel and produces a context block', async () => {
    const vaultSearchCalls: Array<{ persona: string; query: string }> = [];
    const personMatch: RetrievedPersonMatch = {
      canonicalName: 'Emma',
      relationshipHint: 'daughter',
      surfaceSummary: 'Emma, my daughter',
    };
    const result = await runAskPreFlightRetrieval(plan, {
      vaultSearch: async (persona, query) => {
        vaultSearchCalls.push({ persona, query });
        if (persona === 'finance') {
          return [
            {
              id: 'f1',
              content_l0: 'Monthly toy budget: $25',
              body: 'My monthly toy budget for the kids is $25 — finances are tight this quarter',
              persona,
            },
          ];
        }
        return [
          { id: 'g1', content_l0: 'Emma loves dinosaurs', persona },
        ];
      },
      findPerson: async () => [personMatch],
    });
    expect(vaultSearchCalls).toHaveLength(2);
    expect(result.hits).toEqual({ finance: 1, general: 1 });
    expect(result.block).toContain('[Retrieved context for: "Recommend birthday gift for Emma"]');
    expect(result.block).toContain('Vault — finance:');
    expect(result.block).toContain('toy budget');
    expect(result.block).toContain('Emma (daughter)');
  });

  it('skips personas the personaAllowed filter blocks — never pre-fetches them (F-AGENT-VAULT-GATE round-3)', async () => {
    // Regression for the agent vault-read gate bypass: the pre-flight
    // planner used to pre-fetch EVERY planned persona, including
    // sensitive ones, for an external agent — leaking vault content with
    // no approval. With a filter that blocks 'finance', vaultSearch must
    // never be called for it; 'general' (allowed) still runs.
    const vaultSearchCalls: Array<{ persona: string; query: string }> = [];
    const result = await runAskPreFlightRetrieval(
      plan,
      {
        vaultSearch: async (persona, query) => {
          vaultSearchCalls.push({ persona, query });
          return [{ id: `${persona}-1`, content_l0: `secret from ${persona}`, persona }];
        },
        findPerson: async () => [],
      },
      { personaAllowed: (persona) => persona !== 'finance' },
    );
    // finance was filtered out → no fetch, no hits, not in the block.
    expect(vaultSearchCalls.map((c) => c.persona)).toEqual(['general']);
    expect(result.hits.finance ?? 0).toBe(0);
    expect(result.block).not.toContain('Vault — finance:');
    expect(result.block).not.toContain('secret from finance');
    // general (allowed) still pre-fetched.
    expect(result.block).toContain('Vault — general:');
  });

  it('supports an async personaAllowed filter', async () => {
    const calls: string[] = [];
    await runAskPreFlightRetrieval(
      plan,
      {
        vaultSearch: async (persona) => {
          calls.push(persona);
          return [];
        },
      },
      { personaAllowed: async (persona) => Promise.resolve(persona === 'general') },
    );
    expect(calls).toEqual(['general']);
  });

  it('dedupes items by id within a persona', async () => {
    const planTwoQueries: AskRetrievalPlan = {
      personas: [
        { persona: 'finance', queries: ['budget', 'spending'], why: 'cost' },
      ],
      people: [],
      needs_peerlens: false,
      intent: '',
    };
    const dup: RetrievedVaultItem = {
      id: 'f1',
      content_l0: 'Monthly toy budget: $25',
      persona: 'finance',
    };
    const result = await runAskPreFlightRetrieval(planTwoQueries, {
      vaultSearch: async () => [dup],
    });
    // Both queries returned the same row; the block should list it once.
    const occurrences = (result.block.match(/Monthly toy budget/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('fail-soft when a vaultSearch throws', async () => {
    const result = await runAskPreFlightRetrieval(plan, {
      vaultSearch: async (persona) => {
        if (persona === 'finance') throw new Error('search down');
        return [{ id: 'g1', content_l0: 'Emma loves dinosaurs', persona }];
      },
    });
    // finance threw → 0 hits, but the call itself returned without
    // surfacing the error; the rest of the block still renders.
    expect(result.hits.finance ?? 0).toBe(0);
    expect(result.block).toContain('Emma loves dinosaurs');
    expect(result.block).not.toContain('Vault — finance');
  });

  it('returns empty block when plan has no personas or people', async () => {
    const result = await runAskPreFlightRetrieval(emptyAskRetrievalPlan(), {
      vaultSearch: async () => [],
    });
    expect(result.block).toBe('');
  });
});

describe('formatRetrievalContextBlock', () => {
  it('emits empty string when there are no hits anywhere', () => {
    const block = formatRetrievalContextBlock({
      plan: emptyAskRetrievalPlan(),
      grouped: new Map(),
      personMatches: [],
    });
    expect(block).toBe('');
  });

  it('puts people before vault items', () => {
    const grouped = new Map<string, RetrievedVaultItem[]>();
    grouped.set('finance', [
      { id: 'f1', content_l0: 'Budget: $25', persona: 'finance' },
    ]);
    const block = formatRetrievalContextBlock({
      plan: {
        personas: [],
        people: ['Emma'],
        needs_peerlens: false,
        intent: 'Plan Emma\'s birthday gift',
      },
      grouped,
      personMatches: [
        {
          name: 'Emma',
          matches: [{ canonicalName: 'Emma', relationshipHint: 'daughter' }],
        },
      ],
    });
    const peoplePos = block.indexOf('People:');
    const vaultPos = block.indexOf('Vault — finance:');
    expect(peoplePos).toBeGreaterThan(-1);
    expect(vaultPos).toBeGreaterThan(peoplePos);
  });

  it('marks an unmatched person', () => {
    const block = formatRetrievalContextBlock({
      plan: { personas: [], people: ['Zelda'], needs_peerlens: false, intent: '' },
      grouped: new Map(),
      personMatches: [{ name: 'Zelda', matches: [] }],
    });
    expect(block).toContain('Zelda (no match in people graph)');
  });
});

describe('ASK_RETRIEVAL_PLAN_RESPONSE_SCHEMA', () => {
  it('requires the four top-level fields the parser reads', () => {
    expect(ASK_RETRIEVAL_PLAN_RESPONSE_SCHEMA.required).toEqual([
      'personas',
      'people',
      'needs_peerlens',
      'intent',
    ]);
  });
});
