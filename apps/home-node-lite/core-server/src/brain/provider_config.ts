/**
 * Task 5.23 — LLM provider config (Anthropic, OpenAI, Google,
 * OpenRouter, local llama).
 *
 * The Brain's LLM layer reads provider config at boot: which
 * providers are enabled, which API key to use, which models they
 * expose, whether they're cloud- or local-hosted. This module is
 * the typed loader + validator that the router (task 5.24) and the
 * cloud gate (task 5.25) consume.
 *
 * **Shape** — one entry per provider:
 *
 *   {
 *     name: 'anthropic',
 *     kind: 'cloud',
 *     apiKey: '<secret>',              // required for cloud; empty for local
 *     baseUrl: 'https://...',          // optional override
 *     models: ['claude-sonnet-4-6'],   // models the caller may route to
 *     defaultModel: 'claude-sonnet-4-6',
 *     enabled: true,
 *   }
 *
 * **Env-first loader** — production loads from env vars
 * (`DINA_ANTHROPIC_API_KEY`, `DINA_OPENAI_API_KEY`, etc.) + the JSON
 * config at `${configDir}/brain.providers.json`. The JSON provides
 * `{models, defaultModel, enabled, baseUrl?}` for each provider;
 * the env provides the secret key. Splitting secret / non-secret
 * across two sources avoids committing keys and keeps model-list
 * changes reviewable.
 *
 * **Secret redaction** — `toLoggable()` produces a log-safe view of
 * the config with `apiKey: '<redacted>'`. The raw `apiKey` never
 * appears in process-emitted JSON logs; operators rolling a key
 * rotation see only whether it's `<present>` or `<missing>`.
 *
 * **Validation**:
 *   - cloud providers require non-empty apiKey when `enabled`
 *   - `defaultModel` must appear in `models`
 *   - `name` must be non-empty; duplicates across entries rejected
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5d task 5.23.
 */

import { z } from 'zod';
import type { ProviderKind } from './cloud_gate';

/** Known provider names. Open-set via the generic config; pinned list
 *  matches the task spec for reference + readyz render. */
export const KNOWN_PROVIDER_NAMES = Object.freeze([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'local-llama',
] as const);

export type KnownProviderName = (typeof KNOWN_PROVIDER_NAMES)[number];

/** Raw (JSON-config-shaped) entry — before secret merge + validation. */
export const ProviderEntrySchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['cloud', 'local']),
    models: z.array(z.string().min(1)).min(1),
    defaultModel: z.string().min(1),
    enabled: z.boolean().default(true),
    baseUrl: z.string().url().optional(),
  })
  .strict();

export type ProviderEntry = z.infer<typeof ProviderEntrySchema> & {
  /** Populated from env vars after JSON load. Empty for local. */
  apiKey?: string;
};

export const ProviderConfigSchema = z.object({
  providers: z.array(ProviderEntrySchema).min(0),
});

export type ProviderConfig = {
  providers: ProviderEntry[];
};

export type ProviderConfigErrorCode =
  | 'invalid_shape'
  | 'duplicate_provider'
  | 'default_model_not_in_list'
  | 'missing_api_key'
  | 'invalid_json';

export class ProviderConfigError extends Error {
  constructor(
    public readonly code: ProviderConfigErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export interface LoadProviderConfigInput {
  /** The raw JSON string (from disk or test fixture). */
  rawJson: string;
  /** Env-var map — we look up `DINA_<UPPERCASE_NAME>_API_KEY` per provider. */
  env: NodeJS.ProcessEnv;
}

/**
 * Parse + validate the JSON config, merge API keys from env, and
 * return a typed `ProviderConfig`. Throws `ProviderConfigError` on
 * every failure.
 */
export function loadProviderConfig(
  input: LoadProviderConfigInput,
): ProviderConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawJson);
  } catch (err) {
    throw new ProviderConfigError(
      'invalid_json',
      `provider config is not valid JSON: ${(err as Error).message}`,
    );
  }

  const shape = ProviderConfigSchema.safeParse(parsed);
  if (!shape.success) {
    throw new ProviderConfigError(
      'invalid_shape',
      `provider config failed schema validation: ${shape.error.issues.length} issue(s)`,
      {
        issues: shape.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    );
  }

  const seen = new Set<string>();
  const providers: ProviderEntry[] = [];
  for (const entry of shape.data.providers) {
    if (seen.has(entry.name)) {
      throw new ProviderConfigError(
        'duplicate_provider',
        `provider ${JSON.stringify(entry.name)} appears more than once`,
        { provider: entry.name },
      );
    }
    seen.add(entry.name);

    if (!entry.models.includes(entry.defaultModel)) {
      throw new ProviderConfigError(
        'default_model_not_in_list',
        `provider ${JSON.stringify(entry.name)} defaultModel ${JSON.stringify(entry.defaultModel)} is not in models`,
        { provider: entry.name, defaultModel: entry.defaultModel, models: entry.models },
      );
    }

    // Merge API key from env for cloud providers.
    const envKey = `DINA_${entry.name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const apiKey = input.env[envKey];
    const merged: ProviderEntry = { ...entry };
    if (apiKey !== undefined && apiKey.length > 0) {
      merged.apiKey = apiKey;
    }
    if (merged.enabled && entry.kind === 'cloud' && !merged.apiKey) {
      throw new ProviderConfigError(
        'missing_api_key',
        `provider ${JSON.stringify(entry.name)} is enabled + cloud but ${envKey} is not set`,
        { provider: entry.name, envVar: envKey },
      );
    }
    providers.push(merged);
  }
  return { providers };
}

/**
 * Render the config in a log-safe shape — API keys replaced by
 * `<present>` / `<missing>` tokens so operators can tell at a glance
 * whether a key is set without exposing its value.
 */
export function toLoggable(config: ProviderConfig): Array<Record<string, unknown>> {
  return config.providers.map((p) => {
    const out: Record<string, unknown> = {
      name: p.name,
      kind: p.kind,
      enabled: p.enabled,
      models: [...p.models],
      defaultModel: p.defaultModel,
    };
    if (p.baseUrl !== undefined) out['baseUrl'] = p.baseUrl;
    if (p.kind === 'cloud') {
      out['apiKey'] = p.apiKey ? '<present>' : '<missing>';
    }
    return out;
  });
}

/**
 * Filter to enabled + key-present providers — what the router (task
 * 5.24) should actually route against. Disabled providers and cloud
 * providers without a key are silently excluded.
 */
export function availableProviders(
  config: ProviderConfig,
): ProviderEntry[] {
  return config.providers.filter(
    (p) => p.enabled && (p.kind === 'local' || (p.apiKey && p.apiKey.length > 0)),
  );
}

/**
 * Lift the provider shape into the `cloud_gate.ProviderEntry` shape
 * (`{name, kind}`). Useful when wiring `new CloudGate({providers: ...})`
 * from a loaded `ProviderConfig`.
 */
export function toCloudGateEntries(
  config: ProviderConfig,
): Array<{ name: string; kind: ProviderKind }> {
  return config.providers.map((p) => ({ name: p.name, kind: p.kind }));
}
