/**
 * Task 4.77 — GET /v1/memory/toc Fastify route.
 *
 * Exposes the cross-persona Table of Contents over HTTP. Backs onto
 * `@dina/core`'s `MemoryService.toc(personas, limit)` which walks the
 * per-persona topic repositories, merges by decayed EWMA salience,
 * and stable-sorts + truncates to the caller's limit.
 *
 * **Wire contract**:
 *
 *   GET /v1/memory/toc?personas=work,health&limit=20
 *   → 200 { entries: [
 *             { persona, topic, kind, salience, last_update, sample_item_id? },
 *             ...
 *           ] }
 *
 * Query parameters:
 *   personas — optional comma-separated list. Empty / omitted → all
 *              unlocked personas via the service's persona lister.
 *   limit    — optional positive int. Default 20, cap 200. Callers
 *              asking for more than the cap get a 400 so over-broad
 *              ToC pulls are obvious at the call site rather than
 *              silently clipped.
 *
 * **Tier-0 'identity' persona is skipped** by the service layer (no
 * `topic_salience` table there). Locked personas surface as warnings
 * on the service's `onWarning` hook — not 500s — so a partially-
 * available ToC still returns.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4j task 4.77.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  MemoryService,
  TopicKind,
  TopicRepositoryResolver,
} from '@dina/core';
import { isTopicKind } from '@dina/core';

/** Default limit when the client omits it. */
export const DEFAULT_MEMORY_TOC_LIMIT = 20;

/** Hard cap on the client-supplied limit. */
export const MAX_MEMORY_TOC_LIMIT = 200;

export interface MemoryRoutesOptions {
  /** Wired-in `@dina/core.MemoryService`. Required. */
  memoryService: MemoryService;
  /** Default limit for missing `?limit=`. */
  defaultLimit?: number;
  /** Max permitted `?limit=`. Requests above this get a 400. */
  maxLimit?: number;
  /**
   * Per-persona topic repository resolver. When provided, the
   * `POST /v1/memory/touch` ingestion endpoint (task 4.76) is
   * registered. When omitted, touch is 404 (not available on this
   * server — signals deployment's ingestion path is external).
   */
  topicRepositoryResolver?: TopicRepositoryResolver;
  /** Injectable clock (unix SECONDS). Default `Math.floor(Date.now()/1000)`. */
  nowSecFn?: () => number;
}

type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
}

/** Body shape for `POST /v1/memory/touch`. */
interface TouchBody {
  persona?: unknown;
  topic?: unknown;
  kind?: unknown;
  sample_item_id?: unknown;
}

export function registerMemoryRoutes(
  app: FastifyAppShape,
  opts: MemoryRoutesOptions,
): void {
  const { memoryService } = opts;
  if (memoryService === undefined || memoryService === null) {
    throw new Error('registerMemoryRoutes: memoryService is required');
  }
  const defaultLimit = opts.defaultLimit ?? DEFAULT_MEMORY_TOC_LIMIT;
  const maxLimit = opts.maxLimit ?? MAX_MEMORY_TOC_LIMIT;
  if (!Number.isInteger(defaultLimit) || defaultLimit <= 0) {
    throw new Error(
      `registerMemoryRoutes: defaultLimit must be a positive integer (got ${defaultLimit})`,
    );
  }
  if (!Number.isInteger(maxLimit) || maxLimit < defaultLimit) {
    throw new Error(
      `registerMemoryRoutes: maxLimit must be an integer >= defaultLimit (got ${maxLimit})`,
    );
  }

  app.get('/v1/memory/toc', async (req, reply) => {
    const q = (req.query ?? {}) as { personas?: unknown; limit?: unknown };

    // personas: comma-separated; undefined → all unlocked.
    let personas: string[] | undefined;
    if (typeof q.personas === 'string') {
      const trimmed = q.personas.trim();
      if (trimmed.length === 0) {
        personas = undefined;
      } else {
        personas = trimmed
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (personas.length === 0) personas = undefined;
      }
    }

    // limit: parse + validate.
    let limit = defaultLimit;
    if (q.limit !== undefined) {
      const raw = typeof q.limit === 'string' ? q.limit : String(q.limit);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        await reply
          .code(400)
          .send({ error: 'limit must be a positive integer' });
        return;
      }
      if (parsed > maxLimit) {
        await reply
          .code(400)
          .send({ error: `limit exceeds ${maxLimit} cap` });
        return;
      }
      limit = parsed;
    }

    const entries = await memoryService.toc(personas, limit);
    req.log.info(
      {
        memory_toc_personas: personas?.length ?? 'all',
        memory_toc_limit: limit,
        memory_toc_entries: entries.length,
      },
      'memory toc',
    );
    return { entries };
  });

  // -------------------------------------------------------------------------
  // POST /v1/memory/touch  (task 4.76 — reload on ingestion)
  //
  // Called by ingestion pipelines (vault/store, MsgBox message handler,
  // connector hooks) to record that a persona just saw `topic`. Drives
  // the EWMA counters for the persona's working-memory Table of
  // Contents. Because `MemoryService.toc()` reads through to the
  // repositories on every call, this touch is visible on the very
  // NEXT `GET /v1/memory/toc` — no cache invalidation step.
  //
  // Flow:
  //   1. Validate body.
  //   2. `resolveAlias(topic)` → canonical form (collapses "tax plans",
  //      "tax planning" → same salience row).
  //   3. `touch({topic: canonical, kind, nowUnix, sampleItemId?})`.
  //   4. Return `{persona, topic, canonical_topic, kind}` so the caller
  //      can surface the alias-resolution result in its own logs.
  //
  // Server derives `nowUnix` from its own clock — NEVER trusts a
  // client-supplied timestamp (would let a misconfigured caller age
  // out topics artificially).
  //
  // Response:
  //   200 `{persona, topic, canonical_topic, kind}`
  //   400 invalid body (missing/wrong types + unknown kind)
  //   404 endpoint not registered (no resolver was wired)
  //   503 persona's topic repository unavailable (locked / missing)
  // -------------------------------------------------------------------------

  if (opts.topicRepositoryResolver === undefined) return;

  const resolver = opts.topicRepositoryResolver;
  const nowSec = opts.nowSecFn ?? (() => Math.floor(Date.now() / 1000));

  app.post('/v1/memory/touch', async (req, reply) => {
    const body = (req.body ?? {}) as TouchBody;

    if (typeof body.persona !== 'string' || body.persona.length === 0) {
      await reply.code(400).send({ error: 'persona is required' });
      return;
    }
    if (typeof body.topic !== 'string' || body.topic.trim().length === 0) {
      await reply.code(400).send({ error: 'topic is required' });
      return;
    }
    if (typeof body.kind !== 'string' || !isTopicKind(body.kind)) {
      await reply
        .code(400)
        .send({ error: 'kind must be "entity" or "theme"' });
      return;
    }
    if (
      body.sample_item_id !== undefined &&
      typeof body.sample_item_id !== 'string'
    ) {
      await reply
        .code(400)
        .send({ error: 'sample_item_id must be a string when provided' });
      return;
    }

    const persona = body.persona;
    const rawTopic = body.topic.trim();
    const kind = body.kind as TopicKind;

    const repo = resolver(persona);
    if (repo === null) {
      await reply
        .code(503)
        .send({ error: `persona "${persona}" has no topic repository (locked?)` });
      return;
    }

    let canonicalTopic: string;
    try {
      canonicalTopic = await repo.resolveAlias(rawTopic);
    } catch (err) {
      req.log.warn({ persona, err: (err as Error).message }, 'resolveAlias failed');
      canonicalTopic = rawTopic; // fall through to the "variant becomes canonical" tier
    }
    if (canonicalTopic.length === 0) canonicalTopic = rawTopic;

    const touchReq: Parameters<typeof repo.touch>[0] = {
      topic: canonicalTopic,
      kind,
      nowUnix: nowSec(),
    };
    if (body.sample_item_id !== undefined) {
      touchReq.sampleItemId = body.sample_item_id;
    }
    await repo.touch(touchReq);

    req.log.info(
      {
        memory_touch_persona: persona,
        memory_touch_kind: kind,
        memory_touch_canonical: canonicalTopic,
        memory_touch_variant: rawTopic === canonicalTopic ? undefined : rawTopic,
      },
      'memory touch',
    );

    return {
      persona,
      topic: rawTopic,
      canonical_topic: canonicalTopic,
      kind,
    };
  });
}
