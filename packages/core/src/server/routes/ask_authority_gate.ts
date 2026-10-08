/**
 * Core-side enforcement of an agent/device ask's persona access on the reads
 * Brain makes for it (REAL_LIFE_FIXES §0.1 B, §3).
 *
 * A read carrying `ask_authority` (signed query parameter) is evaluated as
 * the ask's requester, never as the owner: a persona the requester may not
 * read right now is refused (`persona_gated`), with no approval card raised
 * (cards come only from the explicit `request` decision). An unknown,
 * expired or session-ended authority is refused. Only Brain may carry an
 * authority; any other caller presenting one is refused.
 */

import { evaluateAgentPersonaAccess } from '../../agent/access';
import { resolveAskAuthority, type AskAuthority } from '../../agent/ask_authority';

import type { GrantMode } from '../../agent/grant_repository';
import type { CoreRequest, CoreResponse } from '../router';

function isBrain(req: CoreRequest): boolean {
  return req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined);
}

/** The authority a request carries: absent, a resolved record, or a refusal. */
export function askAuthorityOf(
  req: CoreRequest,
): { kind: 'none' } | { kind: 'ok'; authority: AskAuthority } | { kind: 'refuse'; response: CoreResponse } {
  const raw = req.query.ask_authority;
  if (raw === undefined || raw === '') return { kind: 'none' };
  if (!isBrain(req)) {
    return { kind: 'refuse', response: { status: 403, body: { error: 'ask_authority_brain_only' } } };
  }
  const authority = resolveAskAuthority(raw);
  if (authority === null) {
    return { kind: 'refuse', response: { status: 403, body: { error: 'ask_authority_invalid' } } };
  }
  return { kind: 'ok', authority };
}

/** Whether the ask's requester may use `persona` in `mode` now (no side effects). */
export function authorityMayAccess(authority: AskAuthority, persona: string, mode: GrantMode): boolean {
  return (
    evaluateAgentPersonaAccess({
      agentDID: authority.requesterDid,
      persona,
      mode,
      sessionId: authority.sessionId,
      askId: authority.askId,
    }).kind === 'allow'
  );
}

/**
 * Gate one persona read. `null` = proceed (no authority, or allowed);
 * otherwise the response to send.
 */
export function askAuthorityGate(
  req: CoreRequest,
  persona: string,
  mode: GrantMode,
): CoreResponse | null {
  const a = askAuthorityOf(req);
  if (a.kind === 'none') return null;
  if (a.kind === 'refuse') return a.response;
  if (!authorityMayAccess(a.authority, persona, mode)) {
    return { status: 403, body: { error: 'persona_gated', persona } };
  }
  return null;
}
