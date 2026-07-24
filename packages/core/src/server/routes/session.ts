/**
 * Session lifecycle routes — now backed by the durable session registry (§15).
 *
 * Item 6 upgrades these from no-op stubs to a real, DID-bound lifecycle:
 *   POST /v1/session/start  → mints (or reuses) a Core session bound to the
 *                             authenticated caller DID + host session id; the
 *                             bootstrap op is exempt from prior-session checks.
 *   POST /v1/session/end    → ends the session (revoking its grants via the
 *                             registry's onEnd hook), DID-bound so an agent can
 *                             only end its OWN session.
 *   GET  /v1/sessions       → lists only the authenticated caller's live
 *                             sessions; foreign sessions are never projected.
 *
 * Wire-compatible with the existing `dina-agent` daemon: `start` still returns
 * `{ session_id, status: 'open' }` and `end` still returns `{ ok: true }`; the
 * new lease field is additive.
 *
 * Auth: open to `agent`, `brain`, `admin` (see `auth/authz.ts`).
 */

import { getSessionRegistry } from '../../session/registry';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

function resolveCallerDid(req: CoreRequest): string {
  const xDID = req.headers['x-did'];
  return req.callerDID ?? (typeof xDID === 'string' ? xDID : '');
}

export function registerSessionRoutes(router: CoreRouter): void {
  router.post('/v1/session/start', async (req: CoreRequest): Promise<CoreResponse> => {
    const agentDid = resolveCallerDid(req);
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    // Bind to the caller's host task. A host hook and MCP client share this
    // Core session only when they intentionally supply the same host id.
    const hostSessionId =
      typeof body.host_session_id === 'string' && body.host_session_id !== ''
        ? body.host_session_id
        : agentDid;
    const session = getSessionRegistry().start({ agentDid, hostSessionId });
    return {
      status: 200,
      body: {
        session_id: session.sessionId,
        status: 'open',
        lease_expires_at: Math.floor(session.leaseExpiresAtMs / 1000),
      },
    };
  });

  router.post('/v1/session/end', async (req: CoreRequest): Promise<CoreResponse> => {
    const agentDid = resolveCallerDid(req);
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    if (sessionId === '') {
      return { status: 400, body: { error: 'missing required field: session_id' } };
    }
    const result = getSessionRegistry().end(sessionId, agentDid);
    if (!result.ok) {
      // A caller may only end its OWN live session. Unknown / foreign / ended
      // ALL return an identical 404 — echoing the registry's distinct reason
      // (`principal_mismatch` vs `not_found`) would be a cross-principal
      // existence oracle (audit finding). Never reveal another session's
      // lifecycle.
      return { status: 404, body: { ok: false } };
    }
    return { status: 200, body: { ok: true } };
  });

  router.get('/v1/sessions', async (req: CoreRequest): Promise<CoreResponse> => {
    const agentDid = resolveCallerDid(req);
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }
    const sessions = getSessionRegistry().listActive(agentDid).map((session) => ({
      session_id: session.sessionId,
      name: session.hostSessionId,
      status: 'active',
      lease_expires_at: Math.floor(session.leaseExpiresAtMs / 1000),
      grants: [],
    }));
    return { status: 200, body: { sessions } };
  });
}
