/**
 * Daily plan routes for the owner's agents (docs/DAILY_PLAN.md §6).
 *
 *   POST /v1/plan/inbox   — one batch of tasks. The only route that accepts a
 *       signed timestamp up to 20 h old (§4), so a batch an agent leaves at
 *       MsgBox for a sleeping phone still counts when the phone wakes.
 *       Replays are refused by batch id and are harmless by design anyway.
 *   GET  /v1/plan/status?since=<ms> — the caller's own tasks and their state.
 *
 * Callers: `agent` and `device` (`authz.ts`). The task origin is always the
 * signed caller DID, never a body field. The owner's own screens use the
 * store in-process on the phone.
 */

import { getDeviceByDID } from '../../devices/registry';
import { PlanIntakeError, parseBatch, receiveBatch } from '../../plan/intake';
import { getPlanStore, type PlanStore } from '../../plan/store';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

export const PLAN_INBOX_PATH = '/v1/plan/inbox';
export const PLAN_STATUS_PATH = '/v1/plan/status';

const INBOX_BODY_MAX_BYTES = 512 * 1024;

export interface PlanRouteDeps {
  store: () => PlanStore | null;
  agentName: (did: string) => string;
  now: () => number;
}

const DEFAULT_DEPS: PlanRouteDeps = {
  store: getPlanStore,
  agentName: (did) => getDeviceByDID(did)?.deviceName ?? '',
  now: () => Date.now(),
};

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}

export function makePlanHandlers(deps: Partial<PlanRouteDeps> = {}): {
  inbox: (req: CoreRequest) => Promise<CoreResponse>;
  status: (req: CoreRequest) => Promise<CoreResponse>;
} {
  const d: PlanRouteDeps = { ...DEFAULT_DEPS, ...deps };
  return {
    inbox: async (req) => {
      const store = d.store();
      if (store === null) return jsonError(503, 'the daily plan is not ready');
      const did = req.callerDID;
      if (did === undefined || did === '') return jsonError(401, 'a signed caller is required');
      if (req.rawBody.byteLength > INBOX_BODY_MAX_BYTES) {
        return jsonError(413, `body exceeds ${INBOX_BODY_MAX_BYTES} bytes`);
      }
      const now = d.now();
      try {
        const batch = parseBatch(req.body, now);
        const result = receiveBatch(store, did, d.agentName(did), batch, now);
        return { status: 200, body: { ...result } };
      } catch (err) {
        if (err instanceof PlanIntakeError) return jsonError(400, err.message);
        return jsonError(500, 'could not store the batch');
      }
    },
    status: async (req) => {
      const store = d.store();
      if (store === null) return jsonError(503, 'the daily plan is not ready');
      const did = req.callerDID;
      if (did === undefined || did === '') return jsonError(401, 'a signed caller is required');
      const sinceRaw = typeof req.query.since === 'string' ? Number(req.query.since) : 0;
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
      const tasks = store.listTasks({ origin: did, updatedSince: since }).map((t) => ({
        source: t.source,
        source_ref: t.sourceRef,
        title: t.title,
        persona: t.persona,
        status: t.status,
        planned_for: t.plannedFor,
        done_at: t.doneAt,
        updated_at: t.updatedAt,
      }));
      return { status: 200, body: { tasks } };
    },
  };
}

export function registerPlanRoutes(router: CoreRouter, deps: Partial<PlanRouteDeps> = {}): void {
  const h = makePlanHandlers(deps);
  router.post(PLAN_INBOX_PATH, h.inbox);
  router.get(PLAN_STATUS_PATH, h.status);
}
