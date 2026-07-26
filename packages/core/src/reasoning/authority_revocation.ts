/**
 * Central reasoning-authority revocation.
 *
 * A connected Brain is also a paired device. Revoking either the backend
 * binding or that device must disable every backend binding for the principal,
 * clear ephemeral presence, and invalidate outstanding context tickets.
 */

import { getSessionRegistryIfConfigured } from '../session/registry';

import { clearReasoningBackendPresence } from './backend_presence';
import { getReasoningBackendRepository } from './backend_repository';
import { getReasoningContextRepository } from './context_repository';

export interface ReasoningAuthorityRevocationResult {
  /** False only when neither reasoning repository is installed. */
  available: boolean;
  ok: boolean;
  bindingsRevoked: number;
  ticketsRevoked: number;
  sessionsEnded: number;
}

export function revokeReasoningAuthorityForPrincipal(
  principalDid: string,
  nowMs: number = Date.now(),
): ReasoningAuthorityRevocationResult {
  if (!/^did:[^:\s]+:\S+$/.test(principalDid)) {
    throw new Error('invalid reasoning authority principal');
  }
  const backends = getReasoningBackendRepository();
  const contexts = getReasoningContextRepository();
  const sessions = getSessionRegistryIfConfigured();
  if (backends === null && contexts === null && sessions === null) {
    return {
      available: false,
      ok: true,
      bindingsRevoked: 0,
      ticketsRevoked: 0,
      sessionsEnded: 0,
    };
  }

  let ok = true;
  let sessionsEnded = 0;
  if (sessions === null) {
    // A reasoning principal can hold a Core session in production. If the
    // registry is absent, the revocation cascade cannot prove that authority
    // was cut and must be retried after full boot.
    ok = false;
  } else {
    const result = sessions.endAllForPrincipal(principalDid);
    sessionsEnded = result.ended;
    ok = result.ok;
  }

  let bindingsRevoked = 0;
  if (backends === null) {
    if (contexts !== null) ok = false;
  } else {
    let bindings: ReturnType<typeof backends.list>;
    try {
      bindings = backends.list();
    } catch {
      bindings = [];
      ok = false;
    }
    for (const binding of bindings) {
      if (binding.principalDid !== principalDid) continue;
      clearReasoningBackendPresence(binding.backendId, binding.principalDid);
      if (!binding.enabled || binding.revokedAtMs !== null) continue;
      try {
        if (
          backends.revoke(
            binding.backendId,
            binding.policyVersion,
            binding.selectedByOwnerDid,
            nowMs,
          )
        ) {
          bindingsRevoked += 1;
          continue;
        }
        const current = backends.get(binding.backendId);
        if (
          current !== null &&
          current.principalDid === principalDid &&
          current.enabled &&
          current.revokedAtMs === null
        ) {
          ok = false;
        }
      } catch {
        ok = false;
      }
    }
  }

  let ticketsRevoked = 0;
  if (contexts === null) {
    if (backends !== null) ok = false;
  } else {
    try {
      ticketsRevoked = contexts.revokeTicketsForPrincipal(principalDid, nowMs);
    } catch {
      ok = false;
    }
  }
  return {
    available: true,
    ok,
    bindingsRevoked,
    ticketsRevoked,
    sessionsEnded,
  };
}
