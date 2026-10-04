/**
 * The gateway's public surface (design §4.1, §7.1, §7.2):
 *
 *   GET  /.well-known/agent-card.json   the signed card, as Core built it
 *   GET  /.well-known/jwks.json         the key set the card's `jku` names
 *   POST /a2a/v1                        JSON-RPC: every A2A v1.0 method
 *   GET|POST|DELETE /a2a/rest/...       REST (HTTP+JSON): the same methods,
 *                                       at the v1.0 paths (`@dina/a2a`
 *                                       `rest_binding.ts`)
 *   POST /a2a/v1/did-binding            binds a client to a DID (design §5.1)
 *   GET  /healthz
 *
 * The gateway decides nothing. It keeps the client's raw body as a string,
 * picks the internal route from the body by the shared table, and forwards
 * the raw body with the client's credential to Core, signed with its own
 * key: the `Authorization` header, or a DID-bound client's four signature
 * headers (`X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature`), passed as
 * they came; Core authenticates the client, re-derives the route from the
 * body and refuses a mismatch. The gateway answers only what needs no
 * authority: protocol errors, methods Dina does not serve, its edge limit,
 * and oversized bodies.
 *
 * Streaming calls (`SendStreamingMessage`, `SubscribeToTask`; JSON-RPC
 * binding §9.4.2, REST §11) answer as Server-Sent Events: each `data:` line
 * is a JSON-RPC response with the call's id, or over REST the bare
 * StreamResponse. The first is Core's answer (the
 * Task, or Core's JSON-RPC error, after which the stream ends); later ones
 * are the task's events from the hub, until the task ends, its authority
 * goes, the stream reaches its lifetime, or the client falls too far
 * behind. A stream slot is taken before the call reaches Core, so a client
 * over its limit creates no task it cannot watch.
 *
 * Logs carry the method, status and latency. Never a body, a token or an id.
 */

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import {
  A2A_BEARER_CHALLENGE,
  A2A_DID_BINDING_PATH,
  A2A_DID_COMPLETE_ROUTE,
  A2A_LIMITS,
  A2A_REST_CONTENT_TYPE,
  A2A_REST_PATH,
  A2A_STREAMING_METHODS,
  DID_REQUEST_HEADERS,
  A2A_VERSION_HEADER,
  STREAM_ENDING_TASK_STATES,
  a2aError,
  canonicalize,
  ingressPathFor,
  isPlainObject,
  jsonRpcError,
  matchRestRequest,
  parseJsonRpcRequestText,
  restIngressPath,
  restMethodsFor,
  type JsonObject,
  type JsonValue,
  type TaskState,
} from '@dina/a2a';
import { A2A_JWKS_PATH, A2A_RPC_PATH, type GatewayEnvelope } from '@dina/core';

import { StreamSlots, type StreamHub, type StreamStart } from './stream_hub';

import type { CoreAnswer, CoreLink } from './core_link';
import type { EdgeLimiter } from './edge_limit';
import type { IncomingHttpHeaders } from 'node:http';
import type { Logger } from 'pino';

export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export interface StreamLimits {
  perIp: number;
  maxLifetimeMs: number;
  keepaliveMs: number;
  maxBufferedBytes: number;
}

export interface GatewayServerDeps {
  core: CoreLink;
  limiter: EdgeLimiter;
  logger: Logger;
  cardCacheMs: number;
  /** Proxy hops trusted for X-Forwarded-For (0: none). Never `true`: that trusts the client's own entries. */
  trustProxy: number;
  hub: StreamHub;
  streams: StreamLimits;
  now?: () => number;
}

const SSE_HEAD = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

/**
 * The state of the Task in Core's answer to a streaming call, or null when
 * it carries none. The answer is `{task}`, inside a JSON-RPC result or, over
 * REST, bare.
 */
/** Where a stream on Core's answer starts, and whose it is: null when Core's answer does not say. */
function streamStartOf(answer: CoreAnswer): StreamStart | null {
  const { eventSeq, credentialGen, streamClient } = answer;
  if (eventSeq === undefined || credentialGen === undefined || streamClient === undefined) return null;
  return { afterSeq: eventSeq, client: streamClient, credentialGen };
}

function answeredTaskState(body: unknown): { id: string; state: TaskState } | null {
  const response = isPlainObject(body) && body.jsonrpc === '2.0' ? body.result : body;
  if (!isPlainObject(response) || !isPlainObject(response.task)) return null;
  const task = response.task;
  if (
    typeof task.id !== 'string' ||
    !isPlainObject(task.status) ||
    typeof task.status.state !== 'string'
  )
    return null;
  return { id: task.id, state: task.status.state as TaskState };
}

interface CachedCard {
  at: number;
  /** The card as served: its canonical JSON text. */
  cardText: string;
  jwks: unknown;
}

const PUBLIC_DOC_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=30',
} as const;

/**
 * The client's credential as it came: its `Authorization` header and, if it
 * signs its requests with its DID, the four signature headers. Core decides
 * which counts (one, never both).
 */
function clientAuth(headers: IncomingHttpHeaders): GatewayEnvelope['client_auth'] {
  const one = (name: string): string | undefined => {
    const v = headers[name];
    return typeof v === 'string' ? v : undefined;
  };
  const authorization = one('authorization');
  const did = one(DID_REQUEST_HEADERS.did);
  const timestamp = one(DID_REQUEST_HEADERS.timestamp);
  const nonce = one(DID_REQUEST_HEADERS.nonce);
  const signature = one(DID_REQUEST_HEADERS.signature);
  const signed =
    did !== undefined || timestamp !== undefined || nonce !== undefined || signature !== undefined
      ? { did_signature: { did: did ?? '', timestamp: timestamp ?? '', nonce: nonce ?? '', signature: signature ?? '' } }
      : {};
  return { ...(authorization === undefined ? {} : { authorization }), ...signed };
}

export function buildGatewayServer(deps: GatewayServerDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: false,
    trustProxy: deps.trustProxy > 0 ? deps.trustProxy : false,
    bodyLimit: A2A_LIMITS.maxPayloadBytes,
  });

  // The raw body, byte for byte: Core binds the route to it and hashes it.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(['application/json', A2A_REST_CONTENT_TYPE], { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  // A REST client reads every error as a `google.rpc.Status`; the reference
  // SDK fails outright on anything else. JSON-RPC and the other doors keep
  // their plain answers.
  const isRestPath = (url: string | undefined): boolean => {
    const path = (url ?? '').split('?')[0] ?? '';
    return path === A2A_REST_PATH || path.startsWith(`${A2A_REST_PATH}/`);
  };

  app.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    const rest = isRestPath(req.raw.url);
    const reason =
      status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : status < 500 ? 'bad_request' : 'internal';
    if (status >= 500) deps.logger.error({ status }, 'a2a gateway error');
    const code = status >= 400 && status < 500 ? status : 500;
    if (rest) return restEdge(reply, code, code === 500 ? 'INTERNAL' : 'INVALID_ARGUMENT', reason);
    return reply.code(code).send({ error: reason });
  });

  app.setNotFoundHandler((req, reply) => {
    if (isRestPath(req.raw.url)) return restEdge(reply, 404, 'NOT_FOUND', 'not_found');
    return reply.code(404).send({ error: 'not_found' });
  });

  let cached: CachedCard | null = null;
  let fetching: Promise<CachedCard | null> | null = null;
  async function currentCard(): Promise<CachedCard | null> {
    if (cached !== null && now() - cached.at < deps.cardCacheMs) return cached;
    fetching ??= deps.core
      .card()
      .then((got) => {
        if (!got.ok) {
          deps.logger.warn({ status: got.status }, 'a2a card unavailable from Core');
          return null;
        }
        cached = { at: now(), cardText: canonicalize(got.card as JsonValue), jwks: got.jwks };
        return cached;
      })
      .finally(() => {
        fetching = null;
      });
    return fetching;
  }

  const limited = (ip: string): boolean => !deps.limiter.allow(ip);

  const slots = new StreamSlots(deps.hub, deps.streams.perIp);

  /**
   * Answer a streaming call whose client is still there (see the module
   * comment). The call is "on its way" until its stream registers with the
   * hub, so events delivered in between are kept for it; then `finish`,
   * the one way a stream ends (the task ending, Core's order to close, the
   * lifetime, a client too far behind, the client leaving), unregisters it
   * and frees its slot, once.
   */
  function stream(
    reply: FastifyReply,
    ip: string,
    frame: (event: JsonObject) => unknown,
    answer: CoreAnswer,
    refuse: (why: 'unauthenticated' | 'unavailable') => void,
  ): void {
    const task = answeredTaskState(answer.body);
    // Nothing of a Task goes out, its opening frame included, until the
    // gateway knows whose credential the call was answered under and no
    // fence holds it back (design §10): a credential that ended before the
    // answer got here takes the answer with it. A Task answer that does not
    // say is not relayed.
    let start: StreamStart | null = null;
    if (task !== null) {
      start = streamStartOf(answer);
      if (start === null || !deps.hub.admits(start.client, start.credentialGen)) {
        slots.answered();
        slots.release(ip);
        refuse(start === null ? 'unavailable' : 'unauthenticated');
        return;
      }
    }
    reply.hijack();
    const raw = reply.raw;
    let finished = false;
    let unregister: (() => void) | null = null;
    // Set once the stream is registered; `finish` clears them.
    const timers: {
      keepalive?: ReturnType<typeof setInterval>;
      lifetime?: ReturnType<typeof setTimeout>;
    } = {};
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearInterval(timers.keepalive);
      clearTimeout(timers.lifetime);
      unregister?.();
      slots.release(ip);
      if (!raw.writableEnded) raw.end();
    };
    raw.once('close', finish);
    raw.writeHead(200, SSE_HEAD);
    const write = (body: unknown): void => {
      if (finished || raw.destroyed) return;
      raw.write(`data: ${JSON.stringify(body)}\n\n`);
      if (raw.writableLength > deps.streams.maxBufferedBytes) finish();
    };
    write(answer.body);
    // A task already at a terminal or interrupted state has nothing more
    // to stream: the client sees it, and the stream ends.
    if (task !== null && start !== null && !STREAM_ENDING_TASK_STATES.has(task.state)) {
      unregister = deps.hub.open(task.id, start, {
        send: (event: JsonObject) => write(frame(event)),
        end: finish,
      });
    }
    // Registered (or not to be): no longer on its way.
    slots.answered();
    // Not registered, or a buffered event already ended it.
    if (unregister === null || finished) {
      finish();
      return;
    }
    timers.keepalive = setInterval(() => {
      if (!finished && !raw.destroyed) raw.write(': keepalive\n\n');
    }, deps.streams.keepaliveMs);
    timers.keepalive.unref?.();
    timers.lifetime = setTimeout(finish, deps.streams.maxLifetimeMs);
    timers.lifetime.unref?.();
  }

  app.get(AGENT_CARD_PATH, async (req, reply) => {
    if (limited(req.ip))
      return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
    const card = await currentCard();
    if (card === null) return reply.code(503).send({ error: 'unavailable' });
    // The card's canonical bytes (RFC 8785), the bytes its signature covers:
    // the same bytes the node publishes to the directory (design §8.2), so a
    // reader can compare them, not just their meaning.
    return reply
      .code(200)
      .headers({ ...PUBLIC_DOC_HEADERS, 'content-type': 'application/json' })
      .send(card.cardText);
  });

  app.get(A2A_JWKS_PATH, async (req, reply) => {
    if (limited(req.ip))
      return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
    const card = await currentCard();
    if (card === null) return reply.code(503).send({ error: 'unavailable' });
    return reply.code(200).headers(PUBLIC_DOC_HEADERS).send(card.jwks);
  });

  app.get('/healthz', async () => ({ ok: true }));

  // The DID binding (design §5.1): plain JSON, forwarded as it came. The
  // owner's challenge, which names the DID, is the authority; Core checks it
  // and the signature, and wants no other credential.
  app.post(A2A_DID_BINDING_PATH, async (req, reply) => {
    if (limited(req.ip)) return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
    const url = req.raw.url ?? '';
    const q = url.indexOf('?');
    const forwarded = await deps.core.forward(A2A_DID_COMPLETE_ROUTE, {
      request: {
        method: 'POST',
        path: A2A_DID_BINDING_PATH,
        query: q === -1 ? '' : url.slice(q + 1),
        body: typeof req.body === 'string' ? req.body : '',
      },
      client_auth: {},
    });
    if (!forwarded.ok) {
      deps.logger.warn({ core_status: forwarded.status }, 'a2a did binding not answered by Core');
      return reply.code(503).send({ error: 'unavailable' });
    }
    deps.logger.info({ status: forwarded.answer.status }, 'a2a did binding');
    return reply.code(forwarded.answer.status).headers(forwarded.answer.headers).send(forwarded.answer.body);
  });

  app.post(A2A_RPC_PATH, async (req, reply) => {
    const started = now();
    if (limited(req.ip))
      return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
    const raw = typeof req.body === 'string' ? req.body : '';
    const parsed = parseJsonRpcRequestText(raw);
    if (!parsed.ok) {
      // A notification (no id) asks for no reply; nothing runs.
      if ('notification' in parsed) return reply.code(204).send();
      return reply.code(200).send(jsonRpcError(parsed.id, parsed.error));
    }
    const { request } = parsed;
    const route = ingressPathFor(request);
    if (!route.ok) {
      // A dot-segment id names no task, and no forward could keep it: the answer Core gives an unknown id.
      const error = route.reason === 'id_unroutable' ? a2aError('taskNotFound') : a2aError('invalidParams', route.reason);
      return reply.code(200).send(jsonRpcError(request.id, error));
    }
    const streaming = A2A_STREAMING_METHODS.has(request.method);
    // A streaming call takes its slot first, and notes if its client leaves
    // while Core answers: then no stream opens, and the slot is freed.
    let left = false;
    if (streaming) {
      if (!slots.take(req.ip))
        return reply.code(429).header('retry-after', '60').send({ error: 'too_many_streams' });
      reply.raw.once('close', () => {
        left = true;
      });
    }
    const url = req.raw.url ?? '';
    const q = url.indexOf('?');
    const version = req.headers[A2A_VERSION_HEADER.toLowerCase()];

    const forwarded = await deps.core.forward(route.path, {
      request: {
        method: 'POST',
        path: A2A_RPC_PATH,
        query: q === -1 ? '' : url.slice(q + 1),
        body: raw,
        ...(typeof version === 'string' ? { version } : {}),
      },
      client_auth: clientAuth(req.headers),
    });
    const streams = streaming && forwarded.ok && forwarded.answer.status === 200 && !left;
    if (streaming && !streams) {
      // No stream follows a refusal, or a client that left: the slot is free again.
      slots.answered();
      slots.release(req.ip);
    }
    if (left) {
      reply.hijack();
      reply.raw.destroy();
      return reply;
    }
    if (!forwarded.ok) {
      deps.logger.warn(
        { method: request.method, core_status: forwarded.status },
        'a2a call not answered by Core',
      );
      return reply.code(503).send({ error: 'unavailable' });
    }
    const { answer } = forwarded;
    deps.logger.info(
      { method: request.method, status: answer.status, ms: now() - started },
      'a2a call',
    );
    if (streams) {
      stream(reply, req.ip, (event) => ({ jsonrpc: '2.0', id: request.id, result: event }), answer, (why) => {
        if (why === 'unavailable') reply.code(503).send({ error: 'unavailable' });
        else reply.code(401).headers({ 'www-authenticate': A2A_BEARER_CHALLENGE }).send({ error: 'unauthenticated' });
      });
      return reply;
    }
    return reply.code(answer.status).headers(answer.headers).send(answer.body);
  });

  // REST (HTTP+JSON): the method and path name the operation; Core reads its
  // params from the path, the query and the body, and answers bare.
  // Every method, so one the binding does not serve is a 405 naming those it does.
  app.route({
    method: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
    url: `${A2A_REST_PATH}/*`,
    handler: async (req, reply) => {
      const started = now();
      const url = req.raw.url ?? '';
      const q = url.indexOf('?');
      // The path as the client sent it, still percent-encoded: Core matches it again.
      const path = q === -1 ? url : url.slice(0, q);
      if (limited(req.ip)) return restEdge(reply, 429, 'RESOURCE_EXHAUSTED', 'rate_limited', { 'retry-after': '60' });
      const match = matchRestRequest(req.method, path);
      if (match === null) {
        const allowed = restMethodsFor(path);
        if (allowed.length > 0) return restEdge(reply, 405, 'UNIMPLEMENTED', 'method_not_allowed', { allow: allowed.join(', ') });
        return restEdge(reply, 404, 'NOT_FOUND', 'not_found');
      }
      const streaming = A2A_STREAMING_METHODS.has(match.operation);
      let left = false;
      if (streaming) {
        if (!slots.take(req.ip)) return restEdge(reply, 429, 'RESOURCE_EXHAUSTED', 'too_many_streams', { 'retry-after': '60' });
        reply.raw.once('close', () => {
          left = true;
        });
      }
      const version = req.headers[A2A_VERSION_HEADER.toLowerCase()];
      const forwarded = await deps.core.forward(restIngressPath(match), {
        request: {
          method: req.method,
          path,
          query: q === -1 ? '' : url.slice(q + 1),
          body: typeof req.body === 'string' ? req.body : '',
          ...(typeof version === 'string' ? { version } : {}),
        },
        client_auth: clientAuth(req.headers),
      });
      const streams = streaming && forwarded.ok && forwarded.answer.status === 200 && !left;
      if (streaming && !streams) {
        slots.answered();
        slots.release(req.ip);
      }
      if (left) {
        reply.hijack();
        reply.raw.destroy();
        return reply;
      }
      if (!forwarded.ok) {
        deps.logger.warn({ method: match.operation, core_status: forwarded.status }, 'a2a rest call not answered by Core');
        return restEdge(reply, 503, 'UNAVAILABLE', 'unavailable');
      }
      const { answer } = forwarded;
      deps.logger.info({ method: match.operation, binding: 'rest', status: answer.status, ms: now() - started }, 'a2a call');
      if (streams) {
        stream(reply, req.ip, (event) => event, answer, (why) => {
          if (why === 'unavailable') restEdge(reply, 503, 'UNAVAILABLE', 'unavailable');
          else restEdge(reply, 401, 'UNAUTHENTICATED', 'unauthenticated', { 'www-authenticate': A2A_BEARER_CHALLENGE });
        });
        return reply;
      }
      return reply
        .code(answer.status)
        .headers(answer.headers)
        .header('content-type', A2A_REST_CONTENT_TYPE)
        .send(answer.body);
    },
  });

  return app;
}

/** The gateway's own answer to a REST client: a `google.rpc.Status`, as Core's are. */
function restEdge(
  reply: FastifyReply,
  code: number,
  status: string,
  reason: string,
  headers: Record<string, string> = {},
): FastifyReply {
  return reply
    .code(code)
    .headers({ ...headers, 'content-type': A2A_REST_CONTENT_TYPE })
    .send({ error: { code, status, message: reason } });
}
