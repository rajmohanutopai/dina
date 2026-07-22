/**
 * LLM provider construction for the Node Brain server.
 *
 * Greenfield policy: no implicit cloud provider. Operators must
 * explicitly select a provider and provide its key in config; invalid
 * config fails during `loadConfig`.
 */

import {
  buildScriptedProvider,
  createGeminiEmbeddingProvider,
  GeminiGenaiAdapter,
  type EmbeddingProvider,
  type LLMProvider,
  type ProviderName,
} from '@dina/brain';

import { buildDeterministicEmbedder, loadScriptedRules } from './scripted_llm';

import type { BrainServerConfig } from './config';

export interface BrainServerLLMRuntime {
  llm: LLMProvider;
  providerName: ProviderName;
  /** Embedding provider matched to the chat provider's credentials.
   *  Forwarded to `buildHomeNodeAskRuntime` for shared registration. */
  embedding?: { name: string; generate: EmbeddingProvider };
}

export function buildBrainServerLLMRuntime(
  config: BrainServerConfig['llm'],
): BrainServerLLMRuntime | undefined {
  switch (config.provider) {
    case 'none':
      return undefined;
    case 'gemini':
      return {
        providerName: 'gemini',
        llm: new GeminiGenaiAdapter({
          apiKey: config.apiKey,
          ...(config.model !== undefined ? { defaultModel: config.model } : {}),
        }),
        embedding: {
          name: 'gemini-embedding-001',
          generate: createGeminiEmbeddingProvider({ apiKey: config.apiKey }),
        },
      };
    case 'scripted':
      // Deterministic canned-response provider (E2E/dev). Paired with a
      // deterministic embedder so semantic search is reproducible + offline.
      return {
        providerName: 'scripted',
        llm: buildScriptedProvider({ rules: loadScriptedRules(config.scriptFile) }),
        embedding: {
          name: 'scripted-deterministic',
          generate: buildDeterministicEmbedder(),
        },
      };
  }
}
