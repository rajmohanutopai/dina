/**
 * Task 5.1 / 5.4 — env-driven config for the Brain server.
 *
 * Parses `process.env` into a typed `BrainServerConfig` with Zod.
 * Fails loud (throws `ConfigError`) on missing required values or
 * invalid types — the process should crash before Fastify binds a
 * port.
 *
 * Env-var names mirror `apps/home-node-lite/core-server` so operators
 * can rely on a single naming convention for both Node processes.
 */

import { z } from 'zod';

import { HomeNodeEndpointConfigError, resolveServerHostedDinaEndpoints } from '@dina/home-node';

const NetworkSchema = z.object({
  /** Bind address. Default: loopback only. */
  host: z.string().min(1),
  /**
   * Listen port. Default: 8200 — same as ARCHITECTURE.md and the
   * Go/Python Brain's default. Paired with Core on 8200 by
   * convention; override via `DINA_BRAIN_PORT` when running both
   * stacks side-by-side.
   */
  port: z.number().int().min(0).max(65535),
});

const RuntimeSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  prettyLogs: z.boolean(),
});

const ReasoningSchema = z.object({
  /** Start the co-located Brain's durable always-on reasoning worker. */
  internalBrainEnabled: z.boolean(),
});

const CoreSchema = z.object({
  baseUrl: z.string().url().refine(isHTTPURL, 'must use http or https'),
  serviceKeyDir: z.string().min(1),
  serviceKeyFile: z
    .string()
    .min(1)
    .refine((value) => !value.includes('/') && !value.includes('\\'), {
      message: 'must be a filename, not a path',
    }),
  serviceDid: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('did:key:'), 'must be a did:key')
    .optional(),
  httpTimeoutMs: z.number().int().positive(),
});

const EndpointSchema = z.object({
  mode: z.enum(['test', 'release']),
  msgboxWsUrl: z.string().url(),
  pdsBaseUrl: z.string().url(),
  appViewBaseUrl: z.string().url(),
  plcDirectoryUrl: z.string().url(),
});

const LLMSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('none'),
  }),
  z.object({
    provider: z.literal('gemini'),
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal('openai'),
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
    // Explicit `reasoning.effort` override (gpt-5+). Unset lets the
    // adapter pick the cheapest effort the model accepts.
    reasoningEffort: z.enum(['none', 'low', 'minimal', 'medium', 'high', 'xhigh']).optional(),
  }),
  // OpenRouter is OpenAI-compatible; same shape, its own key + base URL.
  z.object({
    provider: z.literal('openrouter'),
    apiKey: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  // Deterministic canned-response provider for E2E/dev. NEVER production —
  // gated behind an explicit `DINA_BRAIN_LLM_PROVIDER=scripted` opt-in.
  z.object({
    provider: z.literal('scripted'),
    scriptFile: z.string().min(1).optional(),
  }),
]);

const BrainServerConfigSchema = z.object({
  core: CoreSchema,
  endpoints: EndpointSchema,
  llm: LLMSchema,
  network: NetworkSchema,
  reasoning: ReasoningSchema,
  runtime: RuntimeSchema,
});

export type BrainServerConfig = z.infer<typeof BrainServerConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: { path: string; message: string }[]) {
    super(`brain-server config invalid (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse `env` (defaulting to `process.env`) into a validated config.
 * Accepting a parameter lets tests exercise env-variant branches
 * without mutating process state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainServerConfig {
  const internalBrainEnabled = readBool(env, 'DINA_INTERNAL_BRAIN_ENABLED', false);
  const candidate = {
    core: {
      baseUrl: normalizeBaseUrl(env.DINA_CORE_URL ?? 'http://127.0.0.1:8100'),
      serviceKeyDir: env.DINA_SERVICE_KEY_DIR ?? './service_keys',
      serviceKeyFile: env.DINA_BRAIN_SERVICE_KEY_FILE ?? 'brain.ed25519',
      serviceDid: blankToUndefined(env.DINA_BRAIN_DID),
      httpTimeoutMs: parseInt(env.DINA_CORE_HTTP_TIMEOUT_MS ?? '10000', 10),
    },
    endpoints: readEndpoints(env),
    llm: readLLM(env),
    network: {
      host: env.DINA_BRAIN_HOST ?? '127.0.0.1',
      port: parseInt(env.DINA_BRAIN_PORT ?? '8200', 10),
    },
    reasoning: {
      internalBrainEnabled,
    },
    runtime: {
      logLevel: (env.DINA_BRAIN_LOG_LEVEL ?? 'info') as 'info',
      prettyLogs: (env.DINA_BRAIN_PRETTY_LOGS ?? 'false') === 'true',
    },
  };
  const result = BrainServerConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(
      result.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    );
  }
  if (result.data.reasoning.internalBrainEnabled && result.data.llm.provider === 'none') {
    throw new ConfigError([
      {
        path: 'llm.provider',
        message: 'an LLM provider is required when the internal Brain is enabled',
      },
    ]);
  }
  return result.data;
}

function readEndpoints(env: NodeJS.ProcessEnv) {
  try {
    return resolveServerHostedDinaEndpoints(env);
  } catch (err) {
    if (err instanceof HomeNodeEndpointConfigError) {
      throw new ConfigError([{ path: err.key ?? 'endpoints', message: err.message }]);
    }
    throw err;
  }
}

function readLLM(env: NodeJS.ProcessEnv) {
  const provider = (env.DINA_BRAIN_LLM_PROVIDER ?? 'none').trim().toLowerCase();
  if (provider === 'none') {
    return { provider: 'none' };
  }
  if (provider === 'gemini') {
    return {
      provider: 'gemini',
      apiKey: blankToUndefined(env.DINA_GEMINI_API_KEY ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
      model: blankToUndefined(env.DINA_GEMINI_MODEL),
    };
  }
  if (provider === 'openai') {
    return {
      provider: 'openai',
      apiKey: blankToUndefined(env.DINA_OPENAI_API_KEY ?? env.OPENAI_API_KEY),
      model: blankToUndefined(env.DINA_OPENAI_MODEL),
      reasoningEffort: blankToUndefined(env.DINA_OPENAI_REASONING_EFFORT)?.toLowerCase(),
    };
  }
  if (provider === 'openrouter') {
    return {
      provider: 'openrouter',
      apiKey: blankToUndefined(env.DINA_OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY),
      model: blankToUndefined(env.DINA_OPENROUTER_MODEL),
    };
  }
  if (provider === 'scripted') {
    return {
      provider: 'scripted',
      scriptFile: blankToUndefined(env.DINA_BRAIN_SCRIPTED_LLM_FILE),
    };
  }
  return { provider };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBool(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError([{ path: key, message: 'must be a boolean' }]);
}

function isHTTPURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
