/**
 * AI Provider Service — BYOK model instantiation.
 *
 * Creates AI SDK provider instances from user-supplied API keys
 * stored in react-native-keychain. No shared platform keys.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

import {
  AISDKAdapter,
  GeminiGenaiAdapter,
  getProviderTiers,
  type LLMProvider,
} from '@dina/brain/llm';

import * as Keychain from '../services/keychain';

import { getGrantCredential } from './credits';
import { peekModelOverride } from './model_overrides';

import type { LanguageModel } from 'ai';

export type ProviderType = 'openai' | 'gemini' | 'claude' | 'openrouter';

/** OpenRouter is OpenAI-compatible; reuse the OpenAI SDK with this baseURL. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
  /**
   * Minimum total key length for a key from this provider. Public
   * formats: OpenAI keys (`sk-...`, `sk-proj-...`, `sk-svc-...`) are
   * 40+ characters; Google Gemini keys are exactly 39. The previous
   * validator only required `>= 10` chars which let through obvious
   * typos like `sk-test-1234` and silently activated them.
   */
  minKeyLength: number;
}

export const PROVIDERS: Record<ProviderType, ProviderInfo> = {
  openai: {
    type: 'openai',
    label: 'OpenAI',
    description: 'GPT-5.5, GPT-5.6 Luna',
    keyPrefix: 'sk-',
    minKeyLength: 40,
  },
  gemini: {
    type: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini 3.5 Flash, 3.1 Flash Lite',
    keyPrefix: 'AIza',
    minKeyLength: 39,
  },
  claude: {
    type: 'claude',
    label: 'Anthropic Claude',
    description: 'Claude Opus 4.7, Sonnet 4.6, Haiku 4.5',
    keyPrefix: 'sk-ant-',
    minKeyLength: 40,
  },
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    description: 'Routes to any model across providers',
    keyPrefix: 'sk-or-',
    minKeyLength: 40,
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
 * Resolve the model id for a provider call. Precedence:
 *   1. Explicit `modelId` (caller pin — used by Settings probe).
 *   2. User override from `model_overrides` (picker selection).
 *   3. Tier default from `getProviderTiers(provider)[tier]`.
 *
 * Centralises the tier → model mapping so `createModel` and
 * `createLLMProvider` stay in sync and the rest of the app never
 * hardcodes a model string.
 *
 * Returns the PSEUDO-ID exactly as stored — pseudo-ids like
 * `gpt-5.5+thinking` need to flow further before being unpacked into
 * (realModel, effort). The unpacker lives in `parseOpenAIModelId`
 * below; both `createModel` and `createLLMProvider` call it.
 */
function resolveModelId(provider: ProviderType, opts: CreateProviderOptions): string {
  if (typeof opts.modelId === 'string' && opts.modelId.length > 0) {
    return opts.modelId;
  }
  const tier = opts.tier ?? 'primary';
  const override = peekModelOverride(provider, tier);
  if (override !== null) return override;
  return getProviderTiers(provider)[tier];
}

/**
 * Unpack an OpenAI pseudo-id of the form `<realModel>+thinking` (or
 * any future suffix) into (realModel, effortOverride). For ids
 * without a suffix the model id passes through unchanged and the
 * `effortOverride` is undefined — the adapter's auto-detected floor
 * (via `lowestSupportedOpenAIEffort`) then applies.
 *
 * Pseudo-ids exist because the picker needs to surface the same
 * underlying model in distinct modes (`gpt-5.5` fast vs
 * `gpt-5.5+thinking` slow). Encoding the mode in the id keeps the
 * existing `model_overrides` keychain shape — a single string per
 * tier — without us needing a separate "effort" persistence field.
 */
export function parseOpenAIModelId(pseudo: string): {
  model: string;
  effortOverride?: 'none' | 'low' | 'minimal' | 'medium' | 'high' | 'xhigh';
} {
  if (pseudo.endsWith('+thinking')) {
    return { model: pseudo.slice(0, -'+thinking'.length), effortOverride: 'high' };
  }
  return { model: pseudo };
}

const KEYCHAIN_SERVICE_PREFIX = 'dina.llm.';

// react-native-keychain rejects empty usernames/passwords on Android. Keep a
// non-secret tombstone so an explicit removal still suppresses the optional
// development fallback without relying on an invalid keychain value.
const REMOVED_API_KEY_SENTINEL = '__dina_api_key_removed__';

/** Store an API key securely. */
export async function saveApiKey(provider: ProviderType, key: string): Promise<void> {
  await Keychain.setGenericPassword(provider, key, {
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
    // P2.8: API keys are secrets — keep them device-bound (no iCloud/backup
    // migration), readable after first unlock. Matches the seed stores.
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
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
  claude: process.env.EXPO_PUBLIC_DINA_DEV_CLAUDE_API_KEY ?? '',
  openrouter: process.env.EXPO_PUBLIC_DINA_DEV_OPENROUTER_API_KEY ?? '',
};

/**
 * Retrieve a stored API key. Returns null if not set.
 *
 * Resolution precedence:
 *   1. iOS Keychain — if the user has explicitly interacted with this
 *      provider (set OR removed), the keychain has an entry. An entry
 *      with a normal password is the user's key; the removal sentinel
 *      means "explicitly removed" — return null and skip the dev-env
 *      fallback.
 *   2. Bundle-time `EXPO_PUBLIC_DINA_DEV_*` fallback — used only when
 *      the keychain has NO entry at all (fresh install on a dev
 *      simulator). The moment the user saves or removes via Settings,
 *      keychain takes over forever.
 *
 * Without rule (1), tapping Remove on a dev simulator did nothing —
 * `resetGenericPassword` cleared the entry, the next `getApiKey`
 * resolved through the dev env, and the provider tile reported
 * "configured" again. See `removeApiKey` below for the matching
 * write-side sticky-remove.
 */
export async function getApiKey(provider: ProviderType): Promise<string | null> {
  const result = await Keychain.getGenericPassword({
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
  });
  if (result !== false) {
    // Keychain has an entry — the tombstone means "explicitly removed",
    // not "fall back to dev". Don't consult DEV_API_KEYS.
    return result.password === REMOVED_API_KEY_SENTINEL ? null : result.password;
  }
  const devKey = DEV_API_KEYS[provider];
  if (devKey) return devKey;
  return null;
}

/**
 * Remove a stored API key.
 *
 * Writes a non-secret tombstone to the keychain rather than deleting
 * the entry, so a subsequent `getApiKey` sees "user explicitly
 * removed" and does NOT fall back to the `EXPO_PUBLIC_DINA_DEV_*`
 * env var. A true `resetGenericPassword` here would let the dev
 * fallback resurrect the key on the next read.
 */
export async function removeApiKey(provider: ProviderType): Promise<void> {
  await Keychain.setGenericPassword(provider, REMOVED_API_KEY_SENTINEL, {
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/** Check which providers have keys configured. */
export async function getConfiguredProviders(): Promise<ProviderType[]> {
  const configured: ProviderType[] = [];
  for (const type of Object.keys(PROVIDERS) as ProviderType[]) {
    const key = await getApiKey(type);
    if (key) configured.push(type);
  }
  // Starter Credits: a granted key makes `openrouter` usable even with
  // no BYOK key — boot's pickProvider fallback then selects it on a
  // fresh install (the spec's "default active provider = credits").
  if (!configured.includes('openrouter') && (await getGrantCredential()) !== null) {
    configured.push('openrouter');
  }
  return configured;
}

/** Mask an API key for display: "sk-...abc123" */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Validate key format. Cheap client-side check — confirms prefix and
 * provider-specific minimum length so obvious typos don't get saved
 * and silently flipped to ACTIVE. A real probe call (verifyKey) is
 * the authoritative check; this just keeps junk out of keychain.
 */
export function validateKeyFormat(provider: ProviderType, key: string): string | null {
  const info = PROVIDERS[provider];
  const trimmed = key.trim();
  if (!trimmed) return 'API key is required';
  if (!trimmed.startsWith(info.keyPrefix)) {
    return `${info.label} keys should start with "${info.keyPrefix}"`;
  }
  if (trimmed.length < info.minKeyLength) {
    return `${info.label} keys are at least ${info.minKeyLength} characters. Yours is ${trimmed.length}. Double-check you pasted the full key.`;
  }
  return null; // looks plausible
}

/**
 * Probe the provider with the given key by issuing a single low-cost
 * model-list call. Returns null when the key works, or a human-readable
 * error string when it doesn't.
 *
 * - OpenAI: GET https://api.openai.com/v1/models → 401 means bad key,
 *   200 means valid, anything else is treated as transient.
 * - Gemini: GET https://generativelanguage.googleapis.com/v1beta/models?key=KEY
 *   → 400/401/403 means bad key.
 *
 * Network failures (DNS, timeout) are reported as "couldn't reach"
 * rather than "invalid key" so users on a flaky connection don't lose
 * their working keys to a false negative.
 */
export async function verifyKey(
  provider: ProviderType,
  key: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const trimmed = key.trim();
  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${trimmed}` },
        signal,
      });
      if (res.status === 200) return null;
      if (res.status === 401 || res.status === 403) {
        return "OpenAI rejected this key. Check that it's valid and has access to the chat models.";
      }
      return `OpenAI responded HTTP ${res.status}. Try again or check OpenAI's status.`;
    }
    if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmed)}`,
        { method: 'GET', signal },
      );
      if (res.status === 200) return null;
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return 'Google Gemini rejected this key. Check the key string and that the Gemini API is enabled on your project.';
      }
      return `Google Gemini responded HTTP ${res.status}. Try again later.`;
    }
    if (provider === 'claude') {
      // Anthropic requires both x-api-key and anthropic-version on every
      // request. Their /v1/models endpoint is the cheapest probe — no
      // tokens billed, returns 401 on a bad key.
      const res = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': trimmed,
          'anthropic-version': '2023-06-01',
        },
        signal,
      });
      if (res.status === 200) return null;
      if (res.status === 401 || res.status === 403) {
        return "Anthropic rejected this key. Check that it's valid and has access to the Claude models.";
      }
      return `Anthropic responded HTTP ${res.status}. Try again or check Anthropic's status.`;
    }
    if (provider === 'openrouter') {
      // OpenRouter is OpenAI-compatible. /api/v1/models lists every
      // routable model and works as a cheap key probe.
      const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${trimmed}` },
        signal,
      });
      if (res.status === 200) return null;
      if (res.status === 401 || res.status === 403) {
        return "OpenRouter rejected this key. Check that it's valid and active.";
      }
      return `OpenRouter responded HTTP ${res.status}. Try again later.`;
    }
    return `Unknown provider: ${String(provider)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Couldn't reach ${PROVIDERS[provider].label}: ${msg}`;
  }
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
/**
 * Resolve the usable key for a provider, including the Starter Credits
 * fallback for `openrouter`: a user BYOK key ALWAYS wins; the granted
 * key applies only when no BYOK key exists. When the grant is the
 * source, the returned `grantPin` pins EVERY tier to the credits model
 * (spec: free tier pinned, picker hidden — overrides ignored).
 */
async function resolveProviderKey(
  provider: ProviderType,
): Promise<{ apiKey: string; grantPin?: string } | null> {
  const byok = await getApiKey(provider);
  if (byok) return { apiKey: byok };
  if (provider === 'openrouter') {
    const grant = await getGrantCredential();
    if (grant !== null) return { apiKey: grant.key, grantPin: grant.modelPin };
  }
  return null;
}

export async function createModel(
  provider: ProviderType,
  opts: CreateProviderOptions = {},
): Promise<LanguageModel | null> {
  const resolved = await resolveProviderKey(provider);
  if (resolved === null) return null;
  const { apiKey } = resolved;

  const pseudo = resolved.grantPin ?? resolveModelId(provider, opts);

  switch (provider) {
    case 'openai': {
      // Pseudo-ids like `gpt-5.5+thinking` are catalog-only — strip
      // the suffix before binding to the real OpenAI model. Effort
      // override (if any) is consumed by the adapter for chat calls,
      // not here (single-shot path uses tier-default effort).
      const { model } = parseOpenAIModelId(pseudo);
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    case 'gemini': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(pseudo);
    }
    case 'claude': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(pseudo);
    }
    case 'openrouter': {
      // OpenRouter speaks OpenAI's wire format — reuse the OpenAI SDK
      // with a baseURL override. Model ids are namespaced as
      // `vendor/model` (e.g. `anthropic/claude-sonnet-4-6`).
      //
      // **Use `.chat(...)`, NOT the default `(...)` call.** The plain
      // `openai('model')` form routes through `/v1/responses` (the new
      // reasoning endpoint that gpt-5+ uses); OpenRouter has no such
      // endpoint and silently hangs the connection. `.chat()` pins
      // the call to `/v1/chat/completions` which OpenRouter actually
      // serves.
      const openrouter = createOpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
      return openrouter.chat(pseudo);
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
  const resolved = await resolveProviderKey(provider);
  if (resolved === null) return null;
  const { apiKey } = resolved;

  const pseudo = resolved.grantPin ?? resolveModelId(provider, opts);

  switch (provider) {
    case 'openai': {
      // Unpack `<model>+thinking` pseudo-ids into (real model, effort
      // override). The adapter passes the override into providerOptions
      // on each chat call; the SDK then sends `reasoning.effort: 'high'`
      // for thinking-mode picks instead of the model's auto-detected
      // floor.
      const { model, effortOverride } = parseOpenAIModelId(pseudo);
      const openai = createOpenAI({ apiKey });
      return new AISDKAdapter({
        model: openai(model),
        name: 'openai',
        ...(effortOverride !== undefined ? { openaiReasoningEffort: effortOverride } : {}),
      });
    }
    case 'gemini': {
      return new GeminiGenaiAdapter({ apiKey, defaultModel: pseudo });
    }
    case 'claude': {
      const anthropic = createAnthropic({ apiKey });
      return new AISDKAdapter({ model: anthropic(pseudo), name: 'claude' });
    }
    case 'openrouter': {
      // See the `createModel` openrouter branch for why `.chat(...)`
      // matters — OpenRouter doesn't serve `/v1/responses`, and the
      // default `openai(...)` form would route there.
      const openrouter = createOpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
      return new AISDKAdapter({ model: openrouter.chat(pseudo), name: 'openrouter' });
    }
  }
}
