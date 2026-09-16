/**
 * Group coordination owner surface (docs/GROUP_COORDINATION_ARCHITECTURE.md
 * §7, §9).
 *
 *   POST   /v1/coordination/plans               open a plan; the first round goes out
 *   GET    /v1/coordination/handles             recent plans as handles — id, intent, state, chosen; no guests
 *   GET    /v1/coordination/plans               every open plan, folded as of now
 *   GET    /v1/coordination/plans/:id           one plan, folded as of now
 *   POST   /v1/coordination/plans/:id/choose    pick an agreed slot; the confirm round goes out
 *   POST   /v1/coordination/plans/:id/widen     new candidates; a new proposing round goes out
 *   POST   /v1/coordination/plans/:id/optional  drop a guest from required (nothing is sent)
 *   POST   /v1/coordination/plans/:id/abandon   stop (nothing is sent)
 *   DELETE /v1/coordination/plans/:id           delete the plan and what guests disclosed for it
 *
 * OWNER-PRIVATE, WITH TWO DOORS FOR BRAIN. A plan is the organizer's memory
 * of who was asked and what each household chose to disclose. Every decision
 * (choose, widen, drop, stop, delete) is the owner's: the authz matrix denies
 * every signed caller on the prefix and each handler re-checks the boot-minted
 * owner capability, the same two-part boundary as /v1/run and /v1/commerce.
 * OPENING a plan, READING one, and LISTING plan HANDLES are also admitted to
 * Brain (§11: the `coordinate_group` tool is how "plan X with A, B and C"
 * becomes a fan-out, and `group_plan_handoff` needs to find the plan a later
 * turn means), on the same terms as `/v1/plugins/tool-invoke`: Brain may ask
 * Core to fan out and may read a fold to narrate it; it may not decide
 * anything. A handle carries no guest, no reply and no disclosure.
 * What Brain reads here it already sees through the 1:1 lane — every reply
 * lands as a `service_query` task result Brain consumes today.
 *
 * The handlers add nothing: the service refuses, folds, sends; this file
 * reads a body, names a refusal on the wire, and projects the plan through
 * the one shared projection (`plan_wire.ts`).
 */

import {
  abandonPlan,
  chooseSlot,
  deleteGroupPlan,
  listGroupPlanHandles,
  listGroupPlans,
  makeGuestOptional,
  openGroupPlan,
  readGroupPlan,
  widenPlan,
  type GroupCoordinationRefusal,
  type GroupCoordinationResult,
} from '../../coordination/group_coordination_service';
import { projectHandle, projectPlan } from '../../coordination/plan_wire';

import { makeOwnerGuard } from './owner_guard';

import type { CoreRouter, CoreRequest, CoreResponse } from '../router';

function j(status: number, body: unknown): CoreResponse {
  return { status, body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The refusal is the wire error; the status says what kind of refusal it was. */
function statusFor(refusal: GroupCoordinationRefusal): number {
  switch (refusal) {
    case 'not_found':
      return 404;
    case 'not_wired':
      return 503;
    case 'wrong_state':
    case 'rounds_exhausted':
    case 'slot_not_agreed':
    case 'required_unanswered':
      return 409;
    default:
      return 400;
  }
}

function answer(result: GroupCoordinationResult, okStatus = 200): CoreResponse {
  if (!result.ok) {
    return j(statusFor(result.refusal), {
      error: result.refusal,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    });
  }
  return j(okStatus, { plan: projectPlan(result.plan) });
}

function readGuests(v: unknown): { contactDid: string; required: boolean }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { contactDid: string; required: boolean }[] = [];
  for (const g of v) {
    if (!isRecord(g) || typeof g.contact_did !== 'string') return null;
    if (g.required !== undefined && typeof g.required !== 'boolean') return null;
    out.push({ contactDid: g.contact_did, required: g.required ?? true });
  }
  return out;
}

export function registerGroupCoordinationRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnly = makeOwnerGuard(ownerCapability, 'group plans are the organizer’s own');

  const guarded =
    (handler: (req: CoreRequest) => Promise<CoreResponse>) =>
    async (req: CoreRequest): Promise<CoreResponse> => {
      const denied = ownerOnly(req);
      return denied ?? handler(req);
    };
  // The two Brain doors. `brain` is the signed Brain authority on the server
  // split; an in-process request with no caller type is the phone's shared-VM
  // Brain transport (`trustedInProcess`, unstamped). Anyone else must be the
  // owner. Same admission as the plugin tool-invoke route.
  const brainOrOwner =
    (handler: (req: CoreRequest) => Promise<CoreResponse>) =>
    async (req: CoreRequest): Promise<CoreResponse> => {
      if (req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined)) {
        return handler(req);
      }
      const denied = ownerOnly(req);
      return denied ?? handler(req);
    };

  router.post(
    '/v1/coordination/plans',
    brainOrOwner(async (req) => {
      const b = isRecord(req.body) ? req.body : {};
      const guests = readGuests(b.guests);
      if (guests === null) return j(400, { error: 'malformed_guest', detail: 'guests[].contact_did' });
      if (!Array.isArray(b.candidates)) return j(400, { error: 'no_candidates' });
      if (b.window_seconds !== undefined && typeof b.window_seconds !== 'number') {
        return j(400, { error: 'bad_window' });
      }
      return answer(
        await openGroupPlan({
          intent: typeof b.intent === 'string' ? b.intent : '',
          guests,
          candidates: b.candidates,
          ...(typeof b.window_seconds === 'number' ? { windowSeconds: b.window_seconds } : {}),
        }),
        201,
      );
    }),
  );

  router.get(
    '/v1/coordination/handles',
    brainOrOwner(async () => {
      const plans = await listGroupPlanHandles();
      if (plans === null) return j(503, { error: 'not_wired' });
      return j(200, { plans: plans.map(projectHandle) });
    }),
  );

  router.get(
    '/v1/coordination/plans',
    guarded(async () => {
      const plans = await listGroupPlans();
      if (plans === null) return j(503, { error: 'not_wired' });
      return j(200, { plans: plans.map(projectPlan) });
    }),
  );

  router.get(
    '/v1/coordination/plans/:id',
    brainOrOwner(async (req) => answer(await readGroupPlan(String(req.params.id ?? '')))),
  );

  router.post(
    '/v1/coordination/plans/:id/choose',
    guarded(async (req) => {
      const b = isRecord(req.body) ? req.body : {};
      const slot = isRecord(b.slot) && typeof b.slot.start === 'string' ? b.slot : null;
      if (slot === null) return j(400, { error: 'malformed_slot', detail: 'slot.start' });
      return answer(
        await chooseSlot(String(req.params.id ?? ''), {
          start: slot.start as string,
          ...(typeof slot.end === 'string' ? { end: slot.end } : {}),
          ...(typeof slot.note === 'string' ? { note: slot.note } : {}),
        }),
      );
    }),
  );

  router.post(
    '/v1/coordination/plans/:id/widen',
    guarded(async (req) => {
      const b = isRecord(req.body) ? req.body : {};
      if (!Array.isArray(b.candidates)) return j(400, { error: 'no_candidates' });
      return answer(await widenPlan(String(req.params.id ?? ''), b.candidates));
    }),
  );

  router.post(
    '/v1/coordination/plans/:id/optional',
    guarded(async (req) => {
      const b = isRecord(req.body) ? req.body : {};
      if (typeof b.contact_did !== 'string' || b.contact_did === '') {
        return j(400, { error: 'unknown_guest', detail: 'contact_did' });
      }
      return answer(await makeGuestOptional(String(req.params.id ?? ''), b.contact_did));
    }),
  );

  router.post(
    '/v1/coordination/plans/:id/abandon',
    guarded(async (req) => answer(await abandonPlan(String(req.params.id ?? '')))),
  );

  router.delete(
    '/v1/coordination/plans/:id',
    guarded(async (req) => {
      const result = await deleteGroupPlan(String(req.params.id ?? ''));
      if (!result.ok) return j(503, { error: result.refusal, detail: result.detail });
      return result.removed ? j(200, { removed: true }) : j(404, { error: 'not_found' });
    }),
  );
}
