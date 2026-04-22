/**
 * Service approval inbox — data layer for MOBILE-008.
 *
 * Backs the approval screen that lists workflow tasks with
 * `kind=approval` / `state=pending_approval`, and lets the operator
 * approve or deny each.
 *
 * The inbox is client-injected: the app-layer bootstrap installs a
 * `BrainCoreClient` once via `setInboxCoreClient`; the hook then calls
 * through it. Tests inject a fake client.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md MOBILE-008.
 */

import type { BrainCoreClient, WorkflowTask } from '../../../brain/src/core_client/http';

export interface InboxEntry {
  id: string;
  capability: string;
  serviceName: string;
  description: string;
  requesterDID: string;
  paramsPreview: string;
  createdAt: number;
  expiresAt?: number;
}

/** Subset of `BrainCoreClient` the inbox uses — easier to fake in tests. */
export type InboxCoreClient = Pick<
  BrainCoreClient,
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
 * Fetch pending approvals ordered oldest-first. Empty array when nothing
 * is waiting. Never throws on "no tasks" — that case returns `[]`.
 */
export async function listPendingApprovals(limit = 50): Promise<InboxEntry[]> {
  const c = requireClient();
  const tasks = await c.listWorkflowTasks({
    kind: 'approval',
    state: 'pending_approval',
    limit,
  });
  return tasks.map(toEntry).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Approve a pending task. Returns the updated task so the UI can remove
 * it from the inbox without a refetch.
 */
export async function approvePending(taskId: string): Promise<WorkflowTask> {
  return requireClient().approveWorkflowTask(taskId);
}

/**
 * Deny a pending task with an optional reason. Mirrors the chat
 * `/service_deny` handler: send an `unavailable` D2D first (so the
 * requester sees a real reason instead of timing out), then cancel
 * the approval task authoritatively. Issue #5.
 *
 * The send is best-effort — a failure there still proceeds to cancel;
 * the cancel is the state change we care about.
 */
export async function denyPending(
  taskId: string,
  reason = 'denied_by_operator',
): Promise<WorkflowTask> {
  const core = requireClient();
  const denyReason = reason.trim() === '' ? 'denied_by_operator' : reason.trim();
  // Review #1: `/v1/service/respond` already completes the approval
  // task. Only fall back to `cancelWorkflowTask` when the respond
  // itself failed — otherwise we double-terminate and the second
  // call can surface a false 409 to the operator.
  try {
    await core.sendServiceRespond(taskId, {
      status: 'unavailable',
      error: denyReason,
    });
  } catch {
    return core.cancelWorkflowTask(taskId, denyReason);
  }
  const fresh = await core.getWorkflowTask(taskId);
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
  const capability = typeof parsed.capability === 'string' ? parsed.capability : '';
  const serviceName = typeof parsed.service_name === 'string' ? parsed.service_name : '';
  const requesterDID =
    typeof parsed.from_did === 'string'
      ? parsed.from_did
      : typeof parsed.requester_did === 'string'
        ? parsed.requester_did
        : '';
  const paramsPreview = summariseParams(parsed.params);
  return {
    id: task.id,
    capability,
    serviceName,
    description: task.description ?? '',
    requesterDID,
    paramsPreview,
    createdAt: task.created_at,
    expiresAt: task.expires_at,
  };
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
