/**
 * Versioned laptop-Core -> phone-Core approval synchronization.
 *
 * The authenticated calling device proposes a bounded approval receipt. The
 * phone stores it as a normal workflow approval, so the existing inbox and
 * owner-decision machinery remain authoritative. The caller polls the same
 * phone-owned row; MsgBox supplies signed/sealed transport authentication.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  MIRROR_MAX_DETAIL,
  MIRROR_MAX_LABEL,
  MIRROR_MAX_TTL_SECONDS,
  bounded,
  boundedMultiline,
  hasUnsafeMultilineText,
  hasUnsafeText,
} from '../../approval/mirror_text';
import { getDeviceByDID } from '../../devices/registry';
import { WorkflowTaskState } from '../../workflow/domain';
import {
  WorkflowConflictError,
  WorkflowValidationError,
  getWorkflowService,
} from '../../workflow/service';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export const REMOTE_APPROVAL_PAYLOAD_TYPE = 'remote_coding_gate_v1';
export const REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE = 'remote_facade_action_v1';
/**
 * A mirrored card whose yes needs a person present here (UCP plan §3.9: a
 * merchant's payment page). Presence-gated on this node's own route, so the
 * yes it records is one made in person.
 */
export const REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE = 'remote_facade_presence_v1';
/** The longest link a mirrored card may carry (the hand-off URL's cap). */
const MAX_LINK_URL_BYTES = 2048;
export const REMOTE_APPROVAL_API_PREFIX = '/v1/agent/approval-sync/v1';

const MAX_TTL_SECONDS = MIRROR_MAX_TTL_SECONDS;
const MIN_TTL_SECONDS = 15;
const MAX_DESCRIPTION = 500;
const MAX_LABEL = MIRROR_MAX_LABEL;
const MAX_PENDING_PER_DEVICE = 20;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface RemoteApprovalProposal {
  source_task_id: string;
  source_payload_hash: string;
  agent_did: string;
  action: string;
  risk_level: 'HIGH';
  tool_name: string;
  expires_at: number;
  proposal_type?: 'facade_action';
  display_title?: string;
  display_detail?: string;
  /** Opened here after a yes (https only), shown as its host before the tap. */
  link_url?: string;
  /** The yes needs a person present on this node. */
  presence_required?: true;
}

interface RemoteApprovalPayload extends RemoteApprovalProposal {
  type:
    | typeof REMOTE_APPROVAL_PAYLOAD_TYPE
    | typeof REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE
    | typeof REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE;
  source_device_did: string;
  /**
   * The name the sending device was paired under, from this node's own
   * registry (never the proposal's words): a card names who sent it, and any
   * paired device may send one, so no card is labelled by its action alone.
   */
  source_device_name?: string;
}

/** A payload's fields that a replayed proposal must repeat; the device's name may change. */
function immutablePart(payloadJSON: string): string {
  try {
    const { source_device_name: _name, ...rest } = JSON.parse(payloadJSON) as Record<
      string,
      unknown
    >;
    return JSON.stringify(rest);
  } catch {
    return payloadJSON;
  }
}

export function registerRemoteApprovalRoutes(router: CoreRouter): void {
  router.post(`${REMOTE_APPROVAL_API_PREFIX}/proposals`, createProposal);
  router.get(`${REMOTE_APPROVAL_API_PREFIX}/proposals/:id/status`, getProposalStatus);
  router.delete(`${REMOTE_APPROVAL_API_PREFIX}/proposals/:id`, withdrawProposal);
}

async function createProposal(req: CoreRequest): Promise<CoreResponse> {
  const callerError = requireExternalDevice(req);
  if (callerError !== null) return callerError;
  const service = getWorkflowService();
  if (service === null) return json(503, { error: 'workflow service not wired' });

  const parsed = parseProposal(req.body);
  if ('error' in parsed) return json(400, { error: parsed.error });
  // A card that opens a link, asks for a person present, or speaks as Dina's own shopping
  // (UCP plan §3.9) comes only from the owner's server node (paired with the `node` scope)
  // or an owner device, never from another agent: otherwise an agent could frame a page of
  // its choosing as Dina's "review and pay".
  if (
    req.callerType === 'agent' &&
    req.agentScope !== 'node' &&
    (parsed.link_url !== undefined ||
      parsed.presence_required === true ||
      parsed.action.startsWith('ucp_') ||
      parsed.agent_did.startsWith('ucp:'))
  ) {
    return json(403, {
      error: 'access_denied',
      reason: 'only the owner’s paired node may send this card',
    });
  }
  const callerDID = req.callerDID as string;
  const mirrorId = remoteApprovalProposalId(callerDID, parsed.source_task_id);
  const deviceName = bounded(getDeviceByDID(callerDID)?.deviceName, MAX_LABEL);
  const payload: RemoteApprovalPayload = {
    type:
      parsed.presence_required === true
        ? REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE
        : parsed.proposal_type === 'facade_action'
          ? REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE
          : REMOTE_APPROVAL_PAYLOAD_TYPE,
    source_device_did: callerDID,
    ...parsed,
    ...(deviceName !== '' && !hasUnsafeText(deviceName) ? { source_device_name: deviceName } : {}),
  };
  const payloadJSON = JSON.stringify(payload);

  const existing = service.store().getById(mirrorId);
  if (existing !== null) {
    if (immutablePart(existing.payload) !== immutablePart(payloadJSON)) {
      return json(409, {
        error: 'proposal_conflict',
        reason: 'source task was already proposed with different immutable fields',
      });
    }
    return json(
      200,
      proposalResponse(existing.status, mirrorId, parsed.expires_at, true, existing.error, payload),
    );
  }

  const pendingForDevice = service
    .store()
    .countByKindStateAndPayloadFields(
      'approval',
      WorkflowTaskState.PendingApproval,
      { source_device_did: callerDID },
      MAX_PENDING_PER_DEVICE,
    );
  if (pendingForDevice >= MAX_PENDING_PER_DEVICE) {
    return json(429, {
      error: 'too_many_pending_proposals',
      limit: MAX_PENDING_PER_DEVICE,
    });
  }

  try {
    const task = service.create({
      id: mirrorId,
      kind: 'approval',
      // Compose trusted display chrome from the bounded protocol fields. A
      // buggy source must not be able to smuggle raw tool input through a
      // free-form description field.
      description: proposalDescription(parsed),
      payload: payloadJSON,
      expiresAtSec: parsed.expires_at,
      proposalId: parsed.source_task_id,
      origin: 'agent',
      priority: 'user_blocking',
      initialState: WorkflowTaskState.PendingApproval,
      idempotencyKey: `remote-approval:${callerDID}:${parsed.source_task_id}`,
    });
    return json(
      201,
      proposalResponse(task.status, task.id, parsed.expires_at, false, undefined, payload),
    );
  } catch (err) {
    if (err instanceof WorkflowConflictError) {
      return json(409, { error: 'proposal_conflict', reason: err.message });
    }
    if (err instanceof WorkflowValidationError) {
      return json(400, { error: err.message, field: err.field });
    }
    return json(500, { error: 'proposal_store_failed' });
  }
}

async function getProposalStatus(req: CoreRequest): Promise<CoreResponse> {
  const callerError = requireExternalDevice(req);
  if (callerError !== null) return callerError;
  const service = getWorkflowService();
  if (service === null) return json(503, { error: 'workflow service not wired' });

  const id = req.params.id ?? '';
  const task = id === '' ? null : service.store().getById(id);
  if (task === null) return json(404, { error: 'proposal_not_found' });
  const payload = parseStoredPayload(task.payload);
  if (payload === null || payload.source_device_did !== req.callerDID) {
    // Do not reveal whether another device's proposal exists.
    return json(404, { error: 'proposal_not_found' });
  }
  return json(
    200,
    proposalResponse(task.status, task.id, payload.expires_at, false, task.error, payload),
  );
}

async function withdrawProposal(req: CoreRequest): Promise<CoreResponse> {
  const callerError = requireExternalDevice(req);
  if (callerError !== null) return callerError;
  const service = getWorkflowService();
  if (service === null) return json(503, { error: 'workflow service not wired' });

  const id = req.params.id ?? '';
  const task = id === '' ? null : service.store().getById(id);
  if (task === null) return json(404, { error: 'proposal_not_found' });
  const payload = parseStoredPayload(task.payload);
  if (payload === null || payload.source_device_did !== req.callerDID) {
    return json(404, { error: 'proposal_not_found' });
  }

  if (task.status === WorkflowTaskState.PendingApproval) {
    try {
      service.cancel(task.id, 'withdrawn by source device');
    } catch {
      return json(409, { error: 'proposal_not_withdrawable' });
    }
  }
  // Idempotent for an already-terminal mirror. The source only needs to know
  // that no pending owner decision remains.
  return { status: 204 };
}

function requireExternalDevice(req: CoreRequest): CoreResponse | null {
  if (
    (req.callerType !== 'agent' && req.callerType !== 'device') ||
    typeof req.callerDID !== 'string' ||
    req.callerDID === ''
  ) {
    return json(403, {
      error: 'access_denied',
      reason: 'remote approval synchronization requires an authenticated paired device',
    });
  }
  return null;
}

function parseProposal(body: unknown): RemoteApprovalProposal | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }
  const value = body as Record<string, unknown>;
  const sourceTaskId = bounded(value.source_task_id, 200);
  const sourcePayloadHash = bounded(value.source_payload_hash, 64);
  const agentDID = bounded(value.agent_did, 300);
  const action = bounded(value.action, MAX_LABEL);
  const toolName = bounded(value.tool_name, MAX_LABEL);
  const expiresAt = value.expires_at;
  const proposalType = value.proposal_type;
  const displayTitle = bounded(value.display_title, MAX_LABEL);
  const displayDetail = boundedMultiline(value.display_detail, MIRROR_MAX_DETAIL);
  const nowSec = Math.floor(Date.now() / 1000);

  if (sourceTaskId === '') return { error: 'source_task_id is required' };
  if (!SHA256_HEX.test(sourcePayloadHash))
    return { error: 'source_payload_hash must be sha256 hex' };
  if (agentDID === '') return { error: 'agent_did is required' };
  if (action === '') return { error: 'action is required' };
  if (toolName === '') return { error: 'tool_name is required' };
  if ([sourceTaskId, agentDID, action, toolName].some(hasUnsafeText)) {
    return { error: 'proposal contains control or bidirectional text' };
  }
  if (value.risk_level !== 'HIGH') return { error: 'only HIGH-risk actions may be synchronized' };
  if (proposalType !== undefined && proposalType !== 'facade_action') {
    return { error: 'proposal_type is invalid' };
  }
  if (
    proposalType === 'facade_action' &&
    (displayTitle === '' ||
      displayDetail === '' ||
      hasUnsafeText(displayTitle) ||
      hasUnsafeMultilineText(displayDetail))
  ) {
    return { error: 'facade action display fields are required and must be safe' };
  }
  const linkUrl = value.link_url;
  if (linkUrl !== undefined && !isSafeLink(linkUrl)) return { error: 'link_url must be https' };
  if (value.presence_required !== undefined && value.presence_required !== true)
    return { error: 'presence_required is invalid' };
  // Only a card the phone shows in full (title and detail) may ask for presence or carry a link.
  if (
    (linkUrl !== undefined || value.presence_required === true) &&
    proposalType !== 'facade_action'
  )
    return { error: 'link_url and presence_required need a facade_action' };
  if (
    typeof expiresAt !== 'number' ||
    !Number.isInteger(expiresAt) ||
    expiresAt < nowSec + MIN_TTL_SECONDS ||
    expiresAt > nowSec + MAX_TTL_SECONDS
  ) {
    return { error: `expires_at must be ${MIN_TTL_SECONDS}-${MAX_TTL_SECONDS} seconds from now` };
  }
  return {
    source_task_id: sourceTaskId,
    source_payload_hash: sourcePayloadHash,
    agent_did: agentDID,
    action,
    risk_level: 'HIGH',
    tool_name: toolName,
    expires_at: expiresAt,
    ...(proposalType === 'facade_action'
      ? {
          proposal_type: proposalType,
          display_title: displayTitle,
          display_detail: displayDetail,
        }
      : {}),
    ...(typeof linkUrl === 'string' ? { link_url: linkUrl } : {}),
    ...(value.presence_required === true ? { presence_required: true as const } : {}),
  };
}

/** An https link a phone may open: no credentials, no control or bidi text, within the cap. */
function isSafeLink(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || hasUnsafeText(value)) return false;
  if (new TextEncoder().encode(value).length > MAX_LINK_URL_BYTES) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function proposalDescription(proposal: RemoteApprovalProposal): string {
  if (proposal.proposal_type === 'facade_action') {
    return proposal.display_title as string;
  }
  const agent =
    proposal.agent_did.length > 28
      ? `${proposal.agent_did.slice(0, 20)}...${proposal.agent_did.slice(-6)}`
      : proposal.agent_did;
  const description = `Agent ${agent} requests a HIGH coding action (${proposal.action} via ${proposal.tool_name})`;
  return description.length <= MAX_DESCRIPTION
    ? description
    : `${description.slice(0, MAX_DESCRIPTION - 3)}...`;
}

function parseStoredPayload(raw: string): RemoteApprovalPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<RemoteApprovalPayload>;
    return (value.type === REMOTE_APPROVAL_PAYLOAD_TYPE ||
      value.type === REMOTE_FACADE_APPROVAL_PAYLOAD_TYPE ||
      value.type === REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE) &&
      typeof value.source_device_did === 'string' &&
      typeof value.source_task_id === 'string' &&
      typeof value.source_payload_hash === 'string' &&
      typeof value.expires_at === 'number'
      ? (value as RemoteApprovalPayload)
      : null;
  } catch {
    return null;
  }
}

/**
 * Derive the phone-owned mirror id before transport.
 *
 * The source persists this id before proposing so cancellation can still
 * withdraw a remotely-created card after a crash between POST and response.
 */
export function remoteApprovalProposalId(sourceDID: string, sourceTaskId: string): string {
  const digest = bytesToHex(sha256(new TextEncoder().encode(`${sourceDID}\n${sourceTaskId}`)));
  return `remote-approval-${digest.slice(0, 32)}`;
}

function proposalResponse(
  status: string,
  id: string,
  expiresAt: number,
  deduped: boolean,
  error?: string,
  payload?: Pick<RemoteApprovalPayload, 'type' | 'source_payload_hash'>,
): Record<string, unknown> {
  let decision: 'pending' | 'approved' | 'denied' | 'expired' = 'pending';
  if (status === WorkflowTaskState.Cancelled) decision = 'denied';
  else if (status === WorkflowTaskState.Failed) {
    decision = error === 'expired' ? 'expired' : 'denied';
  } else if (
    status === WorkflowTaskState.Queued ||
    status === WorkflowTaskState.Running ||
    status === WorkflowTaskState.Completed ||
    status === WorkflowTaskState.Recorded
  ) {
    decision = 'approved';
  }
  return {
    version: 1,
    proposal_id: id,
    decision,
    expires_at: expiresAt,
    deduped,
    // What the decision binds to: a source reading a mirror back checks it is the one it sent.
    ...(payload !== undefined ? { source_payload_hash: payload.source_payload_hash } : {}),
    // A yes to a presence-gated mirror was made in person: this node's route admits it no
    // other way (`PRESENCE_GATED_PAYLOAD_TYPES`).
    ...(decision === 'approved' && payload?.type === REMOTE_PRESENCE_APPROVAL_PAYLOAD_TYPE
      ? { presence_verified: true }
      : {}),
  };
}

function json(status: number, body: unknown): CoreResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}
