/**
 * LLM provider configuration manager — store and manage API keys.
 *
 * Providers: claude, openai, gemini, openrouter, local.
 * Each provider has: API key, model preference, availability status.
 *
 * Features:
 *   - Store/update API keys per provider
 *   - Validate key format (basic format check, not network validation)
 *   - Check availability (key present + not revoked)
 *   - List all configured providers with status
 *   - Hot-reload: update key without restart
 *
 * Source: ARCHITECTURE.md Tasks 4.4, 4.16
 */

export type ProviderName = 'claude' | 'openai' | 'gemini' | 'openrouter' | 'local';

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  model: string;
  enabled: boolean;
  configuredAt: number;
}

export interface ProviderStatus {
  name: ProviderName;
  available: boolean;
  model: string;
  reason: string;
}

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_CLAUDE_PRIMARY_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_HEAVY_MODEL,
  DEFAULT_OPENAI_PRIMARY_MODEL,
  DEFAULT_OPENAI_LITE_MODEL,
  DEFAULT_OPENAI_HEAVY_MODEL,
  DEFAULT_GEMINI_PRIMARY_MODEL,
  DEFAULT_GEMINI_LITE_MODEL,
  DEFAULT_GEMINI_HEAVY_MODEL,
  DEFAULT_OPENROUTER_PRIMARY_MODEL,
  DEFAULT_OPENROUTER_LITE_MODEL,
  DEFAULT_OPENROUTER_HEAVY_MODEL,
  DEFAULT_LOCAL_PRIMARY_MODEL,
  DEFAULT_LOCAL_LITE_MODEL,
  DEFAULT_LOCAL_HEAVY_MODEL,
} from '../constants';

/** Provider defaults: model names for each provider. */
const DEFAULT_MODELS: Record<ProviderName, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
  openrouter: DEFAULT_OPENROUTER_MODEL,
  local: DEFAULT_LOCAL_MODEL,
};

/**
 * Per-provider primary / lite / heavy tiers (PC-BRAIN-17). Each
 * provider block ships its own mapping so the router picks the
 * right model AFTER the user has selected a provider (not just
 * the gemini defaults the main-dina port used to hard-code).
 */
export interface ProviderTiers {
  primary: string;
  lite: string;
  heavy: string;
}

const DEFAULT_TIERS: Record<ProviderName, ProviderTiers> = {
  claude: {
    primary: DEFAULT_CLAUDE_PRIMARY_MODEL,
    lite: DEFAULT_CLAUDE_LITE_MODEL,
    heavy: DEFAULT_CLAUDE_HEAVY_MODEL,
  },
  openai: {
    primary: DEFAULT_OPENAI_PRIMARY_MODEL,
    lite: DEFAULT_OPENAI_LITE_MODEL,
    heavy: DEFAULT_OPENAI_HEAVY_MODEL,
  },
  gemini: {
    primary: DEFAULT_GEMINI_PRIMARY_MODEL,
    lite: DEFAULT_GEMINI_LITE_MODEL,
    heavy: DEFAULT_GEMINI_HEAVY_MODEL,
  },
  openrouter: {
    primary: DEFAULT_OPENROUTER_PRIMARY_MODEL,
    lite: DEFAULT_OPENROUTER_LITE_MODEL,
    heavy: DEFAULT_OPENROUTER_HEAVY_MODEL,
  },
  local: {
    primary: DEFAULT_LOCAL_PRIMARY_MODEL,
    lite: DEFAULT_LOCAL_LITE_MODEL,
    heavy: DEFAULT_LOCAL_HEAVY_MODEL,
  },
};

/** API key format patterns (basic validation). */
const KEY_PATTERNS: Record<string, RegExp> = {
  claude: /^sk-ant-/,
  openai: /^sk-/,
  gemini: /^AI/,
  openrouter: /^sk-or-/,
};

/** Configured providers. */
const providers = new Map<ProviderName, ProviderConfig>();

/**
 * Configure a provider with an API key.
 *
 * @param name — provider name
 * @param apiKey — the API key (empty string to clear)
 * @param model — optional model override
 */
export function configureProvider(name: ProviderName, apiKey: string, model?: string): void {
  if (name === 'local') {
    // Local doesn't need an API key
    providers.set(name, {
      name,
      apiKey: '',
      model: model ?? DEFAULT_MODELS.local,
      enabled: true,
      configuredAt: Date.now(),
    });
    return;
  }

  providers.set(name, {
    name,
    apiKey,
    model: model ?? DEFAULT_MODELS[name],
    enabled: apiKey.length > 0,
    configuredAt: Date.now(),
  });
}

/**
 * Remove a provider configuration.
 */
export function removeProvider(name: ProviderName): void {
  providers.delete(name);
}

/**
 * Get a provider's configuration. Returns null if not configured.
 */
export function getProviderConfig(name: ProviderName): ProviderConfig | null {
  return providers.get(name) ?? null;
}

/**
 * Validate an API key format (basic pattern check).
 *
 * This is NOT a network validation — it only checks the prefix format.
 * Returns null if valid, or an error message if invalid.
 */
export function validateKeyFormat(name: ProviderName, apiKey: string): string | null {
  if (name === 'local') return null; // no key needed

  if (!apiKey || apiKey.trim().length === 0) {
    return 'API key is required';
  }

  const pattern = KEY_PATTERNS[name];
  if (pattern && !pattern.test(apiKey)) {
    return `Invalid key format for ${name} — expected prefix: ${pattern.source}`;
  }

  if (apiKey.length < 10) {
    return 'API key is too short';
  }

  return null;
}

/**
 * Check if a provider is available (configured + enabled).
 */
export function isProviderAvailable(name: ProviderName): boolean {
  const config = providers.get(name);
  if (!config) return false;
  return config.enabled;
}

/**
 * Get the status of all providers (configured or not).
 */
export function getProviderStatuses(): ProviderStatus[] {
  const allNames: ProviderName[] = ['claude', 'openai', 'gemini', 'openrouter', 'local'];

  return allNames.map((name) => {
    const config = providers.get(name);
    if (!config) {
      return { name, available: false, model: DEFAULT_MODELS[name], reason: 'Not configured' };
    }
    if (!config.enabled) {
      return { name, available: false, model: config.model, reason: 'Disabled (empty API key)' };
    }
    return { name, available: true, model: config.model, reason: 'Ready' };
  });
}

/**
 * Get the best available provider (preference: local → claude → openai → gemini → openrouter).
 */
export function getBestProvider(): ProviderName | null {
  const preference: ProviderName[] = ['local', 'claude', 'openai', 'gemini', 'openrouter'];
  for (const name of preference) {
    if (isProviderAvailable(name)) return name;
  }
  return null;
}

/**
 * Count configured providers.
 */
export function configuredCount(): number {
  return providers.size;
}

/** Reset all provider config (for testing). */
export function resetProviderConfig(): void {
  providers.clear();
}

/**
 * Return `{primary, lite, heavy}` model IDs scoped to `name`
 * (PC-BRAIN-17).
 *
 * Port of main-dina's `model_config.get_provider_tiers`. Once a
 * user has picked a provider, the router asks this function for
 * the three tiers that provider advertises, rather than using a
 * hard-coded "gemini default" fallback.
 *
 * Fallback cascade: a configured provider's explicit `model`
 * overrides the primary tier (reflects the user's preference); a
 * missing tier falls back to the provider's primary; a totally
 * unknown provider returns the empty-string sentinel so callers
 * can detect + log rather than fire an unknown-model request.
 *
 * Returns a FRESH object per call so caller mutations don't
 * poison the shared default table.
 */
export function getProviderTiers(name: ProviderName): ProviderTiers {
  const defaults = DEFAULT_TIERS[name] ?? { primary: '', lite: '', heavy: '' };
  const config = providers.get(name);
  // A user-configured `model` overrides the primary tier so the
  // Settings-side choice wins. The lite / heavy tiers stay on the
  // provider defaults since there's no per-tier override surface
  // (yet); if we add one later the merge happens here.
  const primary = config?.model && config.model !== '' ? config.model : defaults.primary;
  return {
    primary,
    lite: defaults.lite !== '' ? defaults.lite : primary,
    heavy: defaults.heavy !== '' ? defaults.heavy : primary,
  };
}
