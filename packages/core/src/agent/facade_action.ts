/**
 * Durable owner approval for narrow coding-agent facade actions.
 *
 * Unlike the coding gate, Talk and delegation must show the owner the bounded
 * semantic action being approved. This payload therefore carries normalized
 * action data, but never arbitrary tool arguments or a caller-selected task
 * kind/origin/state. The facade remains the only executor.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import {
  WorkflowTaskKind,
  WorkflowTaskState,
  type WorkflowTask,
} from '../workflow/domain';
import {
  WorkflowConflictError,
  getWorkflowService,
} from '../workflow/service';

export const FACADE_ACTION_APPROVAL_TYPE = 'agent_facade_action_v1';
export const FACADE_ACTION_APPROVAL_TTL_SEC = 15 * 60;
export const MAX_PENDING_FACADE_ACTIONS_PER_AGENT = 20;

export type FacadeAction =
  | 'talk'
  | 'delegate'
  | 'review'
  | 'service_publish'
  | 'service_invoke';

export interface FacadeActionApprovalPayload {
  type: typeof FACADE_ACTION_APPROVAL_TYPE;
  action: FacadeAction;
  agent_did: string;
  session: string;
  request_id: string;
  payload_hash: string;
  display_title: string;
  display_detail: string;
  action_payload: Record<string, unknown>;
}

export type CreateFacadeActionApprovalResult =
  | { kind: 'created' | 'existing'; task: WorkflowTask; payload: FacadeActionApprovalPayload }
  | { kind: 'conflict'; taskId: string }
  | { kind: 'too_many_pending' }
  | { kind: 'unavailable' };

export function facadeActionTaskId(
  agentDid: string,
  sessionId: string,
  action: FacadeAction,
  requestId: string,
): string {
  const digest = hashText(`${agentDid}\n${sessionId}\n${action}\n${requestId}`);
  return `agent-action-${digest.slice(0, 32)}`;
}

export function facadeActionPayloadHash(
  action: FacadeAction,
  actionPayload: Record<string, unknown>,
): string {
  return hashText(canonicalJson({ action, action_payload: actionPayload }));
}

export function createFacadeActionApproval(input: {
  action: FacadeAction;
  agentDid: string;
  sessionId: string;
  requestId: string;
  actionPayload: Record<string, unknown>;
  displayTitle: string;
  displayDetail: string;
  nowMs?: number;
}): CreateFacadeActionApprovalResult {
  const service = getWorkflowService();
  if (service === null) return { kind: 'unavailable' };

  const nowMs = input.nowMs ?? Date.now();
  const taskId = facadeActionTaskId(
    input.agentDid,
    input.sessionId,
    input.action,
    input.requestId,
  );
  const payload: FacadeActionApprovalPayload = {
    type: FACADE_ACTION_APPROVAL_TYPE,
    action: input.action,
    agent_did: input.agentDid,
    session: input.sessionId,
    request_id: input.requestId,
    payload_hash: facadeActionPayloadHash(input.action, input.actionPayload),
    display_title: input.displayTitle,
    display_detail: input.displayDetail,
    action_payload: input.actionPayload,
  };
  const payloadJSON = JSON.stringify(payload);

  const existing = service.store().getById(taskId);
  if (existing !== null) {
    const stored = parseFacadeActionApprovalPayload(existing.payload);
    if (
      stored === null ||
      stored.agent_did !== input.agentDid ||
      stored.session !== input.sessionId ||
      stored.action !== input.action ||
      stored.request_id !== input.requestId ||
      stored.payload_hash !== payload.payload_hash
    ) {
      return { kind: 'conflict', taskId };
    }
    return { kind: 'existing', task: existing, payload: stored };
  }

  const pendingCount = service
    .store()
    .listByKindAndState(
      WorkflowTaskKind.Approval,
      WorkflowTaskState.PendingApproval,
      Math.max(1, service.store().size()),
    )
    .filter((task) => {
      const candidate = parseFacadeActionApprovalPayload(task.payload);
      return (
        candidate?.agent_did === input.agentDid &&
        candidate.session === input.sessionId
      );
    }).length;
  if (pendingCount >= MAX_PENDING_FACADE_ACTIONS_PER_AGENT) {
    return { kind: 'too_many_pending' };
  }

  try {
    const task = service.create({
      id: taskId,
      kind: WorkflowTaskKind.Approval,
      description: input.displayTitle,
      payload: payloadJSON,
      expiresAtSec: Math.floor(nowMs / 1000) + FACADE_ACTION_APPROVAL_TTL_SEC,
      priority: 'user_blocking',
      origin: 'agent',
      sessionName: input.sessionId,
      initialState: WorkflowTaskState.PendingApproval,
      idempotencyKey: `${FACADE_ACTION_APPROVAL_TYPE}:${taskId}`,
    });
    appendAudit(
      input.agentDid,
      'agent_facade_approval_created',
      input.action,
      `task=${task.id}`,
    );
    return { kind: 'created', task, payload };
  } catch (error) {
    if (error instanceof WorkflowConflictError) {
      const raced = service.store().getById(taskId);
      const stored = parseFacadeActionApprovalPayload(raced?.payload);
      if (
        raced !== null &&
        stored !== null &&
        stored.payload_hash === payload.payload_hash &&
        stored.agent_did === input.agentDid &&
        stored.session === input.sessionId
      ) {
        return { kind: 'existing', task: raced, payload: stored };
      }
      return { kind: 'conflict', taskId };
    }
    throw error;
  }
}

export function parseFacadeActionApprovalPayload(
  raw: string | null | undefined,
): FacadeActionApprovalPayload | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.type !== FACADE_ACTION_APPROVAL_TYPE ||
    (item.action !== 'talk' &&
      item.action !== 'delegate' &&
      item.action !== 'review' &&
      item.action !== 'service_publish' &&
      item.action !== 'service_invoke') ||
    !safeBounded(item.agent_did, 300) ||
    !safeBounded(item.session, 200) ||
    !safeBounded(item.request_id, 128) ||
    typeof item.payload_hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(item.payload_hash) ||
    !safeBounded(item.display_title, 160) ||
    !safeDisplayDetail(item.display_detail, 4_000) ||
    item.action_payload === null ||
    typeof item.action_payload !== 'object' ||
    Array.isArray(item.action_payload)
  ) {
    return null;
  }
  return item as unknown as FacadeActionApprovalPayload;
}

export function isFacadeActionApproval(task: WorkflowTask | null): boolean {
  return (
    task !== null &&
    task.kind === WorkflowTaskKind.Approval &&
    parseFacadeActionApprovalPayload(task.payload) !== null
  );
}

function safeBounded(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlOrBidi(value)
  );
}

function safeDisplayDetail(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x09) continue;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return false;
    }
  }
  return true;
}

function hasControlOrBidi(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function hashText(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}
