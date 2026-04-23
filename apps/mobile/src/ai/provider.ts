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

export type ProviderType = 'openai' | 'gemini';

export interface ProviderInfo {
  type: ProviderType;
  label: string;
  description: string;
  keyPrefix: string;
  defaultModel: string;
  models: string[];
}

export const PROVIDERS: Record<ProviderType, ProviderInfo> = {
  openai: {
    type: 'openai',
    label: 'OpenAI',
    description: 'GPT-5.4, GPT-5 mini',
    keyPrefix: 'sk-',
    // Aligned with home-node `models.json` (primary=gpt-5.4, lite=gpt-5-mini).
    defaultModel: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-5-mini'],
  },
  gemini: {
    type: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini 3.1 Pro, Gemini 3.1 Flash',
    keyPrefix: 'AIza',
    // Models aligned with the home-node `models.json` production defaults
    // (primary=gemini-3.1-pro-preview, lite=gemini-3.1-flash-lite-preview,
    // heavy=gemini-3.1-pro-preview). `gemini-2.0-flash` deprecated for
    // new Google AI Studio accounts.
    defaultModel: 'gemini-3.1-pro-preview',
    models: [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-preview',
      'gemini-3.1-flash-lite-preview',
    ],
  },
};

const KEYCHAIN_SERVICE_PREFIX = 'dina.llm.';

/** Store an API key securely. */
export async function saveApiKey(provider: ProviderType, key: string): Promise<void> {
  await Keychain.setGenericPassword(provider, key, {
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
  });
}

/** Retrieve a stored API key. Returns null if not set. */
export async function getApiKey(provider: ProviderType): Promise<string | null> {
  const result = await Keychain.getGenericPassword({
    service: `${KEYCHAIN_SERVICE_PREFIX}${provider}`,
  });
  if (result && result.password) {
    return result.password;
  }
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

/** Create an AI SDK LanguageModel from stored key. Returns null if no key. */
export async function createModel(
  provider: ProviderType,
  modelId?: string,
): Promise<LanguageModel | null> {
  const apiKey = await getApiKey(provider);
  if (!apiKey) return null;

  const info = PROVIDERS[provider];
  const model = modelId ?? info.defaultModel;

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
