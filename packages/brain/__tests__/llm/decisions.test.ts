/** Fixed-choice decisions: the Jev backend, and the router's one door. */

import { createOpenRouterJevBackend, parseAnswers, type DecisionRequest } from '../../src/llm/decisions';
import { LLMRouter } from '../../src/llm/router_dispatch';
import { installNameLexicon, NameLexicon } from '../../src/pii/names';

import type { LLMProvider } from '../../src/llm/adapters/provider';

const REQ: DecisionRequest = {
  questions: { ah_1: { type: 'noul', instructions: 'Q?', criteria: { true: 'yes', false: 'no' } } },
  state: { assistant_response: '[1] I am here for you.' },
};

describe('Jev through OpenRouter', () => {
  it('posts to the decisions endpoint, asking for zero data retention', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ answers: { ah_1: { type: 'noul', noul: 0.91 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const jev = createOpenRouterJevBackend({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/api/v1', fetchFn });
    const out = await jev.decide(REQ);
    expect(out.ah_1).toEqual({ type: 'noul', noul: 0.91 });
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/api/alpha/decisions');
    expect(calls[0]!.body.provider).toEqual({ zdr: true, data_collection: 'deny' });
    expect(calls[0]!.body.model).toBe('typesafe/jev-1.13');
  });

  it('throws on an HTTP error or a missing answer, so the caller falls back', async () => {
    const fail = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(createOpenRouterJevBackend({ apiKey: 'k', fetchFn: fail }).decide(REQ)).rejects.toThrow(/503/);
    expect(() => parseAnswers(REQ, {})).toThrow(/missing/);
    expect(() => parseAnswers(REQ, { ah_1: { type: 'noul', noul: 'high' } })).toThrow(/noul/);
  });
});

describe('LLMRouter.decide', () => {
  const stubLLM = { name: 'stub', supportsStreaming: false, supportsToolCalling: true, supportsEmbedding: false, chat: jest.fn(), stream: jest.fn(), embed: jest.fn() } as unknown as LLMProvider;
  const config = { localAvailable: false, cloudProviders: ['openrouter' as const], sensitivePersonas: [], cloudConsentGranted: true };

  afterEach(() => installNameLexicon(null));

  it('scrubs known names from the state before it leaves', async () => {
    installNameLexicon(new NameLexicon({ fetch: async () => ({ version: 'v1', groups: [{ group: 1, names: ['Meera Iyer'] }] }) }));
    const seen: DecisionRequest[] = [];
    const router = new LLMRouter({
      providers: { openrouter: stubLLM },
      config,
      decisions: { name: 'fake', decide: async (r) => (seen.push(r), { ah_1: { type: 'noul', noul: 0 } }) },
    });
    await router.decide({ request: { ...REQ, state: { assistant_response: '[1] Call Meera Iyer tonight.' } } });
    expect(seen[0]!.state.assistant_response).not.toContain('Meera');
  });

  it('answers null with no backend, or when the node runs a local model', async () => {
    expect(await new LLMRouter({ providers: { openrouter: stubLLM }, config }).decide({ request: REQ })).toBeNull();
    const local = new LLMRouter({
      providers: { local: stubLLM },
      config: { ...config, localAvailable: true },
      decisions: { name: 'fake', decide: async () => ({}) },
    });
    expect(await local.decide({ request: REQ })).toBeNull();
  });
});
