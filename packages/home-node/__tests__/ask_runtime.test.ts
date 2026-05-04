import type { AppViewClient, LLMProvider } from '@dina/brain';
import type { CoreClient } from '@dina/core';

import { buildHomeNodeAskRuntime } from '../ask-runtime';

describe('@dina/home-node/ask-runtime', () => {
  it('builds the shared Pattern A ask coordinator from injected Core, AppView, and LLM handles', async () => {
    const provider = scriptedProvider('shared ask runtime answered');
    const runtime = buildHomeNodeAskRuntime({
      core: stubCore(),
      appView: stubAppView(),
      llm: provider,
      providerName: 'gemini',
    });

    const result = await runtime.coordinator.handleAsk({
      question: 'does the shared ask runtime compose?',
      requesterDid: 'did:plc:requester',
      requestIdHeader: 'ask-shared-test',
    });

    expect(result).toMatchObject({
      kind: 'fast_path',
      status: 200,
      body: {
        status: 'complete',
        answer: { text: 'shared ask runtime answered' },
      },
    });
    expect(result.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(runtime.orchestrator).toBeDefined();
    expect(runtime.approvalManager).toBeDefined();
  });

  it('fails fast when required runtime dependencies are omitted', () => {
    const base = {
      core: stubCore(),
      appView: stubAppView(),
      llm: scriptedProvider('unused'),
      providerName: 'gemini' as const,
    };

    expect(() => buildHomeNodeAskRuntime({ ...base, core: undefined as never }))
      .toThrow(/core is required/);
    expect(() => buildHomeNodeAskRuntime({ ...base, appView: undefined as never }))
      .toThrow(/appView is required/);
    expect(() => buildHomeNodeAskRuntime({ ...base, llm: undefined as never }))
      .toThrow(/llm is required/);
    expect(() => buildHomeNodeAskRuntime({ ...base, providerName: undefined as never }))
      .toThrow(/providerName is required/);
  });
});

function scriptedProvider(answer: string): LLMProvider {
  return {
    name: 'scripted',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    chat: jest.fn(async () => ({
      content: answer,
      toolCalls: [],
      model: 'scripted',
      usage: { inputTokens: 3, outputTokens: 4 },
      finishReason: 'end' as const,
    })),
    stream: () => {
      throw new Error('not used');
    },
    embed: async () => {
      throw new Error('not used');
    },
  };
}

function stubAppView(): AppViewClient {
  return {
    searchServices: jest.fn(async () => []),
    isDiscoverable: jest.fn(async () => false),
    resolveTrust: jest.fn(async () => ({ profiles: [] })),
    searchTrust: jest.fn(async () => []),
  } as unknown as AppViewClient;
}

function stubCore(): CoreClient {
  return {
    findContactsByPreference: jest.fn(async () => []),
    sendServiceQuery: jest.fn(async () => ({
      taskId: 'task-1',
      queryId: 'q-1',
      deduped: false,
    })),
  } as unknown as CoreClient;
}
