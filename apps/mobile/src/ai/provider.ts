/**
 * AI Provider Service — BYOK model instantiation.
 *
 * Creates AI SDK provider instances from user-supplied API keys
 * stored in react-native-keychain. No shared platform keys.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import * as Keychain from 'react-native-keychain';

import { AISDKAdapter } from '@dina/brain/src/llm/adapters/aisdk';
import { GeminiGenaiAdapter } from '@dina/brain/src/llm/adapters/gemini_genai';
import type { LLMProvider } from '@dina/brain/src/llm/adapters/provider';
import { getProviderTiers } from '@dina/brain/src/llm/provider_config';

export type ProviderType = 'openai' | 'gemini';

/**
 * Model tier for a given provider — primary (default for chat / agentic
 * /ask), lite (cheap classification calls: compose-context, intent,
 * guard-scan), heavy (multi-step reasoning). Tier values are sourced
 * from `@dina/brain`'s `getProviderTiers`, which mirrors home-node
 * `models.json` (single source of truth across stacks). Callers that
 * just want chat semantics can omit `tier` — defaults to 'primary'.
 */
export type LLMTier = 'primary' | 'lite' | 'heavy';

export interface ProviderInfo {
  type: ProviderType;
  label: string;
  description: string;
  keyPrefix: string;
}

export const PROVIDERS: Record<ProviderType, ProviderInfo> = {
  openai: {
    type: 'openai',
    label: 'OpenAI',
    description: 'GPT-5.4, GPT-5 mini',
    keyPrefix: 'sk-',
  },
  gemini: {
    type: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini 3.1 Pro',
    keyPrefix: 'AIza',
  },
};

export interface CreateProviderOptions {
  /** Tier to pick from `getProviderTiers(provider)`. Defaults to 'primary'. */
  readonly tier?: LLMTier;
  /**
   * Explicit model id override. Wins over `tier` when set — preserves
   * the Settings-side per-user model preference path. Undefined falls
   * back to the tier lookup.
   */
  readonly modelId?: string;
}

/**
 * Resolve the model id for a provider call. Explicit `modelId` wins;
 * otherwise look up `getProviderTiers(provider)[tier]`. Centralises the
 * tier→model mapping so `createModel` and `createLLMProvider` stay in
 * sync and the rest of the app never hardcodes a model string.
 */
function resolveModelId(provider: ProviderType, opts: CreateProviderOptions): string {
  if (typeof opts.modelId === 'string' && opts.modelId.length > 0) {
    return opts.modelId;
  }
  const tier = opts.tier ?? 'primary';
  return getProviderTiers(provider)[tier];
}

const KEYCHAIN_SERVICE_PREFIX = 'dina.llm.';

/** Store an API key securely. */
export async function saveApiKey(provider: ProviderType, key: string): Promise<void> {
  await Keychain.setGenericPassword(provider, key, {
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
  });
}

/**
 * Dev-only bundle-time API-key fallback.
 *
 * The mobile app stores production keys in the iOS Keychain via the
 * Settings UI — that's still the primary path. But on a fresh dev
 * build (simulator erased / test rig / CI) the keychain is empty and
 * `getApiKey` would return `null`, which makes `tryBuildAgenticAsk`
 * bail → `/ask` falls back to single-shot mode → canned "no memories"
 * response. For dev loops that's painful, so we accept a bundle-time
 * env-var fallback keyed under `EXPO_PUBLIC_DINA_DEV_<PROVIDER>_API_KEY`
 * — same `EXPO_PUBLIC_DINA_DEV_*` autopilot shape as the passphrase +
 * owner overrides in `components/onboarding/onboarding_flow.tsx`.
 *
 * Production builds must NOT ship a real key in the JS bundle (it
 * would be extractable). `.env` is gitignored + only loaded by Expo
 * at bundle time when present.
 */
const DEV_API_KEYS: Record<ProviderType, string> = {
  openai: process.env.EXPO_PUBLIC_DINA_DEV_OPENAI_API_KEY ?? '',
  gemini: process.env.EXPO_PUBLIC_DINA_DEV_GEMINI_API_KEY ?? '',
};

/** Retrieve a stored API key. Returns null if not set.
 *  Priority: iOS Keychain → bundle-time dev-env fallback → null. */
export async function getApiKey(provider: ProviderType): Promise<string | null> {
  const result = await Keychain.getGenericPassword({
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
  });
  if (result && result.password) {
    return result.password;
  }
  const devKey = DEV_API_KEYS[provider];
  if (devKey) return devKey;
  return null;
}

/** Remove a stored API key. */
export async function removeApiKey(provider: ProviderType): Promise<void> {
  await Keychain.resetGenericPassword({
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
  });
}

/** Check which providers have keys configured. */
export async function getConfiguredProviders(): Promise<ProviderType[]> {
  const configured: ProviderType[] = [];
  for (const type of Object.keys(PROVIDERS) as ProviderType[]) {
    const key = await getApiKey(type);
    if (key) configured.push(type);
  }
  return configured;
}

/** Mask an API key for display: "sk-...abc123" */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** Validate key format (basic prefix check). */
export function validateKeyFormat(provider: ProviderType, key: string): string | null {
  const info = PROVIDERS[provider];
  if (!key.trim()) return 'API key is required';
  if (!key.startsWith(info.keyPrefix)) {
    return `${info.label} keys should start with "${info.keyPrefix}"`;
  }
  if (key.length < 10) return 'Key seems too short';
  return null; // valid
}

/** Create an AI SDK `LanguageModel` from stored key. Returns null if no key.
 *
 *  Single-shot callers only — `chat.ts::getModel` and
 *  `brain_wiring.ts::wireBrainChatProvider` use this for the
 *  non-agentic `reason()` pipeline where `generateText` is called once
 *  and the result is returned straight to the user. That path has no
 *  tool-use round-trip, so the `thoughtSignature` bug that forced the
 *  agentic `/ask` branch onto `@google/genai` does NOT apply here;
 *  Gemini stays on the AI SDK model for this surface.
 *
 *  For multi-turn tool-use, use `createLLMProvider` instead. */
export async function createModel(
  provider: ProviderType,
  opts: CreateProviderOptions = {},
): Promise<LanguageModel | null> {
  const apiKey = await getApiKey(provider);
  if (!apiKey) return null;

  const model = resolveModelId(provider, opts);

  switch (provider) {
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    case 'gemini': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model);
    }
  }
}

/**
 * Create a Brain-facing `LLMProvider` for the selected BYOK provider.
 *
 * This is the entry point the agentic `/ask` path uses — it hides the
 * per-provider SDK choice behind `LLMProvider`, the same interface
 * `runAgenticTurn` expects:
 *
 *   - `openai` → AI-SDK `LanguageModel` wrapped in `AISDKAdapter`.
 *     AI SDK's tool-call normalization earns its keep here; OpenAI
 *     tool round-trip is stateless so the adapter has no metadata to
 *     thread.
 *   - `gemini` → `GeminiGenaiAdapter` over `@google/genai`. The AI SDK
 *     path would work for 2.5-flash and earlier non-thinking models
 *     but drops `thoughtSignature` on 3.x thinking models, so every
 *     Gemini branch now goes through the native SDK for correctness
 *     parity across model variants.
 *
 * Returns `null` when the provider has no configured key — the caller
 * then reports "no provider" / falls back to single-shot `reason()`.
 */
export async function createLLMProvider(
  provider: ProviderType,
  opts: CreateProviderOptions = {},
): Promise<LLMProvider | null> {
  const apiKey = await getApiKey(provider);
  if (!apiKey) return null;

  const model = resolveModelId(provider, opts);

  switch (provider) {
    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return new AISDKAdapter({ model: openai(model), name: 'openai' });
    }
    case 'gemini': {
      return new GeminiGenaiAdapter({ apiKey, defaultModel: model });
    }
  }
}
