import { getSessionRegistry } from '../session/registry';

import type { CoreRequest, CoreResponse } from './router';

export type AgentSessionGuardResult =
  | { ok: true; sessionId: string }
  | { ok: false; response: CoreResponse };

/**
 * Require a live, DID-bound session when a shared route is called by an agent.
 *
 * Brain/admin/owner callers keep their existing route contract. Coding agents
 * pass the session in the signed query string so service request bodies remain
 * identical to the public protocol shapes.
 */
export function requireAgentSession(req: CoreRequest): AgentSessionGuardResult {
  if (req.callerType !== 'agent') return { ok: true, sessionId: '' };

  const agentDid = req.callerDID ?? '';
  const sessionId = req.query.session_id ?? '';
  if (agentDid === '' || sessionId === '') {
    return { ok: false, response: { status: 401, body: { error: 'invalid_session' } } };
  }
  const renewed = getSessionRegistry().renew(sessionId, agentDid);
  if (!renewed.ok) {
    return { ok: false, response: { status: 401, body: { error: 'invalid_session' } } };
  }
  return { ok: true, sessionId };
}
