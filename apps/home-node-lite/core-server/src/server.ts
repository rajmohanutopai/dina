/**
 * Task 4.6 (Fastify half) + 4.7 (per-request log bindings) + 4.10
 * (/healthz + /readyz).
 *
 * **Split from `main.ts` on purpose.** The composition root (main.ts)
 * builds config, logger, and adapter wires — then hands those
 * dependencies to `createServer()`. Tests instantiate the server
 * without going through the boot ceremony.
 *
 * **Log-field parity with Go slog (task 4.7).** Go slog emits
 * `time`, `level`, `msg`, plus per-request fields `persona`, `did`,
 * `request_id`, `route`. The pino base logger already emits the first
 * three in the slog shape (see logger.ts). Here we add per-request
 * bindings via Fastify's `request.log` child-logger + an `onRequest`
 * hook that populates `request_id` + `route` immediately. The
 * auth middleware (task 4.19+) will attach `did` + `persona` after
 * signature verification by calling `req.bindDidContext(...)`.
 *
 * `/healthz` — always 200 when the process is alive (liveness probe).
 *   Mirrors Go's `core/internal/handler/healthz.go`.
 *
 * `/readyz` — 200 when all dependencies the server needs to answer
 *   requests are reachable. Today that's the process itself (no DB yet;
 *   storage-node pending). As DB + MsgBox + PLC connections land,
 *   they'll be added to the readiness probe — each as a named check
 *   with its own status. Returns 503 with a `{status:"not_ready",
 *   checks:{...}}` body if any named check fails.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4a tasks 4.6 + 4.7 + 4.10.
 */

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import type { Logger } from './logger';
import type { CoreServerConfig } from './config';
import { getServerVersion } from './version';
import { installAgentContextDecorator } from './auth/agent_did_decorator';
import { REQUEST_ID_HEADER, validateRequestId } from './trace/trace_context';

// ---------------------------------------------------------------------------
// Request-log context (task 4.7)
// ---------------------------------------------------------------------------

/**
 * Fields we bind onto every request's child logger to match Go slog's
 * per-request context shape.
 *
 *   - `request_id` — stable id for the lifetime of the request. Set
 *     once at `onRequest`; mirrors Go Core's `RequestID` context value.
 *   - `route` — the matched route path (`/v1/vault/store`), NOT the
 *     raw URL. Matters so log correlation works even for parameterised
 *     routes (`/v1/vault/items/:id`).
 *   - `did` / `persona` — attached by the auth middleware once it's
 *     verified the signature (task 4.19+). Unknown before auth runs.
 */
export interface RequestLogBindings {
  request_id: string;
  route?: string;
  did?: string;
  persona?: string;
}

declare module 'fastify' {
  // Augment Fastify's per-request type surface so downstream code can
  // call `req.bindDidContext(...)` to tag auth-derived fields onto the
  // request logger after verification.
  interface FastifyRequest {
    /**
     * Attach `did` + `persona` to this request's log context. Called
     * by the auth middleware after it verifies a signed request.
     * Re-calls overwrite. Safe to call multiple times.
     */
    bindDidContext(ctx: { did?: string; persona?: string }): void;
  }
}

/** One readiness check — e.g. "db", "msgbox", "plc". */
export interface ReadinessCheck {
  /** Short name rendered in the response body. */
  name: string;
  /** Returns true when the dependency is reachable; false when not. */
  probe: () => Promise<boolean> | boolean;
}

export interface CreateServerOptions {
  config: CoreServerConfig;
  logger: Logger;
  /** Optional readiness checks. None by default — today we only probe
   *  the process. Adapters + DB add their checks as they're wired. */
  readinessChecks?: ReadinessCheck[];
}

/**
 * Build an unlistened Fastify instance. Caller `await server.listen(...)`.
 *
 * **Async** so plugin registrations (`@fastify/sensible`,
 * `@fastify/rate-limit`) can be awaited before route handlers attach —
 * without the await, a plugin's hooks don't install before downstream
 * route definitions fire and the hook never applies to those routes.
 *
 * The return type is deliberately inferred (not annotated) because
 * Fastify's `FastifyInstance` default generics pick `FastifyBaseLogger`
 * while we supply a full pino `Logger`. Annotating the return forces
 * a child-logger-factory mismatch under strict tsconfig; letting
 * inference run preserves the pino-typed logger end-to-end.
 */
export async function createServer(opts: CreateServerOptions) {
  const { config, logger, readinessChecks = [] } = opts;

  const app = Fastify({
    // Hand Fastify the project logger; its own request/error logs slot
    // into the same JSON / pretty stream as our business logs.
    loggerInstance: logger,
    // Rename Fastify's default `reqId` binding to `request_id` so even
    // its built-in access-log-style entries ("incoming request",
    // "request completed") match Go slog's snake_case field naming.
    requestIdLogLabel: 'request_id',
    // Task 4.35 + 4.86: prefer a client-supplied `X-Request-Id` header
    // (Brain → Core propagation for distributed tracing), but VALIDATE
    // it first — a malformed / oversized / CRLF-bearing inbound id
    // would become a log-injection vector if blindly echoed. We
    // disable Fastify's built-in header-consumption (`requestIdHeader:
    // false`) and do it ourselves inside `genReqId` so we can fall
    // back to the monotonic generator when validation fails.
    requestIdHeader: false,
    genReqId: makeRequestIdGenerator(),
    disableRequestLogging: false,
    // Task 4.32: 2 MiB write-body cap matches Go Core. Larger payloads
    // (blob uploads) bypass the Core HTTP surface — they go through
    // the MsgBox binary path (task 4.41+).
    bodyLimit: 2 * 1024 * 1024,
  });

  // ── Agent-context decorator (task 4.28) ─────────────────────────────
  //
  // Reserve the shape on every FastifyRequest so handlers can type-safely
  // read `req.agentDid` / `req.agentCallerType` / `req.agentSessionId`.
  // Auth middleware calls `setAgentContext(req, {...})` after verifying
  // a signed request; unauthenticated routes leave these as `null`.
  installAgentContextDecorator(app);

  // ── Per-request log bindings (task 4.7) ─────────────────────────────
  //
  // On every incoming request, replace the default Fastify child
  // logger with one bound to `request_id` + `route` — the slog-parity
  // field names. The `route` is read from Fastify's matched routeOptions
  // (so `/v1/vault/items/:id` logs with the pattern, not the filled URL).
  //
  // `bindDidContext` rebinds the child logger with additional fields
  // after auth middleware has identified the caller. The wrapping is
  // cheap (pino child loggers share config with the parent).

  app.addHook('onRequest', async (req) => {
    const route = req.routeOptions?.url ?? req.url;
    req.log = req.log.child({
      request_id: String(req.id),
      route,
    });
    req.bindDidContext = (ctx) => {
      req.log = req.log.child({
        ...(ctx.did !== undefined ? { did: ctx.did } : {}),
        ...(ctx.persona !== undefined ? { persona: ctx.persona } : {}),
      });
    };
  });

  // ── Request-ID echo (task 4.35) ─────────────────────────────────────
  //
  // Echo the final `request_id` back as `X-Request-Id` on every
  // response — clients / upstream proxies use this to correlate their
  // logs with ours. Because task 4.35 also accepts an inbound
  // `X-Request-Id` header (handled via Fastify's `requestIdHeader`
  // option), the value round-trips: client sends it, we log under it,
  // we echo it back.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', String(req.id));
  });

  // ── Content-Type JSON enforcement (task 4.33) ───────────────────────
  //
  // Writes (POST / PUT / PATCH) with a body MUST declare `Content-Type:
  // application/json` (or `application/octet-stream` for the binary
  // upload path). Anything else → 415 Unsupported Media Type. This
  // prevents the classic "forgot the header" bug where Fastify's
  // default text parser silently swallows a JSON payload. GET/DELETE
  // are exempt — they should never carry a body.
  //
  // Admin / pairing-bypass paths are exempt from this check because
  // their auth flows may accept form-encoded callbacks from browsers.
  // (Today there are no such routes registered; the exemption is
  // future-proofing.)
  const ENFORCED_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
  const ALLOWED_CONTENT_TYPES = [
    'application/json',
    'application/octet-stream',
  ];
  app.addHook('onRequest', async (req, reply) => {
    if (!ENFORCED_WRITE_METHODS.has(req.method)) return;
    // Empty-body writes are allowed through (e.g. POST to trigger an
    // action that takes no input) — check only when a body is present.
    const contentLength = Number(req.headers['content-length'] ?? '0');
    if (contentLength === 0 && req.headers['transfer-encoding'] !== 'chunked') {
      return;
    }
    const raw = req.headers['content-type'];
    const ct = typeof raw === 'string' ? raw.split(';')[0]?.trim().toLowerCase() ?? '' : '';
    if (!ALLOWED_CONTENT_TYPES.some((allowed) => ct === allowed)) {
      await reply.code(415).send({ error: 'unsupported media type' });
    }
  });

  // ── Error envelope (task 4.8) ───────────────────────────────────────
  //
  // `@fastify/sensible` gives us `reply.notFound()`, `reply.badRequest()`,
  // etc. — typed HTTP-error helpers that throw `createError()` objects
  // which our custom `setErrorHandler` then renders in Dina's canonical
  // error-envelope shape: `{ "error": "<message>" }`.
  //
  // **Parity target (Go Core).** Go's handlers write
  // `http.Error(w, "<msg>", status)` which emits a plain-text body; our
  // server's Fastify envelope wraps the same status + message in JSON
  // under the key `error`. Per the plan in tasks 4.17-4.18, the key
  // names and status codes match Go per-handler; exact error-message
  // strings are tracked in M5 test fixtures, not globally.
  //
  // **5xx messages are masked** — Fastify's default leaks the raw
  // thrown-error message into the response body, which can expose
  // internal details. We override with a constant "internal server
  // error" and log the original with the full request context.

  // ── CORS (task 4.31) ────────────────────────────────────────────────
  //
  // Semantics match Go Core's `middleware/cors.go`:
  //   - unset / empty → same-origin only (no CORS headers emitted)
  //   - "*"          → wildcard, no credentials
  //   - comma-list   → exact-match allowlist, credentials enabled
  //
  // Methods (GET, POST, PUT, DELETE, OPTIONS) and headers
  // (Authorization, Content-Type) mirror Go's hardcoded set.
  const corsAllowOrigin = config.cors.allowOrigin?.trim() ?? '';
  if (corsAllowOrigin !== '') {
    const allowedOrigins = corsAllowOrigin
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const isWildcard = allowedOrigins.length === 1 && allowedOrigins[0] === '*';
    await app.register(cors, {
      origin: isWildcard ? '*' : allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      // Go emits `Access-Control-Allow-Credentials: true` only when the
      // origin isn't a wildcard (CORS spec forbids credentials + `*`).
      credentials: !isWildcard,
      // Preflight → 204 No Content (matches Go).
      optionsSuccessStatus: 204,
    });
  }

  await app.register(sensible);

  // ── Rate limit (task 4.30) ──────────────────────────────────────────
  //
  // Per-DID budget: `config.runtime.rateLimitPerMinute` requests / 60s
  // window. Default 60 (matches Go Core); `DINA_RATE_LIMIT` env var
  // overrides via the config layer (task 4.4). The keyGenerator
  // prefers `X-DID` when present (signed-request identifier) so each
  // caller gets its own bucket; falls back to IP otherwise. /healthz
  // + /readyz are deliberately exempt so an overloaded node can still
  // be probed by orchestrators.
  //
  // **Must be awaited** — without the await, the plugin's hooks don't
  // install before downstream route definitions, so the rate-limit
  // hook never fires.
  await app.register(rateLimit, {
    max: config.runtime.rateLimitPerMinute,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
    keyGenerator: (req) => {
      const did = req.headers['x-did'];
      if (typeof did === 'string' && did.length > 0) return `did:${did}`;
      return `ip:${req.ip}`;
    },
    // `@fastify/rate-limit` THROWS the return value of
    // errorResponseBuilder — it doesn't send it directly (see the
    // plugin's `throw params.errorResponseBuilder(...)` at
    // node_modules/@fastify/rate-limit/index.js). So the returned
    // object must carry `statusCode` (for our setErrorHandler's
    // 4xx-vs-5xx branch) and a `message` our envelope renderer can use.
    errorResponseBuilder: (_req, context) => {
      const err: Error & { statusCode?: number } = new Error(
        `rate limit exceeded: ${context.max} requests per ${context.after}`,
      );
      err.statusCode = 429;
      return err;
    },
  });

  app.setErrorHandler(async (err, req, reply) => {
    // Fastify's error-handler signature types `err` as `FastifyError`
    // (which extends Error with optional statusCode + code); under
    // strict tsconfig we still narrow explicitly so `.message` / `.code`
    // accesses are safe.
    const fastifyErr = err as {
      message: string;
      stack?: string;
      code?: string;
      statusCode?: number;
    };
    const status = typeof fastifyErr.statusCode === 'number' ? fastifyErr.statusCode : 500;

    if (status >= 500) {
      // Log the full error server-side with request context; the client
      // only sees a generic 500 message.
      req.log.error(
        { err: { message: fastifyErr.message, stack: fastifyErr.stack, code: fastifyErr.code } },
        'request failed (5xx)',
      );
      await reply.code(status).send({ error: 'internal server error' });
      return;
    }

    // 4xx: client-visible message is safe to echo back. Validation
    // errors from Fastify carry a human-readable `message`; bad-request
    // envelopes from httpErrors already have the right shape.
    req.log.warn(
      { status, err: { message: fastifyErr.message, code: fastifyErr.code } },
      'request failed',
    );
    await reply.code(status).send({ error: fastifyErr.message });
  });

  // 404 handler — Fastify's default sends an empty body; Dina wraps
  // it in the same envelope so callers can parse consistently.
  app.setNotFoundHandler(async (_req, reply) => {
    await reply.code(404).send({ error: 'not found' });
  });

  // ── /healthz ─────────────────────────────────────────────────────────
  // Liveness probe: answer 200 with a constant body as long as the
  // process is up enough to serve HTTP. If the event loop is wedged
  // or Fastify has crashed, the probe fails by not responding.

  app.get('/healthz', async () => ({
    status: 'ok',
    // Matches Go Core's /healthz body. Version comes from
    // DINA_CORE_VERSION env (if set by the release pipeline) else the
    // package.json version field, resolved once at boot.
    version: getServerVersion(),
  }));

  // ── /readyz ──────────────────────────────────────────────────────────
  // Readiness probe: aggregate over the supplied checks. 200 when all
  // pass, 503 when any fail. Body shape:
  //   { status: "ok" | "not_ready", checks: { name: "ok" | "fail" } }

  app.get('/readyz', async (_req, reply) => {
    const results: Record<string, 'ok' | 'fail'> = {};
    let allOk = true;
    for (const check of readinessChecks) {
      try {
        const ok = await check.probe();
        results[check.name] = ok ? 'ok' : 'fail';
        if (!ok) allOk = false;
      } catch (err) {
        logger.warn({ check: check.name, err: (err as Error).message }, 'readiness probe threw');
        results[check.name] = 'fail';
        allOk = false;
      }
    }
    if (!allOk) {
      await reply.code(503).send({ status: 'not_ready', checks: results });
      return;
    }
    return { status: 'ok', checks: results };
  });

  // A tiny hook for tests + ops: surface the effective bind address
  // through a log line when listening starts. Fastify emits its own
  // `serverListening` message too, but includes the port/host in a
  // single line so ops grepping for "listening on" finds one hit.
  app.addHook('onReady', async () => {
    logger.info(
      { host: config.network.host, port: config.network.port },
      'core-server ready',
    );
  });

  return app;
}

// ---------------------------------------------------------------------------
// Request-ID generator (tasks 4.35 + 4.86)
// ---------------------------------------------------------------------------
//
// Fastify calls this for every incoming request. Contract:
//   - If the client supplied a validatable `X-Request-Id`, preserve
//     it (Brain → Core trace correlation).
//   - Otherwise fall back to a monotonic `req-N` id.
//
// Validation (see `src/trace/trace_context.ts`) rejects empty, >128
// chars, or non-printable ASCII / CR / LF / NUL. Rejected values
// silently fall through to the generator — fail-safe, because a
// malformed header may come from a misconfigured proxy and we'd
// rather lose the trace than accept a log-injection vector.
//
// We type the arg loosely because Fastify's `genReqId` signature is
// `(req: FastifyRequest | RawRequestDefault) => string` depending on
// the options shape; the `.headers` access is the only thing we need.

function makeRequestIdGenerator(): (req: { headers: Record<string, unknown> }) => string {
  let seq = 0;
  return (req) => {
    const raw = req?.headers?.[REQUEST_ID_HEADER];
    const headerValue = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
    const v = validateRequestId(typeof headerValue === 'string' ? headerValue : undefined);
    if (v.ok) return v.value;
    seq += 1;
    return `req-${seq}`;
  };
}
