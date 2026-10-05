/**
 * A minimal input for `buildAgenticAskPipeline`, for tests that check which
 * tools an ask gets: a model that says nothing, an AppView and a Core that
 * answer empty. Tests pass the host clients they are about (`a2aClient`,
 * `ucpClient`, …) through `over`.
 */

import type { buildAgenticAskPipeline } from '../../src/composition/agentic_ask';
import type { ChatResponse, LLMProvider } from '../../src/llm/adapters/provider';
import type { WorkflowTask } from '@dina/core';

export type BuilderInput = Parameters<typeof buildAgenticAskPipeline>[0];

export function builderInput(over: Partial<BuilderInput> = {}): BuilderInput {
  const llm: LLMProvider = {
    name: 'fake',
    supportsStreaming: false,
    supportsToolCalling: true,
    supportsEmbedding: false,
    chat: async (): Promise<ChatResponse> => ({
      content: '',
      toolCalls: [],
      model: 'fake',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'end',
    }),
    stream: () => {
      throw new Error('not used');
    },
    embed: async () => {
      throw new Error('not used');
    },
  };
  const appViewClient = {
    searchServices: async () => [],
    searchCapabilities: async () => [],
    isDiscoverable: async () => ({ isDiscoverable: false, capabilities: [] }),
    searchCatalog: async () => [],
    getProfile: async () => null,
    resolveTrust: async () => ({}) as never,
    searchTrust: async () => ({}) as never,
  } as unknown as BuilderInput['appViewClient'];
  const coreClient = {
    findContactsByPreference: async () => [],
    contactLookup: async () => null,
    listPluginToolCapabilities: async () => [],
    invokePluginTool: async () => ({
      ok: false as const,
      code: 'install_unknown',
      message: 'none',
    }),
    listContacts: async () => [],
    openGroupPlan: async () => ({ ok: false as const, refusal: 'not_wired', detail: 'none' }),
    getGroupPlan: async () => null,
    listGroupPlanHandles: async () => [],
    createWorkflowTask: async () => ({ task: {} as WorkflowTask, deduped: false }),
    getWorkflowTask: async () => null,
    completeWorkflowTask: async () => ({}) as WorkflowTask,
  } as unknown as BuilderInput['coreClient'];
  return {
    llm,
    providerName: 'gemini',
    appViewClient,
    orchestratorHandle: {
      issueQueryToDID: async () => ({
        queryId: 'q',
        taskId: 't',
        toDID: 'did:plc:x',
        serviceName: 'x',
        deduped: false,
      }),
    },
    coreClient,
    ...over,
  };
}
