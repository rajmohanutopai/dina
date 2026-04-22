/**
 * Task 4.78 — POST /v1/pii/scrub Fastify route.
 *
 * Tier 1 PII scrubbing over the wire. Takes plain text, runs the
 * regex-based `@dina/core.detectPII`, filters through the allow-list
 * (task 4.81), and emits `{scrubbed, entities}` with per-type
 * sequential token names (`[EMAIL_1]`, `[PHONE_1]`, ...).
 *
 * **Wire shape** — parity with the Python Brain's `/v1/pii/scrub`:
 *
 *   Request:  { text: string }
 *   Response: { scrubbed: string,
 *               entities: [{ type, start, end, value, token }, ...] }
 *
 * The Brain uses this to sanitize LLM prompts and restore answers
 * via `/v1/pii/rehydrate` (task 4.79 — pending). Entities carry the
 * raw PII `value` because the caller (Brain) holds that mapping in
 * a session-scoped cache and uses it for rehydration later.
 *
 * **Length cap** — 100 KiB default. Prevents a caller from DoS'ing
 * the regex engine with a multi-megabyte request. Matches the
 * Python route's `Field(..., max_length=100_000)`. Caller-overridable
 * for tests.
 *
 * **Allow-list injection** — optional. When omitted the route uses
 * the bare Tier 1 regex output (aggressive). Production composition
 * root will supply a populated `AllowList` from the operator's
 * `pii_allowlist.yaml`.
 *
 * **Never log the text** — the request body is PII-by-definition.
 * Log only counts + latency + request_id; the input + output never
 * hit stdout.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4k task 4.78.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { detectPII, rehydratePII } from '@dina/core';
import { AllowList, filterMatches } from './allow_list';
import {
  type RehydrationSessionRegistry,
  type RehydrationEntity,
} from './rehydration_sessions';

/** Default cap on input length (matches Python `max_length=100_000`). */
export const DEFAULT_MAX_TEXT_LENGTH = 100_000;

export interface PiiRoutesOptions {
  /**
   * Allow-list applied to detected PII. When omitted every regex match
   * is scrubbed (aggressive). When provided, matches the allow-list
   * suppresses are dropped before token assignment.
   */
  allowList?: AllowList;
  /** Max input text length in characters. Default 100 000. */
  maxTextLength?: number;
  /**
   * Optional session registry for the session-based rehydrate flow
   * (task 4.79). When provided, `/v1/pii/rehydrate` accepts
   * `{session_id, text}` bodies + a session-create sub-endpoint is
   * registered. When omitted, only the direct-entities rehydrate
   * mode is available.
   */
  rehydrationSessions?: RehydrationSessionRegistry;
}

export interface ScrubResponseBody {
  scrubbed: string;
  entities: Array<{
    type: string;
    start: number;
    end: number;
    value: string;
    token: string;
  }>;
}

/** Structural Fastify subset — matches the pattern in `src/pair/routes.ts`. */
type RouteHandler = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export interface FastifyAppShape {
  post(path: string, handler: RouteHandler): unknown;
}

/** Shape for POST /v1/pii/scrub request body. */
interface ScrubRequestBody {
  text?: unknown;
}

export function registerPiiRoutes(app: FastifyAppShape, opts: PiiRoutesOptions = {}): void {
  const allowList = opts.allowList;
  const maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const rehydrationSessions = opts.rehydrationSessions;
  if (!Number.isFinite(maxTextLength) || maxTextLength <= 0) {
    throw new Error(
      `registerPiiRoutes: maxTextLength must be > 0 (got ${maxTextLength})`,
    );
  }

  app.post('/v1/pii/scrub', async (req, reply) => {
    const body = (req.body ?? {}) as ScrubRequestBody;
    if (typeof body.text !== 'string') {
      await reply.code(400).send({ error: 'text is required' });
      return;
    }
    const text = body.text;
    if (text.length > maxTextLength) {
      await reply
        .code(413)
        .send({ error: `text exceeds ${maxTextLength}-character limit` });
      return;
    }

    // Empty input is a valid no-op — emit the empty scrub explicitly
    // rather than asking `detectPII` to handle it.
    if (text.length === 0) {
      return { scrubbed: '', entities: [] as ScrubResponseBody['entities'] };
    }

    const rawMatches = detectPII(text);
    const filtered = filterMatches(rawMatches, allowList);

    // Log only counts — NEVER the raw text or the matched values.
    req.log.info(
      {
        pii_raw_matches: rawMatches.length,
        pii_matches: filtered.length,
        pii_allow_list_size: allowList?.size() ?? 0,
        pii_input_length: text.length,
      },
      'pii scrub',
    );

    // Assign per-type sequential tokens in document order — matches the
    // semantics of `scrubPII` in `@dina/core` but reapplied here because
    // we need the filtered set, not the raw set.
    const byStart = filtered.slice().sort((a, b) => a.start - b.start);
    const typeCounts: Record<string, number> = {};
    const entities: ScrubResponseBody['entities'] = [];
    for (const m of byStart) {
      const n = (typeCounts[m.type] ?? 0) + 1;
      typeCounts[m.type] = n;
      entities.push({
        type: m.type,
        start: m.start,
        end: m.end,
        value: m.value,
        token: `[${m.type}_${n}]`,
      });
    }

    // Rebuild the scrubbed string back-to-front so offsets in
    // `entities` still reference the ORIGINAL text (the contract the
    // rehydrate flow depends on).
    let scrubbed = text;
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i]!;
      scrubbed = scrubbed.slice(0, e.start) + e.token + scrubbed.slice(e.end);
    }

    return { scrubbed, entities };
  });

  // -------------------------------------------------------------------------
  // POST /v1/pii/rehydrate  (task 4.79)
  //
  // Restore PII values into a scrubbed text. Supports two request shapes:
  //
  //   Session mode: { session_id, text, consume? }
  //     Requires `rehydrationSessions` to have been wired in. Looks up
  //     the cached entities by session_id. `consume: true` destroys
  //     the session after rehydrate (single-use semantics).
  //
  //   Direct mode:  { text, entities: [{token, value}, ...] }
  //     Stateless. Same mapping shape the scrub response emits; the
  //     caller supplies it so the server never holds PII.
  //
  // Response 200: { rehydrated }
  // Response 400: malformed body (missing/wrong types)
  // Response 404: session_id unknown or expired
  // Response 501: session mode requested but no registry configured
  // -------------------------------------------------------------------------

  app.post('/v1/pii/rehydrate', async (req, reply) => {
    const body = (req.body ?? {}) as {
      session_id?: unknown;
      text?: unknown;
      entities?: unknown;
      consume?: unknown;
    };
    if (typeof body.text !== 'string') {
      await reply.code(400).send({ error: 'text is required' });
      return;
    }
    const text = body.text;
    if (text.length > maxTextLength) {
      await reply
        .code(413)
        .send({ error: `text exceeds ${maxTextLength}-character limit` });
      return;
    }

    const hasSessionId = typeof body.session_id === 'string' && body.session_id.length > 0;
    const hasEntities = Array.isArray(body.entities);

    if (hasSessionId && hasEntities) {
      await reply
        .code(400)
        .send({ error: 'provide either session_id or entities, not both' });
      return;
    }
    if (!hasSessionId && !hasEntities) {
      await reply.code(400).send({ error: 'session_id or entities is required' });
      return;
    }

    let entities: ReadonlyArray<RehydrationEntity>;
    if (hasSessionId) {
      if (rehydrationSessions === undefined) {
        await reply
          .code(501)
          .send({ error: 'session-based rehydrate is not enabled on this server' });
        return;
      }
      const sessionId = body.session_id as string;
      const consume = body.consume === true;
      const fetched = consume
        ? rehydrationSessions.consume(sessionId)
        : rehydrationSessions.get(sessionId);
      if (fetched === undefined) {
        await reply.code(404).send({ error: 'session not found or expired' });
        return;
      }
      entities = fetched;
    } else {
      const raw = body.entities as unknown[];
      const validated: RehydrationEntity[] = [];
      for (const e of raw) {
        if (
          typeof e !== 'object' ||
          e === null ||
          typeof (e as { token?: unknown }).token !== 'string' ||
          typeof (e as { value?: unknown }).value !== 'string' ||
          ((e as { token: string }).token).length === 0
        ) {
          await reply
            .code(400)
            .send({ error: 'entities must be [{token: string, value: string}, ...]' });
          return;
        }
        validated.push({
          token: (e as { token: string }).token,
          value: (e as { value: string }).value,
        });
      }
      entities = validated;
    }

    const rehydrated = rehydratePII(text, [...entities]);
    req.log.info(
      {
        pii_rehydrate_mode: hasSessionId ? 'session' : 'direct',
        pii_rehydrate_entity_count: entities.length,
        pii_input_length: text.length,
      },
      'pii rehydrate',
    );
    return { rehydrated };
  });

  // -------------------------------------------------------------------------
  // POST /v1/pii/session  (task 4.79 companion — session-create)
  //
  // Registers an entity map in the session cache. Only available when
  // `rehydrationSessions` was wired in.
  //
  // Request:  { entities: [{token, value}, ...], ttl_ms? }
  // Response: { session_id, expires_at }
  // -------------------------------------------------------------------------

  if (rehydrationSessions !== undefined) {
    app.post('/v1/pii/session', async (req, reply) => {
      const body = (req.body ?? {}) as {
        entities?: unknown;
        ttl_ms?: unknown;
      };
      if (!Array.isArray(body.entities)) {
        await reply.code(400).send({ error: 'entities must be an array' });
        return;
      }
      const raw = body.entities as unknown[];
      const validated: RehydrationEntity[] = [];
      for (const e of raw) {
        if (
          typeof e !== 'object' ||
          e === null ||
          typeof (e as { token?: unknown }).token !== 'string' ||
          typeof (e as { value?: unknown }).value !== 'string' ||
          ((e as { token: string }).token).length === 0
        ) {
          await reply
            .code(400)
            .send({ error: 'entities must be [{token: string, value: string}, ...]' });
          return;
        }
        validated.push({
          token: (e as { token: string }).token,
          value: (e as { value: string }).value,
        });
      }
      let ttlMs: number | undefined;
      if (body.ttl_ms !== undefined) {
        if (typeof body.ttl_ms !== 'number' || !Number.isFinite(body.ttl_ms) || body.ttl_ms <= 0) {
          await reply.code(400).send({ error: 'ttl_ms must be a positive number' });
          return;
        }
        ttlMs = body.ttl_ms;
      }
      const { sessionId, expiresAtMs } = rehydrationSessions.create(
        validated,
        ttlMs !== undefined ? { ttlMs } : {},
      );
      return { session_id: sessionId, expires_at: expiresAtMs };
    });
  }
}
