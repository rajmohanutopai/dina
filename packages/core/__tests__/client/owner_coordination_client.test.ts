/**
 * The owner-marked coordination client (GROUP_COORDINATION §9) against the
 * REAL routes: every verb reaches its route (no "no route for"), a refusal
 * comes back typed with the route's own error key, and the Brain-shared
 * `CoreClient` reaches only the two doors it is allowed (§11).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { InProcessTransport } from '../../src/client/in-process-transport';
import {
  InProcessOwnerCoordinationClient,
  OwnerCoordinationHttpError,
} from '../../src/client/owner-coordination-client';
import { addContact, resetContactDirectory } from '../../src/contacts/directory';
import { SQLiteContactRepository, setContactRepository } from '../../src/contacts/repository';
import {
  SQLiteServiceOfferRepository,
  setServiceOfferRepository,
  type ServiceOffer,
} from '../../src/contacts/service_offers_repository';
import { GROUP_COORDINATION_CAPABILITY } from '../../src/coordination/group_coordination_service';
import { SQLiteGroupPlanRepository, setGroupPlanRepository } from '../../src/coordination/group_plan_repository';
import { SQLitePeopleRepository, setPeopleRepository } from '../../src/people/repository';
import { CoreRouter } from '../../src/server/router';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { registerGroupCoordinationRoutes } from '../../src/server/routes/group_coordination';
import { setServiceQuerySender } from '../../src/server/routes/service_query';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

const OWNER_CAP = 'test-owner-capability-secret';
const GARCIA = 'did:plc:garcia';
const MILLER = 'did:plc:miller';

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

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;
let owner: InProcessOwnerCoordinationClient;
let brain: InProcessTransport;
let workflow: WorkflowService;
let sent: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'owner-coordination-client-'));
  adapter = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: randomBytes(32).toString('hex') });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  resetContactDirectory();
  setPeopleRepository(new SQLitePeopleRepository(adapter));
  setContactRepository(new SQLiteContactRepository(adapter));
  addContact(GARCIA, 'The Garcias', 'verified');
  addContact(MILLER, 'The Millers', 'verified');
  const offers = new SQLiteServiceOfferRepository(adapter);
  offers.upsert(offerFrom(GARCIA));
  offers.upsert(offerFrom(MILLER));
  setServiceOfferRepository(offers);
  setGroupPlanRepository(new SQLiteGroupPlanRepository(adapter));
  workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  setWorkflowService(workflow);
  sent = [];
  setServiceQuerySender(async (to) => {
    sent.push(to);
  });
  setD2DSender(async () => undefined);
  router = new CoreRouter();
  registerGroupCoordinationRoutes(router, OWNER_CAP);
  owner = new InProcessOwnerCoordinationClient(router, OWNER_CAP);
  brain = new InProcessTransport(router);
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

/** Land a guest's reply the way the receive pipeline does, on that guest's live spoke. */
function accept(did: string, slots: { start: string }[]): void {
  const store = workflow.store();
  const tasks = store
    .listByKindAndState('service_query', 'running', 50)
    .filter((t) => (JSON.parse(t.payload) as { to_did?: string }).to_did === did);
  const task = tasks[tasks.length - 1];
  if (task === undefined) throw new Error(`no live spoke for ${did}`);
  store.completeWithDetails(
    task.id,
    '',
    'received',
    JSON.stringify({ status: 'success', result: { status: 'accepted', accepted_slots: slots } }),
    '{}',
    Date.now(),
  );
}

describe('the Brain-shared client reaches the two doors and no more', () => {
  it('opens a plan and reads its fold; a refusal is a value with the route’s own name', async () => {
    const opened = await brain.openGroupPlan({
      intent: "Emma's birthday",
      guests: [{ contactDid: GARCIA }, { contactDid: MILLER, required: false }],
      candidates: [{ start: 'Sat 19' }, { start: 'Sat 26' }],
      windowSeconds: 60,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.refusal);
    expect(opened.plan.guests.map((g) => [g.contact_did, g.required])).toEqual([[GARCIA, true], [MILLER, false]]);
    expect(sent).toEqual([GARCIA, MILLER]);

    accept(GARCIA, [{ start: 'Sat 26' }]);
    const read = await brain.getGroupPlan(opened.plan.plan_id);
    expect(read?.state).toBe('folded');
    expect(read?.fold?.agreed).toEqual([{ start: 'Sat 26' }]);
    expect(await brain.getGroupPlan('nope')).toBeNull();

    const handles = await brain.listGroupPlanHandles();
    expect(handles.map((h) => h.plan_id)).toEqual([opened.plan.plan_id]);
    expect(handles[0]).toEqual({ plan_id: opened.plan.plan_id, intent: "Emma's birthday", state: 'folded', round: 1, chosen: null, updated_at: expect.any(Number) });

    const refused = await brain.openGroupPlan({ intent: '', guests: [{ contactDid: GARCIA }], candidates: [{ start: 'x' }] });
    expect(refused).toEqual({ ok: false, refusal: 'empty_intent' });
    const stranger = await brain.openGroupPlan({ intent: 'x', guests: [{ contactDid: 'did:plc:stranger' }], candidates: [{ start: 'x' }] });
    expect(stranger).toEqual({ ok: false, refusal: 'guest_not_a_contact', detail: 'did:plc:stranger' });
  });
});

describe('the owner client', () => {
  it('lists, reads, chooses, widens, drops, stops and deletes through the real routes', async () => {
    const opened = await brain.openGroupPlan({
      intent: "Emma's birthday",
      guests: [{ contactDid: GARCIA }, { contactDid: MILLER }],
      candidates: [{ start: 'Sat 19' }, { start: 'Sat 26' }],
      windowSeconds: 60,
    });
    if (!opened.ok) throw new Error(opened.refusal);
    const id = opened.plan.plan_id;
    expect((await owner.list()).map((p) => p.plan_id)).toEqual([id]);
    expect((await owner.get(id))?.state).toBe('proposing');
    expect(await owner.get('nope')).toBeNull();

    // Not agreed yet: the refusal is typed, with the route's status and key.
    await expect(owner.choose(id, { start: 'Sat 26' })).rejects.toMatchObject({
      name: 'OwnerCoordinationHttpError',
      status: 409,
      errorKey: 'wrong_state',
    });

    accept(GARCIA, [{ start: 'Sat 26' }]);
    const dropped = await owner.makeOptional(id, MILLER);
    expect(dropped.state).toBe('folded');
    expect(dropped.fold?.agreed).toEqual([{ start: 'Sat 26' }]);

    const confirming = await owner.choose(id, { start: 'Sat 26' });
    expect(confirming.state).toBe('confirming');
    expect(sent).toHaveLength(4);

    const widened = await owner.widen(id, [{ start: 'Sun 27' }]);
    expect(widened.state).toBe('proposing');
    expect(widened.round).toBe(3);

    const stopped = await owner.abandon(id);
    expect(stopped.state).toBe('abandoned');
    expect(await owner.list()).toEqual([]);

    expect(await owner.remove(id)).toBe(true);
    expect(await owner.remove(id)).toBe(false);
    expect(await owner.get(id)).toBeNull();
  });

  it('a client without the boot capability is refused on every decision', async () => {
    const opened = await brain.openGroupPlan({
      intent: 'x',
      guests: [{ contactDid: GARCIA }],
      candidates: [{ start: 'Sat 26' }],
    });
    if (!opened.ok) throw new Error(opened.refusal);
    const impostor = new InProcessOwnerCoordinationClient(router, 'wrong-capability');
    for (const call of [
      () => impostor.list(),
      () => impostor.choose(opened.plan.plan_id, { start: 'Sat 26' }),
      () => impostor.widen(opened.plan.plan_id, [{ start: 'x' }]),
      () => impostor.makeOptional(opened.plan.plan_id, GARCIA),
      () => impostor.abandon(opened.plan.plan_id),
      () => impostor.remove(opened.plan.plan_id),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(OwnerCoordinationHttpError);
      await expect(call()).rejects.toMatchObject({ status: 403 });
    }
  });
});
