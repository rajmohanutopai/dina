/**
 * `/v1/coordination/*` — the owner boundary and the wire shape (GROUP_COORDINATION
 * §7, §9). The service is exercised in `__tests__/coordination/`; here the
 * router is driven end to end over the REAL identity store (contacts, people,
 * offers and plans through the SQLite adapter and the identity migrations)
 * with the real submit path and a fake sender, and what is pinned is who may
 * call, what a refusal looks like on the wire, and what a surface is handed.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { addContact, resetContactDirectory } from '../../../src/contacts/directory';
import { SQLiteContactRepository, setContactRepository } from '../../../src/contacts/repository';
import {
  SQLiteServiceOfferRepository,
  setServiceOfferRepository,
  type ServiceOffer,
} from '../../../src/contacts/service_offers_repository';
import { GROUP_COORDINATION_CAPABILITY } from '../../../src/coordination/group_coordination_service';
import {
  SQLiteGroupPlanRepository,
  setGroupPlanRepository,
  type GroupPlanRepository,
} from '../../../src/coordination/group_plan_repository';
import { SQLitePeopleRepository, setPeopleRepository } from '../../../src/people/repository';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { setD2DSender } from '../../../src/server/routes/d2d_msg';
import { registerGroupCoordinationRoutes } from '../../../src/server/routes/group_coordination';
import { setServiceQuerySender } from '../../../src/server/routes/service_query';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

import type { ServiceQueryBody } from '../../../src/d2d/service_bodies';

const OWNER_CAP = 'test-owner-capability-secret';
const GARCIA = 'did:plc:garcia';
const MILLER = 'did:plc:miller';
const NON_OWNER: (string | undefined)[] = [undefined, 'brain', 'agent', 'plugin', 'connector', 'device', 'service'];

function req(
  method: CoreRequest['method'],
  path: string,
  callerType: string | undefined,
  body: unknown = undefined,
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

function offerFrom(did: string): ServiceOffer {
  return {
    grantId: `grant_${did}`,
    providerDid: did,
    capability: GROUP_COORDINATION_CAPABILITY,
    serviceUri: `at://${did}/com.dinakernel.service.profile/talk`,
    serviceName: 'a Dina',
    schemaHash: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

const PLAN_BODY = {
  intent: "Emma's birthday",
  guests: [{ contact_did: GARCIA, required: true }, { contact_did: MILLER }],
  candidates: [{ start: 'Sat 19' }, { start: 'Sat 26' }],
  window_seconds: 60,
};

let router: CoreRouter;
let workflow: WorkflowService;
let sent: { to: string; body: ServiceQueryBody }[];
let plans: GroupPlanRepository;
let dir: string;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'group-coordination-routes-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  // The organizer's contacts, through the live directory over the real repos:
  // `getContact` is what the service's layer-1 check reads.
  resetContactDirectory();
  setPeopleRepository(new SQLitePeopleRepository(adapter));
  setContactRepository(new SQLiteContactRepository(adapter));
  addContact(GARCIA, 'The Garcias', 'verified');
  addContact(MILLER, 'The Millers', 'trusted');
  const offers = new SQLiteServiceOfferRepository(adapter);
  offers.upsert(offerFrom(GARCIA));
  offers.upsert(offerFrom(MILLER));
  setServiceOfferRepository(offers);
  plans = new SQLiteGroupPlanRepository(adapter);
  setGroupPlanRepository(plans);
  sent = [];
  workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  setWorkflowService(workflow);
  setServiceQuerySender(async (to, _type, body) => {
    sent.push({ to, body });
  });
  setD2DSender(async () => undefined);
  router = new CoreRouter();
  registerGroupCoordinationRoutes(router, OWNER_CAP);
});

afterEach(() => {
  setWorkflowService(null);
  setServiceOfferRepository(null);
  setGroupPlanRepository(null);
  setContactRepository(null);
  setPeopleRepository(null);
  resetContactDirectory();
  setServiceQuerySender(null);
  setD2DSender(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function open(): Promise<Record<string, unknown>> {
  const resp = await router.handle(req('POST', '/v1/coordination/plans', 'owner', PLAN_BODY));
  expect(resp).toEqual(expect.objectContaining({ status: 201 }));
  return (resp.body as { plan: Record<string, unknown> }).plan;
}

describe('/v1/coordination/* — owner boundary', () => {
  it('rejects every non-owner caller on every route (403), and sends nothing', async () => {
    const routes: [CoreRequest['method'], string][] = [
      ['POST', '/v1/coordination/plans'],
      ['GET', '/v1/coordination/handles'],
      ['GET', '/v1/coordination/plans'],
      ['GET', '/v1/coordination/plans/p1'],
      ['POST', '/v1/coordination/plans/p1/choose'],
      ['POST', '/v1/coordination/plans/p1/widen'],
      ['POST', '/v1/coordination/plans/p1/optional'],
      ['POST', '/v1/coordination/plans/p1/abandon'],
      ['DELETE', '/v1/coordination/plans/p1'],
    ];
    // Opening and reading are also Brain's doors (the next test); every other
    // caller is refused on every route, and every caller on every decision.
    const brainDoors = new Set(['POST /v1/coordination/plans', 'GET /v1/coordination/plans/p1', 'GET /v1/coordination/handles']);
    for (const [method, path] of routes) {
      for (const ct of NON_OWNER) {
        if (brainDoors.has(`${method} ${path}`) && (ct === 'brain' || ct === undefined)) continue;
        const resp = await router.handle(req(method, path, ct, PLAN_BODY));
        expect([method, path, ct, resp.status]).toEqual([method, path, ct, 403]);
      }
    }
    expect(sent).toHaveLength(0);
    expect(plans.listOpen()).toEqual([]);
  });

  it('Brain, and an unstamped in-process caller, may open a plan, read it and list handles — and nothing else (§11)', async () => {
    for (const ct of ['brain', undefined]) {
      const opened = await router.handle(req('POST', '/v1/coordination/plans', ct, PLAN_BODY));
      expect(opened.status).toBe(201);
      const planId = (opened.body as { plan: { plan_id: string } }).plan.plan_id;
      const read = await router.handle(req('GET', `/v1/coordination/plans/${planId}`, ct));
      expect(read.status).toBe(200);
      const handles = await router.handle(req('GET', '/v1/coordination/handles', ct));
      expect(handles.status).toBe(200);
      const list = (handles.body as { plans: Record<string, unknown>[] }).plans;
      expect(list.map((h) => h.plan_id)).toContain(planId);
      // A handle names the plan and nothing about who is in it.
      for (const h of list) {
        expect(Object.keys(h).sort()).toEqual(['chosen', 'intent', 'plan_id', 'round', 'state', 'updated_at']);
        expect(JSON.stringify(h)).not.toContain('did:');
      }
      for (const [method, path, body] of [
        ['GET', '/v1/coordination/plans', undefined],
        ['POST', `/v1/coordination/plans/${planId}/choose`, { slot: { start: 'Sat 26' } }],
        ['POST', `/v1/coordination/plans/${planId}/widen`, { candidates: [{ start: 'Sun 27' }] }],
        ['POST', `/v1/coordination/plans/${planId}/optional`, { contact_did: MILLER }],
        ['POST', `/v1/coordination/plans/${planId}/abandon`, undefined],
        ['DELETE', `/v1/coordination/plans/${planId}`, undefined],
      ] as [CoreRequest['method'], string, unknown][]) {
        const resp = await router.handle(req(method, path, ct, body));
        expect([method, path, resp.status]).toEqual([method, path, 403]);
      }
    }
    expect(sent).toHaveLength(4);
  });

  it('a router registered without a capability refuses the owner too (fail closed)', async () => {
    const bare = new CoreRouter();
    registerGroupCoordinationRoutes(bare, undefined);
    const resp = await bare.handle(req('POST', '/v1/coordination/plans', 'owner', PLAN_BODY));
    expect(resp.status).toBe(403);
  });
});

describe('/v1/coordination/* — the wire', () => {
  it('POST opens a plan, fans out, and answers the projection in snake_case with spoke task ids', async () => {
    const plan = await open();
    expect(sent.map((s) => s.to)).toEqual([GARCIA, MILLER]);
    expect(plan).toEqual(
      expect.objectContaining({
        plan_id: expect.stringMatching(/^gp_/),
        intent: "Emma's birthday",
        state: 'proposing',
        window_seconds: 60,
        round: 1,
        round_opened_at: expect.any(Number),
        window_closes_at: expect.any(Number),
        candidates: [{ start: 'Sat 19' }, { start: 'Sat 26' }],
        chosen: null,
        fold: null,
        requirements: [],
      }),
    );
    const guests = plan.guests as Record<string, unknown>[];
    expect(guests).toHaveLength(2);
    expect(guests[0]).toEqual({
      contact_did: GARCIA,
      required: true,
      outcome: 'waiting',
      reply: null,
      disclosures: [],
      spokes: [{ round: 1, stage: 'queried', task_id: expect.any(String) }],
    });
    // `required` defaults to true when omitted.
    expect(guests[1].required).toBe(true);
    // No camelCase leaks.
    expect(JSON.stringify(plan)).not.toMatch(/[a-z][A-Z]/);
  });

  it('GET folds on read: a landed reply is answered, the fold is present, requirements are de-identified', async () => {
    const plan = await open();
    const guests = plan.guests as { spokes: { task_id: string }[] }[];
    workflow.store().completeWithDetails(
      guests[0].spokes[0].task_id,
      '',
      'received',
      JSON.stringify({
        status: 'success',
        result: {
          status: 'accepted',
          accepted_slots: [{ start: 'Sat 26' }],
          disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }],
        },
      }),
      '{}',
      Date.now(),
    );
    // Both guests are required (the second by default), so the plan folds only
    // once both have answered; in between the fold is provisional.
    const provisional = await router.handle(req('GET', `/v1/coordination/plans/${plan.plan_id}`, 'owner'));
    expect((provisional.body as { plan: { state: string; fold: { state: string } } }).plan).toEqual(
      expect.objectContaining({ state: 'proposing', fold: expect.objectContaining({ state: 'waiting', missing_required: [MILLER] }) }),
    );
    workflow.store().completeWithDetails(
      guests[1].spokes[0].task_id,
      '',
      'received',
      JSON.stringify({ status: 'success', result: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }, { start: 'Sat 19' }] } }),
      '{}',
      Date.now(),
    );
    const resp = await router.handle(req('GET', `/v1/coordination/plans/${plan.plan_id}`, 'owner'));
    expect(resp.status).toBe(200);
    const read = (resp.body as { plan: Record<string, unknown> }).plan;
    expect((read.guests as Record<string, unknown>[])[0].outcome).toBe('answered');
    expect(read.fold).toEqual(
      expect.objectContaining({ state: 'converged', agreed: [{ start: 'Sat 26' }], missing_required: [], emptied_by: [] }),
    );
    expect(read.state).toBe('folded');
    expect(read.requirements).toEqual([{ kind: 'dietary', count: 1, needs: ['gluten-free'] }]);
    const list = await router.handle(req('GET', '/v1/coordination/plans', 'owner'));
    expect(list.status).toBe(200);
    expect((list.body as { plans: { plan_id: string }[] }).plans.map((p) => p.plan_id)).toEqual([plan.plan_id]);
  });

  it('refusals are named on the wire with a status that says what kind', async () => {
    const malformed = await router.handle(req('POST', '/v1/coordination/plans', 'owner', { ...PLAN_BODY, guests: [{ required: true }] }));
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'malformed_guest', detail: 'guests[].contact_did' });
    const stranger = await router.handle(
      req('POST', '/v1/coordination/plans', 'owner', { ...PLAN_BODY, guests: [{ contact_did: 'did:plc:stranger' }] }),
    );
    expect(stranger.status).toBe(400);
    expect(stranger.body).toEqual({ error: 'guest_not_a_contact', detail: 'did:plc:stranger' });
    const tooMany = await router.handle(
      req('POST', '/v1/coordination/plans', 'owner', { ...PLAN_BODY, candidates: Array.from({ length: 13 }, (_, i) => ({ start: `d${i}` })) }),
    );
    expect(tooMany.status).toBe(400);
    expect((tooMany.body as { error: string }).error).toBe('too_many_candidates');
    expect(sent).toHaveLength(0);

    const missing = await router.handle(req('GET', '/v1/coordination/plans/nope', 'owner'));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });

    const plan = await open();
    const early = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/choose`, 'owner', { slot: { start: 'Sat 26' } }));
    expect(early.status).toBe(409);
    expect((early.body as { error: string }).error).toBe('wrong_state');
    const noSlot = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/choose`, 'owner', {}));
    expect(noSlot.status).toBe(400);
    expect((noSlot.body as { error: string }).error).toBe('malformed_slot');
    const noGuest = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/optional`, 'owner', {}));
    expect(noGuest.status).toBe(400);
    const noCandidates = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/widen`, 'owner', {}));
    expect(noCandidates.status).toBe(400);
    expect((noCandidates.body as { error: string }).error).toBe('no_candidates');
  });

  it('choose, widen, optional, abandon and delete each answer the projection or a named refusal', async () => {
    const plan = await open();
    const guests = plan.guests as { spokes: { task_id: string }[] }[];
    for (const g of guests) {
      workflow.store().completeWithDetails(
        g.spokes[0].task_id,
        '',
        'received',
        JSON.stringify({ status: 'success', result: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] } }),
        '{}',
        Date.now(),
      );
    }
    const optional = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/optional`, 'owner', { contact_did: MILLER }));
    expect(optional.status).toBe(200);
    expect(((optional.body as { plan: { guests: { required: boolean }[] } }).plan.guests)[1].required).toBe(false);

    const chosen = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/choose`, 'owner', { slot: { start: 'Sat 26' } }));
    expect(chosen.status).toBe(200);
    expect((chosen.body as { plan: { state: string; round: number } }).plan).toEqual(expect.objectContaining({ state: 'confirming', round: 2 }));
    expect(sent).toHaveLength(4);

    const widened = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/widen`, 'owner', { candidates: [{ start: 'Sun 27' }] }));
    expect(widened.status).toBe(200);
    expect((widened.body as { plan: { state: string; round: number } }).plan).toEqual(expect.objectContaining({ state: 'proposing', round: 3 }));

    const abandoned = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/abandon`, 'owner'));
    expect(abandoned.status).toBe(200);
    expect((abandoned.body as { plan: { state: string } }).plan.state).toBe('abandoned');
    const again = await router.handle(req('POST', `/v1/coordination/plans/${plan.plan_id}/abandon`, 'owner'));
    expect(again.status).toBe(409);

    const removed = await router.handle(req('DELETE', `/v1/coordination/plans/${plan.plan_id}`, 'owner'));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true });
    const gone = await router.handle(req('DELETE', `/v1/coordination/plans/${plan.plan_id}`, 'owner'));
    expect(gone.status).toBe(404);
  });

  it('answers 503 by name when the plan store is not wired', async () => {
    setGroupPlanRepository(null);
    const resp = await router.handle(req('POST', '/v1/coordination/plans', 'owner', PLAN_BODY));
    expect(resp.status).toBe(503);
    expect(resp.body).toEqual({ error: 'not_wired', detail: 'group plan store' });
    const list = await router.handle(req('GET', '/v1/coordination/plans', 'owner'));
    expect(list.status).toBe(503);
  });
});
