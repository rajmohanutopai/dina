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
 *   dina_remember_status POST /v1/agent/memory/status owned staging projection
 *   dina_find_service    POST /v1/agent/service/search Core AppView-search façade
 *   dina_service_status POST /v1/agent/service/status requester-owned result projection
 *   dina_talk            POST /v1/agent/talk         Core dina_talk façade (per-call phone approval)
 *   dina_delegate        POST /v1/agent/delegate     Core delegation façade
 *   dina_peerlens       POST /v1/agent/peerlens/search Core PeerLens read façade
 *   dina_review         POST /v1/agent/peerlens/attest Core PeerLens write façade
 *   dina_review_status  POST /v1/agent/peerlens/status owned publish projection
 *   dina_vaults         POST /v1/agent/vaults          metadata-only vault projection
 *   dina_reminders      POST /v1/agent/reminders       session-readable active reminders
 */

import { isScopeAuthorized } from '../../auth/agent_scope';
import { getSessionRegistry } from '../../session/registry';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export interface AgentFacadeContext {
  /** Authenticated agent DID. */
  agentDid: string;
  /** Agent session id (from the durable registry), '' if none. */
  sessionId: string;
  /** Parsed JSON body. */
  body: Record<string, unknown>;
}

export type AgentFacadeHandler = (ctx: AgentFacadeContext) => Promise<CoreResponse> | CoreResponse;

/** Injected backings; a façade route is registered only when its handler exists. */
export interface AgentFacadeHandlers {
  /** 5c — dina_remember: provenance-preserving agent memory ingress. */
  memory?: AgentFacadeHandler;
  /** Poll an agent-owned staged memory without exposing another producer's row. */
  memoryStatus?: AgentFacadeHandler;
  /** 9 — dina_find_service: AppView service search. */
  findService?: AgentFacadeHandler;
  /** Service-query status, ownership checked by the injected backing. */
  serviceStatus?: AgentFacadeHandler;
  /** Durable publication receipt for an owned service listing. */
  servicePublicationStatus?: AgentFacadeHandler;
  /** Owner-approved service listing mutation. */
  servicePublish?: AgentFacadeHandler;
  /** Owner-approved outbound service invocation. */
  serviceInvoke?: AgentFacadeHandler;
  /** 11 — dina_talk: message another Dina (per-call phone approval). */
  talk?: AgentFacadeHandler;
  /** 11 — dina_delegate: hand a bounded task to an external agent. */
  delegate?: AgentFacadeHandler;
  /** Poll a Talk/delegation approval or execution using its stable request id. */
  actionStatus?: AgentFacadeHandler;
  /** 12 — dina_peerlens: bounded AppView search. */
  peerlensSearch?: AgentFacadeHandler;
  /** 12 — dina_review: owner-approved, durable PeerLens publish. */
  peerlensAttest?: AgentFacadeHandler;
  /** Poll an owned review approval/publish using its stable request id. */
  peerlensStatus?: AgentFacadeHandler;
  /** Metadata-only vault list with session-derived access state. */
  vaults?: AgentFacadeHandler;
  /** Active reminders from personas readable by this exact agent session. */
  reminders?: AgentFacadeHandler;
  /** 5d — dina_recall/dina_ask: Core-mediated ask (the backing runs the persona PEP). */
  ask?: AgentFacadeHandler;
  /** Bounded, scrubbed vault projection for an owner-interactive host turn. */
  contextPrepare?: AgentFacadeHandler;
  /** Schema-valid structured memory proposal; Core owns the eventual commit. */
  memoryPropose?: AgentFacadeHandler;
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
    if (sessionId === '') {
      return { status: 401, body: { error: 'invalid_session' } };
    }
    const session = getSessionRegistry().renew(sessionId, agentDid);
    if (!session.ok) {
      // Unknown, foreign, ended, and expired sessions intentionally collapse
      // to one response so this route is not a cross-principal session oracle.
      return { status: 401, body: { error: 'invalid_session' } };
    }
    // Non-owner reasoning jobs receive their bounded projection through the
    // reasoning claim. The broad owner-agent facades are intentionally closed
    // while this principal carries any non-owner reservation. Checking the
    // whole principal, rather than only this session, prevents minting a second
    // session to escape the service/contact/delegation authority floor.
    if (getSessionRegistry().hasActiveNonOwnerAuthority(agentDid)) {
      return { status: 403, body: { error: 'non_owner_session_restricted' } };
    }
    return handler({ agentDid, sessionId, body });
  };
}

export function registerAgentFacadeRoutes(
  router: CoreRouter,
  handlers: AgentFacadeHandlers = {},
): void {
  const routes: [keyof AgentFacadeHandlers, string][] = [
    ['memory', '/v1/agent/memory'],
    ['memoryStatus', '/v1/agent/memory/status'],
    ['findService', '/v1/agent/service/search'],
    ['serviceStatus', '/v1/agent/service/status'],
    ['servicePublicationStatus', '/v1/agent/service/publication-status'],
    ['servicePublish', '/v1/agent/service/publish'],
    ['serviceInvoke', '/v1/agent/service/invoke'],
    ['talk', '/v1/agent/talk'],
    ['delegate', '/v1/agent/delegate'],
    ['actionStatus', '/v1/agent/action/status'],
    ['peerlensSearch', '/v1/agent/peerlens/search'],
    ['peerlensAttest', '/v1/agent/peerlens/attest'],
    ['peerlensStatus', '/v1/agent/peerlens/status'],
    ['vaults', '/v1/agent/vaults'],
    ['reminders', '/v1/agent/reminders'],
    ['ask', '/v1/agent/ask'],
    ['contextPrepare', '/v1/agent/context/prepare'],
    ['memoryPropose', '/v1/agent/memory/propose'],
  ];
  for (const [key, path] of routes) {
    const handler = handlers[key];
    if (handler) router.post(path, facade(path, handler));
  }
}
