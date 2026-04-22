/**
 * Task 4.4 + 4.5 — Env-driven config loader with Zod validation.
 *
 * Parses `process.env` into a typed `CoreServerConfig` object, applying
 * defaults, coercing types (port numbers, bools), and failing loud on
 * missing required vars or structurally invalid values.
 *
 * **Fail-loud philosophy.** A misconfigured Home Node at boot is safer
 * than one that silently starts with defaults that expose keys or data
 * to the wrong audience. We throw `ConfigError` on any Zod validation
 * failure so the process crashes before Fastify binds a port.
 *
 * **Parity with Go config.** The Go Core reads the same env vars (see
 * `core/internal/config/*.go`). Keep names and defaults in sync.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a tasks 4.4–4.5.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
//
// One `z.object` per logical config subsection, then a parent object that
// composes them. Keeps the shape readable and each section independently
// testable. `strict()` is deliberately NOT used — env vars other than ours
// may be present and are none of our business.

/** Network binding (where Fastify listens). */
const NetworkSchema = z.object({
  /** Bind address. Default: loopback only. */
  host: z.string().min(1),
  /**
   * Listen port. Default: 8100 (internal) — same as Go's brain→core.
   * Port 0 is a valid value ("OS-chosen ephemeral"); commonly used in
   * tests. Zod min=0 reflects HTTP's actual port range 0-65535.
   */
  port: z.number().int().min(0).max(65535),
});

/** Storage layout. */
const StorageSchema = z.object({
  /** Root dir for identity.sqlite + vault/ per-persona files. */
  vaultDir: z.string().min(1),
  /** Max SQLite cache pages (performance tuning; Go default: 1000). */
  cachePages: z.number().int().min(100),
});

/** Runtime behavior. */
const RuntimeSchema = z.object({
  /** Logger verbosity — follows pino level names. `silent` suppresses
   *  all output and is useful for tests. */
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  /** Requests-per-minute per DID. Matches Go's default 60. */
  rateLimitPerMinute: z.number().int().min(1),
  /** Emit pretty (pino-pretty) logs when true; JSON otherwise. */
  prettyLogs: z.boolean(),
});

/** MsgBox relay (optional — off when unset). */
const MsgBoxSchema = z.object({
  /** Relay URL, e.g. `https://msgbox.dina.example`. */
  url: z.string().url().optional(),
  /** Home node's own DID, needed for MsgBox subscription. */
  homeNodeDid: z.string().optional(),
});

/**
 * CORS (Cross-Origin Resource Sharing). Matches Go Core's
 * `AllowOrigin` semantics (core/internal/middleware/cors.go):
 *   - unset / empty  → same-origin only (no CORS headers emitted)
 *   - `*`            → wildcard, no credentials
 *   - comma-list     → exact-match allowlist, credentials enabled
 */
const CorsSchema = z.object({
  allowOrigin: z.string().optional(),
});

/** Full server config — every subsection required. */
export const CoreServerConfigSchema = z.object({
  network: NetworkSchema,
  storage: StorageSchema,
  runtime: RuntimeSchema,
  msgbox: MsgBoxSchema,
  cors: CorsSchema,
});

export type CoreServerConfig = z.infer<typeof CoreServerConfigSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
//
// Defaults chosen to be safe + private: loopback binding, moderate rate
// limit, INFO logs, pretty logs off (so prod JSON works by default). All
// are override-able via env.

export const DEFAULTS = Object.freeze({
  network: { host: '127.0.0.1', port: 8100 },
  storage: { cachePages: 1000 },
  runtime: { logLevel: 'info', rateLimitPerMinute: 60, prettyLogs: false },
} as const);

// ---------------------------------------------------------------------------
// Env coercion helpers
// ---------------------------------------------------------------------------

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue?: number,
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${key} must be an integer (got ${JSON.stringify(raw)})`, [
      { path: key, message: 'not an integer' },
    ]);
  }
  return n;
}

function readBool(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const normalized = raw.toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${key} must be a boolean (got ${JSON.stringify(raw)})`, [
    { path: key, message: 'not a boolean' },
  ]);
}

function readString(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue?: string,
): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw;
}

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const v = readString(env, key);
  if (v === undefined) {
    throw new ConfigError(`${key} is required`, [{ path: key, message: 'required env var unset' }]);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate config from a process-env-like source.
 *
 * Pass `process.env` in production; tests pass a plain object. This
 * keeps the loader deterministic — no hidden reads.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreServerConfig {
  // Field mapping: env var → config path. Keeping this table explicit so
  // a reader can see what every env var means without hunting through
  // coercion functions.
  //
  //   DINA_CORE_HOST       → network.host       (default: 127.0.0.1)
  //   DINA_CORE_PORT       → network.port       (default: 8100)
  //   DINA_VAULT_DIR       → storage.vaultDir   (required)
  //   DINA_CACHE_PAGES     → storage.cachePages (default: 1000)
  //   DINA_LOG_LEVEL       → runtime.logLevel   (default: info)
  //   DINA_RATE_LIMIT      → runtime.rateLimit  (default: 60)
  //   DINA_PRETTY_LOGS     → runtime.prettyLogs (default: false)
  //   DINA_MSGBOX_URL      → msgbox.url         (optional)
  //   DINA_HOMENODE_DID    → msgbox.homeNodeDid (optional)
  //   DINA_CORS_ORIGIN     → cors.allowOrigin   (optional; matches Go's AllowOrigin)

  const draft = {
    network: {
      host: readString(env, 'DINA_CORE_HOST', DEFAULTS.network.host),
      port: readInt(env, 'DINA_CORE_PORT', DEFAULTS.network.port),
    },
    storage: {
      vaultDir: requireString(env, 'DINA_VAULT_DIR'),
      cachePages: readInt(env, 'DINA_CACHE_PAGES', DEFAULTS.storage.cachePages),
    },
    runtime: {
      logLevel: readString(env, 'DINA_LOG_LEVEL', DEFAULTS.runtime.logLevel),
      rateLimitPerMinute: readInt(
        env,
        'DINA_RATE_LIMIT',
        DEFAULTS.runtime.rateLimitPerMinute,
      ),
      prettyLogs: readBool(env, 'DINA_PRETTY_LOGS', DEFAULTS.runtime.prettyLogs),
    },
    msgbox: {
      url: readString(env, 'DINA_MSGBOX_URL'),
      homeNodeDid: readString(env, 'DINA_HOMENODE_DID'),
    },
    cors: {
      allowOrigin: readString(env, 'DINA_CORS_ORIGIN'),
    },
  };

  const parsed = CoreServerConfigSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ConfigError(
      `core-server config validation failed: ${parsed.error.issues.length} issue(s)`,
      parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    );
  }
  return parsed.data;
}
