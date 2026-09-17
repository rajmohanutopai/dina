/**
 * `/api/v1/coordination/*` — the web thin client's READ path for group plans
 * (docs/GROUP_COORDINATION_ARCHITECTURE.md §9, §11).
 *
 * Brain holds two doors on Core for plans: read one by id, and list the
 * recent handles. Both are Brain's own authority (the same doors the
 * `coordinate_group` and `group_plan_handoff` tools use), so a page Brain
 * serves may read a plan card's fold through them without any owner
 * capability touching Brain. DECISIONS — choose, widen, drop, stop, delete —
 * are the owner's and are NOT proxied here: an owner bearer must never
 * transit a Brain-served page (round-C, `apps/home-node-lite/web/SECURITY.md`),
 * so those live on Core's own owner surface, the same as run and watch.
 */

import { CoreHttpError, type CoreClient } from '@dina/core';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterCoordinationApiRoutesOptions {
  /** Brain→Core client (signed HTTP to core-server). */
  core: Pick<CoreClient, 'getGroupPlan' | 'listGroupPlanHandles'>;
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusForCoreError(err: unknown): number {
  if (err instanceof CoreHttpError && err.status >= 400 && err.status < 500) return err.status;
  return 502;
}

export function registerCoordinationApiRoutes(
  app: FastifyInstance,
  opts: RegisterCoordinationApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { core } = opts;

  // GET /api/v1/coordination/handles — recent plans as handles (no guests).
  app.get(`${prefix}/coordination/handles`, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const plans = await core.listGroupPlanHandles();
      return reply.status(200).send({ plans });
    } catch (err) {
      return reply.status(statusForCoreError(err)).send({ error: asError(err) });
    }
  });

  // GET /api/v1/coordination/plans/:id — one plan, folded as of now.
  app.get(
    `${prefix}/coordination/plans/:id`,
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const plan = await core.getGroupPlan(req.params.id);
        if (plan === null) return reply.status(404).send({ error: 'not_found' });
        return reply.status(200).send({ plan });
      } catch (err) {
        return reply.status(statusForCoreError(err)).send({ error: asError(err) });
      }
    },
  );
}
