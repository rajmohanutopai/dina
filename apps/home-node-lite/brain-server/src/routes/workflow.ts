/**
 * `/api/v1/workflow/tasks` routes — the SPA's approval-inbox data layer.
 *
 * In lite the workflow store lives in core-server's process. The browser
 * SPA can't reach it directly, so it talks to the brain-server (same origin
 * as the served bundle), which proxies each call to core-server through its
 * `CoreClient` (`HttpCoreTransport`). Same shape as the reminders routes —
 * a thin HTTP shim over a layer Core already owns. Mobile bypasses all of
 * this (it runs Core in-process and calls the in-process client directly).
 *
 * This is the web-parity fix for the Activity → Needs-action inbox: without
 * it the SPA's `useApprovalInbox` reads the empty in-browser store and shows
 * "All caught up" even when Core has pending agent-approval tasks.
 *
 *   GET  /api/v1/workflow/tasks?kind=&state=   → CoreClient.listWorkflowTasks
 *   GET  /api/v1/workflow/tasks/:id            → CoreClient.getWorkflowTask
 *   POST /api/v1/workflow/tasks/:id/approve    → CoreClient.approveWorkflowTask
 *   POST /api/v1/workflow/tasks/:id/cancel     → CoreClient.cancelWorkflowTask
 *   POST /api/v1/service/respond               → CoreClient.sendServiceRespond
 */

import {
  CoreHttpError,
  WorkflowConflictError,
  WorkflowTransitionError,
  WorkflowValidationError,
  type CoreClient,
  type ServiceRespondRequestBody,
  type WorkflowTask,
  type WorkflowTaskState,
} from '@dina/core';
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

/**
 * Map a CoreClient error to the HTTP status the SPA should see. Core's own
 * business errors (bad transition, already-resolved, not-found) are 4xx, NOT
 * 502 — flattening them to 502 hid "already resolved"/"not found" behind a
 * generic bad-gateway so the inbox couldn't react (review finding). Only a
 * genuine transport/unknown failure is 502.
 */
function statusForCoreError(err: unknown): number {
  // Core's HTTP status, forwarded structurally (CoreHttpError.status) — a 404
  // (task gone) / 409 (already resolved) from Core is NOT a gateway failure.
  if (err instanceof CoreHttpError && err.status >= 400 && err.status < 500) return err.status;
  // Typed workflow errors thrown outside parseOk (e.g. the conflict path).
  if (err instanceof WorkflowValidationError) return 400;
  if (err instanceof WorkflowConflictError || err instanceof WorkflowTransitionError) return 409;
  return 502;
}

export function registerWorkflowApiRoutes(
  app: FastifyInstance,
  opts: RegisterWorkflowApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/workflow/tasks?kind=approval&state=pending_approval&limit=…
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
        typeof req.query.limit === 'string' && Number.isFinite(Number(req.query.limit))
          ? Number(req.query.limit)
          : undefined;
      try {
        const tasks: WorkflowTask[] = await core.listWorkflowTasks({
          kind,
          state: state as WorkflowTaskState,
          ...(limit !== undefined ? { limit } : {}),
        });
        return reply.status(200).send({ tasks, count: tasks.length });
      } catch (err) {
        return reply.status(statusForCoreError(err)).send({ error: asError(err) });
      }
    },
  );

  // GET /api/v1/workflow/tasks/:id
  app.get(
    `${prefix}/workflow/tasks/:id`,
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const task = await core.getWorkflowTask(req.params.id);
        if (task === null) return reply.status(404).send({ error: 'task not found' });
        return reply.status(200).send({ task });
      } catch (err) {
        return reply.status(statusForCoreError(err)).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/workflow/tasks/:id/approve   { scope?: 'single' | 'session' }
  app.post(
    `${prefix}/workflow/tasks/:id/approve`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { scope?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const scope = (req.body ?? {}).scope;
      const opt: { scope: 'single' | 'session' } | undefined =
        scope === 'single' || scope === 'session' ? { scope } : undefined;
      try {
        const task = await core.approveWorkflowTask(req.params.id, opt);
        return reply.status(200).send({ task });
      } catch (err) {
        return reply.status(statusForCoreError(err)).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/workflow/tasks/:id/cancel   { reason?: string }
  app.post(
    `${prefix}/workflow/tasks/:id/cancel`,
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { reason?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const reason = typeof (req.body ?? {}).reason === 'string' ? (req.body.reason as string) : '';
      try {
        const task = await core.cancelWorkflowTask(req.params.id, reason);
        return reply.status(200).send({ task });
      } catch (err) {
        return reply.status(statusForCoreError(err)).send({ error: asError(err) });
      }
    },
  );

  // POST /api/v1/service/respond   { task_id, response_body }
  // A provider's inbox decision on a service query — approve (respond with
  // data) or DENY (respond `unavailable`) — must send a REAL `service.respond`
  // D2D back to the requester. The web thin-client can't reach Core's
  // in-process sender, so it proxies here → CoreClient.sendServiceRespond.
  // Without this, a web deny only cancelled the local task and the requester
  // would TIME OUT instead of receiving the intended `unavailable` (review P2).
  app.post(
    `${prefix}/service/respond`,
    async (
      req: FastifyRequest<{ Body: { task_id?: unknown; response_body?: unknown } }>,
      reply: FastifyReply,
    ) => {
      const body = req.body ?? {};
      const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
      if (taskId === '') return reply.status(400).send({ error: 'task_id is required' });
      if (body.response_body === undefined || body.response_body === null) {
        return reply.status(400).send({ error: 'response_body is required' });
      }
      try {
        // Core validates response_body server-side; forward it structurally.
        const result = await core.sendServiceRespond(
          taskId,
          body.response_body as ServiceRespondRequestBody,
        );
        return reply.status(200).send(result);
      } catch (err) {
        return reply.status(statusForCoreError(err)).send({ error: asError(err) });
      }
    },
  );
}
