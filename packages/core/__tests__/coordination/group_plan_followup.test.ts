/**
 * docs/STATE_MACHINES.md GROUP-1 to GROUP-4: what a plan still owes once it has
 * settled or stopped, and the slot length both sides of a booking agree on.
 */

import { validateBookedBody } from '../../src/coordination/group_booking';
import {
  GROUP_COORDINATION_CAPABILITY,
  abandonPlan,
  chooseSlot,
  deleteGroupPlan,
  listGroupPlanHandles,
  listGroupPlans,
  openGroupPlan,
  readGroupPlan,
  sweepGroupPlanFollowUps,
  type GroupCoordinationDeps,
} from '../../src/coordination/group_coordination_service';
import { MAX_SLOT_CHARS, currentSpoke, type GroupPlan } from '../../src/coordination/group_plan';
import { InMemoryGroupPlanRepository } from '../../src/coordination/group_plan_repository';
import { setNodeDID } from '../../src/pairing/ceremony';
import { submitServiceQuery } from '../../src/server/routes/service_query';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const T0 = 1_800_000_000_000;
const G = 'did:plc:garcia';
const J = 'did:plc:johnson';
const slot = { start: 'Sat 12' };

function harness() {
  const clock = { now: T0 };
  const workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    nowMsFn: () => clock.now,
  });
  setWorkflowService(workflow);
  const sent: { to: string; type: string; body: Record<string, unknown> }[] = [];
  const fail = new Set<string>();
  const offerOf = (did: string) => ({
    grantId: `g_${did}`,
    providerDid: did,
    capability: GROUP_COORDINATION_CAPABILITY,
    serviceUri: `at://${did}/com.dinakernel.service.profile/talk`,
    serviceName: did,
    schemaHash: '',
    createdAt: 1,
    updatedAt: 1,
  });
  const offers = {
    findByProviderDidAndCapability: (d: string) => [offerOf(d)],
    listByProviderDid: () => [],
    listAll: () => [],
    get: () => null,
    remove: () => false,
    upsert: () => {},
  };
  const plans = new InMemoryGroupPlanRepository();
  let ids = 0;
  const deps = {
    plans,
    offers,
    workflow,
    submitQuery: submitServiceQuery,
    querySender: async () => {},
    sendD2D: async (to: string, type: string, body: Record<string, unknown>) => {
      if (fail.has(to)) throw new Error('refused');
      sent.push({ to, type, body });
    },
    contactTrust: () => 'trusted',
    holdTier: () => 'full',
    nowMs: () => clock.now,
    newId: () => `id${(ids += 1)}`,
  } as unknown as GroupCoordinationDeps;
  return { deps, clock, workflow, sent, fail, plans };
}
type Harness = ReturnType<typeof harness>;

function reply(h: Harness, plan: GroupPlan, did: string, slots: unknown[]): void {
  const guest = plan.guests.find((x) => x.contactDid === did);
  const spoke = guest === undefined ? null : currentSpoke(guest, plan.round);
  if (spoke === null || spoke.stage !== 'queried') throw new Error('no spoke');
  const body = {
    query_id: 'q',
    capability: GROUP_COORDINATION_CAPABILITY,
    status: 'success',
    result: { status: 'accepted', accepted_slots: slots },
    ttl_seconds: 60,
  };
  expect(
    h.workflow
      .store()
      .completeWithDetails(spoke.taskId, '', 'received', JSON.stringify(body), '{}', h.clock.now),
  ).not.toBe(0);
}

function ok(r: { ok: boolean; plan?: GroupPlan; refusal?: string }): GroupPlan {
  if (!r.ok || r.plan === undefined) throw new Error(r.refusal ?? 'refused');
  return r.plan;
}

const booked = (h: Harness) => h.sent.filter((s) => s.body.state === 'booked').map((s) => s.to);
const cancelled = (h: Harness) =>
  h.sent.filter((s) => s.body.state === 'cancelled').map((s) => s.to);
const outcome = (plan: GroupPlan, did: string) =>
  plan.guests.find((g) => g.contactDid === did)?.outcome;

async function settled(h: Harness, s: { start: string } = slot): Promise<GroupPlan> {
  let plan = ok(
    await openGroupPlan(
      {
        intent: 'dinner',
        guests: [{ contactDid: G, required: true }],
        candidates: [s],
        windowSeconds: 120,
      },
      h.deps,
    ),
  );
  reply(h, plan, G, [s]);
  plan = ok(await chooseSlot(plan.planId, s, h.deps));
  reply(h, plan, G, [s]);
  plan = ok(await readGroupPlan(plan.planId, h.deps));
  expect(plan.state).toBe('settled');
  return plan;
}

beforeAll(() => setNodeDID('did:plc:organizer'));
afterEach(() => setWorkflowService(null));

describe('GROUP-1: an optional guest after the plan settles', () => {
  async function confirming(h: Harness): Promise<GroupPlan> {
    let plan = ok(
      await openGroupPlan(
        {
          intent: 'dinner',
          guests: [
            { contactDid: G, required: true },
            { contactDid: J, required: false },
          ],
          candidates: [slot],
          windowSeconds: 120,
        },
        h.deps,
      ),
    );
    reply(h, plan, G, [slot]);
    reply(h, plan, J, [slot]);
    plan = ok(await readGroupPlan(plan.planId, h.deps));
    plan = ok(await chooseSlot(plan.planId, slot, h.deps));
    h.clock.now += 1000;
    reply(h, plan, G, [slot]);
    plan = ok(await readGroupPlan(plan.planId, h.deps));
    expect(plan.state).toBe('settled');
    return plan;
  }

  it('a yes inside the window is recorded and booked; the plan stays settled', async () => {
    const h = harness();
    let plan = await confirming(h);
    h.clock.now += 1000;
    reply(h, plan, J, [slot]);
    plan = ok(await readGroupPlan(plan.planId, h.deps));
    expect(plan.state).toBe('settled');
    expect(outcome(plan, J)).toBe('answered');
    expect(booked(h).sort()).toEqual([G, J].sort());
  });

  it('silence ends in unreachable at the close, with no booking', async () => {
    const h = harness();
    let plan = await confirming(h);
    h.clock.now += 10 * 60 * 1000;
    plan = ok(await readGroupPlan(plan.planId, h.deps));
    expect(plan.state).toBe('settled');
    expect(outcome(plan, J)).toBe('unreachable');
    expect(booked(h)).toEqual([G]);
  });

  it('the sweep picks up the yes with nobody reading the plan', async () => {
    const h = harness();
    const plan = await confirming(h);
    h.clock.now += 1000;
    reply(h, plan, J, [slot]);
    await sweepGroupPlanFollowUps(h.deps);
    expect(booked(h).sort()).toEqual([G, J].sort());
  });
});

describe('GROUP-2: a word the sender did not take is sent again', () => {
  it('a failed cancellation goes out on a sweep, and on a list', async () => {
    for (const drive of [sweepGroupPlanFollowUps, listGroupPlans, listGroupPlanHandles]) {
      const h = harness();
      const plan = await settled(h);
      h.fail.add(G);
      await abandonPlan(plan.planId, h.deps);
      expect(cancelled(h)).toEqual([]);
      h.fail.clear();
      await drive(h.deps);
      expect(cancelled(h)).toEqual([G]);
      // Once only.
      await drive(h.deps);
      expect(cancelled(h)).toEqual([G]);
    }
  });

  it('an unsent booked word on a settled plan goes out on a sweep', async () => {
    const h = harness();
    h.fail.add(G);
    await settled(h);
    expect(booked(h)).toEqual([]);
    h.fail.clear();
    await sweepGroupPlanFollowUps(h.deps);
    expect(booked(h)).toEqual([G]);
  });

  it('a delete held for a cancellation finishes once the word is taken', async () => {
    const h = harness();
    const plan = await settled(h);
    h.fail.add(G);
    expect(await deleteGroupPlan(plan.planId, h.deps)).toMatchObject({
      ok: false,
      refusal: 'cancellations_pending',
    });
    expect(h.plans.get(plan.planId)).not.toBeNull();
    h.fail.clear();
    await sweepGroupPlanFollowUps(h.deps);
    expect(cancelled(h)).toEqual([G]);
    expect(h.plans.get(plan.planId)).toBeNull();
  });

  it('a word that still fails stays owed, and a plan owing nothing is left alone', async () => {
    const h = harness();
    const plan = await settled(h);
    h.fail.add(G);
    await abandonPlan(plan.planId, h.deps);
    await sweepGroupPlanFollowUps(h.deps);
    expect(h.plans.listFollowUps().map((p) => p.planId)).toEqual([plan.planId]);
    h.fail.clear();
    await sweepGroupPlanFollowUps(h.deps);
    expect(h.plans.listFollowUps()).toEqual([]);
  });
});

describe('GROUP-3: the longest slot a plan admits is a slot a guest admits', () => {
  it('holds at the boundary', async () => {
    const start = 'x'.repeat(MAX_SLOT_CHARS);
    const h = harness();
    const s = { start };
    await settled(h, s);
    const word = h.sent.find((x) => x.body.state === 'booked');
    expect(validateBookedBody(word?.body)).not.toBeNull();
    expect(
      validateBookedBody({ ...word?.body, slot: { start: 'x'.repeat(MAX_SLOT_CHARS + 1) } }),
    ).toBeNull();
  });
});

describe('GROUP-4: a fault on one spoke', () => {
  it('leaves read and list working, with the spoke still waiting for its grant', async () => {
    const h = harness();
    const offers = h.deps.offers.findByProviderDidAndCapability;
    h.deps.offers.findByProviderDidAndCapability = () => [];
    const plan = ok(
      await openGroupPlan(
        {
          intent: 'd',
          guests: [{ contactDid: G, required: true }],
          candidates: [slot],
          windowSeconds: 120,
        },
        h.deps,
      ),
    );
    expect(currentSpoke(plan.guests[0], plan.round)?.stage).toBe('grant_requested');
    h.deps.offers.findByProviderDidAndCapability = offers;
    h.deps.submitQuery = (async () => ({ status: 500, body: { error: 'disk' } })) as never;
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(currentSpoke(read.guests[0], read.round)?.stage).toBe('grant_requested');
    expect(await listGroupPlans(h.deps)).toHaveLength(1);
  });

  it('a plan that throws on read is left out of the lists; the others show', async () => {
    const h = harness();
    const good = await settled(h);
    const stored = h.plans.get(good.planId);
    if (stored === null) throw new Error('no plan');
    h.plans.put({ ...stored, planId: 'broken', state: 'proposing', roundOpenedAt: T0 });
    const get = h.plans.get.bind(h.plans);
    h.plans.get = (id: string) => {
      if (id === 'broken') throw new Error('corrupt');
      return get(id);
    };
    const handles = await listGroupPlanHandles(h.deps);
    expect(handles?.map((p) => p.planId)).toEqual([good.planId]);
    expect(await listGroupPlans(h.deps)).toEqual([]);
  });
});
