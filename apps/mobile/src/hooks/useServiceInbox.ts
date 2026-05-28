/**
 * Service approval inbox — data layer for MOBILE-008.
 *
 * Backs the approval screen that lists workflow tasks with
 * `kind=approval` / `state=pending_approval`, and lets the operator
 * approve or deny each.
 *
 * The inbox is client-injected: the app-layer bootstrap installs a
 * `CoreClient` once via `setInboxCoreClient`; the hook then calls
 * through it. Tests inject a fake client.
 *
 * Source: SERVICE_DISCOVERY_DESIGN.md MOBILE-008.
 */

import type { CoreClient, WorkflowTask } from '@dina/core';
import { markNotificationRead } from '@dina/brain/notifications';

/**
 * Approval-task variants the inbox knows how to render.
 *
 * - `service_query` — bus-driver flow. Approval gates a `service.query`
 *   D2D round-trip; deny → send `unavailable` to the requester.
 * - `intent_validation` — `dina validate` flow from OpenClaw / sample
 *   agents. Approval gates an agent action (send_email, transfer_money,
 *   etc.); the agent polls `/v1/intent/:id/status`. Deny is a plain
 *   workflow cancel — there is no service.query requester to notify.
 * - `staging_persona_access` — `/remember` wants to store into a locked
 *   persona; approve drains the staged memory, deny drops it.
 * - `vault_read` — `ask` request that touches a sensitive/locked persona;
 *   approve allows the vault read for this request, deny cancels it. Backed
 *   by a workflow task (`kind=approval`, `payload.type=vault_read_request`)
 *   created by `persona_guard.ts` — same store as every other approval kind.
 * - `unknown` — payload doesn't match a known shape; render with what
 *   we can read and surface a generic deny.
 */
export type InboxEntryKind =
  | 'service_query'
  | 'intent_validation'
  | 'staging_persona_access'
  | 'vault_read'
  | 'unknown';

export interface InboxEntry {
  id: string;
  /** Discriminator the UI uses to pick a render template + deny path. */
  kind: InboxEntryKind;
  /** service_query: capability name. intent_validation: action name. */
  capability: string;
  /** service_query: provider/service display name; intent_validation: ''. */
  serviceName: string;
  description: string;
  /** service_query: requester DID. intent_validation: agent DID (when present). */
  requesterDID: string;
  /** service_query: serialized params. intent_validation: target text. */
  paramsPreview: string;
  /** intent_validation only — surfaces SAFE/MODERATE/HIGH/BLOCKED. */
  riskLevel?: 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';
  createdAt: number;
  expiresAt?: number;
}

/** Subset of `CoreClient` the inbox uses — easier to fake in tests. */
export type InboxCoreClient = Pick<
  CoreClient,
  | 'listWorkflowTasks'
  | 'approveWorkflowTask'
  | 'cancelWorkflowTask'
  | 'getWorkflowTask'
  // `sendServiceRespond` is used by denyPending so the requester gets
  // an `unavailable` D2D. Review #1: the respond already terminates
  // the approval task, so we only call cancelWorkflowTask as a fallback
  // when respond failed.
  | 'sendServiceRespond'
>;

let client: InboxCoreClient | null = null;

/**
 * Install the Core client used by the inbox. Call once from the app
 * bootstrap after identity + HTTP-server wiring is ready.
 */
export function setInboxCoreClient(next: InboxCoreClient | null): void {
  client = next;
}

/** Clear the bound client — tests use this for isolation. */
export function resetInboxCoreClient(): void {
  client = null;
}

/** Raised when the inbox is used before a client is wired. */
export class InboxNotConfiguredError extends Error {
  constructor() {
    super('Service inbox Core client not configured — call setInboxCoreClient');
    this.name = 'InboxNotConfiguredError';
  }
}

/**
 * Fetch pending approvals ordered oldest-first. Single source of truth:
 * workflow tasks (`kind=approval, state=pending_approval`). Covers all
 * approval kinds — service_query, intent_validation, staging_persona_access,
 * and vault_read_request (the latter via workflow tasks created by the
 * persona guard when an ask touches a locked persona).
 *
 * Empty array when nothing is waiting. Never throws on "no items".
 */
export async function listPendingApprovals(limit = 50): Promise<InboxEntry[]> {
  const c = requireClient();
  const tasks = await c.listWorkflowTasks({ kind: 'approval', state: 'pending_approval', limit });
  return tasks.map(toEntry).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Workflow task lifecycle as the UI sees it. Three terminal-ish
 * buckets so the chat-thread inline card can persist its resolved
 * label across re-renders and across surfaces — if the operator
 * approves on the Approvals tab and then comes back to the chat
 * thread, the bubble already shows the resolved state instead of
 * re-rendering the action buttons.
 *
 *   - `pending`  — still awaiting a decision
 *   - `approved` — owner approved (queued / running / completed)
 *   - `denied`   — owner denied OR task failed / expired
 *   - `missing`  — task vanished (TTL swept, never existed)
 */
export type ApprovalLifecycleState = 'pending' | 'approved' | 'denied' | 'missing';

/**
 * Probe a workflow task's current lifecycle bucket. Used by the chat
 * card to detect cross-surface state changes (the Approvals tab may
 * have already resolved this approval) and to gracefully recover from
 * "already resolved" errors when the operator double-taps across
 * surfaces.
 */
export async function getApprovalLifecycle(taskId: string): Promise<ApprovalLifecycleState> {
  const c = requireClient();
  const task = await c.getWorkflowTask(taskId);
  if (task === null) return 'missing';
  switch (task.status) {
    case 'pending_approval':
      return 'pending';
    case 'queued':
    case 'running':
    case 'completed':
      return 'approved';
    case 'cancelled':
    case 'canceled':
    case 'failed':
    case 'expired':
      return 'denied';
    default:
      // Unknown — be conservative; render as pending so the operator
      // can take action rather than seeing a stale resolved label.
      return 'pending';
  }
}

/**
 * Approve a pending workflow task. All approval kinds — including
 * `vault_read` — are backed by workflow tasks, so this always calls
 * `approveWorkflowTask`.
 *
 * `scope` is only meaningful for `intent_validation` tasks:
 *   'single'  — one-time approval (default).
 *   'session' — auto-approve the same action for the session (~30 min).
 */
export async function approvePending(
  taskId: string,
  kind: InboxEntryKind = 'service_query',
  scope?: 'single' | 'session',
): Promise<WorkflowTask> {
  const c = requireClient();
  void kind; // all kinds are workflow tasks; kept for UI discriminator use only
  const out = await c.approveWorkflowTask(taskId, scope !== undefined ? { scope } : undefined);
  // The workflow approval inbox bridge writes a notification at task
  // CREATE with `id === task.id`. The bridge does not (yet) listen for
  // task RESOLUTION, so without this the tab-bar badge would still
  // count the resolved entry as unread — "All caught up" list with a
  // red `1` on the icon. Mark read on the same surface that resolved
  // the task so the badge clears. `markNotificationRead` is a no-op
  // when the id isn't found (e.g. ApprovalManager path, which uses a
  // different id space).
  markNotificationRead(taskId);
  return out;
}

/**
 * Deny a pending task with an optional reason.
 *
 * Two flavours, discriminated on the approval task's payload kind:
 *
 *   - `service_query` (bus-driver flow): mirror the chat
 *     `/service_deny` handler — send an `unavailable` D2D so the
 *     requester sees a real reason instead of TTL-timing out, then
 *     fall back to `cancelWorkflowTask` only if the respond failed
 *     (review #1: respond already terminates the task; double-cancel
 *     produces a spurious 409). Issue #5.
 *
 *   - `intent_validation` (`dina validate` flow): the requester is an
 *     OpenClaw agent polling `/v1/intent/:id/status`; there is no
 *     service.query waiting on a D2D response. Just cancel the task
 *     — the agent's next poll sees `cancelled → status='denied'`.
 *
 *   - `staging_persona_access`: this is a local `/remember` gate. Just
 *     cancel the workflow task; Core marks the staged row denied.
 *
 *   - `unknown`: fall back to the service_query path. Worst case the
 *     respond fails because the requester DID is missing/malformed
 *     and we cancel anyway.
 *
 * Caller passes the entry's `kind` so we don't have to re-fetch the
 * task to inspect the payload. When omitted, default to the service
 * query flow because it is the only variant with a D2D requester.
 */
export async function denyPending(
  taskId: string,
  reason = 'denied_by_operator',
  kind: InboxEntryKind = 'service_query',
): Promise<WorkflowTask> {
  const core = requireClient();
  const denyReason = reason.trim() === '' ? 'denied_by_operator' : reason.trim();

  if (
    kind === 'vault_read' ||
    kind === 'intent_validation' ||
    kind === 'staging_persona_access'
  ) {
    // Plain cancel — no service.respond peer to notify. The agent
    // observes intent_validation through polling; staging approvals are
    // local and Core handles the pending_unlock denial.
    const result = await core.cancelWorkflowTask(taskId, denyReason);
    markNotificationRead(taskId); // see comment in approvePending
    return result;
  }

  try {
    await core.sendServiceRespond(taskId, {
      status: 'unavailable',
      error: denyReason,
    });
  } catch {
    const result = await core.cancelWorkflowTask(taskId, denyReason);
    markNotificationRead(taskId); // see comment in approvePending
    return result;
  }
  const fresh = await core.getWorkflowTask(taskId);
  markNotificationRead(taskId); // see comment in approvePending
  if (fresh === null) {
    // Task vanished — treat as canceled-equivalent so the UI can
    // drop it from the inbox.
    return {
      id: taskId,
      kind: 'approval',
      status: 'canceled',
      priority: 'normal',
      description: '',
      payload: '',
      result_summary: '',
      policy: '',
      created_at: 0,
      updated_at: 0,
    };
  }
  return fresh;
}

function requireClient(): InboxCoreClient {
  if (client === null) throw new InboxNotConfiguredError();
  return client;
}

function toEntry(task: WorkflowTask): InboxEntry {
  const parsed = safeParse(task.payload);
  const payloadType = typeof parsed.type === 'string' ? parsed.type : '';

  if (payloadType === 'intent_validation') {
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    const target = typeof parsed.target === 'string' ? parsed.target : '';
    const agentDID = typeof parsed.agent_did === 'string' ? parsed.agent_did : '';
    const riskLevel = normaliseRiskLevel(parsed.risk_level);
    return {
      id: task.id,
      kind: 'intent_validation',
      capability: action,
      serviceName: '',
      description: task.description ?? '',
      requesterDID: agentDID,
      paramsPreview: target,
      ...(riskLevel !== undefined ? { riskLevel } : {}),
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'vault_read_request') {
    const persona = typeof parsed.persona === 'string' ? parsed.persona : '';
    const requesterDID =
      typeof parsed.requester_did === 'string' ? parsed.requester_did : '';
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    const preview = typeof parsed.preview === 'string' ? parsed.preview : '';
    return {
      id: task.id,
      kind: 'vault_read',
      capability: persona,
      serviceName: 'Vault access',
      description: reason,
      requesterDID,
      paramsPreview: preview,
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  if (payloadType === 'staging_persona_access') {
    const persona = typeof parsed.persona === 'string' ? parsed.persona : '';
    const source = typeof parsed.source === 'string' ? parsed.source : '';
    const sourceId = typeof parsed.source_id === 'string' ? parsed.source_id : '';
    const preview = typeof parsed.preview === 'string' ? parsed.preview : '';
    return {
      id: task.id,
      kind: 'staging_persona_access',
      capability: persona,
      serviceName: 'Memory access',
      description: task.description ?? '',
      requesterDID: source !== '' ? source : sourceId,
      paramsPreview: preview,
      createdAt: task.created_at,
      ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
    };
  }

  // Default — service_query (bus-driver) flow. Falls through to
  // 'unknown' when the payload is malformed enough that neither
  // capability nor type could be read.
  const capability = typeof parsed.capability === 'string' ? parsed.capability : '';
  const serviceName = typeof parsed.service_name === 'string' ? parsed.service_name : '';
  const requesterDID =
    typeof parsed.from_did === 'string'
      ? parsed.from_did
      : typeof parsed.requester_did === 'string'
        ? parsed.requester_did
        : '';
  const paramsPreview = summariseParams(parsed.params);
  const isServiceQuery =
    payloadType === 'service_query_execution' || (payloadType === '' && capability !== '');
  return {
    id: task.id,
    kind: isServiceQuery ? 'service_query' : 'unknown',
    capability,
    serviceName,
    description: task.description ?? '',
    requesterDID,
    paramsPreview,
    createdAt: task.created_at,
    ...(task.expires_at !== undefined ? { expiresAt: task.expires_at } : {}),
  };
}

function normaliseRiskLevel(raw: unknown): InboxEntry['riskLevel'] | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw === 'SAFE' || raw === 'MODERATE' || raw === 'HIGH' || raw === 'BLOCKED') return raw;
  return undefined;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function summariseParams(params: unknown, max = 120): string {
  if (params === undefined || params === null) return '';
  try {
    const s = typeof params === 'string' ? params : JSON.stringify(params);
    return s.length <= max ? s : `${s.slice(0, max)}…`;
  } catch {
    return '';
  }
}
