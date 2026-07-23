/**
 * Items 5c/9/11/12 — the coding-agent façades (§14, NEW-01/03/05).
 *
 * Each MCP tool the coding agent uses gets its OWN narrow Core route rather than
 * a broad prefix grant (NEW-02): `/v1/agent/*`. A façade route:
 *   1. binds to the authenticated agent DID (never a body-supplied one);
 *   2. is scope-gated — it requires `agent_scope='coding'` and fails closed on a
 *      missing/`runner` scope (item 6b);
 *   3. validates its input and delegates to an INJECTED backing (the real
 *      AppView search / D2D talk / delegation create / PeerLens publisher wired
 *      at composition), so the route owns the least-privilege authz while the
 *      capability lives where it already does.
 *
 *   tool                 route                     backing (injected)
 *   ──────────────────── ───────────────────────── ──────────────────────────
 *   dina_remember        POST /v1/agent/memory      provenance-preserving ingress (origin staging)
 *   dina_find_service    POST /v1/agent/find-service Core AppView-search façade
 *   dina_talk            POST /v1/agent/talk         Core dina_talk façade (per-call phone approval)
 *   dina_delegate        POST /v1/agent/delegate     Core delegation façade
 *   dina_peerlens/review POST /v1/agent/peerlens     Core PeerLens façades
 */

import { isScopeAuthorized } from '../../auth/agent_scope';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export interface AgentFacadeContext {
  /** Authenticated agent DID. */
  agentDid: string;
  /** Agent session id (from the durable registry), '' if none. */
  sessionId: string;
  /** Parsed JSON body. */
  body: Record<string, unknown>;
}

export type AgentFacadeHandler = (
  ctx: AgentFacadeContext,
) => Promise<CoreResponse> | CoreResponse;

/** Injected backings; a façade route is registered only when its handler exists. */
export interface AgentFacadeHandlers {
  /** 5c — dina_remember: provenance-preserving agent memory ingress. */
  memory?: AgentFacadeHandler;
  /** 9 — dina_find_service: AppView service search. */
  findService?: AgentFacadeHandler;
  /** 11 — dina_talk: message another Dina (per-call phone approval). */
  talk?: AgentFacadeHandler;
  /** 11 — dina_delegate: hand a bounded task to an external agent. */
  delegate?: AgentFacadeHandler;
  /** 12 — dina_peerlens / dina_review: read/write trust. */
  peerlens?: AgentFacadeHandler;
  /** 5d — dina_recall/dina_ask: Core-mediated ask (the backing runs the persona PEP). */
  ask?: AgentFacadeHandler;
}

const MAX_FACADE_BODY_BYTES = 64 * 1024;

function resolveCallerDid(req: CoreRequest): string {
  const xDID = req.headers['x-did'];
  return req.callerDID ?? (typeof xDID === 'string' ? xDID : '');
}

/** Shared wrapper: auth-bind + scope-gate + body parse, then delegate. */
function facade(path: string, handler: AgentFacadeHandler) {
  return async (req: CoreRequest): Promise<CoreResponse> => {
    if (req.rawBody.length > MAX_FACADE_BODY_BYTES) {
      return { status: 413, body: { error: 'request body too large' } };
    }
    const agentDid = resolveCallerDid(req);
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }
    // Item 6b — coding-scope required, fail-closed on a missing/`runner` scope.
    if (!isScopeAuthorized(req.agentScope, path)) {
      return { status: 403, body: { error: `agent_scope 'coding' required for ${path}` } };
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    return handler({ agentDid, sessionId, body });
  };
}

export function registerAgentFacadeRoutes(
  router: CoreRouter,
  handlers: AgentFacadeHandlers = {},
): void {
  const routes: Array<[keyof AgentFacadeHandlers, string]> = [
    ['memory', '/v1/agent/memory'],
    ['findService', '/v1/agent/find-service'],
    ['talk', '/v1/agent/talk'],
    ['delegate', '/v1/agent/delegate'],
    ['peerlens', '/v1/agent/peerlens'],
    ['ask', '/v1/agent/ask'],
  ];
  for (const [key, path] of routes) {
    const handler = handlers[key];
    if (handler) router.post(path, facade(path, handler));
  }
}
