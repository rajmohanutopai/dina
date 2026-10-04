/**
 * What the asking conversation hears about an A2A Lane 1 operation
 * (docs/A2A_GATEWAY_ARCHITECTURE.md A2A-I7, §6.5). Every sentence is Dina's
 * own: an ending is described from Core's state and reason code, never from
 * anything the remote agent wrote. Only a result the guard released is
 * quoted, and only the released bytes.
 *
 * Core appends exactly one A2A event when an operation ends (its
 * `operation_end.ts`), on the operation's dispatch child or, before one
 * exists, its consent card. The workflow's own events on those tasks
 * (`completed`, `failed`, `cancelled`, ...) say nothing to the owner.
 */

import type { A2AOperationStatus } from '@dina/core';

export const A2A_DISPATCH_PAYLOAD_TYPE = 'a2a_dispatch';
export const A2A_DELEGATION_CONSENT_TYPE = 'a2a_delegation_consent';
export const A2A_OPERATION_ENDED_EVENT = 'a2a_operation_ended';
export const A2A_RESULT_RELEASED_EVENT = 'a2a_result_released';
export const A2A_RESULT_BLOCKED_EVENT = 'a2a_result_blocked';
export const A2A_RESULT_HELD_EVENT = 'a2a_result_held';

/** The A2A event kinds the consumer delivers, beside the workflow's own terminal kinds. */
export const A2A_EVENT_KINDS: ReadonlySet<string> = new Set([
  A2A_OPERATION_ENDED_EVENT,
  A2A_RESULT_RELEASED_EVENT,
  A2A_RESULT_BLOCKED_EVENT,
  A2A_RESULT_HELD_EVENT,
]);

/** A bubble should stay readable; the full result stays in Core for the console. */
const MAX_RESULT_CHARS = 4000;

/**
 * The operation id of an A2A task — a dispatch child or a consent card, both
 * Core-minted payloads — or null for any other task.
 */
export function a2aOperationIdOf(taskPayload: string): string | null {
  try {
    const parsed = JSON.parse(taskPayload) as { type?: unknown; operation_id?: unknown };
    const a2aType = parsed.type === A2A_DISPATCH_PAYLOAD_TYPE || parsed.type === A2A_DELEGATION_CONSENT_TYPE;
    return a2aType && typeof parsed.operation_id === 'string' ? parsed.operation_id : null;
  } catch {
    return null;
  }
}

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS - 1)}…` : text;
}

/** The released value as text: the default envelope's parts, or a pinned schema's object. */
export function renderReleasedResult(result: unknown): string {
  const envelope = result as { version?: unknown; parts?: unknown } | null;
  if (
    envelope !== null &&
    typeof envelope === 'object' &&
    envelope.version === 1 &&
    Array.isArray(envelope.parts)
  ) {
    return clip(
      envelope.parts
        .map((part: unknown) => {
          const p = part as { text?: unknown; data?: unknown };
          return typeof p.text === 'string' ? p.text : JSON.stringify(p.data, null, 2);
        })
        .join('\n\n'),
    );
  }
  return clip(JSON.stringify(result, null, 2));
}

function failureSentence(agent: string, reason: string): string {
  if (reason === 'remote_unreachable:credential_unusable' || reason === 'credential_unusable') {
    return `Dina could not use the credential you set up for ${agent}, so nothing was sent.`;
  }
  if (reason === 'token_unavailable') {
    return `Dina could not reach the sign-in service for ${agent}, so nothing was sent. Try again later.`;
  }
  const code = reason.split(':')[0] ?? reason;
  // `agent_revoked`, `agent_changed`, `agent_not_found`: the agent's standing moved.
  if (code.startsWith('agent_')) {
    return `The request to ${agent} was not sent: something changed after you approved it.`;
  }
  switch (code) {
    case 'remote_needs_input':
      return `${agent} needs more information than Dina can give it, so the request stopped.`;
    case 'remote_needs_auth':
      return `${agent} asked to sign in, which Dina cannot do yet, so the request stopped.`;
    case 'remote_auth_refused':
      return `${agent} refused the credential you set up, so the request was not carried out.`;
    case 'remote_failed':
      return `${agent} could not do it.`;
    case 'remote_rejected':
    case 'remote_error':
      return `${agent} turned the request down.`;
    case 'remote_unreachable':
      return `Dina could not reach ${agent}. Nothing was sent.`;
    case 'result_refused':
      return `${agent} answered in a form Dina could not accept, so the answer was set aside.`;
    case 'stale_authority':
    case 'card_changed':
    case 'endpoint_changed':
    case 'binding_changed':
    case 'credential_changed':
    case 'credential_revoked':
    case 'skill_not_bound':
    case 'consent_mismatch':
    case 'approval_not_intact':
    case 'no_permit':
      return `The request to ${agent} was not sent: something changed after you approved it.`;
    case 'expired':
    case 'permit_expired':
    case 'dispatch_expired':
      return `The request to ${agent} expired before it was sent.`;
    default:
      return `The request to ${agent} did not finish.`;
  }
}

/** Why the guard held an answer back, from the reason code Core recorded. */
function blockedSentence(agent: string, reason: string): string {
  const kept = 'It was set aside and will not be shown.';
  switch (reason) {
    case 'guard_blocked:instruction_pattern':
    case 'guard_blocked:model_block':
      return `Dina held back the answer from ${agent}: it looked like it was trying to give Dina instructions or ask for private details. ${kept}`;
    case 'guard_blocked:guard_unparseable':
      return `Dina held back the answer from ${agent}: the check on it did not give a clear answer. ${kept}`;
    case 'quarantine_unreadable':
      return `Dina held back the answer from ${agent}: its stored copy could not be read back. ${kept}`;
    default:
      return `Dina held back the answer from ${agent}. ${kept}`;
  }
}

/** How an operation ended, from its state and reason; null while it has not ended. */
function endingSentence(agent: string, op: A2AOperationStatus): string | null {
  const reason = op.reason ?? '';
  switch (op.state) {
    case 'failed':
    case 'stale_authority':
      return failureSentence(agent, reason);
    case 'expired':
      return `The request to ${agent} expired before it was sent.`;
    case 'refused':
      return `You declined the request to ${agent}. Nothing was sent.`;
    case 'cancelled':
      return reason === 'cancelled_by_remote'
        ? `${agent} cancelled the request.`
        : `The request to ${agent} was cancelled.`;
    case 'outcome_unknown':
      // The remote reported it done, but its answer could not be taken: it may well have acted.
      return reason.startsWith('result_refused')
        ? `${agent} reported the request done, but answered in a form Dina could not accept, so the answer was set aside. It may have been carried out. Check with the agent before asking again.`
        : `Dina sent the request to ${agent} but cannot tell whether it was done. Check with the agent before asking again.`;
    default:
      return null;
  }
}

/**
 * The sentence for one A2A event, or null when it says nothing to the owner:
 * any workflow event kind, and an ending event whose operation is somehow
 * not ended.
 */
export function a2aDeliveryText(eventKind: string, op: A2AOperationStatus | null): string | null {
  const agent = op === null || op.agent_name === '' ? 'The remote agent' : op.agent_name;
  switch (eventKind) {
    case A2A_OPERATION_ENDED_EVENT:
      return op === null ? null : endingSentence(agent, op);
    case A2A_RESULT_RELEASED_EVENT:
      return op !== null && op.result !== null
        ? `${agent} answered:\n\n${renderReleasedResult(op.result)}`
        : null;
    case A2A_RESULT_BLOCKED_EVENT:
      return blockedSentence(agent, op?.reason ?? '');
    case A2A_RESULT_HELD_EVENT:
      return `The answer from ${agent} is waiting. Dina checks answers from outside agents before showing them, and has not been able to check this one yet: no checking model is set up, or it is not running or not answering.`;
    default:
      return null;
  }
}
