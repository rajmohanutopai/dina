/**
 * Owner-only group-plan client (GROUP_COORDINATION §9) — the plan card's
 * dispatch, on the same REAL boundary as `InProcessOwnerRunClient` and the
 * commerce client: a separate client from the Brain-shared `CoreClient`,
 * stamping the boot-minted owner capability, so Brain holds no reference to a
 * dispatch the decision routes would admit. Brain opens and reads plans
 * through `CoreClient`; the organizer chooses, widens, drops, stops and
 * deletes through THIS.
 *
 * The methods mirror the routes one-to-one and add nothing: Core refuses,
 * folds and sends; the card renders what Core answers.
 */

import { readGroupPlanWire, type GroupPlanWire } from '../coordination/plan_wire';

import type { CoreRequest, CoreResponse, CoreRouter } from '../server/router';

export class OwnerCoordinationHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The route's own error key — the refusal name (`slot_not_agreed`, `rounds_exhausted`, …). */
    readonly errorKey: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'OwnerCoordinationHttpError';
  }
}

function buildOwnerReq(overrides: Partial<CoreRequest>): CoreRequest {
  return {
    method: 'POST',
    path: '/',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    // The same two-part owner marker the run client documents: trustedInProcess
    // skips the network auth pipeline in-process, and the unforgeable
    // ownerCapability is what the route guard actually verifies.
    trustedInProcess: true,
    callerType: 'owner',
    ...overrides,
  };
}

function expectPlan(res: CoreResponse, ctx: string): GroupPlanWire {
  if (res.status < 200 || res.status >= 300) {
    const body = (res.body as { error?: string; detail?: string } | undefined) ?? {};
    const key = body.error ?? 'error';
    throw new OwnerCoordinationHttpError(
      `OwnerCoordinationClient: ${ctx} failed ${String(res.status)} — ${key}`,
      res.status,
      key,
      body.detail,
    );
  }
  const plan = readGroupPlanWire((res.body as { plan?: unknown } | undefined)?.plan);
  if (plan === null) {
    throw new OwnerCoordinationHttpError(`OwnerCoordinationClient: ${ctx} answered no plan`, res.status, 'response_malformed');
  }
  return plan;
}

export class InProcessOwnerCoordinationClient {
  constructor(
    private readonly router: CoreRouter,
    private readonly ownerCapability: string,
  ) {}

  private stamp(overrides: Partial<CoreRequest>): CoreRequest {
    return buildOwnerReq({ ...overrides, ownerCapability: this.ownerCapability });
  }

  private async post(path: string, body: Record<string, unknown>, ctx: string): Promise<GroupPlanWire> {
    const res = await this.router.handle(this.stamp({ method: 'POST', path, body }));
    return expectPlan(res, ctx);
  }

  /** Every open plan, folded as of now, newest first. */
  async list(): Promise<GroupPlanWire[]> {
    const res = await this.router.handle(this.stamp({ method: 'GET', path: '/v1/coordination/plans' }));
    if (res.status < 200 || res.status >= 300) {
      const key = (res.body as { error?: string } | undefined)?.error ?? 'error';
      throw new OwnerCoordinationHttpError(`OwnerCoordinationClient: list failed ${String(res.status)} — ${key}`, res.status, key);
    }
    const plans = (res.body as { plans?: unknown[] } | undefined)?.plans;
    return Array.isArray(plans) ? plans.map(readGroupPlanWire).filter((p): p is GroupPlanWire => p !== null) : [];
  }

  /** One plan, folded as of now; null when it does not exist. */
  async get(planId: string): Promise<GroupPlanWire | null> {
    const res = await this.router.handle(
      this.stamp({ method: 'GET', path: `/v1/coordination/plans/${encodeURIComponent(planId)}` }),
    );
    if (res.status === 404) return null;
    return expectPlan(res, `get(${planId})`);
  }

  /** The organizer picks an agreed slot; the confirm round goes out. */
  async choose(planId: string, slot: { start: string; end?: string; note?: string }): Promise<GroupPlanWire> {
    return this.post(`/v1/coordination/plans/${encodeURIComponent(planId)}/choose`, { slot }, `choose(${planId})`);
  }

  /** New candidates; a new proposing round goes out. */
  async widen(planId: string, candidates: { start: string; end?: string; note?: string }[]): Promise<GroupPlanWire> {
    return this.post(`/v1/coordination/plans/${encodeURIComponent(planId)}/widen`, { candidates }, `widen(${planId})`);
  }

  /** Drop a guest from required. Nothing is sent. */
  async makeOptional(planId: string, contactDid: string): Promise<GroupPlanWire> {
    return this.post(
      `/v1/coordination/plans/${encodeURIComponent(planId)}/optional`,
      { contact_did: contactDid },
      `makeOptional(${planId})`,
    );
  }

  /** Stop. Nothing is sent. */
  async abandon(planId: string): Promise<GroupPlanWire> {
    return this.post(`/v1/coordination/plans/${encodeURIComponent(planId)}/abandon`, {}, `abandon(${planId})`);
  }

  /** Delete the plan and what guests disclosed for it. */
  async remove(planId: string): Promise<boolean> {
    const res = await this.router.handle(
      this.stamp({ method: 'DELETE', path: `/v1/coordination/plans/${encodeURIComponent(planId)}` }),
    );
    if (res.status === 404) return false;
    if (res.status < 200 || res.status >= 300) {
      const key = (res.body as { error?: string } | undefined)?.error ?? 'error';
      throw new OwnerCoordinationHttpError(`OwnerCoordinationClient: remove failed ${String(res.status)} — ${key}`, res.status, key);
    }
    return true;
  }
}
