/**
 * HTTP layer (USER_BACKUP.md §4.3).
 *
 *   PUT    /v1/backups/:backupId/:counter  — 201, or 409 `counter_not_newer`
 *   GET    /v1/backups/:backupId/list      — `{ copies: [{ counter, size, stored_at }] }`
 *   GET    /v1/backups/:backupId/:counter  — the bytes; `latest` for the newest
 *   DELETE /v1/backups/:backupId           — `{ removed }`
 *   GET    /healthz
 *
 * Every /v1 call passes the backup-key check (`auth.ts`) before anything
 * else. Logs carry the method, the route pattern and the status: never a
 * backup id, a body or a header, since linking an id to a person is the one
 * thing the store must not make easy (§6).
 */

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { checkSignedCall, TIMESTAMP_WINDOW_MS } from './auth';

import type { BackupConfig } from './config';
import type { CopyStore } from './store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ServerDeps {
  config: BackupConfig;
  store: CopyStore;
  now?: () => number;
  logLevel?: string;
}

const BACKUP_ID = /^[0-9a-f]{64}$/;

interface Params {
  backupId: string;
  counter?: string;
}

function parseCounter(raw: string | undefined): number | 'latest' | null {
  if (raw === 'latest') return 'latest';
  if (raw === undefined || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? 'info',
      redact: { paths: ['req.headers', 'req.body', 'res.body'], remove: true },
      serializers: {
        req(req) {
          return { method: req.method, route: req.routeOptions?.url ?? 'unknown' };
        },
      },
    },
    bodyLimit: deps.config.maxCopyBytes,
    trustProxy: true, // behind Caddy
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: deps.config.maxCopyBytes },
    (_req, body, done) => done(null, body),
  );

  await app.register(rateLimit, {
    max: deps.config.rateLimit.max,
    timeWindow: deps.config.rateLimit.windowMs,
    keyGenerator: (req) => {
      const id = (req.params as Partial<Params> | undefined)?.backupId;
      return typeof id === 'string' && BACKUP_ID.test(id) ? `id:${id}` : `ip:${req.ip}`;
    },
  });

  /** The backup-key check; replies and returns false when it fails. */
  const authorized = (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply): boolean => {
    const { backupId } = req.params;
    if (!BACKUP_ID.test(backupId)) {
      void reply.status(400).send({ error: 'bad_backup_id' });
      return false;
    }
    const [path, query = ''] = req.url.split('?', 2);
    const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
    const refusal = checkSignedCall(
      { method: req.method, path: path ?? '', query, body, headers: req.headers, backupId },
      now(),
      (nonce) => deps.store.claimNonce(nonce, now(), 2 * TIMESTAMP_WINDOW_MS),
    );
    if (refusal !== null) {
      void reply.status(401).send({ error: refusal });
      return false;
    }
    return true;
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.put<{ Params: Params }>('/v1/backups/:backupId/:counter', async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const counter = parseCounter(req.params.counter);
    if (counter === null || counter === 'latest') {
      return reply.status(400).send({ error: 'bad_counter' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.status(400).send({ error: 'empty_copy' });
    }
    const outcome = deps.store.put(req.params.backupId, counter, new Uint8Array(req.body), now());
    if (outcome === 'not_newer') return reply.status(409).send({ error: 'counter_not_newer' });
    return reply.status(201).send({ ok: true });
  });

  app.get<{ Params: Params }>('/v1/backups/:backupId/list', async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const copies = deps.store
      .list(req.params.backupId)
      .map((c) => ({ counter: c.counter, size: c.size, stored_at: c.storedAt }));
    return reply.status(200).send({ copies });
  });

  app.get<{ Params: Params }>('/v1/backups/:backupId/:counter', async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const counter = parseCounter(req.params.counter);
    if (counter === null) return reply.status(400).send({ error: 'bad_counter' });
    const got = deps.store.get(req.params.backupId, counter);
    if (!got.ok) {
      return got.reason === 'not_found'
        ? reply.status(404).send({ error: 'not_found' })
        : reply.status(500).send({ error: 'copy_corrupt' });
    }
    return reply
      .status(200)
      .header('Content-Type', 'application/octet-stream')
      .header('X-Backup-Counter', String(got.counter))
      .send(Buffer.from(got.bytes));
  });

  app.delete<{ Params: Params }>('/v1/backups/:backupId', async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    return reply.status(200).send({ removed: deps.store.deleteAll(req.params.backupId) });
  });

  return app;
}
