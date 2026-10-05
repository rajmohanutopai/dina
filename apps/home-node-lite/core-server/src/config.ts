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
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a tasks 4.4–4.5.
 */

import { z } from 'zod';

import { parseA2APublicOrigin } from '@dina/core';
import {
  HomeNodeEndpointConfigError,
  resolveServerHostedDinaEndpoints,
  type HostedDinaEndpoints,
} from '@dina/home-node';

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

/** Hosted Dina endpoint fleet selected for this Home Node. */
const EndpointSchema = z.object({
  mode: z.enum(['test', 'release']),
  msgboxWsUrl: z.string().url(),
  pdsBaseUrl: z.string().url(),
  appViewBaseUrl: z.string().url(),
  plcDirectoryUrl: z.string().url(),
});

/** MsgBox relay. Test fleet is the default for greenfield installs. */
const MsgBoxSchema = z.object({
  /** Relay URL, e.g. `wss://test-mailbox.dinakernel.com/ws`. */
  url: z.string().url().optional(),
  /** Home node's own DID, needed for MsgBox subscription. */
  homeNodeDid: z.string().optional(),
  /** Connect to MsgBox during boot. Defaults true for greenfield installs. */
  enabled: z.boolean().optional(),
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

/**
 * Service-DID allowlist. Today only `brain` lives here. install-lite
 * (and the test harness) derives the brain Ed25519 seed and computes
 * its `did:key:` form; we wire that into Core's caller-type registry
 * at boot so signed requests from brain-server resolve to
 * `callerType: 'service' / name: 'brain'` instead of falling through
 * to the unknown-caller 403.
 *
 * Optional — omitting it leaves the allowlist empty (signed requests
 * from any unregistered DID stay 403, which is the safe default). When
 * present, the DID must be a `did:key:` (canonical-sign requirement).
 */
const ServicesSchema = z.object({
  brainDid: z
    .string()
    .refine((value) => value.startsWith('did:key:'), 'must be a did:key')
    .optional(),
  // Base URL of the co-located lite Brain. Core's Tier-1 `dina.local` runner
  // posts claimed capability executions here (the Brain has the LLM). Optional
  // — defaults to the brain's default port at boot when unset.
  brainUrl: z.string().url().optional(),
  /**
   * Explicitly provision the co-located Brain as an always-on reasoning
   * backend. Omitted/false keeps the durable backend policy untouched.
   */
  internalBrainEnabled: z.boolean().optional(),
});

/**
 * A2A Lane 2 (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1, §7.1). Set the public
 * origin and the gateway DID together to serve outside agents through the
 * gateway process; set neither to leave Lane 2 off.
 *
 * - `publicOrigin`: the gateway's public https origin. Core puts it on the
 *   card it signs and never takes it from the gateway.
 * - `gatewayDid`: the did:key of the gateway's own service key, registered
 *   as caller type `gateway` (the gateway never holds Core's or Brain's keys).
 *
 * Every outside client's call arrives under the gateway's one DID, so Core
 * exempts it from the per-DID bucket (and its routes from the per-address
 * one); Core's per-client budgets and the gateway's per-address edge limit
 * do the per-caller limiting (design §4.1).
 */
const A2ASchema = z
  .object({
    publicOrigin: z
      .string()
      .refine(
        (value) => parseA2APublicOrigin(value) !== null,
        'must be a bare https origin (no path, query or credentials)',
      )
      .optional(),
    gatewayDid: z
      .string()
      .refine((value) => value.startsWith('did:key:'), 'must be a did:key')
      .optional(),
  })
  .refine((v) => (v.publicOrigin === undefined) === (v.gatewayDid === undefined), {
    message: 'set DINA_A2A_PUBLIC_URL and DINA_A2A_GATEWAY_DID together',
    path: ['gatewayDid'],
  });

/**
 * UCP buyer (docs/UCP_IMPLEMENTATION_PLAN.md). Off by default until the
 * profile host is deployed; `profileHost` names a test deployment.
 */
const UcpSchema = z.object({
  enabled: z.boolean(),
  profileHost: z
    .string()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
      'must be a lower-case host name',
    )
    .optional(),
});

/** Full server config — every subsection required. */
export const CoreServerConfigSchema = z.object({
  endpoints: EndpointSchema.optional(),
  network: NetworkSchema,
  storage: StorageSchema,
  runtime: RuntimeSchema,
  msgbox: MsgBoxSchema,
  ucp: UcpSchema.optional(),
  cors: CorsSchema,
  // Optional — keeps existing test fixtures (which don't supply
  // `services`) typecheck-clean while still surfacing the loaded
  // shape via `LoadedCoreServerConfig` below.
  services: ServicesSchema.optional(),
  a2a: A2ASchema.optional(),
});

export type CoreServerConfig = z.infer<typeof CoreServerConfigSchema>;

export type LoadedCoreServerConfig = Omit<CoreServerConfig, 'endpoints' | 'msgbox'> & {
  endpoints: HostedDinaEndpoints;
  msgbox: { url: string; homeNodeDid?: string; enabled: boolean };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly { path: string; message: string }[],
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

function readInt(env: NodeJS.ProcessEnv, key: string, defaultValue?: number): number | undefined {
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

function readBool(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedCoreServerConfig {
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
  //   DINA_ENDPOINT_MODE   → endpoints.mode     (default: test)
  //   DINA_MSGBOX_URL      → endpoints/msgbox.url
  //   DINA_MSGBOX_ENABLED  → msgbox.enabled    (default: true)
  //   DINA_PDS_URL         → endpoints.pdsBaseUrl
  //   DINA_APPVIEW_URL     → endpoints.appViewBaseUrl
  //   DINA_PLC_URL         → endpoints.plcDirectoryUrl
  //   DINA_HOMENODE_DID    → msgbox.homeNodeDid (optional)
  //   DINA_CORS_ORIGIN     → cors.allowOrigin   (optional; matches Go's AllowOrigin)
  //   DINA_BRAIN_DID       → services.brainDid  (optional; install-lite + paired-stack tests set this)
  //   DINA_INTERNAL_BRAIN_ENABLED → services.internalBrainEnabled (default false)
  //   DINA_A2A_PUBLIC_URL  → a2a.publicOrigin   (optional; with DINA_A2A_GATEWAY_DID)
  //   DINA_A2A_GATEWAY_DID → a2a.gatewayDid     (optional; with DINA_A2A_PUBLIC_URL)
  //   DINA_UCP_ENABLED     → ucp.enabled          (default false: the profile host is not deployed yet)
  //   DINA_UCP_PROFILE_HOST → ucp.profileHost     (optional; a test deployment's host name)

  const endpoints = readEndpoints(env);
  const internalBrainEnabled = readBool(env, 'DINA_INTERNAL_BRAIN_ENABLED', false);
  const draft = {
    endpoints,
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
      rateLimitPerMinute: readInt(env, 'DINA_RATE_LIMIT', DEFAULTS.runtime.rateLimitPerMinute),
      prettyLogs: readBool(env, 'DINA_PRETTY_LOGS', DEFAULTS.runtime.prettyLogs),
    },
    msgbox: {
      url: endpoints.msgboxWsUrl,
      homeNodeDid: readString(env, 'DINA_HOMENODE_DID'),
      enabled: readBool(env, 'DINA_MSGBOX_ENABLED', true),
    },
    cors: {
      allowOrigin: readString(env, 'DINA_CORS_ORIGIN'),
    },
    services: {
      brainDid: readString(env, 'DINA_BRAIN_DID'),
      brainUrl: readString(env, 'DINA_BRAIN_URL'),
      ...(internalBrainEnabled ? { internalBrainEnabled: true } : {}),
    },
    a2a: {
      publicOrigin: readString(env, 'DINA_A2A_PUBLIC_URL'),
      gatewayDid: readString(env, 'DINA_A2A_GATEWAY_DID'),
    },
    ucp: {
      enabled: readBool(env, 'DINA_UCP_ENABLED', false),
      profileHost: readString(env, 'DINA_UCP_PROFILE_HOST'),
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
  if (parsed.data.services?.internalBrainEnabled && !parsed.data.services.brainDid) {
    throw new ConfigError('DINA_INTERNAL_BRAIN_ENABLED requires DINA_BRAIN_DID', [
      { path: 'services.brainDid', message: 'required when internal Brain is enabled' },
    ]);
  }
  return parsed.data as LoadedCoreServerConfig;
}

function readEndpoints(env: NodeJS.ProcessEnv) {
  try {
    return resolveServerHostedDinaEndpoints(env);
  } catch (err) {
    if (err instanceof HomeNodeEndpointConfigError) {
      throw new ConfigError(err.message, [{ path: err.key ?? 'endpoints', message: err.message }]);
    }
    throw err;
  }
}
