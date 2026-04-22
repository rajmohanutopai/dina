/**
 * LLM provider management hook — data layer for Settings → LLM Providers screen.
 *
 * Wraps the Brain's provider_config module with a UI-friendly API:
 *   - List all providers with status (available/unavailable/not configured)
 *   - Add or update an API key for a provider
 *   - Validate key format before saving
 *   - Remove a provider configuration
 *   - Hot-reload: changes take effect immediately (no restart needed)
 *
 * Source: ARCHITECTURE.md Task 4.16
 */

import {
  configureProvider,
  removeProvider,
  getProviderConfig,
  getProviderStatuses,
  validateKeyFormat,
  isProviderAvailable,
  getBestProvider,
  configuredCount,
  resetProviderConfig,
  type ProviderName,
  type ProviderStatus,
} from '../../../brain/src/llm/provider_config';

export interface ProviderUIState {
  name: ProviderName;
  displayName: string;
  available: boolean;
  model: string;
  reason: string;
  hasKey: boolean;
  keyPreview: string; // "sk-ant-****1234" — masked for display
}

/** Human-readable provider names. */
const DISPLAY_NAMES: Record<ProviderName, string> = {
  claude: 'Anthropic Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  local: 'Local (on-device)',
};

/**
 * Get all providers with UI-friendly state.
 */
export function getProviderUIStates(): ProviderUIState[] {
  const statuses = getProviderStatuses();

  return statuses.map((s) => {
    const config = getProviderConfig(s.name);
    return {
      name: s.name,
      displayName: DISPLAY_NAMES[s.name] ?? s.name,
      available: s.available,
      model: s.model,
      reason: s.reason,
      hasKey: !!config?.apiKey,
      keyPreview: config?.apiKey ? maskKey(config.apiKey) : '',
    };
  });
}

/**
 * Add or update an API key for a provider.
 *
 * Returns null on success, or an error message on validation failure.
 */
export function setProviderKey(name: ProviderName, apiKey: string, model?: string): string | null {
  // Validate key format
  const validationError = validateKeyFormat(name, apiKey);
  if (validationError) return validationError;

  // Configure the provider
  configureProvider(name, apiKey, model);

  return null; // success
}

/**
 * Remove a provider's API key.
 */
export function clearProviderKey(name: ProviderName): void {
  removeProvider(name);
}

/**
 * Enable local mode (no API key needed).
 */
export function enableLocalProvider(model?: string): void {
  configureProvider('local', '', model);
}

/**
 * Get the best available provider for display.
 */
export function getBestAvailable(): { name: string; displayName: string } | null {
  const best = getBestProvider();
  if (!best) return null;
  return { name: best, displayName: DISPLAY_NAMES[best] ?? best };
}

/**
 * Get the total count of configured providers.
 */
export function getConfiguredCount(): number {
  return configuredCount();
}

/**
 * Check if any LLM provider is available.
 */
export function hasAnyProvider(): boolean {
  return getBestProvider() !== null;
}

/**
 * Reset all provider configurations (for testing).
 */
export function resetProviders(): void {
  resetProviderConfig();
}

/** Mask an API key for display: show first 6 and last 4 chars. */
function maskKey(key: string): string {
  if (key.length <= 10) return '****';
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}
