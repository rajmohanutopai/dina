/**
 * `/api/v1/workflow/tasks` routes — the SPA's approvals/inbox layer.
 *
 * The browser's service-inbox + approvals UI lists pending workflow tasks
 * and approves/cancels them through the brain-server, which proxies to
 * core-server via its `CoreClient`. core-server owns the workflow store +
 * the approval state machine; this is the thin HTTP shim the web
 * `BrowserCoreProxyClient` calls. Mobile drives the in-process
 * WorkflowService directly.
 *
 *   GET  /api/v1/workflow/tasks?kind=&state=&limit= → CoreClient.listWorkflowTasks
 *   GET  /api/v1/workflow/tasks/:id                 → CoreClient.getWorkflowTask (404 → null)
 *   POST /api/v1/workflow/tasks/:id/approve         → CoreClient.approveWorkflowTask
 *   POST /api/v1/workflow/tasks/:id/cancel          → CoreClient.cancelWorkflowTask
 *   POST /api/v1/service/respond                    → CoreClient.sendServiceRespond
 *
 * Only the browser-relevant read + approve/cancel/respond surface is
 * proxied; claim/heartbeat/complete/fail are agent/server-side and never
 * hit from the browser. `kind` + `state` are required query params
 * (matches the core route); Core failure → 502.
 *
 * `/service/respond` is the inbox DENY path: when the operator denies a
 * `service_query` approval, `useServiceInbox.denyPending` calls
 * `sendServiceRespond` so the requester receives an `unavailable`
 * `service.response` D2D — without this proxy the web denial silently
 * fell back to a local cancel and the requester was left hanging.
 */

import type { CoreClient, ServiceRespondRequestBody } from '@dina/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterWorkflowApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: CoreClient;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerWorkflowApiRoutes(
  app: FastifyInstance,
  opts: RegisterWorkflowApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/workflow/tasks?kind=&state=&limit= — pending-task list.
  app.get(
    `${prefix}/workflow/tasks`,
    async (
      req: FastifyRequest<{ Querystring: { kind?: string; state?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
      const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
      if (kind === '' || state === '') {
        return reply.status(400).send({ error: 'kind and state query parameters are required' });
      }
      const limit =
        typeof req.query.limit === 'string' && req.query.limit !== ''
          ? Number(req.query.limit)
          : undefined;
      try {
        const tasks = await core.listWorkflowTasks({
          kind,
          state,
          ...(limit !== undefined && Number.isInteger(limit) && limit > 0 ? { limit } : {}),
        });
        return reply.status(200).send({ tasks });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/workflow/tasks/:id — single task (404 → null).
  app.get(
    `${prefix}/workflow/tasks/:id`,
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const task = await core.getWorkflowTask(req.params.id);
        if (task === null) return reply.status(404).send({ error: 'task not found' });
        return reply.status(200).send({ task });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/workflow/tasks/:id/approve — body { scope?: 'single'|'session' }.
  app.post(
    `${prefix}/workflow/tasks/:id/approve`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { scope?: 'single' | 'session' } }>,
      reply: FastifyReply,
    ) => {
      const scope = req.body?.scope;
      try {
        const task = await core.approveWorkflowTask(
          req.params.id,
          scope !== undefined ? { scope } : undefined,
        );
        return reply.status(200).send({ task });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/workflow/tasks/:id/cancel — body { reason?: string }.
  app.post(
    `${prefix}/workflow/tasks/:id/cancel`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
      reply: FastifyReply,
    ) => {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      try {
        const task = await core.cancelWorkflowTask(req.params.id, reason);
        return reply.status(200).send({ task });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/service/respond — inbox deny→notify. Body mirrors the core
  // route: { task_id, response_body: { status, result?, error? } }. Core
  // claims the approval task, opens the provider window, and sends the
  // requester the `service.response` D2D. Response is mapped back to the
  // snake_case wire shape the proxy client + http transport both parse.
  app.post(
    `${prefix}/service/respond`,
    async (
      req: FastifyRequest<{
        Body: { task_id?: string; response_body?: ServiceRespondRequestBody };
      }>,
      reply: FastifyReply,
    ) => {
      const taskId = typeof req.body?.task_id === 'string' ? req.body.task_id.trim() : '';
      const responseBody = req.body?.response_body;
      if (taskId === '') {
        return reply.status(400).send({ error: 'task_id is required' });
      }
      if (
        responseBody === undefined ||
        responseBody === null ||
        typeof responseBody !== 'object' ||
        Array.isArray(responseBody)
      ) {
        return reply.status(400).send({ error: 'response_body must be a JSON object' });
      }
      try {
        const result = await core.sendServiceRespond(taskId, responseBody);
        return reply.status(200).send({
          status: result.status,
          task_id: result.taskId,
          already_processed: result.alreadyProcessed,
        });
      } catch (err) {
        return reply.status(502).send({ error: asError(err) });
      }
    },
  );
}
