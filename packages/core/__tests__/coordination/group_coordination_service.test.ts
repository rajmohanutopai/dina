/**
 * The fan-out (GROUP_COORDINATION §4, §5, §11; §16 rules 4, 8, 9) — driven
 * through the REAL 1:1 submit path over an in-memory workflow store, with a
 * fake sender that records every body, an injected clock, and replies landed
 * the way the receive pipeline lands them (`completeWithDetails` with a
 * `service.response` body as the task result).
 *
 * Most of these pin what the organizer's node must NOT be able to tell: which
 * guest refused, which was offline, and which was never granted — because all
 * of those resolve at the same instant, and only a yes arrives early.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { appendAudit, queryAudit, resetAuditState } from '../../src/audit/service';
import {
  installOwnerQuestions,
  makeOwnerQuestionDecisionHandler,
  reconcileOwnerQuestionsAtBoot,
} from '../../src/commitment/owner_questions';
import { StrategyQuestionStore } from '../../src/commitment/strategy_questions';
import { StrategyStore } from '../../src/commitment/strategy_store';
import { StrategyTurnStore } from '../../src/commitment/strategy_turns';
import {
  GROUP_COORDINATION_CAPABILITY,
  abandonPlan,
  applyGroupSlotMove,
  chooseSlot,
  deleteGroupPlan,
  listGroupPlans,
  makeGuestOptional,
  openGroupPlan,
  readGroupPlan,
  replayOfferForOpenPlans,
  spokeParams,
  toSpokeReply,
  widenPlan,
  wireGroupCoordinationOfferReplay,
  type GroupCoordinationDeps,
  type GroupCoordinationResult,
} from '../../src/coordination/group_coordination_service';
import { MAX_PLAN_ROUNDS, currentSpoke, windowClosesAt, type GroupPlan } from '../../src/coordination/group_plan';
import { InMemoryGroupPlanRepository } from '../../src/coordination/group_plan_repository';
import { installGroupSlotStrategy, slotFromMove } from '../../src/coordination/group_slot_strategy';
import { emitServiceOfferReceived, resetServiceOfferReceivedListeners } from '../../src/d2d/service_offer_events';
import { setNodeDID } from '../../src/pairing/ceremony';
import { submitServiceQuery } from '../../src/server/routes/service_query';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

import type { NegotiationBrief } from '../../src/commitment/strategy_submit';
import type { WorkflowTask } from '../../src/workflow/domain';
import type { TrustLevel } from '../../src/contacts/directory';
import type { ServiceOffer, ServiceOfferRepository } from '../../src/contacts/service_offers_repository';
import type { ServiceQueryBody } from '../../src/d2d/service_bodies';
import type { SharingTier } from '../../src/gatekeeper/sharing';

const T0 = 1_800_000_000_000;
const GARCIA = 'did:plc:garcia';
const MILLER = 'did:plc:miller';
const JOHNSON = 'did:plc:johnson';
const SAT_12 = { start: 'Sat 12' };
const SAT_19 = { start: 'Sat 19' };
const SAT_26 = { start: 'Sat 26' };
const INTENT = "Emma's 8th birthday, a Saturday this month";

class FakeOffers implements ServiceOfferRepository {
  private readonly rows = new Map<string, ServiceOffer>();
  upsert(o: ServiceOffer): void {
    this.rows.set(o.grantId, o);
  }
  listByProviderDid(did: string): ServiceOffer[] {
    return [...this.rows.values()].filter((o) => o.providerDid === did).sort((a, b) => b.createdAt - a.createdAt);
  }
  findByProviderDidAndCapability(did: string, cap: string): ServiceOffer[] {
    return this.listByProviderDid(did).filter((o) => o.capability === cap);
  }
  listAll(): ServiceOffer[] {
    return [...this.rows.values()];
  }
  get(id: string): ServiceOffer | null {
    return this.rows.get(id) ?? null;
  }
  remove(id: string): boolean {
    return this.rows.delete(id);
  }
}

function offerFrom(did: string, over: Partial<ServiceOffer> = {}): ServiceOffer {
  const name = did.slice('did:plc:'.length);
  return {
    grantId: `grant_${name}`,
    providerDid: did,
    capability: GROUP_COORDINATION_CAPABILITY,
    serviceUri: `at://${did}/com.dinakernel.service.profile/talk`,
    serviceName: `${name}'s Dina`,
    schemaHash: '',
    createdAt: Math.floor(T0 / 1000),
    updatedAt: Math.floor(T0 / 1000),
    ...over,
  };
}

interface Harness {
  deps: GroupCoordinationDeps;
  clock: { now: number };
  queries: { to: string; body: ServiceQueryBody }[];
  preflights: { to: string; type: string; body: Record<string, unknown> }[];
  offers: FakeOffers;
  plans: InMemoryGroupPlanRepository;
  workflow: WorkflowService;
  trust: Map<string, TrustLevel>;
  failSendsTo: Set<string>;
  /** The organizer's own tier per category for every guest (§13); admits all by default. */
  holdTiers: Map<string, SharingTier>;
}

function harness(): Harness {
  const clock = { now: T0 };
  const repo = new InMemoryWorkflowRepository();
  const workflow = new WorkflowService({ repository: repo, nowMsFn: () => clock.now });
  setWorkflowService(workflow);
  const queries: Harness['queries'] = [];
  const preflights: Harness['preflights'] = [];
  const failSendsTo = new Set<string>();
  const holdTiers = new Map<string, SharingTier>();
  const offers = new FakeOffers();
  const plans = new InMemoryGroupPlanRepository();
  const trust = new Map<string, TrustLevel>([
    [GARCIA, 'trusted'],
    [MILLER, 'verified'],
    [JOHNSON, 'verified'],
  ]);
  let ids = 0;
  const deps: GroupCoordinationDeps = {
    plans,
    offers,
    workflow,
    submitQuery: submitServiceQuery,
    querySender: async (to, _type, body) => {
      if (failSendsTo.has(to)) throw new Error('relay refused');
      queries.push({ to, body });
    },
    sendD2D: async (to, type, body) => {
      if (failSendsTo.has(to)) throw new Error('relay refused');
      preflights.push({ to, type, body });
    },
    contactTrust: (did) => trust.get(did) ?? null,
    holdTier: (_did, category) => holdTiers.get(category) ?? 'full',
    nowMs: () => clock.now,
    newId: () => `id${(ids += 1)}`,
  };
  return { deps, clock, queries, preflights, offers, plans, workflow, trust, failSendsTo, holdTiers };
}

function ok(result: GroupCoordinationResult): GroupPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal} ${result.detail ?? ''}`);
  return result.plan;
}
function refusal(result: GroupCoordinationResult): string {
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}
function guest(plan: GroupPlan, did: string) {
  const g = plan.guests.find((x) => x.contactDid === did);
  if (g === undefined) throw new Error(`no guest ${did}`);
  return g;
}
function taskOf(plan: GroupPlan, did: string): string {
  const spoke = currentSpoke(guest(plan, did), plan.round);
  if (spoke === null || spoke.stage !== 'queried') throw new Error(`${did} has no queried spoke`);
  return spoke.taskId;
}

/** Land a reply the way the receive pipeline does: the full service.response JSON as the task result. */
function reply(h: Harness, plan: GroupPlan, did: string, result: unknown, status = 'success'): void {
  const taskId = taskOf(plan, did);
  const body = { query_id: 'q', capability: GROUP_COORDINATION_CAPABILITY, status, result, ttl_seconds: 60 };
  const eventId = h.workflow.store().completeWithDetails(taskId, '', 'received', JSON.stringify(body), '{}', h.clock.now);
  if (eventId === 0) throw new Error(`reply to ${did} did not land`);
}

async function openDefault(h: Harness, over: Partial<Parameters<typeof openGroupPlan>[0]> = {}): Promise<GroupPlan> {
  return ok(
    await openGroupPlan(
      {
        intent: INTENT,
        guests: [
          { contactDid: GARCIA, required: true },
          { contactDid: MILLER, required: true },
          { contactDid: JOHNSON, required: false },
        ],
        candidates: [SAT_12, SAT_19, SAT_26],
        windowSeconds: 120,
        ...over,
      },
      h.deps,
    ),
  );
}

let h: Harness;
beforeEach(() => {
  resetAuditState();
  resetServiceOfferReceivedListeners();
  h = harness();
  h.offers.upsert(offerFrom(GARCIA));
  h.offers.upsert(offerFrom(MILLER));
  h.offers.upsert(offerFrom(JOHNSON));
});
afterEach(() => {
  setWorkflowService(null);
  resetServiceOfferReceivedListeners();
});

describe('opening a plan fans out N ordinary 1:1 spokes', () => {
  it('every spoke carries the organizer’s own intent and candidates, and nothing else (rule 4)', async () => {
    const plan = await openDefault(h);
    expect(plan.state).toBe('proposing');
    expect(plan.round).toBe(1);
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, MILLER, JOHNSON]);
    for (const q of h.queries) {
      expect(q.body.capability).toBe(GROUP_COORDINATION_CAPABILITY);
      expect(q.body.params).toEqual({ intent: INTENT, candidate_slots: [SAT_12, SAT_19, SAT_26] });
      expect(q.body.params).toEqual(spokeParams(plan));
      expect(q.body.ttl_seconds).toBe(120);
      // Nothing on the wire names the plan or another guest.
      const wire = JSON.stringify(q.body);
      expect(wire).not.toContain(plan.planId);
      for (const other of [GARCIA, MILLER, JOHNSON].filter((d) => d !== q.to)) expect(wire).not.toContain(other);
    }
    // The spoke echoes the guest's own offer (grant + listing), as the Talk thread would.
    expect(h.queries[0].body.grant_id).toBe('grant_garcia');
    expect(h.queries[0].body.service_uri).toBe(`at://${GARCIA}/com.dinakernel.service.profile/talk`);
    // Distinct query ids; every spoke recorded with the task that carried it.
    expect(new Set(h.queries.map((q) => q.body.query_id)).size).toBe(3);
    for (const did of [GARCIA, MILLER, JOHNSON]) {
      const task = h.workflow.store().getById(taskOf(plan, did));
      expect(task?.status).toBe('running');
      expect(task?.expires_at).toBe(Math.floor(T0 / 1000) + 120);
    }
    expect(h.plans.get(plan.planId)).toEqual(plan);
  });

  it('a guest with no stored offer is asked for reach through the 1:1 preflight, never queried blind', async () => {
    h.offers.remove('grant_miller');
    const plan = await openDefault(h);
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, JOHNSON]);
    expect(h.preflights).toHaveLength(1);
    expect(h.preflights[0].to).toBe(MILLER);
    expect(h.preflights[0].type).toBe('service.grant_request');
    expect(h.preflights[0].body).toEqual({
      request_id: expect.any(String),
      capability: GROUP_COORDINATION_CAPABILITY,
      requested_surface: 'talk',
      intent: INTENT,
    });
    expect(currentSpoke(guest(plan, MILLER), 1)).toEqual({ round: 1, stage: 'grant_requested', requestId: expect.any(String) });
    expect(guest(plan, MILLER).outcome).toBe('waiting');
  });

  it('refuses a guest who is not a contact, or is blocked, before anything is sent (§5 layer 1)', async () => {
    h.trust.set(MILLER, 'blocked');
    const blocked = await openGroupPlan(
      { intent: INTENT, guests: [{ contactDid: GARCIA, required: true }, { contactDid: MILLER, required: true }], candidates: [SAT_26] },
      h.deps,
    );
    expect(blocked).toEqual({ ok: false, refusal: 'guest_not_a_contact', detail: MILLER });
    const stranger = await openGroupPlan(
      { intent: INTENT, guests: [{ contactDid: 'did:plc:stranger', required: true }], candidates: [SAT_26] },
      h.deps,
    );
    expect(refusal(stranger)).toBe('guest_not_a_contact');
    expect(h.queries).toHaveLength(0);
    expect(h.preflights).toHaveLength(0);
    expect(h.plans.listOpen()).toEqual([]);
  });

  it('the bounds refuse the whole plan by name and nothing goes out (rule 8)', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ contactDid: `did:plc:g${i}`, required: true }));
    for (const g of nine) h.trust.set(g.contactDid, 'verified');
    expect(refusal(await openGroupPlan({ intent: INTENT, guests: nine, candidates: [SAT_26] }, h.deps))).toBe('too_many_guests');
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ start: `Sat ${i}` }));
    expect(
      refusal(await openGroupPlan({ intent: INTENT, guests: [{ contactDid: GARCIA, required: true }], candidates: thirteen }, h.deps)),
    ).toBe('too_many_candidates');
    expect(
      refusal(await openGroupPlan({ intent: INTENT, guests: [{ contactDid: GARCIA, required: true }], candidates: [SAT_26], windowSeconds: 301 }, h.deps)),
    ).toBe('bad_window');
    expect(h.queries).toHaveLength(0);
  });

  it('a spoke whose send fails is still recorded, still a task, and resolves with the window like every other silence', async () => {
    h.failSendsTo.add(MILLER);
    const plan = await openDefault(h);
    expect(h.workflow.store().getById(taskOf(plan, MILLER))?.status).toBe('failed');
    expect(guest(plan, MILLER).outcome).toBe('waiting');
    const before = ok(await readGroupPlan(plan.planId, h.deps));
    expect(before.guests.map((g) => g.outcome)).toEqual(['waiting', 'waiting', 'waiting']);
    const audit = queryAudit({ action: 'group_plan_spoke_send_failed' });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).not.toContain(MILLER);
  });

  it('nothing wired → a named refusal, never a throw', async () => {
    setWorkflowService(null);
    const result = await openGroupPlan({ intent: INTENT, guests: [{ contactDid: GARCIA, required: true }], candidates: [SAT_26] }, { ...h.deps, workflow: undefined });
    expect(result).toEqual({ ok: false, refusal: 'not_wired', detail: 'workflow service' });
  });
});

describe('the fold on read', () => {
  it('before any reply the fold is provisional and the plan stays proposing', async () => {
    const plan = await openDefault(h);
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(read.state).toBe('proposing');
    expect(read.fold).toEqual(expect.objectContaining({ state: 'waiting', agreed: [], missingRequired: [GARCIA, MILLER] }));
    expect(windowClosesAt(read)).toBe(T0 + 120_000);
  });

  it('a yes is recorded the moment it lands; the plan folds once every required guest is accounted for', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26, SAT_19], as_of: 'now' });
    let read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, GARCIA).outcome).toBe('answered');
    expect(guest(read, GARCIA).reply).toEqual({ status: 'accepted', accepted_slots: [SAT_26, SAT_19] });
    expect(read.state).toBe('proposing');
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_19] });
    read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(read.state).toBe('folded');
    expect(read.fold?.agreed).toEqual([SAT_19]);
    // The optional guest is still waiting and blocks nothing.
    expect(guest(read, JOHNSON).outcome).toBe('waiting');
    expect(read.fold?.missingRequired).toEqual([]);
    expect(h.plans.get(plan.planId)?.state).toBe('folded');
  });

  it('disclosures ride the reply: normalised, deduplicated, malformed ones dropped and counted — never their text (§6, §13)', async () => {
    const plan = await openDefault(h);
    reply(h, plan, MILLER, {
      status: 'accepted',
      accepted_slots: [SAT_26],
      disclosures: [
        { kind: 'dietary', text: '  someone is\ngluten-free ', about: 'household' },
        { kind: 'dietary', text: 'someone is gluten-free', about: 'household' },
        { kind: 'dietary', text: 'Lily is gluten-free', about: 'Lily' },
        { kind: 'medical', text: 'x', about: 'household' },
      ],
    });
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, MILLER).disclosures).toEqual([{ kind: 'dietary', text: 'someone is gluten-free', about: 'household' }]);
    const audit = queryAudit({ action: 'group_plan_disclosure_dropped' });
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toContain('dropped=2');
    expect(audit[0].detail).not.toContain('Lily');
    expect(audit[0].detail).not.toContain('gluten');
  });

  it('a reply this node cannot read is no reply — it resolves with the window, never as "accepted nothing"', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [{ start: 7 }] });
    reply(h, plan, MILLER, { status: 'maybe' });
    let read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(read.guests.map((g) => g.outcome)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(read.fold?.emptiedBy).toEqual([]);
    expect(queryAudit({ action: 'group_plan_reply_malformed' })).toHaveLength(2);
    h.clock.now = T0 + 120_000;
    read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, GARCIA).outcome).toBe('unreachable');
    expect(guest(read, MILLER).outcome).toBe('unreachable');
    expect(read.fold?.emptiedBy).toEqual([]);
  });

  it('guest-authored text is clipped, not refused: an over-long counter slot still lands as a counter', async () => {
    const plan = await openDefault(h);
    const longStart = 'Sunday '.repeat(30);
    reply(h, plan, GARCIA, { status: 'counter', counter_slots: [{ start: longStart, note: 'x'.repeat(500) }], message: 'y'.repeat(1000) });
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    const r = guest(read, GARCIA).reply;
    if (r?.status !== 'counter') throw new Error(`expected a counter, got ${JSON.stringify(r)}`);
    expect(r.counter_slots?.[0].start.length).toBeLessThanOrEqual(80);
    expect(r.counter_slots?.[0].note?.length).toBeLessThanOrEqual(120);
    expect(r.message?.length).toBeLessThanOrEqual(400);
  });

  it('`toSpokeReply` keeps only the fold’s fields', () => {
    expect(toSpokeReply({ status: 'accepted', accepted_slots: [SAT_26], as_of: 'x', extra: 1 })).toEqual({
      status: 'accepted',
      accepted_slots: [SAT_26],
    });
    expect(toSpokeReply({ status: 'needs_more_info', message: 'which weekend?' })).toEqual({ status: 'needs_more_info', message: 'which weekend?' });
    expect(toSpokeReply({ status: 'accepted', message: 5 })).toBeNull();
    expect(toSpokeReply('accepted')).toBeNull();
  });
});

describe('the shared window collapses every negative path (§5, rule 9)', () => {
  it('silence, a soft refusal, a failed send and a never-granted guest all become `unreachable` at the same instant', async () => {
    h.offers.remove('grant_johnson'); // never granted: the preflight goes out, no offer ever lands
    h.trust.set('did:plc:offline', 'verified');
    h.offers.upsert(offerFrom('did:plc:offline'));
    h.failSendsTo.add('did:plc:offline');
    const plan = await openDefault(h, {
      guests: [
        { contactDid: GARCIA, required: true }, // silent
        { contactDid: MILLER, required: true }, // soft refusal
        { contactDid: JOHNSON, required: false }, // ungranted
        { contactDid: 'did:plc:offline', required: false }, // send failed
      ],
    });
    reply(h, plan, MILLER, undefined, 'unavailable');
    const closesAt = windowClosesAt(plan) ?? 0;
    h.clock.now = closesAt - 1;
    let read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(read.guests.map((g) => g.outcome)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(read.state).toBe('proposing');
    h.clock.now = closesAt;
    read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(read.guests.map((g) => g.outcome)).toEqual(['unreachable', 'unreachable', 'unreachable', 'unreachable']);
    // Every unreachable guest carries the same non-reason: nothing on the record says which was which.
    expect(new Set(read.guests.map((g) => JSON.stringify({ reply: g.reply, outcome: g.outcome }))).size).toBe(1);
    expect(read.state).toBe('folded');
    // The round is over (plan state) and the required replies are missing
    // (fold state): nothing was agreed, and nobody is named as having said no.
    expect(read.fold?.state).toBe('waiting');
    expect(read.fold?.missingRequired).toEqual([GARCIA, MILLER]);
    expect(read.fold?.agreed).toEqual([]);
    expect(read.fold?.emptiedBy).toEqual([]);
  });

  it('a yes that lands after the window closed is not read back into a closed round', async () => {
    const plan = await openDefault(h);
    h.clock.now = T0 + 120_000;
    let read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, GARCIA).outcome).toBe('unreachable');
    // The task is still `running` in the store (no sweeper ran); a reply lands.
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, GARCIA).outcome).toBe('unreachable');
    expect(guest(read, GARCIA).reply).toBeNull();
  });

  it('what counts is WHEN the reply landed, not when the plan was read — a store that kept a late reply changes nothing', async () => {
    const plan = await openDefault(h);
    // Miller answered inside the window; Garcia's reply was completed after it
    // (a store without the expiry check would keep it). Nobody read the plan
    // until long after; the fold still says only what the window admits.
    h.clock.now = T0 + 100_000;
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_26] });
    h.clock.now = T0 + 130_000;
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    h.clock.now = T0 + 600_000;
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, MILLER)).toEqual(expect.objectContaining({ outcome: 'answered', reply: { status: 'accepted', accepted_slots: [SAT_26] } }));
    expect(guest(read, GARCIA)).toEqual(expect.objectContaining({ outcome: 'unreachable', reply: null }));
    expect(read.state).toBe('folded');
    expect(read.fold?.missingRequired).toEqual([GARCIA]);
  });

  it('one clock reading per fold: a window that closes mid-pass closes for every guest or for none', async () => {
    const plan = await openDefault(h);
    // The clock advances on every read; the first reading decides the pass.
    let ticks = 0;
    const deps = { ...h.deps, nowMs: () => T0 + 120_000 - 1 + ticks++ };
    const read = ok(await readGroupPlan(plan.planId, deps));
    expect(read.guests.map((g) => g.outcome)).toEqual(['waiting', 'waiting', 'waiting']);
  });
});

describe('the offer that unlocks a spoke', () => {
  it('when the guest’s offer lands inside the window the query goes out with the remaining window, and the spoke becomes `queried`', async () => {
    h.offers.remove('grant_miller');
    const plan = await openDefault(h);
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, JOHNSON]);
    h.clock.now = T0 + 30_000;
    h.offers.upsert(offerFrom(MILLER));
    expect(await replayOfferForOpenPlans(MILLER, h.deps)).toBe(1);
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, JOHNSON, MILLER]);
    expect(h.queries[2].body.ttl_seconds).toBe(90);
    expect(h.queries[2].body.params).toEqual({ intent: INTENT, candidate_slots: [SAT_12, SAT_19, SAT_26] });
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, MILLER).spokes).toEqual([{ round: 1, stage: 'queried', taskId: expect.any(String), queryId: expect.any(String) }]);
    expect(h.workflow.store().getById(taskOf(read, MILLER))?.expires_at).toBe(Math.floor((T0 + 120_000) / 1000));
    // A second event for the same guest sends nothing more.
    expect(await replayOfferForOpenPlans(MILLER, h.deps)).toBe(0);
    expect(h.queries).toHaveLength(3);
  });

  it('an offer that lands after the window closed sends nothing; the guest resolved as unreachable', async () => {
    h.offers.remove('grant_miller');
    const plan = await openDefault(h);
    h.clock.now = T0 + 120_000;
    h.offers.upsert(offerFrom(MILLER));
    expect(await replayOfferForOpenPlans(MILLER, h.deps)).toBe(0);
    expect(h.queries).toHaveLength(2);
    expect(guest(ok(await readGroupPlan(plan.planId, h.deps)), MILLER).outcome).toBe('unreachable');
  });

  it('the read path is the fallback when the event was missed', async () => {
    h.offers.remove('grant_miller');
    const plan = await openDefault(h);
    h.offers.upsert(offerFrom(MILLER));
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, JOHNSON, MILLER]);
    expect(currentSpoke(guest(read, MILLER), 1)?.stage).toBe('queried');
  });

  it('the wired listener reacts only to this capability’s offers, from the transport-authenticated sender', async () => {
    h.offers.remove('grant_miller');
    const plan = await openDefault(h);
    const dispose = wireGroupCoordinationOfferReplay(h.deps);
    emitServiceOfferReceived({ providerDID: MILLER, capability: 'eta_query', grantId: 'g', serviceUri: 'u', serviceName: 'n', schemaHash: '' });
    await Promise.resolve();
    expect(h.queries).toHaveLength(2);
    h.offers.upsert(offerFrom(MILLER));
    emitServiceOfferReceived({ providerDID: MILLER, capability: GROUP_COORDINATION_CAPABILITY, grantId: 'grant_miller', serviceUri: 'u', serviceName: 'n', schemaHash: '' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, JOHNSON, MILLER]);
    dispose();
    expect(currentSpoke(guest(ok(await readGroupPlan(plan.planId, h.deps)), MILLER), 1)?.stage).toBe('queried');
  });
});

describe('choosing, widening, settling', () => {
  async function folded(): Promise<GroupPlan> {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26, SAT_19] });
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_19, SAT_26] });
    reply(h, plan, JOHNSON, { status: 'accepted', accepted_slots: [SAT_26] });
    return ok(await readGroupPlan(plan.planId, h.deps));
  }

  it('choose sends the confirm round to every guest with one candidate and a confirming intent; all yes → settled', async () => {
    const plan = await folded();
    expect(plan.fold?.agreed).toEqual([SAT_19, SAT_26]);
    h.clock.now = T0 + 10_000;
    const confirming = ok(await chooseSlot(plan.planId, { start: 'sat 26' }, h.deps));
    expect(confirming.state).toBe('confirming');
    expect(confirming.round).toBe(2);
    expect(confirming.chosen).toEqual(SAT_26);
    expect(h.queries.slice(3).map((q) => q.to)).toEqual([GARCIA, MILLER, JOHNSON]);
    for (const q of h.queries.slice(3)) {
      expect(q.body.params).toEqual({ intent: `Confirming Sat 26: ${INTENT}`, candidate_slots: [SAT_26] });
      expect(q.body.ttl_seconds).toBe(120);
    }
    expect(windowClosesAt(confirming)).toBe(T0 + 10_000 + 120_000);
    for (const did of [GARCIA, MILLER, JOHNSON]) reply(h, confirming, did, { status: 'accepted', accepted_slots: [SAT_26] });
    const settled = ok(await readGroupPlan(plan.planId, h.deps));
    expect(settled.state).toBe('settled');
    expect(settled.chosen).toEqual(SAT_26);
    expect(h.plans.listOpen()).toEqual([]);
  });

  it('a slot nobody agreed on is refused; the round counter does not move', async () => {
    const plan = await folded();
    expect(refusal(await chooseSlot(plan.planId, SAT_12, h.deps))).toBe('slot_not_agreed');
    expect(h.queries).toHaveLength(3);
    expect(h.plans.get(plan.planId)?.round).toBe(1);
  });

  it('a guest who reneges at confirm leaves the plan confirming with an empty fold naming them, and widen recovers', async () => {
    const plan = await folded();
    const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    reply(h, confirming, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    reply(h, confirming, MILLER, { status: 'counter', counter_slots: [{ start: 'Sun 27' }] });
    const stuck = ok(await readGroupPlan(plan.planId, h.deps));
    expect(stuck.state).toBe('confirming');
    expect(stuck.fold?.state).toBe('empty');
    expect(stuck.fold?.emptiedBy).toEqual([MILLER]);
    const widened = ok(await widenPlan(plan.planId, [{ start: 'Sun 27' }, { start: 'Sun 4 Oct' }], h.deps));
    expect(widened.state).toBe('proposing');
    expect(widened.round).toBe(3);
    expect(widened.chosen).toBeNull();
    expect(h.queries.slice(6).map((q) => q.body.params)).toEqual(
      Array(3).fill({ intent: INTENT, candidate_slots: [{ start: 'Sun 27' }, { start: 'Sun 4 Oct' }] }),
    );
    // Disclosures survive a widen; replies do not.
    expect(widened.guests.every((g) => g.reply === null && g.outcome === 'waiting')).toBe(true);
  });

  it('a new round supersedes the last: a still-live spoke is cancelled and its late reply is never this round’s answer', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_26] });
    const foldedPlan = ok(await readGroupPlan(plan.planId, h.deps));
    const johnsonRound1 = taskOf(foldedPlan, JOHNSON);
    expect(h.workflow.store().getById(johnsonRound1)?.status).toBe('running');
    const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    expect(h.workflow.store().getById(johnsonRound1)?.status).toBe('cancelled');
    expect(taskOf(confirming, JOHNSON)).not.toBe(johnsonRound1);
    // The old task cannot complete; the new one is still waiting.
    const landed = h.workflow
      .store()
      .completeWithDetails(johnsonRound1, '', 'received', JSON.stringify({ status: 'success', result: { status: 'accepted', accepted_slots: [SAT_26] } }), '{}', h.clock.now);
    expect(landed).toBe(0);
    expect(guest(ok(await readGroupPlan(plan.planId, h.deps)), JOHNSON).outcome).toBe('waiting');
  });

  it('three rounds is the ceiling; the fourth is refused before anything is on the wire', async () => {
    let plan = await folded();
    for (let round = 2; round <= MAX_PLAN_ROUNDS; round += 1) {
      plan = ok(await widenPlan(plan.planId, [{ start: `Sun ${round}` }], h.deps));
      expect(plan.round).toBe(round);
      for (const did of [GARCIA, MILLER]) reply(h, plan, did, { status: 'accepted', accepted_slots: [] });
      plan = ok(await readGroupPlan(plan.planId, h.deps));
    }
    const sent = h.queries.length;
    expect(refusal(await widenPlan(plan.planId, [{ start: 'Sun 9' }], h.deps))).toBe('rounds_exhausted');
    expect(h.queries).toHaveLength(sent);
  });

  it('dropping a guest from required re-folds without sending; abandoning cancels the live spokes without sending', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    const optional = ok(await makeGuestOptional(plan.planId, MILLER, h.deps));
    expect(optional.state).toBe('folded');
    expect(optional.fold?.agreed).toEqual([SAT_26]);
    expect(h.queries).toHaveLength(3);
    const gone = ok(await abandonPlan(plan.planId, h.deps));
    expect(gone.state).toBe('abandoned');
    expect(h.workflow.store().getById(taskOf(gone, MILLER))?.status).toBe('cancelled');
    expect(h.queries).toHaveLength(3);
    expect(refusal(await abandonPlan(plan.planId, h.deps))).toBe('wrong_state');
  });

  it('deleting a plan removes it and what guests disclosed for it, and cancels its live spokes', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26], disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }] });
    ok(await readGroupPlan(plan.planId, h.deps));
    expect(await deleteGroupPlan(plan.planId, h.deps)).toEqual({ ok: true, removed: true });
    expect(h.plans.get(plan.planId)).toBeNull();
    expect(h.workflow.store().getById(taskOf(plan, MILLER))?.status).toBe('cancelled');
    expect(await deleteGroupPlan(plan.planId, h.deps)).toEqual({ ok: true, removed: false });
    expect(refusal(await readGroupPlan(plan.planId, h.deps))).toBe('not_found');
  });

  it('lists every open plan folded as of now, newest first', async () => {
    const a = await openDefault(h);
    h.clock.now = T0 + 1000;
    const b = await openDefault(h, { guests: [{ contactDid: GARCIA, required: true }] });
    reply(h, b, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    const listed = await listGroupPlans(h.deps);
    expect(listed?.map((p) => p.planId)).toEqual([b.planId, a.planId]);
    expect(listed?.[0].state).toBe('folded');
  });
});

describe('the organizer holds what its own tier admits (§13)', () => {
  it('a disclosure the organizer’s tier for that contact refuses is dropped on receipt, counted, never quoted; the slots stay', async () => {
    h.holdTiers.set('health', 'none');
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, {
      status: 'accepted',
      accepted_slots: [SAT_26],
      disclosures: [
        { kind: 'dietary', text: 'someone is gluten-free', about: 'household' },
        { kind: 'transport', text: 'we can drive', about: 'household' },
      ],
    });
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    expect(guest(read, GARCIA).outcome).toBe('answered');
    expect(guest(read, GARCIA).reply).toEqual({ status: 'accepted', accepted_slots: [SAT_26] });
    expect(guest(read, GARCIA).disclosures).toEqual([{ kind: 'transport', text: 'we can drive', about: 'household' }]);
    // …and the prose that may repeat the refused fact is not held either.
    const plan2 = await openDefault(h);
    reply(h, plan2, MILLER, {
      status: 'accepted',
      accepted_slots: [{ start: 'Sat 26', note: 'we are gluten-free' }],
      message: 'Someone here is gluten-free.',
      disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }],
    });
    const read2 = ok(await readGroupPlan(plan2.planId, h.deps));
    expect(guest(read2, MILLER).reply).toEqual({ status: 'accepted', accepted_slots: [SAT_26] });
    expect(JSON.stringify(read2)).not.toContain('gluten');
    const audit = queryAudit({ action: 'group_plan_disclosure_refused' });
    expect(audit).toHaveLength(2); // one per refused reply
    for (const entry of audit) {
      expect(entry.detail).toContain('refused=1');
      expect(entry.detail).not.toContain('gluten');
    }
  });
});

describe('a provisional fold is not a decision (§4, §13)', () => {
  it('choose is refused while a required guest never answered; dropping them from required opens the choice', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    h.clock.now = T0 + 120_000;
    const folded = ok(await readGroupPlan(plan.planId, h.deps));
    expect(folded.state).toBe('folded');
    expect(folded.fold?.state).toBe('waiting');
    expect(folded.fold?.agreed).toEqual([SAT_26]);
    const refused = await chooseSlot(plan.planId, SAT_26, h.deps);
    expect(refused).toEqual({ ok: false, refusal: 'required_unanswered', detail: MILLER });
    expect(h.queries).toHaveLength(3);
    const relaxed = ok(await makeGuestOptional(plan.planId, MILLER, h.deps));
    expect(relaxed.fold?.state).toBe('converged');
    const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    expect(confirming.state).toBe('confirming');
    expect(h.queries).toHaveLength(6);
  });
});

describe('a settled plan can be reopened or stopped (§13)', () => {
  it('widen from settled reopens the fold within the round ceiling; abandon from settled stops it', async () => {
    const plan = await openDefault(h);
    for (const did of [GARCIA, MILLER, JOHNSON]) reply(h, plan, did, { status: 'accepted', accepted_slots: [SAT_26] });
    ok(await readGroupPlan(plan.planId, h.deps));
    const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    for (const did of [GARCIA, MILLER, JOHNSON]) reply(h, confirming, did, { status: 'accepted', accepted_slots: [SAT_26] });
    setNodeDID('did:plc:mikeorganiser0000000000');
    const settled = ok(await readGroupPlan(plan.planId, h.deps));
    expect(settled.state).toBe('settled');
    // COMMITMENT_KERNEL §15 step 6: each guest who accepted is told it is booked, alone.
    const booked = () => h.preflights.filter((m) => m.type === 'coordination.booked');
    expect(booked().map((m) => [m.to, (m.body as { state: string }).state])).toEqual([
      [GARCIA, 'booked'],
      [MILLER, 'booked'],
      [JOHNSON, 'booked'],
    ]);
    // The Garcias can't make the 26th after all: the organizer reopens with other dates.
    const reopened = ok(await widenPlan(plan.planId, [{ start: 'Sun 27' }], h.deps));
    expect(booked().slice(3).map((m) => [m.to, (m.body as { state: string }).state])).toEqual([
      [GARCIA, 'cancelled'],
      [MILLER, 'cancelled'],
      [JOHNSON, 'cancelled'],
    ]);
    expect(reopened.state).toBe('proposing');
    expect(reopened.round).toBe(3);
    expect(reopened.chosen).toBeNull();
    expect(h.plans.listOpen().map((p) => p.planId)).toEqual([plan.planId]);
    const stopped = ok(await abandonPlan(plan.planId, h.deps));
    expect(stopped.state).toBe('abandoned');
  });

  it('deleting a settled plan tells each booked guest first; one that cannot be told keeps the plan', async () => {
    setNodeDID('did:plc:mikeorganiser0000000000');
    const plan = await openDefault(h);
    for (const did of [GARCIA, MILLER, JOHNSON]) reply(h, plan, did, { status: 'accepted', accepted_slots: [SAT_26] });
    ok(await readGroupPlan(plan.planId, h.deps));
    const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    for (const did of [GARCIA, MILLER, JOHNSON]) reply(h, confirming, did, { status: 'accepted', accepted_slots: [SAT_26] });
    expect(ok(await readGroupPlan(plan.planId, h.deps)).state).toBe('settled');
    h.failSendsTo.add(MILLER);
    expect(await deleteGroupPlan(plan.planId, h.deps)).toEqual({
      ok: false,
      refusal: 'cancellations_pending',
      detail: 'a booked guest could not be told yet',
    });
    expect(h.plans.get(plan.planId)).not.toBeNull();
    // The refusal stopped the plan: a read books nobody again.
    const before = h.preflights.filter((m) => m.type === 'coordination.booked').length;
    expect(ok(await readGroupPlan(plan.planId, h.deps)).state).toBe('abandoned');
    const sinceRead = h.preflights.filter((m) => m.type === 'coordination.booked').slice(before);
    expect(sinceRead.every((m) => (m.body as { state: string }).state === 'cancelled')).toBe(true);
    h.failSendsTo.delete(MILLER);
    expect(await deleteGroupPlan(plan.planId, h.deps)).toEqual({ ok: true, removed: true });
    const cancels = h.preflights.filter(
      (m) => m.type === 'coordination.booked' && (m.body as { state: string }).state === 'cancelled',
    );
    // Each guest told once: the Garcias and Johnsons on the first try, the Millers on the second.
    expect(cancels.map((m) => m.to).sort()).toEqual([GARCIA, JOHNSON, MILLER].sort());
  });
});

describe('the fan-out survives its own faults', () => {
  it('a spoke whose submit is faulty is audited, not thrown; the next read resumes it inside the window', async () => {
    let faults = 0;
    const deps: GroupCoordinationDeps = {
      ...h.deps,
      submitQuery: async (body, options) => {
        const to = (body as { to_did: string }).to_did;
        if (to === MILLER && faults === 0) {
          faults += 1;
          return { status: 503, body: { error: 'workflow service not wired' } };
        }
        return submitServiceQuery(body, options);
      },
    };
    const plan = ok(
      await openGroupPlan(
        {
          intent: INTENT,
          guests: [{ contactDid: GARCIA, required: true }, { contactDid: MILLER, required: true }],
          candidates: [SAT_26],
          windowSeconds: 120,
        },
        deps,
      ),
    );
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA]);
    expect(currentSpoke(guest(plan, MILLER), 1)).toBeNull();
    expect(queryAudit({ action: 'group_plan_spoke_fault' })).toHaveLength(1);
    // Read while the window is open: the fan-out resumes for the guest it never reached.
    const resumed = ok(await readGroupPlan(plan.planId, deps));
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, MILLER]);
    expect(currentSpoke(guest(resumed, MILLER), 1)?.stage).toBe('queried');
    // A second read sends nothing more.
    ok(await readGroupPlan(plan.planId, deps));
    expect(h.queries).toHaveLength(2);
  });

  it('a crash between the send and the plan write re-links to the task on the wire — even one the guest already answered — and never asks twice', async () => {
    const plan = await openDefault(h);
    // Simulate the crash window: the query went out and the guest answered,
    // but the plan row never recorded the spoke.
    const millerTask = taskOf(plan, MILLER);
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_26] });
    const wiped: GroupPlan = {
      ...plan,
      guests: plan.guests.map((g) => (g.contactDid === MILLER ? { ...g, spokes: [] } : g)),
    };
    h.plans.put(wiped);
    expect(h.queries).toHaveLength(3);
    const read = ok(await readGroupPlan(plan.planId, h.deps));
    // One question on the wire per guest per round, and the reply that landed on it is folded.
    expect(h.queries).toHaveLength(3);
    expect(taskOf(read, MILLER)).toBe(millerTask);
    expect(guest(read, MILLER)).toEqual(
      expect.objectContaining({ outcome: 'answered', reply: { status: 'accepted', accepted_slots: [SAT_26] } }),
    );
    // The 1:1 path is unchanged: an unscoped repeat of a COMPLETED query is a new query.
    const again = await submitServiceQuery(
      {
        to_did: MILLER,
        capability: GROUP_COORDINATION_CAPABILITY,
        query_id: 'fresh',
        params: spokeParams(plan),
        ttl_seconds: 60,
        service_uri: `at://${MILLER}/com.dinakernel.service.profile/talk`,
        grant_id: 'grant_miller',
      },
      { sender: h.deps.querySender, nowSecFn: () => Math.floor(h.clock.now / 1000) },
    );
    expect((again.body as { deduped?: boolean }).deduped).toBeUndefined();
    expect(h.queries).toHaveLength(4);
  });

  it('a guest the fan-out never reached is not resumed after the window; it closes like any silence', async () => {
    const deps: GroupCoordinationDeps = {
      ...h.deps,
      submitQuery: async (body, options) =>
        (body as { to_did: string }).to_did === MILLER
          ? { status: 500, body: { error: 'boom' } }
          : submitServiceQuery(body, options),
    };
    const plan = await openDefault({ ...h, deps });
    h.clock.now = T0 + 120_000;
    const read = ok(await readGroupPlan(plan.planId, deps));
    expect(guest(read, MILLER).outcome).toBe('unreachable');
    expect(h.queries.map((q) => q.to)).toEqual([GARCIA, JOHNSON]);
  });
});

describe('deleting a plan deletes what guests disclosed for it (§7)', () => {
  it('every spoke’s stored reply is scrubbed, in every round', async () => {
    const plan = await openDefault(h);
    for (const did of [GARCIA, MILLER, JOHNSON]) {
      reply(h, plan, did, {
        status: 'accepted',
        accepted_slots: [SAT_26],
        disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }],
      });
    }
    ok(await readGroupPlan(plan.planId, h.deps));
    const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    reply(h, confirming, GARCIA, { status: 'accepted', accepted_slots: [SAT_26] });
    const before = confirming.guests.flatMap((g) => g.spokes).filter((s) => s.stage === 'queried');
    expect(before).toHaveLength(6);
    expect(await deleteGroupPlan(plan.planId, h.deps)).toEqual({ ok: true, removed: true });
    for (const spoke of before) {
      if (spoke.stage !== 'queried') continue;
      const task = h.workflow.store().getById(spoke.taskId);
      expect(task).not.toBeNull();
      expect(task?.result ?? '').not.toContain('gluten');
      expect(task?.result ?? '').toBe('');
      expect(['completed', 'cancelled']).toContain(task?.status);
    }
  });
});

describe('what leaves the node, and what the log holds', () => {
  it('the audit trail carries counts and ids, never the intent or a disclosure', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26], disclosures: [{ kind: 'dietary', text: 'peanut allergy', about: 'nobody' }] });
    ok(await readGroupPlan(plan.planId, h.deps));
    appendAudit('test', 'marker', 'x');
    const everything = queryAudit().map((e) => `${e.action} ${e.resource} ${e.detail ?? ''}`).join('\n');
    expect(everything).toContain('group_plan_opened');
    expect(everything).not.toContain('Emma');
    expect(everything).not.toContain('peanut');
  });

  it('two plans asking the same guest the same question never share a task', async () => {
    const a = await openDefault(h);
    const b = await openDefault(h);
    expect(taskOf(a, GARCIA)).not.toBe(taskOf(b, GARCIA));
    expect(h.queries).toHaveLength(6);
  });
});

describe('Brain picks the slot (COMMITMENT_KERNEL §15 step 11)', () => {
  let db: NodeSQLiteAdapter;
  let briefs: NegotiationBrief[];
  let settings: { strategy: 'fixed' | 'brain'; valuesOn: boolean };
  let budget: number;
  let dbDir: string;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-group-slot-'));
    db = new NodeSQLiteAdapter({
      path: path.join(dbDir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    briefs = [];
    settings = { strategy: 'brain', valuesOn: true };
    budget = 5;
    installGroupSlotStrategy({
      settings: () => settings,
      canSpend: () => budget > 0,
      charge: () => {
        if (budget <= 0) return false;
        budget -= 1;
        return true;
      },
      turns: new StrategyTurnStore(db),
      submit: (brief) => {
        briefs.push(brief);
        return { taskId: `task-${String(briefs.length)}` };
      },
      atomically: (fn) => db.transaction(fn),
    });
  });
  afterEach(() => {
    installGroupSlotStrategy(null);
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  async function folded(): Promise<GroupPlan> {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_26, SAT_19] });
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_19, SAT_26] });
    reply(h, plan, JOHNSON, { status: 'accepted', accepted_slots: [SAT_26] });
    return ok(await readGroupPlan(plan.planId, h.deps));
  }
  const pick = (planId: string, turn: number, value: string) =>
    applyGroupSlotMove(
      {
        input: { kind: 'group.organizer', ref: { negotiationId: planId, turn } },
        result: { move: { kind: 'propose', versions: [{ terms: [{ name: 'slot', value }] }] } },
      },
      h.deps,
    );

  it('a fold with agreed slots asks Brain once; its pick opens the confirming round', async () => {
    const plan = await folded();
    expect(plan.fold?.agreed).toEqual([SAT_19, SAT_26]);
    expect(briefs).toHaveLength(1);
    const brief = briefs[0];
    expect(brief?.ref).toEqual({ negotiationId: plan.planId, turn: 1 });
    expect(brief?.table).toEqual({
      intent: INTENT,
      agreed: [
        { index: 0, start: SAT_19.start },
        { index: 1, start: SAT_26.start },
      ],
    });
    // Nothing about the guests reaches Brain.
    expect(JSON.stringify(brief)).not.toMatch(new RegExp([GARCIA, MILLER, JOHNSON].join('|')));
    // Reading again does not ask again.
    await readGroupPlan(plan.planId, h.deps);
    expect(briefs).toHaveLength(1);
    expect(await pick(plan.planId, 1, '1')).toBe('chosen');
    const confirming = ok(await readGroupPlan(plan.planId, h.deps));
    expect(confirming.state).toBe('confirming');
    expect(confirming.chosen).toEqual(SAT_26);
    expect(budget).toBe(4);
  });

  it('a pick outside the agreed slots, or a stale one, chooses nothing; the owner picks', async () => {
    const plan = await folded();
    expect(await pick(plan.planId, 1, '7')).toBe('owner_picks');
    expect(ok(await readGroupPlan(plan.planId, h.deps)).state).toBe('folded');
    // The turn is closed: a second try changes nothing, and the owner still can.
    expect(await pick(plan.planId, 1, '0')).toBe('owner_picks');
    expect(ok(await chooseSlot(plan.planId, SAT_19, h.deps)).chosen).toEqual(SAT_19);
  });

  it('Brain’s index is read against the slots it was shown, not a fold that moved since', async () => {
    const plan = await openDefault(h);
    reply(h, plan, GARCIA, { status: 'accepted', accepted_slots: [SAT_19, SAT_26] });
    reply(h, plan, MILLER, { status: 'accepted', accepted_slots: [SAT_26] });
    reply(h, plan, JOHNSON, { status: 'declined' });
    const folded = ok(await readGroupPlan(plan.planId, h.deps));
    expect(folded.fold?.agreed).toEqual([SAT_26]);
    expect(briefs[0]?.table).toMatchObject({ agreed: [{ index: 0, start: SAT_26.start }] });
    // Miller is no longer required: the fold now agrees on Sat 19 too, first.
    const relaxed = ok(await makeGuestOptional(plan.planId, MILLER, h.deps));
    expect(relaxed.fold?.agreed).toEqual([SAT_19, SAT_26]);
    // Brain's 0 meant Sat 26, the one slot it was shown.
    expect(await pick(plan.planId, 1, '0')).toBe('chosen');
    expect(ok(await readGroupPlan(plan.planId, h.deps)).chosen).toEqual(SAT_26);
  });

  it('the verdict is charged before the slot is chosen: no budget, no confirming round', async () => {
    const plan = await folded();
    budget = 0;
    expect(await pick(plan.planId, 1, '1')).toBe('owner_picks');
    expect(ok(await readGroupPlan(plan.planId, h.deps)).state).toBe('folded');
  });

  it('a crash after the choice, before its turn was settled: the replay settles it and charges nothing more', async () => {
    const plan = await folded();
    const move = {
      input: { kind: 'group.organizer', ref: { negotiationId: plan.planId, turn: 1 } },
      result: { move: { kind: 'propose', versions: [{ terms: [{ name: 'slot', value: '1' }] }] } },
    };
    // The first try charges and chooses, then stops before settling.
    const slot = slotFromMove(ok(await readGroupPlan(plan.planId, h.deps)), {
      planId: plan.planId,
      turn: 1,
      result: move.result,
      nowMs: T0,
    });
    expect(slot).toEqual(SAT_26);
    ok(await chooseSlot(plan.planId, SAT_26, h.deps));
    expect(budget).toBe(4);
    // The replay finds the slot chosen: the turn is settled, no second charge.
    expect(await applyGroupSlotMove(move, h.deps)).toBe('owner_picks');
    expect(budget).toBe(4);
    expect(ok(await readGroupPlan(plan.planId, h.deps)).chosen).toEqual(SAT_26);
  });

  it('the verdict and its mark land together: a crash between them charges nothing, and the replay pays once', async () => {
    // A real budget on the same database: one verdict in this plan.
    const strategies = new StrategyStore(db, { perNegotiation: 1, perOwnerMonthly: 10 });
    const turns = new StrategyTurnStore(db);
    let failOnce = true;
    const realNote = turns.note.bind(turns);
    turns.note = (...args: Parameters<StrategyTurnStore['note']>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('crash between the charge and its mark');
      }
      return realNote(...args);
    };
    installGroupSlotStrategy({
      settings: () => settings,
      canSpend: (id, nowMs) =>
        strategies.canSpend({ kind: 'group.organizer', negotiationId: id, nowMs, thresholdVersion: 0 }).ok,
      charge: (id, nowMs) =>
        strategies.charge({ kind: 'group.organizer', negotiationId: id, count: 1, nowMs, thresholdVersion: 0 }).ok,
      turns,
      submit: (brief) => {
        briefs.push(brief);
        return { taskId: `task-${String(briefs.length)}` };
      },
      atomically: (fn) => db.transaction(fn),
    });
    const plan = await folded();
    await expect(pick(plan.planId, 1, '1')).rejects.toThrow('crash between');
    // The charge rolled back with the mark: the one verdict still pays for the replay.
    expect(await pick(plan.planId, 1, '1')).toBe('chosen');
    expect(ok(await readGroupPlan(plan.planId, h.deps)).chosen).toEqual(SAT_26);
  });

  it('the owner on the fixed style, or no budget: Brain is not asked', async () => {
    settings = { strategy: 'fixed', valuesOn: true };
    await folded();
    expect(briefs).toEqual([]);
    settings = { strategy: 'brain', valuesOn: true };
    budget = 0;
    await folded();
    expect(briefs).toEqual([]);
  });

  describe('Brain asks the owner (§15 step 14)', () => {
    let questions: StrategyQuestionStore;
    const handler = makeOwnerQuestionDecisionHandler({
      workflow: () => h.workflow,
      nowMs: () => h.clock.now,
    });
    beforeEach(() => {
      installOwnerQuestions(db);
      questions = new StrategyQuestionStore(db);
    });
    afterEach(() => installOwnerQuestions(null));

    const askMove = (planId: string, turn: number, question: string, answersSeen = 0) =>
      applyGroupSlotMove(
        {
          input: {
            kind: 'group.organizer',
            ref: { negotiationId: planId, turn },
            ...(answersSeen > 0
              ? { ownerAnswers: Array.from({ length: answersSeen }, () => ({ question: 'q', answer: 'yes' })) }
              : {}),
          },
          result: { move: { kind: 'ask_owner', question } },
        },
        h.deps,
      );
    const pickSeen = (planId: string, turn: number, value: string, answersSeen: number) =>
      applyGroupSlotMove(
        {
          input: {
            kind: 'group.organizer',
            ref: { negotiationId: planId, turn },
            ownerAnswers: Array.from({ length: answersSeen }, () => ({ question: 'q', answer: 'yes' })),
          },
          result: { move: { kind: 'propose', versions: [{ terms: [{ name: 'slot', value }] }] } },
        },
        h.deps,
      );
    /** The owner answers the card the way the inbox does; the handler is told. */
    function answer(cardId: string, decision: 'approved' | 'denied'): void {
      const task = decision === 'approved' ? h.workflow.approve(cardId) : h.workflow.cancel(cardId, 'no');
      handler({ task, decision });
    }
    const openCard = (planId: string, turn: number) => questions.openFor('group.organizer', planId, turn)?.cardId ?? '';
    const turnState = (planId: string, turn: number) =>
      new StrategyTurnStore(db).get('group.organizer', planId, turn)?.state;

    it('GQ-01: a question goes on a card; the round waits; a yes goes back to Brain, whose pick then stands', async () => {
      const plan = await folded();
      expect(await askMove(plan.planId, 1, 'Saturday 26th clashes with the school fete. Take it anyway?')).toBe(
        'asked_owner',
      );
      const card = h.workflow.store().getById(openCard(plan.planId, 1));
      expect(card?.status).toBe('pending_approval');
      expect(card?.description).toBe(
        'Brain asks, on a group booking: Saturday 26th clashes with the school fete. Take it anyway?',
      );
      // The card names no plan and no guest.
      expect(card?.payload).not.toMatch(new RegExp([plan.planId, GARCIA, MILLER, JOHNSON].join('|')));
      // Nothing is chosen while the card is open, and reading does not ask Brain again.
      const waiting = ok(await readGroupPlan(plan.planId, h.deps));
      expect(waiting.state).toBe('folded');
      expect(briefs).toHaveLength(1);
      expect(turnState(plan.planId, 1)).toBe('pending');
      // A replay of the move that asked, while the card is open, changes nothing.
      expect(await askMove(plan.planId, 1, 'again?')).toBe('owner_picks');
      expect(questions.countFor('group.organizer', plan.planId)).toBe(1);
      expect(turnState(plan.planId, 1)).toBe('pending');

      answer(card?.id ?? '', 'approved');
      expect(h.workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
      expect(briefs).toHaveLength(2);
      expect(briefs[1]?.ref).toEqual({ negotiationId: plan.planId, turn: 1 });
      expect(briefs[1]?.ownerAnswers).toEqual([
        { question: 'Saturday 26th clashes with the school fete. Take it anyway?', answer: 'yes' },
      ]);
      expect(briefs[1]?.table).toEqual(briefs[0]?.table);
      // A pick from the brief before the answer is stale: the turn stays for the new one.
      expect(await pick(plan.planId, 1, '0')).toBe('owner_picks');
      expect(turnState(plan.planId, 1)).toBe('pending');
      expect(await pickSeen(plan.planId, 1, '1', 1)).toBe('chosen');
      expect(ok(await readGroupPlan(plan.planId, h.deps)).chosen).toEqual(SAT_26);
    });

    it('GQ-02: a no goes back to Brain too; a lapse leaves the pick to the owner', async () => {
      const plan = await folded();
      await askMove(plan.planId, 1, 'May I pick the earlier one?');
      answer(openCard(plan.planId, 1), 'denied');
      expect(briefs[1]?.ownerAnswers).toEqual([{ question: 'May I pick the earlier one?', answer: 'no' }]);
      // Brain asks a second question; the owner lets it lapse.
      expect(await askMove(plan.planId, 1, 'Then the later one?', 1)).toBe('asked_owner');
      const second = h.workflow.store().getById(openCard(plan.planId, 1));
      expect(second?.expires_at).toBe(Math.floor((h.clock.now + 24 * 3600_000) / 1000));
      h.clock.now += 25 * 3600_000;
      h.workflow.expireTasks(Math.floor(h.clock.now / 1000), h.clock.now);
      handler({ task: { ...(second as WorkflowTask) }, decision: 'lapsed' });
      expect(turnState(plan.planId, 1)).toBe('fallen_back');
      expect(briefs).toHaveLength(2);
      expect(ok(await chooseSlot(plan.planId, SAT_19, h.deps)).chosen).toEqual(SAT_19);
    });

    it('GQ-03: two questions a deal at most; a third lets the owner pick', async () => {
      const plan = await folded();
      await askMove(plan.planId, 1, 'One?');
      answer(openCard(plan.planId, 1), 'approved');
      await askMove(plan.planId, 1, 'Two?', 1);
      answer(openCard(plan.planId, 1), 'approved');
      expect(await askMove(plan.planId, 1, 'Three?', 2)).toBe('owner_picks');
      expect(turnState(plan.planId, 1)).toBe('fallen_back');
      expect(questions.countFor('group.organizer', plan.planId)).toBe(2);
    });

    it('GQ-04: the owner picks while the card is open: the question is withdrawn, and its notice records nothing', async () => {
      const plan = await folded();
      await askMove(plan.planId, 1, 'Wait for Garcia’s reply on the 19th?');
      const cardId = openCard(plan.planId, 1);
      ok(await chooseSlot(plan.planId, SAT_19, h.deps));
      const card = h.workflow.store().getById(cardId);
      expect(card?.status).toBe('cancelled');
      // The cancel's notice reaches the handler as a no; the question was settled first.
      handler({ task: card as WorkflowTask, decision: 'denied' });
      expect(questions.byCard(cardId)?.answer).toBe('lapsed');
      expect(briefs).toHaveLength(1);
      // Brain chosen no more: a question still open is withdrawn on the next read.
      const other = await folded();
      await askMove(other.planId, 1, 'Anything?');
      settings = { strategy: 'fixed', valuesOn: true };
      await readGroupPlan(other.planId, h.deps);
      expect(questions.openIn('group.organizer', other.planId)).toEqual([]);
    });

    it('GQ-05: a yes whose handler a crash cut short is settled at boot; the plan’s next read hands it to Brain', async () => {
      const plan = await folded();
      await askMove(plan.planId, 1, 'Go ahead?');
      const cardId = openCard(plan.planId, 1);
      h.workflow.approve(cardId); // the handler never ran
      expect(reconcileOwnerQuestionsAtBoot(h.clock.now)).toBe(1);
      expect(questions.byCard(cardId)?.answer).toBe('yes');
      expect(h.workflow.store().getById(cardId)?.status).toBe('completed');
      // Boot asks Brain nothing (its broker may not be up): the answer is not used up.
      expect(briefs).toHaveLength(1);
      expect(turnState(plan.planId, 1)).toBe('pending');
      await readGroupPlan(plan.planId, h.deps);
      expect(briefs[1]?.ownerAnswers).toEqual([{ question: 'Go ahead?', answer: 'yes' }]);
      // Again at boot: nothing more.
      expect(reconcileOwnerQuestionsAtBoot(h.clock.now)).toBe(0);
      expect(briefs).toHaveLength(2);
    });

    it('GQ-07: the card never shows the plan’s id, even when Brain writes it into the question', async () => {
      const plan = await folded();
      await askMove(plan.planId, 1, `Is ${plan.planId} the family lunch?`);
      const card = h.workflow.store().getById(openCard(plan.planId, 1));
      expect(card?.description).toBe('Brain asks, on a group booking: Is this deal the family lunch?');
      expect(card?.payload).not.toContain(plan.planId);
    });

    it('GQ-08: a question that arrives after the owner deleted the plan raises no card', async () => {
      const plan = await folded();
      expect(await deleteGroupPlan(plan.planId, h.deps)).toEqual({ ok: true, removed: true });
      expect(await askMove(plan.planId, 1, 'Still there?')).toBe('owner_picks');
      expect(questions.countFor('group.organizer', plan.planId)).toBe(0);
      expect(turnState(plan.planId, 1)).toBe('fallen_back');
    });

    it('GQ-09: a delete that stops with a guest still to tell withdraws Brain’s question', async () => {
      setNodeDID('did:plc:mikeorganiser0000000000');
      const plan = await openDefault(h);
      for (const did of [GARCIA, MILLER, JOHNSON]) reply(h, plan, did, { status: 'accepted', accepted_slots: [SAT_26] });
      ok(await readGroupPlan(plan.planId, h.deps));
      const confirming = ok(await chooseSlot(plan.planId, SAT_26, h.deps));
      for (const did of [GARCIA, MILLER, JOHNSON])
        reply(h, confirming, did, { status: 'accepted', accepted_slots: [SAT_26] });
      expect(ok(await readGroupPlan(plan.planId, h.deps)).state).toBe('settled');
      // Miller cannot be told the booking is off, so the widened plan keeps that to do.
      h.failSendsTo.add(MILLER);
      const wider = ok(await widenPlan(plan.planId, [SAT_19], h.deps));
      // Miller cannot be reached for the wider round either: the owner goes on without them.
      for (const did of [GARCIA, JOHNSON]) reply(h, wider, did, { status: 'accepted', accepted_slots: [SAT_19] });
      ok(await makeGuestOptional(plan.planId, MILLER, h.deps));
      const refolded = ok(await readGroupPlan(plan.planId, h.deps));
      expect(refolded.state).toBe('folded');
      expect(await askMove(plan.planId, refolded.round, 'The 19th then?')).toBe('asked_owner');
      const cardId = openCard(plan.planId, refolded.round);
      expect(await deleteGroupPlan(plan.planId, h.deps)).toMatchObject({ ok: false, refusal: 'cancellations_pending' });
      expect(h.workflow.store().getById(cardId)?.status).toBe('cancelled');
      expect(questions.byCard(cardId)?.answer).toBe('lapsed');
    });

    it('GQ-06: an answer whose hand-back a crash cut short goes back to Brain on the next read', async () => {
      const plan = await folded();
      await askMove(plan.planId, 1, 'Go ahead?');
      const cardId = openCard(plan.planId, 1);
      // The answer is kept, then the process stops before Brain is asked again.
      questions.answer(cardId, 'yes', h.clock.now);
      expect(briefs).toHaveLength(1);
      await readGroupPlan(plan.planId, h.deps);
      expect(briefs).toHaveLength(2);
      expect(briefs[1]?.ownerAnswers).toEqual([{ question: 'Go ahead?', answer: 'yes' }]);
      await readGroupPlan(plan.planId, h.deps);
      expect(briefs).toHaveLength(2);
    });
  });
});
