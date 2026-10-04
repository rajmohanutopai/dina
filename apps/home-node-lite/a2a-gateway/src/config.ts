/**
 * Gateway configuration (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1), from the
 * environment:
 *
 *   DINA_A2A_GATEWAY_HOST       listen host (default 127.0.0.1: put a TLS
 *                               terminator in front; the public origin is https)
 *   DINA_A2A_GATEWAY_PORT       listen port (default 8400)
 *   DINA_CORE_URL               Core's base URL (default http://127.0.0.1:8100)
 *   DINA_A2A_GATEWAY_KEY_DIR    directory holding the gateway's service key
 *   DINA_A2A_GATEWAY_KEY_FILE   its file name (default gateway.ed25519: a raw
 *                               32-byte Ed25519 seed, the gateway's alone)
 *   DINA_A2A_GATEWAY_DID        optional: the did:key Core registered; checked
 *                               against the key at boot
 *   DINA_A2A_GATEWAY_IP_LIMIT   calls per minute per client address (default 120)
 *   DINA_A2A_GATEWAY_MAX_STREAMS     event streams open at once (default 500)
 *   DINA_A2A_GATEWAY_STREAMS_PER_IP  of those, per client address (default 20)
 *   DINA_A2A_GATEWAY_TRUST_PROXY  how many proxies in front set X-Forwarded-For
 *                               (normally 1, the TLS terminator; default 0).
 *                               The client's address is the one the nearest
 *                               of them saw; entries the client wrote further
 *                               left are never trusted.
 *   DINA_LOG_LEVEL, DINA_PRETTY_LOGS
 */

import { z } from 'zod';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ConfigSchema = z.object({
  network: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    /** Proxy hops trusted for X-Forwarded-For; 0 trusts none. */
    trustProxy: z.number().int().min(0).max(8),
  }),
  core: z.object({
    baseUrl: z.string().url(),
    timeoutMs: z.number().int().positive(),
  }),
  serviceKey: z.object({
    dir: z.string().min(1),
    file: z.string().regex(/^[A-Za-z0-9._-]+$/, 'a plain file name'),
    did: z
      .string()
      .refine((v) => v.startsWith('did:key:'), 'must be a did:key')
      .optional(),
  }),
  limits: z.object({
    perIpPerMinute: z.number().int().positive(),
    cardCacheMs: z.number().int().nonnegative(),
  }),
  streams: z.object({
    max: z.number().int().positive(),
    perIp: z.number().int().positive(),
    /** A stream ends after this long; the client may subscribe again. */
    maxLifetimeMs: z.number().int().positive(),
    keepaliveMs: z.number().int().positive(),
    /** A client this far behind (bytes not yet sent) has its stream ended. */
    maxBufferedBytes: z.number().int().positive(),
  }),
  delivery: z.object({
    intervalMs: z.number().int().positive(),
    webhookConcurrency: z.number().int().positive(),
    claimLimit: z.number().int().positive().max(100),
  }),
  runtime: z.object({
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    prettyLogs: z.boolean(),
  }),
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const v = str(env, key);
  return v === undefined ? fallback : Number(v);
}

function bool(env: NodeJS.ProcessEnv, key: string): boolean {
  const v = str(env, key)?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const did = str(env, 'DINA_A2A_GATEWAY_DID');
  const draft = {
    network: {
      host: str(env, 'DINA_A2A_GATEWAY_HOST') ?? '127.0.0.1',
      port: int(env, 'DINA_A2A_GATEWAY_PORT', 8400),
      trustProxy: int(env, 'DINA_A2A_GATEWAY_TRUST_PROXY', 0),
    },
    core: {
      baseUrl: str(env, 'DINA_CORE_URL') ?? 'http://127.0.0.1:8100',
      timeoutMs: 15_000,
    },
    serviceKey: {
      dir: str(env, 'DINA_A2A_GATEWAY_KEY_DIR') ?? '',
      file: str(env, 'DINA_A2A_GATEWAY_KEY_FILE') ?? 'gateway.ed25519',
      ...(did === undefined ? {} : { did }),
    },
    limits: {
      perIpPerMinute: int(env, 'DINA_A2A_GATEWAY_IP_LIMIT', 120),
      cardCacheMs: 30_000,
    },
    streams: {
      max: int(env, 'DINA_A2A_GATEWAY_MAX_STREAMS', 500),
      perIp: int(env, 'DINA_A2A_GATEWAY_STREAMS_PER_IP', 20),
      maxLifetimeMs: 30 * 60_000,
      keepaliveMs: 15_000,
      maxBufferedBytes: 1024 * 1024,
    },
    delivery: {
      intervalMs: 1_000,
      webhookConcurrency: 8,
      claimLimit: 100,
    },
    runtime: {
      logLevel: str(env, 'DINA_LOG_LEVEL') ?? 'info',
      prettyLogs: bool(env, 'DINA_PRETTY_LOGS'),
    },
  };
  const parsed = ConfigSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ConfigError(
      `a2a-gateway config validation failed: ${parsed.error.issues.length} issue(s)`,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}
