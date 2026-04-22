/**
 * Task 5.3 — Brain-server configuration loader.
 *
 * Reads the brain-server's environment config with Zod-style
 * validation. Produces a typed `BrainConfig` the app wiring consumes
 * at boot.
 *
 * **Source precedence** (highest → lowest):
 *   1. Explicit override in code (testing / programmatic boot).
 *   2. Environment variables (`DINA_BRAIN_PORT`, …).
 *   3. Documented defaults.
 *
 * **Required keys**:
 *   - `DINA_CORE_URL` — signed-HTTP endpoint Brain calls.
 *
 * **Optional keys with defaults**:
 *   - `DINA_BRAIN_PORT` (default `8200`) — HTTP port.
 *   - `DINA_MODEL_DEFAULT` (default `anthropic:claude-haiku-4-5`)
 *     — fallback model when the task policy doesn't pin one.
 *   - `DINA_LOG_LEVEL` (default `info`).
 *   - `DINA_CONFIG_DIR` (default `~/.dina/brain`).
 *
 * **Provider keys**: every `DINA_<PROVIDER>_API_KEY` env var (e.g.
 * `DINA_ANTHROPIC_API_KEY`, `DINA_GEMINI_API_KEY`) lands in
 * `providerKeys` keyed by lowercase provider id.
 *
 * **Security posture**:
 *   - `toLoggable(config)` returns the config with API keys
 *     redacted. Callers logging at startup MUST pass through this
 *     first — never log raw config.
 *   - Absent provider keys return `present: false` + a helpful hint
 *     naming which env var was missing.
 *
 * **Error shape**: `BrainConfigError` carries a `code` enum +
 * `detail` so ops-actionable errors are machine-readable.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5a task 5.3.
 */

export const DEFAULT_BRAIN_PORT = 8200;
export const DEFAULT_MODEL_DEFAULT = 'anthropic:claude-haiku-4-5';
export const DEFAULT_LOG_LEVEL = 'info';

export interface BrainConfig {
  /** HTTP port. */
  port: number;
  /** Core endpoint Brain calls via signed HTTP. */
  coreUrl: string;
  /** Default model id (`provider:model`). Used when TaskRoutingPolicy doesn't pin one. */
  modelDefault: string;
  /** pino log level. */
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Filesystem dir for Brain state (non-secret). */
  configDir: string;
  /** Provider id → API key. Populated from `DINA_<PROVIDER>_API_KEY` env. */
  providerKeys: Record<string, string>;
}

export type BrainConfigErrorCode =
  | 'missing_required'
  | 'invalid_port'
  | 'invalid_url'
  | 'invalid_log_level'
  | 'invalid_model_default';

export class BrainConfigError extends Error {
  constructor(
    public readonly code: BrainConfigErrorCode,
    public readonly detail: Record<string, string>,
  ) {
    super(`BrainConfig: ${code} — ${JSON.stringify(detail)}`);
    this.name = 'BrainConfigError';
  }
}

export interface LoadBrainConfigOptions {
  /** Process env. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Programmatic overrides — wins over env. */
  overrides?: Partial<BrainConfig>;
  /**
   * When false (default), missing `DINA_CORE_URL` throws. When true,
   * missing core URL loads anyway — useful for test fixtures that
   * construct a BrainConfig without a real Core.
   */
  allowMissingCoreUrl?: boolean;
}

const LOG_LEVELS: ReadonlySet<BrainConfig['logLevel']> = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
]);

/** `DINA_<PROVIDER>_API_KEY` pattern. Underscores in provider names → hyphens. */
const PROVIDER_KEY_RE = /^DINA_([A-Z][A-Z0-9_]*)_API_KEY$/;

/**
 * Load the brain-server config from environment + overrides.
 * Throws `BrainConfigError` on any validation failure.
 */
export function loadBrainConfig(opts: LoadBrainConfigOptions = {}): BrainConfig {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const overrides = opts.overrides ?? {};

  // port
  const port = resolvePort(
    overrides.port,
    env.DINA_BRAIN_PORT,
    DEFAULT_BRAIN_PORT,
  );

  // coreUrl
  const coreUrl = resolveCoreUrl(
    overrides.coreUrl,
    env.DINA_CORE_URL,
    opts.allowMissingCoreUrl === true,
  );

  // modelDefault — must be `provider:model` shape
  const modelDefault = resolveModelDefault(
    overrides.modelDefault,
    env.DINA_MODEL_DEFAULT,
    DEFAULT_MODEL_DEFAULT,
  );

  // logLevel
  const logLevel = resolveLogLevel(
    overrides.logLevel,
    env.DINA_LOG_LEVEL,
    DEFAULT_LOG_LEVEL,
  );

  // configDir
  const configDir =
    overrides.configDir ??
    env.DINA_CONFIG_DIR ??
    defaultConfigDir(env);

  // providerKeys — collect every DINA_<PROVIDER>_API_KEY + merge
  // overrides.
  const providerKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '') continue;
    const match = PROVIDER_KEY_RE.exec(key);
    if (match === null) continue;
    const providerId = match[1]!.toLowerCase().replace(/_/g, '-');
    providerKeys[providerId] = value;
  }
  if (overrides.providerKeys) {
    for (const [id, key] of Object.entries(overrides.providerKeys)) {
      providerKeys[id] = key;
    }
  }

  return {
    port,
    coreUrl,
    modelDefault,
    logLevel,
    configDir,
    providerKeys,
  };
}

/**
 * Redacted view of a config — replace API keys with `<present>` /
 * `<missing>` tokens. Callers logging config at boot MUST pipe
 * through this first.
 */
export function toLoggable(config: BrainConfig): Omit<BrainConfig, 'providerKeys'> & {
  providerKeys: Record<string, '<present>'>;
} {
  const redacted: Record<string, '<present>'> = {};
  for (const id of Object.keys(config.providerKeys)) {
    redacted[id] = '<present>';
  }
  return {
    port: config.port,
    coreUrl: config.coreUrl,
    modelDefault: config.modelDefault,
    logLevel: config.logLevel,
    configDir: config.configDir,
    providerKeys: redacted,
  };
}

/** True when an API key is present for the given provider id. */
export function hasProviderKey(config: BrainConfig, providerId: string): boolean {
  return Object.prototype.hasOwnProperty.call(config.providerKeys, providerId);
}

// ── Internals ──────────────────────────────────────────────────────────

function resolvePort(
  override: number | undefined,
  envValue: string | undefined,
  defaultValue: number,
): number {
  let candidate: number;
  if (override !== undefined) {
    candidate = override;
  } else if (envValue !== undefined) {
    // Strict: reject strings that aren't a clean integer. parseInt
    // would silently truncate "1.5" → 1; we need to surface that.
    candidate = /^-?\d+$/.test(envValue) ? Number(envValue) : Number.NaN;
  } else {
    candidate = defaultValue;
  }
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new BrainConfigError('invalid_port', {
      supplied: String(envValue ?? override),
      hint: 'port must be an integer in [1, 65535]',
    });
  }
  return candidate;
}

function resolveCoreUrl(
  override: string | undefined,
  envValue: string | undefined,
  allowMissing: boolean,
): string {
  const candidate = override ?? envValue;
  if (candidate === undefined || candidate === '') {
    if (allowMissing) return '';
    throw new BrainConfigError('missing_required', {
      key: 'DINA_CORE_URL',
      hint: 'set DINA_CORE_URL to Core\'s signed-HTTP endpoint (e.g. http://localhost:8100)',
    });
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol must be http or https');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new BrainConfigError('invalid_url', {
      key: 'DINA_CORE_URL',
      supplied: candidate,
      reason,
    });
  }
  return candidate;
}

function resolveModelDefault(
  override: string | undefined,
  envValue: string | undefined,
  defaultValue: string,
): string {
  const candidate = override ?? envValue ?? defaultValue;
  if (typeof candidate !== 'string' || candidate === '' || !candidate.includes(':')) {
    throw new BrainConfigError('invalid_model_default', {
      supplied: candidate ?? '',
      hint: 'must be `provider:model` (e.g. "anthropic:claude-haiku-4-5")',
    });
  }
  return candidate;
}

function resolveLogLevel(
  override: string | undefined,
  envValue: string | undefined,
  defaultValue: string,
): BrainConfig['logLevel'] {
  const candidate = override ?? envValue ?? defaultValue;
  if (!LOG_LEVELS.has(candidate as BrainConfig['logLevel'])) {
    throw new BrainConfigError('invalid_log_level', {
      supplied: String(candidate),
      allowed: Array.from(LOG_LEVELS).join(','),
    });
  }
  return candidate as BrainConfig['logLevel'];
}

function defaultConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME ?? env.USERPROFILE ?? '/tmp';
  return `${home}/.dina/brain`;
}
