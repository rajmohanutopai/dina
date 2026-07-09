/**
 * Inbox Core-client resolver — WEB.
 *
 * In the web thin-client the in-process Core store is empty (Core runs
 * server-side), so the approval inbox must talk to core-server. It does so
 * through the brain-server's `/api/v1/workflow/tasks` proxy (same origin as
 * the served bundle) — the F4 web-parity fix for Activity → Needs-action.
 * Mirrors the reminder/chat web transports.
 */

import type {
  ServiceRespondRequestBody,
  ServiceRespondResult,
  WorkflowTask,
} from '@dina/core';

import type { InboxCoreClient } from '../hooks/useServiceInbox';

const BASE = '/api/v1/workflow/tasks';

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`inbox: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const httpInbox: InboxCoreClient = {
  async listWorkflowTasks(filter) {
    const qs = new URLSearchParams({
      kind: filter.kind,
      state: filter.state,
      ...(filter.limit !== undefined ? { limit: String(filter.limit) } : {}),
    });
    const body = await readJson(await fetch(`${BASE}?${qs.toString()}`));
    return (body.tasks as WorkflowTask[] | undefined) ?? [];
  },

  async getWorkflowTask(id) {
    const res = await fetch(`${BASE}/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    const body = await readJson(res);
    return (body.task as WorkflowTask | undefined) ?? null;
  },

  async approveWorkflowTask(id, opts) {
    const body = await readJson(
      await fetch(`${BASE}/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      }),
    );
    return body.task as WorkflowTask;
  },

  async cancelWorkflowTask(id, reason) {
    const body = await readJson(
      await fetch(`${BASE}/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason ?? '' }),
      }),
    );
    return body.task as WorkflowTask;
  },

  // Service-query responses (provider → requester D2D): approve sends the
  // result, DENY sends `unavailable`. The web thin-client can't reach Core's
  // in-process sender, so it proxies to the brain's `/api/v1/service/respond`
  // → CoreClient.sendServiceRespond. Previously this rejected and denyPending
  // fell back to a LOCAL cancel, so the requester never got `unavailable` and
  // TIMED OUT (review P2) — now the real protocol response is sent.
  async sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult> {
    const body = await readJson(
      await fetch('/api/v1/service/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, response_body: responseBody }),
      }),
    );
    return {
      status: typeof body.status === 'string' ? body.status : '',
      taskId: typeof body.task_id === 'string' ? body.task_id : taskId,
      alreadyProcessed: body.already_processed === true,
    };
  },
};

export function resolveInboxCoreClient(_inProcess: InboxCoreClient): InboxCoreClient {
  return httpInbox;
}
