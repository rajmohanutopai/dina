/**
 * Task 4.28 — Agent-DID injected into the Fastify request context.
 *
 * Once the auth middleware (tasks 4.19-4.26, pending composition) has
 * verified a signed request, it needs a place to stash the
 * authenticated caller's DID + CallerType so route handlers can read
 * "who's calling" without re-parsing headers. Fastify's canonical
 * pattern is `decorateRequest` — adds typed properties to every
 * `FastifyRequest` with `null`/default initial values.
 *
 * **Why a decorator, not a hook-mutation.** Augmenting
 * `FastifyRequest` with ad-hoc properties inside a hook works at
 * runtime but trips strict TS under `exactOptionalPropertyTypes` and
 * loses the typed-access surface. `decorateRequest('agentDid', null)`
 * tells Fastify to reserve the shape at startup — fast access (no
 * property-lookup penalty inside the hot path) AND typed-visible to
 * every handler.
 *
 * **API surface**:
 *   - `req.agentDid`: string | null — the verified caller's DID. Set
 *     by auth middleware after signature verification, reset to null
 *     for unauthenticated routes (healthz, readyz, pairing, etc.).
 *   - `req.agentCallerType`: CallerType | null — which class of caller.
 *   - `req.agentSessionId`: string | null — for agent-session grants.
 *     Unused by non-agent callers.
 *
 * Also exposes `setAgentContext(req, ctx)` — the canonical setter
 * called by the middleware so tests + future hooks don't reach
 * directly into `req.*` with conflicting semantics.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4c task 4.28.
 */

import type { FastifyRequest } from 'fastify';
import type { CallerType } from '@dina/core';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Verified caller's DID. `null` until auth middleware sets it;
     * stays `null` for unauthenticated routes (healthz, readyz, pair/*).
     */
    agentDid: string | null;
    /**
     * Verified caller's category: `'brain' | 'admin' | 'connector' |
     * 'device' | 'agent'`. `null` until auth middleware sets it.
     */
    agentCallerType: CallerType | null;
    /**
     * Session id when the caller is an agent working inside a named
     * session (`dina session start --name "task"`). `null` otherwise.
     */
    agentSessionId: string | null;
  }
}

export interface AgentContext {
  did: string;
  callerType: CallerType;
  /** Optional — populated when the caller is an agent with a session grant. */
  sessionId?: string;
}

/**
 * Minimal structural type covering the one Fastify method we call here.
 * Accepting a full `FastifyInstance` would require matching the
 * specific generic parameters (custom Logger etc.) that the concrete
 * instance was built with — those carry pino's `Logger` shape while
 * the default Fastify type picks `FastifyBaseLogger`, so a direct
 * annotation trips strict-tsconfig. Structural typing sidesteps the
 * issue without weakening the type surface callers actually need.
 */
interface DecorateRequestSurface {
  decorateRequest(name: string, value: unknown): unknown;
}

/**
 * Install the decorator triplet. Call once during server setup,
 * before any routes/hooks that consume `req.agentDid`.
 */
export function installAgentContextDecorator(app: DecorateRequestSurface): void {
  app.decorateRequest('agentDid', null);
  app.decorateRequest('agentCallerType', null);
  app.decorateRequest('agentSessionId', null);
}

/**
 * Canonical setter — auth middleware (4.19-4.26) and test hooks call
 * this after signature + allowlist verification. Using the setter
 * (not direct property assignment) gives us a single call-site to
 * also update the request logger's bindings via `req.bindDidContext`,
 * so the structured log context includes the newly-identified caller.
 */
export function setAgentContext(req: FastifyRequest, ctx: AgentContext): void {
  req.agentDid = ctx.did;
  req.agentCallerType = ctx.callerType;
  req.agentSessionId = ctx.sessionId ?? null;
  // Forward to the log-context decorator from task 4.7 so slog-parity
  // `did` / `persona` fields land on every subsequent handler log.
  // Persona binding is intentionally NOT auto-set here — that lives
  // on the gatekeeper layer which decides the access-tier persona
  // for the request's path (not the caller's root DID).
  req.bindDidContext({ did: ctx.did });
}

/**
 * Read shortcut — typed variant of `req.agentDid` that throws when
 * the handler is unauthenticated. Used in route handlers that MUST
 * have a caller (i.e. all authenticated routes).
 */
export function requireAgentContext(req: FastifyRequest): AgentContext {
  if (req.agentDid === null || req.agentCallerType === null) {
    throw new Error(
      'requireAgentContext: no authenticated caller on this request — ' +
        'did the auth middleware run?',
    );
  }
  const ctx: AgentContext = {
    did: req.agentDid,
    callerType: req.agentCallerType,
  };
  if (req.agentSessionId !== null) {
    ctx.sessionId = req.agentSessionId;
  }
  return ctx;
}
