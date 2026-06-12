/**
 * HTTP layer — Fastify, two routes, aggressive redaction.
 *
 *   GET  /xrpc/com.dinakernel.credits.getConfig?platform=ios|android
 *   POST /xrpc/com.dinakernel.credits.claimGrant
 *   GET  /healthz
 *
 * Logging policy (spec "redacted logs"): request bodies are NEVER
 * logged (they carry attestation tokens), responses are NEVER logged
 * (they carry minted keys), and Fastify's request logging is reduced to
 * method/route/status. The only request-derived values that may appear
 * in logs are `platform` and refusal codes.
 *
 * Rate limiting: per-IP on claimGrant (attestation is the real gate;
 * this is the cheap outer shell that keeps junk off the Apple API).
 */

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import {
  CREDITS_CLAIM_GRANT_NSID,
  CREDITS_GET_CONFIG_NSID,
} from '@dina/protocol';

import { processClaim } from './claim';

import type { ClaimDeps } from './claim';
import type { FastifyInstance } from 'fastify';

export interface ServerDeps extends Omit<ClaimDeps, 'log'> {
  /** Claims per IP per window (default 5 per hour). */
  claimRateLimit?: { max: number; windowMs: number };
  /** Log level — tests pass 'silent'. */
  logLevel?: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? 'info',
      // Belt-and-suspenders: even if a serializer is added later,
      // these paths never reach the log line.
      redact: {
        paths: ['req.headers.authorization', 'req.body', 'res.body'],
        remove: true,
      },
      serializers: {
        req(req) {
          return { method: req.method, url: req.url.split('?')[0] };
        },
      },
    },
    // Attestation tokens are a few KB; nothing legitimate is large.
    bodyLimit: 64 * 1024,
    trustProxy: true, // behind Caddy — rate-limit on the real client IP
  });

  const limits = deps.claimRateLimit ?? { max: 5, windowMs: 60 * 60 * 1000 };
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.ip,
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.get(`/xrpc/${CREDITS_GET_CONFIG_NSID}`, async (req, reply) => {
    const platform = (req.query as Record<string, unknown>).platform;
    const cfg = deps.config;
    const enabled =
      !cfg.paused &&
      (platform === 'android' ? cfg.enabledAndroid : platform === 'ios' ? cfg.enabledIos : false);
    return reply.header('Cache-Control', 'public, max-age=300').status(200).send({
      enabled,
      grant_usd: cfg.grantUsd,
      model_pin: cfg.modelPin,
      est_conversations: cfg.estConversations,
    });
  });

  app.post(
    `/xrpc/${CREDITS_CLAIM_GRANT_NSID}`,
    {
      config: {
        rateLimit: {
          max: limits.max,
          timeWindow: limits.windowMs,
        },
      },
    },
    async (req, reply) => {
      // Adapt pino's (obj, msg) signature to the pipeline's
      // (msg, fields) — passing app.log directly would silently drop
      // the fields as unused printf args.
      const log = {
        info: (msg: string, fields?: Record<string, unknown>) => app.log.info(fields ?? {}, msg),
        warn: (msg: string, fields?: Record<string, unknown>) => app.log.warn(fields ?? {}, msg),
        error: (msg: string, fields?: Record<string, unknown>) => app.log.error(fields ?? {}, msg),
      };
      const outcome = await processClaim({ ...deps, log }, req.body);
      return reply.status(outcome.status).send(outcome.body);
    },
  );

  // @fastify/rate-limit answers 429 with its own body; normalize it to
  // the wire contract so clients parse a typed refusal.
  app.setErrorHandler((err: { statusCode?: number; name?: string }, _req, reply) => {
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: 'rate_limited' });
    }
    // Malformed JSON, wrong content-type, oversized body — client
    // errors, normalized to the wire contract (never a 500).
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(400).send({ error: 'bad_request' });
    }
    app.log.error({ name: err.name ?? 'unknown' }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });

  return app;
}
