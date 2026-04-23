/**
 * Onboarding LLM setup hook — optional API key configuration.
 *
 * During onboarding, the user can:
 *   1. Enter an API key for Claude, OpenAI, or Gemini
 *   2. Skip to use local-only mode (no cloud LLM)
 *   3. Add OpenRouter as a fallback
 *
 * The screen validates keys before saving and shows provider status.
 * This step is entirely optional — Dina works in FTS-only mode
 * without any LLM provider configured.
 *
 * Source: ARCHITECTURE.md Task 4.4
 */

import {
  configureProvider,
  validateKeyFormat,
  getProviderStatuses,
  isProviderAvailable,
  resetProviderConfig,
  type ProviderName,
} from '@dina/brain/src/llm/provider_config';

export type SetupChoice = 'claude' | 'openai' | 'gemini' | 'openrouter' | 'local' | 'skip';

export interface LLMSetupState {
  choice: SetupChoice | null;
  apiKey: string;
  validationError: string | null;
  configured: boolean;
  providerName: string | null;
}

/** Provider display info for the selection screen. */
const PROVIDER_OPTIONS: Array<{
  name: ProviderName;
  label: string;
  description: string;
  keyPrefix: string;
}> = [
  {
    name: 'claude',
    label: 'Anthropic Claude',
    description: 'Best reasoning, tool calling',
    keyPrefix: 'sk-ant-',
  },
  {
    name: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, embeddings, broad support',
    keyPrefix: 'sk-',
  },
  {
    name: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini Flash, structured output, embeddings',
    keyPrefix: 'AI',
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    description: 'Access many models via one key',
    keyPrefix: 'sk-or-',
  },
];

/**
 * Get the provider options for the selection screen.
 */
export function getProviderOptions() {
  return PROVIDER_OPTIONS;
}

/**
 * Validate an API key for a provider without saving it.
 * Returns null if valid, error message if not.
 */
export function validateKey(provider: ProviderName, apiKey: string): string | null {
  return validateKeyFormat(provider, apiKey);
}

/**
 * Configure a provider with an API key. Validates first.
 * Returns null on success, error message on failure.
 */
export function setupProvider(provider: ProviderName, apiKey: string): string | null {
  const error = validateKeyFormat(provider, apiKey);
  if (error) return error;

  configureProvider(provider, apiKey);
  return null;
}

/**
 * Skip LLM setup — configure local-only mode.
 * Dina will work in FTS-only mode for search and use local model when available.
 */
export function skipLLMSetup(): void {
  configureProvider('local', '');
}

/**
 * Check if any LLM provider is configured after setup.
 */
export function isLLMConfigured(): boolean {
  return getProviderStatuses().some((s) => s.available);
}

/**
 * Get a summary of what was configured for the completion screen.
 */
export function getSetupSummary(): { provider: string; mode: string } {
  const statuses = getProviderStatuses();
  const available = statuses.filter((s) => s.available);

  if (available.length === 0) {
    return { provider: 'None', mode: 'FTS-only (no LLM)' };
  }

  const localAvailable = available.some((s) => s.name === 'local');
  const cloudAvailable = available.filter((s) => s.name !== 'local');

  if (cloudAvailable.length > 0) {
    const primary = cloudAvailable[0];
    const label = PROVIDER_OPTIONS.find((p) => p.name === primary.name)?.label ?? primary.name;
    return {
      provider: label,
      mode: localAvailable ? 'Hybrid (local + cloud)' : 'Cloud',
    };
  }

  return { provider: 'Local', mode: 'On-device only' };
}

/**
 * Reset LLM setup state (for testing).
 */
export function resetLLMSetup(): void {
  resetProviderConfig();
}
