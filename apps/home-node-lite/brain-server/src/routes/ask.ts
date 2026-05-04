/**
 * `/api/v1/ask` route binding for the Fastify Brain server.
 *
 * Thin glue: takes an already-constructed `AskCoordinator`
 * (from the public `@dina/brain` package surface) and exposes its
 * four primitives as HTTP routes:
 *
 *   POST /api/v1/ask                  → submit (5.17 contract: 200 fast-path or 202 async)
 *   GET  /api/v1/ask/:id/status       → poll (5.18 contract)
 *   POST /api/v1/ask/:id/approve      → operator triggers `gateway.approve`
 *   POST /api/v1/ask/:id/deny         → operator triggers `gateway.deny`
 *
 * **Why a coordinator-shaped input, not raw deps**: the wiring of
 * `AskRegistry` + `AskApprovalGateway` + `AskApprovalResumer` is
 * order-sensitive (resumer needs registry events; gateway needs
 * registry; etc). `createAskCoordinator` already encapsulates that
 * order. The route plugin just hands HTTP to the coordinator.
 *
 * **`X-Request-Id` header → ask id**: 5.17 + 5.58 contract — if a
 * client supplies a valid `X-Request-Id`, the registry uses it
 * verbatim as the ask id. Lets the same id flow through logs and
 * provider audit trails.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 5.21-F.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AskCoordinator } from '@dina/brain';

export interface RegisterAskRoutesOptions {
  coordinator: AskCoordinator;
  /** Route prefix override (defaults to /api/v1). */
  prefix?: string;
}

interface SubmitBody {
  question?: unknown;
  requesterDid?: unknown;
  ttlMs?: unknown;
}

interface IdParams {
  id: string;
}

interface DenyBody {
  reason?: unknown;
}

export function registerAskRoutes(app: FastifyInstance, opts: RegisterAskRoutesOptions): void {
  if (!opts || !opts.coordinator) {
    throw new TypeError('registerAskRoutes: coordinator is required');
  }
  const { coordinator } = opts;
  const prefix = opts.prefix ?? '/api/v1';

  // POST /api/v1/ask — submit
  app.post(
    `${prefix}/ask`,
    async (req: FastifyRequest<{ Body: SubmitBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      if (typeof body.question !== 'string' || body.question.trim() === '') {
        return reply.status(400).send({ error: 'question must be a non-empty string' });
      }
      if (typeof body.requesterDid !== 'string' || body.requesterDid.trim() === '') {
        return reply.status(400).send({ error: 'requesterDid must be a non-empty string' });
      }
      if (body.ttlMs !== undefined && typeof body.ttlMs !== 'number') {
        return reply.status(400).send({ error: 'ttlMs must be a number when supplied' });
      }
      const headerVal = req.headers['x-request-id'];
      const requestIdHeader =
        typeof headerVal === 'string' ? headerVal : Array.isArray(headerVal) ? headerVal[0] : null;
      const submitInput: Parameters<AskCoordinator['handleAsk']>[0] = {
        question: body.question,
        requesterDid: body.requesterDid,
        requestIdHeader: requestIdHeader ?? null,
      };
      if (typeof body.ttlMs === 'number') submitInput.ttlMs = body.ttlMs;
      const result = await coordinator.handleAsk(submitInput);
      return reply.status(result.status).send(result.body);
    },
  );

  // GET /api/v1/ask/:id/status — poll
  app.get(
    `${prefix}/ask/:id/status`,
    async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      const id = req.params.id;
      const result = await coordinator.handleStatus(id);
      return reply.status(result.status).send(result.body);
    },
  );

  // POST /api/v1/ask/:id/approve — operator approves
  app.post(
    `${prefix}/ask/:id/approve`,
    async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      const id = req.params.id;
      const record = await coordinator.registry.get(id);
      if (record === null || record.approvalId === undefined) {
        return reply
          .status(404)
          .send({ error: 'ask not found or has no pending approval', request_id: id });
      }
      const r = await coordinator.gateway.approve(record.approvalId);
      if (r.ok) {
        return reply.status(200).send({ ok: true, request_id: id, approval_id: record.approvalId });
      }
      const status = approveFailureStatus(r.failure.reason);
      return reply.status(status).send({
        ok: false,
        request_id: id,
        reason: r.failure.reason,
        ...(r.failure.detail !== undefined ? { detail: r.failure.detail } : {}),
      });
    },
  );

  // POST /api/v1/ask/:id/deny — operator denies
  app.post(
    `${prefix}/ask/:id/deny`,
    async (
      req: FastifyRequest<{ Params: IdParams; Body: DenyBody }>,
      reply: FastifyReply,
    ) => {
      const id = req.params.id;
      const body = req.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const record = await coordinator.registry.get(id);
      if (record === null || record.approvalId === undefined) {
        return reply
          .status(404)
          .send({ error: 'ask not found or has no pending approval', request_id: id });
      }
      const r = await coordinator.gateway.deny(record.approvalId, reason);
      if (r.ok) {
        return reply.status(200).send({ ok: true, request_id: id, approval_id: record.approvalId });
      }
      const status = approveFailureStatus(r.failure.reason);
      return reply.status(status).send({
        ok: false,
        request_id: id,
        reason: r.failure.reason,
        ...(r.failure.detail !== undefined ? { detail: r.failure.detail } : {}),
      });
    },
  );
}

function approveFailureStatus(reason: string): number {
  switch (reason) {
    case 'unknown_approval':
      return 404;
    case 'source_rejected':
      return 409;
    case 'ask_state_invalid':
      return 409;
    default:
      return 500;
  }
}
