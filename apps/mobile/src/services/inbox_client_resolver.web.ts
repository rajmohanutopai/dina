/**
 * Inbox Core-client resolver — WEB (WEB_OWNER_SURFACE_PLAN §3.5).
 *
 * The tab's own limited node holds none of the owner's approval cards; they
 * live in the Home Node's Core. The page reaches Core directly, as the owner,
 * through this browser's owner device (`owner_dispatcher.web.ts`): the list,
 * one card, the approve/cancel decisions and the answer to a service query,
 * the same routes the phone reaches in-process. Nothing goes through Brain,
 * so every kind of card is decidable here, exactly as on the phone.
 *
 * A browser not connected as the owner gets no cards and a message saying
 * where to connect.
 */

import { getOwnerDispatcher } from './owner_dispatcher';
import { CONNECT_OWNER_DEVICE_MESSAGE } from './owner_errors';

import type { InboxCoreClient } from '../hooks/useServiceInbox';
import type {
  CoreResponse,
  OwnerRequest,
  ServiceRespondRequestBody,
  ServiceRespondResult,
  WorkflowTask,
} from '@dina/core';

const TASKS = '/v1/workflow/tasks';

export class OwnerInboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorKey: string,
  ) {
    super(message);
    this.name = 'OwnerInboxError';
  }
}

async function send(req: OwnerRequest): Promise<CoreResponse> {
  const dispatcher = getOwnerDispatcher();
  if (dispatcher === null) {
    throw new OwnerInboxError(
      'Owner access is not available on this page.',
      0,
      'no_owner_dispatcher',
    );
  }
  return dispatcher.dispatch(req);
}

function bodyOf(res: CoreResponse): Record<string, unknown> {
  return res.body !== null && typeof res.body === 'object'
    ? (res.body as Record<string, unknown>)
    : {};
}

/** The answer's body when it is the expected status; a readable error otherwise. */
function answerOf(res: CoreResponse, ok: number, what: string): Record<string, unknown> {
  const body = bodyOf(res);
  if (res.status === ok) return body;
  const key = typeof body.error === 'string' ? body.error : 'error';
  if (key === 'owner_device_not_connected') {
    throw new OwnerInboxError(CONNECT_OWNER_DEVICE_MESSAGE, res.status, key);
  }
  const reason =
    typeof body.reason === 'string'
      ? body.reason
      : typeof body.detail === 'string'
        ? body.detail
        : key;
  throw new OwnerInboxError(`${what}: ${reason}`, res.status, key);
}

const ownerInbox: InboxCoreClient = {
  async listWorkflowTasks(filter) {
    const res = await send({
      method: 'GET',
      path: TASKS,
      query: {
        kind: filter.kind,
        state: filter.state,
        ...(filter.limit !== undefined ? { limit: String(filter.limit) } : {}),
      },
    });
    return (
      (answerOf(res, 200, 'Could not load approvals').tasks as WorkflowTask[] | undefined) ?? []
    );
  },

  async getWorkflowTask(id) {
    const res = await send({ method: 'GET', path: `${TASKS}/${encodeURIComponent(id)}` });
    if (res.status === 404) return null;
    return (
      (answerOf(res, 200, 'Could not load the approval').task as WorkflowTask | undefined) ?? null
    );
  },

  async approveWorkflowTask(id, opts) {
    const res = await send({
      method: 'POST',
      path: `${TASKS}/${encodeURIComponent(id)}/approve`,
      body: opts ?? {},
    });
    return answerOf(res, 200, 'Could not approve').task as WorkflowTask;
  },

  async cancelWorkflowTask(id, reason) {
    const res = await send({
      method: 'POST',
      path: `${TASKS}/${encodeURIComponent(id)}/cancel`,
      body: { reason: reason ?? '' },
    });
    return answerOf(res, 200, 'Could not decline').task as WorkflowTask;
  },

  // A declined service query answers the requester `unavailable` through
  // Core's respond route, so the requester hears no rather than timing out.
  async sendServiceRespond(
    taskId: string,
    responseBody: ServiceRespondRequestBody,
  ): Promise<ServiceRespondResult> {
    const res = await send({
      method: 'POST',
      path: '/v1/service/respond',
      body: { task_id: taskId, response_body: responseBody },
    });
    const body = answerOf(res, 200, 'Could not answer the request');
    return {
      status: typeof body.status === 'string' ? body.status : '',
      taskId: typeof body.task_id === 'string' ? body.task_id : taskId,
      alreadyProcessed: body.already_processed === true,
    };
  },
};

export function resolveInboxCoreClient(_inProcess: InboxCoreClient): InboxCoreClient {
  return ownerInbox;
}

/** Decisions reach Core as the owner here, as on the phone. */
export const OWNER_DECIDES_ON_THIS_SURFACE = true;
