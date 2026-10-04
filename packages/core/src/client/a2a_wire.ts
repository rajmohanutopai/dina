/**
 * The Brain-side wire of A2A Lane 1 (design §4.3): request bodies and the
 * parsers both transports share, so the HTTP and in-process clients read
 * Core's answers identically. Refusals are values, never throws: the loop
 * relays them to the owner's conversation as they are. The types live in
 * `core-client.ts` beside every other `CoreClient` wire type.
 */

import type {
  A2ACallableAgent,
  A2ADelegateInput,
  A2ADelegateResult,
  A2AGuardVerdictInput,
  A2AGuardVerdictResult,
  OwnerTurnInput,
} from './core-client';

const record = (raw: unknown): Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

const errorOf = (raw: unknown): string => {
  const e = record(raw).error;
  return typeof e === 'string' ? e : 'response_malformed';
};

export function a2aDelegateBody(input: A2ADelegateInput): Record<string, unknown> {
  return {
    agent_id: input.agentId,
    skill: input.skill,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.replyTo !== undefined ? { reply_to: input.replyTo } : {}),
    ...(input.releaseSession !== undefined ? { release_session: input.releaseSession } : {}),
    ...(input.sources !== undefined
      ? {
          sources: input.sources.map((s) =>
            s.from === 'owner'
              ? { quote: s.quote, from: 'owner' }
              : { quote: s.quote, from: 'vault', persona: s.persona, item_id: s.itemId },
          ),
        }
      : {}),
  };
}

export function parseA2ADelegateResponse(status: number, raw: unknown): A2ADelegateResult {
  if (status !== 201) return { ok: false, status, reason: errorOf(raw) };
  const r = record(raw);
  const projection = record(r.projection);
  if (typeof r.operation_id !== 'string' || typeof r.approval_task_id !== 'string' || !Array.isArray(projection.parts)) {
    return { ok: false, status, reason: 'response_malformed' };
  }
  return {
    ok: true,
    operationId: r.operation_id,
    approvalTaskId: r.approval_task_id,
    consentHash: typeof r.consent_hash === 'string' ? r.consent_hash : '',
    expiresAtMs: typeof r.expires_at_ms === 'number' ? r.expires_at_ms : 0,
    projection: { parts: projection.parts },
    labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === 'string') : [],
  };
}

export function parseA2AAgentsResponse(raw: unknown): A2ACallableAgent[] {
  const agents = record(raw).agents;
  return Array.isArray(agents) ? (agents as A2ACallableAgent[]) : [];
}

/** The node's DID from `GET /v1/a2a/self`, or null when Core has none yet. */
export function parseA2ASelfResponse(status: number, raw: unknown): string | null {
  const did = record(raw).did;
  return status === 200 && typeof did === 'string' && did !== '' ? did : null;
}

export function parseA2AGuardVerdictResponse(status: number, raw: unknown): A2AGuardVerdictResult {
  if (status !== 200) return { ok: false, status, reason: errorOf(raw) };
  const state = record(raw).state;
  return typeof state === 'string' ? { ok: true, state } : { ok: false, status, reason: 'response_malformed' };
}

export function a2aGuardVerdictBody(input: A2AGuardVerdictInput): Record<string, unknown> {
  return {
    job_id: input.jobId,
    claim_id: input.claimId,
    digest: input.digest,
    verdict: input.verdict,
    code: input.code,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

export function ownerTurnBody(input: OwnerTurnInput): Record<string, unknown> {
  return { release_session: input.releaseSession, turn_id: input.turnId, text: input.text };
}

/** True when Core recorded the turn; false for a repeat or a host with no release log (503). */
export function parseOwnerTurnResponse(status: number, raw: unknown): boolean {
  if (status === 503) return false;
  if (status !== 200) throw new Error(`recordOwnerTurn() failed ${status}: ${errorOf(raw)}`);
  return record(raw).recorded === true;
}
