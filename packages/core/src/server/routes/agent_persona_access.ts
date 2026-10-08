/**
 * POST /v1/agent/persona-access — Core's persona-access decision for an
 * agent/device ask (REAL_LIFE_FIXES §3.2). Brain only.
 *
 * Body: `{ ask_authority, op: 'check' | 'request', mode?: 'read' | 'write',
 *          personas?: string[], persona?: string, scope?: string }`.
 *
 *  - `check` judges each persona with NO side effects: no card, nothing
 *    claimed. Brain's vault fan-out searches only the `allowed` ones.
 *  - `request` asks for one persona: `allowed` (a grant or free tier lets it
 *    through now), `approval_required` (one card, reused while pending for
 *    this agent + session + persona + mode), or `denied`.
 *
 * The requester and session come from Core's ask authority, never the body.
 * Any failure to resolve the authority refuses the call: Brain treats every
 * non-answer as gated / denied (fail closed).
 */

import { requireAgentPersonaAccess } from '../../agent/access';
import { resolveAskAuthority } from '../../agent/ask_authority';
import { resolveInstalledPersonaName } from '../../persona/service';

import { authorityMayAccess } from './ask_authority_gate';

import type { GrantMode } from '../../agent/grant_repository';
import type { CoreRouter } from '../router';

export const AGENT_PERSONA_ACCESS = '/v1/agent/persona-access';

const MAX_CHECK_PERSONAS = 64;

export function registerAgentPersonaAccessRoute(router: CoreRouter): void {
  router.post(AGENT_PERSONA_ACCESS, async (req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const authority = resolveAskAuthority(
      typeof body.ask_authority === 'string' ? body.ask_authority : '',
    );
    if (authority === null) {
      return { status: 403, body: { error: 'ask_authority_invalid' } };
    }
    const mode: GrantMode = body.mode === 'write' ? 'write' : 'read';

    if (body.op === 'check') {
      const raw = Array.isArray(body.personas) ? body.personas : [];
      const personas = raw.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
      if (personas.length > MAX_CHECK_PERSONAS) {
        return { status: 400, body: { error: `too many personas (max ${MAX_CHECK_PERSONAS})` } };
      }
      const decisions: Record<string, 'allowed' | 'gated'> = {};
      for (const p of personas) {
        decisions[p] = authorityMayAccess(authority, p, mode) ? 'allowed' : 'gated';
      }
      return { status: 200, body: { decisions } };
    }

    if (body.op === 'request') {
      const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
      if (persona === '') return { status: 400, body: { error: 'persona is required' } };
      const scope = typeof body.scope === 'string' ? body.scope.slice(0, 4096) : '';
      const decision = requireAgentPersonaAccess({
        agentDID: authority.requesterDid,
        persona: resolveInstalledPersonaName(persona),
        mode,
        scope,
        sessionId: authority.sessionId,
        askId: authority.askId,
      });
      if (decision.kind === 'allow') return { status: 200, body: { decision: 'allowed' } };
      if (decision.kind === 'approval_required') {
        return { status: 200, body: { decision: 'approval_required', task_id: decision.taskId } };
      }
      return { status: 200, body: { decision: 'denied', reason: decision.reason } };
    }

    return { status: 400, body: { error: "op must be 'check' or 'request'" } };
  });
}
