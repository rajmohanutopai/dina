/**
 * LLM provider construction for the Node Brain server.
 *
 * Greenfield policy: no implicit cloud provider. Operators must
 * explicitly select a provider and provide its key in config; invalid
 * config fails during `loadConfig`.
 */

import { createOpenAI } from '@ai-sdk/openai';

import {
  buildScriptedProvider,
  createGeminiEmbeddingProvider,
  GeminiGenaiAdapter,
  type EmbeddingProvider,
  type LLMProvider,
  type ProviderName,
} from '@dina/brain';
import { AISDKAdapter, getProviderTiers } from '@dina/brain/llm';

import { buildDeterministicEmbedder, loadScriptedRules } from './scripted_llm';

import type { BrainServerConfig } from './config';

/** OpenRouter is OpenAI-compatible; reuse the OpenAI SDK with this baseURL. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
    case 'openai': {
      // Mirrors the mobile `createLLMProvider` 'openai' branch: AI-SDK
      // model wrapped in `AISDKAdapter`; the adapter auto-detects the
      // cheapest accepted `reasoning.effort` per model id. No embedding
      // pair — semantic search falls back to FTS5 + query expansion.
      const openai = createOpenAI({ apiKey: config.apiKey });
      const model = config.model ?? getProviderTiers('openai').primary;
      return {
        providerName: 'openai',
        llm: new AISDKAdapter({
          model: openai(model),
          name: 'openai',
          ...(config.reasoningEffort !== undefined
            ? { openaiReasoningEffort: config.reasoningEffort }
            : {}),
        }),
      };
    }
    case 'openrouter': {
      // `.chat(...)` matters: OpenRouter does not serve `/v1/responses`,
      // and the default `openai(...)` form would route there.
      const openrouter = createOpenAI({ apiKey: config.apiKey, baseURL: OPENROUTER_BASE_URL });
      const model = config.model ?? getProviderTiers('openrouter').primary;
      return {
        providerName: 'openrouter',
        llm: new AISDKAdapter({ model: openrouter.chat(model), name: 'openrouter' }),
      };
    }
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
