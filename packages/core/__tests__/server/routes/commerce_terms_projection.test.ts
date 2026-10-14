/**
 * SHELF_SPACE_NEGOTIATION §7.4 — test plan R-07: Brain's projection of every
 * term card on every surface Core gives it. Each of the five card types is
 * raised by a real term engine (harness fleets, documents moving only through
 * both sides' gates) into the workflow inbox through the production card
 * port. Brain then reads the task list, each task, `/running`, the events
 * feed and the notification log: it sees which card and which negotiation,
 * never a term, a floor, a holding or a counterparty's DID, and it can neither
 * mint nor decide a card. Every `/v1/commerce/terms/*` route is owner-only, in
 * the authz matrix and in the handler, and Brain's code names none of them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isAuthorized } from '../../../src/auth/authz';
import { InProcessTransport } from '../../../src/client/in-process-transport';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_DELIVERY_FAILED_CARD } from '../../../src/commerce/term/term_engine';
import { createTermEngine } from '../../../src/commerce/term/term_runtime';
import {
  TERM_DECISION_CARD,
  TERM_FLOOR_CARD,
  TERM_STRANGER_CARD,
} from '../../../src/commerce/term/term_seller';
import { termWorkflowHooks } from '../../../src/commerce/term/term_workflow';
import {
  InMemoryNotificationLogRepository,
  setNotificationLogRepository,
} from '../../../src/notifications/repository';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { createCoreRouter } from '../../../src/server/core_server';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';
import { publishListing } from '../../commerce/term/term_harness';
import {
  BRAND2_DID,
  BRAND_DID,
  DAY,
  Fleet,
  HOUR,
  juicePolicy,
  STORE_DID,
  type Node,
} from '../../commerce/term/term_harness';

import type { TermCardSpec, TermTransaction } from '../../../src/commerce/term/term_context';
import type { TermPolicy } from '../../../src/commerce/term/term_policy';
import type { CoreRequest, CoreResponse } from '../../../src/server/router';
import type { DatabaseAdapter } from '../../../src/storage/db_adapter';
import type { TermListing } from '@dina/commerce-protocol';

const OWNER_CAP = 'owner-capability-for-term-projection-01';
const router = createCoreRouter({ ownerCapability: OWNER_CAP });
const BRAIN_DID = 'did:key:brain';
const ALL_DIDS = [STORE_DID, BRAND_DID, BRAND2_DID];

const FIVE_TYPES = [
  TERM_STRANGER_CARD,
  TERM_FLOOR_CARD,
  TERM_PROPOSAL_CARD,
  TERM_DECISION_CARD,
  TERM_DELIVERY_FAILED_CARD,
];

function request(
  callerType: 'owner' | 'brain',
  method: CoreRequest['method'],
  urlPath: string,
  over: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {},
): CoreRequest {
  return {
    method,
    path: urlPath,
    query: over.query ?? {},
    headers: {},
    body: over.body,
    rawBody: new Uint8Array(),
    params: over.params ?? {},
    trustedInProcess: true,
    callerType,
    // Brain is given the owner's capability too: the caller type alone must refuse it.
    ownerCapability: OWNER_CAP,
    ...(callerType === 'brain' ? { callerDID: BRAIN_DID } : {}),
  } as CoreRequest;
}

const brain = (
  method: CoreRequest['method'],
  urlPath: string,
  over: Parameters<typeof request>[3] = {},
): CoreRequest => request('brain', method, urlPath, over);
const owner = (
  method: CoreRequest['method'],
  urlPath: string,
  over: Parameters<typeof request>[3] = {},
): CoreRequest => request('owner', method, urlPath, over);

/** The production card port (term_runtime.ts) — what a booted node raises cards through. */
function productionCardPort() {
  return createTermEngine({
    adapter: {} as unknown as DatabaseAdapter,
    transaction: {} as unknown as TermTransaction,
    nodeDid: () => '',
    now: () => 0,
  }).ctx.deps.cards;
}

/** Keep the harness's card list (the scenario helpers read it) and raise into the workflow too. */
function teeCards(node: Node): void {
  const harness = node.engine.ctx.deps.cards;
  const port = productionCardPort();
  node.engine.ctx.deps.cards = {
    raise: (card) => {
      const kept = harness.raise(card);
      port.raise(card);
      return kept;
    },
    close: (cardId, reason) => {
      harness.close(cardId, reason);
      port.close(cardId, reason);
    },
  };
}

function setUpStore(
  fleet: Fleet,
  policy: TermPolicy = juicePolicy(),
): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(brand: Node, listing: TermListing, uri: string, maxRounds: number): string {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: maxRounds,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function card(node: Node, type: string): TermCardSpec {
  const found = node.cards.filter((c) => c.type === type);
  const last = found[found.length - 1];
  if (last === undefined) throw new Error(`no ${type} card`);
  return last;
}

interface Raised {
  spec: TermCardSpec;
  /** The engine whose card it is (the decision hook routes to it). */
  owner: Node;
}

/**
 * One fleet per card, so each card is the only one its node raises into the
 * workflow. The rules each scenario leans on are the ones term_scenarios
 * pins; here only the card matters.
 */
function raiseAllFive(fleets: Fleet[]): Map<string, Raised> {
  const raised = new Map<string, Raised>();
  const fresh = (): Fleet => {
    const fleet = new Fleet();
    fleets.push(fleet);
    return fleet;
  };

  // Stranger: under contacts_or_card an unknown brand is held and the owner asked.
  {
    const fleet = fresh();
    const { store, listing, uri } = setUpStore(fleet, juicePolicy({ access: 'contacts_or_card' }));
    teeCards(store);
    ask(fleet.add(BRAND_DID), listing, uri, 3);
    fleet.pump();
    raised.set(TERM_STRANGER_CARD, { spec: card(store, TERM_STRANGER_CARD), owner: store });
  }

  // Floor: automatic limit 240000; the counter's halfway (210000) sits between it and the
  // hard floor 150000, so the owner is asked.
  {
    const fleet = fresh();
    const base = juicePolicy();
    const policy = juicePolicy({
      resources: base.resources.map((r) =>
        r.resource_ref === 'slot-3'
          ? { ...r, floors: { ...r.floors, fee: { hard: '150000', auto: '240000' } } }
          : r,
      ),
    });
    const { store, listing, uri } = setUpStore(fleet, policy);
    teeCards(store);
    ask(fleet.add(BRAND_DID), listing, uri, 2);
    fleet.pump();
    raised.set(TERM_FLOOR_CARD, { spec: card(store, TERM_FLOOR_CARD), owner: store });
  }

  // Proposal: one round, and the brand's owner is asked to send the proposal.
  {
    const fleet = fresh();
    const { listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    teeCards(brand);
    ask(brand, listing, uri, 1);
    fleet.pump();
    raised.set(TERM_PROPOSAL_CARD, { spec: card(brand, TERM_PROPOSAL_CARD), owner: brand });
  }

  // Decision: the brand's owner sends the proposal (on its own engine) and the store is asked.
  {
    const fleet = fresh();
    const { store, listing, uri } = setUpStore(fleet);
    teeCards(store);
    const brand = fleet.add(BRAND_DID);
    ask(brand, listing, uri, 1);
    fleet.pump();
    brand.engine.decideCard(card(brand, TERM_PROPOSAL_CARD).cardId, true);
    fleet.pump();
    raised.set(TERM_DECISION_CARD, { spec: card(store, TERM_DECISION_CARD), owner: store });
  }

  // Delivery failed: the store never answers; 16 × 6h passes the request's deadline.
  {
    const fleet = fresh();
    const { listing, uri } = setUpStore(fleet);
    const brand = fleet.add(BRAND2_DID);
    teeCards(brand);
    fleet.unreachable.add(STORE_DID);
    ask(brand, listing, uri, 3);
    for (let i = 0; i < 16; i += 1) {
      fleet.advance(6 * HOUR);
      brand.engine.sweep();
      fleet.pump();
    }
    raised.set(TERM_DELIVERY_FAILED_CARD, {
      spec: card(brand, TERM_DELIVERY_FAILED_CARD),
      owner: brand,
    });
  }
  return raised;
}

/** Every leaf of the owner's card except the three ids Brain may read, as strings. */
function ownerOnlyLeaves(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
      return;
    }
    out.push(String(value));
  };
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'type' || key === 'card_id' || key === 'request_id') continue;
    walk(value);
  }
  return out;
}

/** Every string leaf Brain was handed, reading into JSON strings (payloads, event details). */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') stringLeaves(parsed, out);
    } catch {
      /* plain text */
    }
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out);
  }
  return out;
}

function expectNothingOwnerOnly(seen: unknown, cards: Iterable<Raised>): void {
  const leaves = new Set(stringLeaves(seen));
  const text = JSON.stringify(seen);
  for (const { spec } of cards) {
    for (const leaf of ownerOnlyLeaves(spec.payload)) {
      expect({ card: spec.type, leaked: leaves.has(leaf) ? leaf : null }).toEqual({
        card: spec.type,
        leaked: null,
      });
    }
  }
  for (const did of ALL_DIDS) expect(text).not.toContain(did);
}

function redactedPayload(spec: TermCardSpec): Record<string, unknown> {
  return {
    type: spec.type,
    card_id: spec.cardId,
    request_id: spec.payload.request_id,
    redacted: 'owner_only',
  };
}

interface TaskView {
  id: string;
  status: string;
  description: string;
  payload: string;
}

function tasksOf(res: CoreResponse): TaskView[] {
  return (res.body as { tasks: TaskView[] }).tasks;
}

let fleets: Fleet[];
let workflow: WorkflowService;
let notifications: InMemoryNotificationLogRepository;
let cards: Map<string, Raised>;

beforeEach(() => {
  setNodeDID(STORE_DID);
  workflow = new WorkflowService({
    repository: new InMemoryWorkflowRepository(),
    ...termWorkflowHooks(),
  });
  setWorkflowService(workflow);
  notifications = new InMemoryNotificationLogRepository();
  setNotificationLogRepository(notifications);
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  fleets = [];
  cards = raiseAllFive(fleets);
});

afterEach(() => {
  installCommerceRuntime(null);
  setWorkflowService(null);
  setNotificationLogRepository(null);
  clearOwnerPresence();
  installOwnerPresenceVerifier(null);
  for (const fleet of fleets) fleet.closeAll();
});

function raisedCard(type: string): Raised {
  const found = cards.get(type);
  if (found === undefined) throw new Error(`no ${type}`);
  return found;
}

describe('R-07 — the five term cards as Brain reads them', () => {
  it('each real card reached the inbox with owner-only content (so the checks below bite)', async () => {
    const res = await router.handle(
      owner('GET', '/v1/workflow/tasks', {
        query: { kind: 'approval', state: 'pending_approval' },
      }),
    );
    const listed = tasksOf(res);
    expect(listed.map((t) => (JSON.parse(t.payload) as { type: string }).type).sort()).toEqual(
      [...FIVE_TYPES].sort(),
    );
    for (const type of FIVE_TYPES) {
      const { spec } = raisedCard(type);
      const task = listed.find((t) => t.id === spec.cardId);
      expect(task === undefined ? null : JSON.parse(task.payload)).toEqual(spec.payload);
      // A counterparty DID is on every card, and something more than ids.
      expect(ALL_DIDS.some((did) => JSON.stringify(spec.payload).includes(did))).toBe(true);
      expect(ownerOnlyLeaves(spec.payload).length).toBeGreaterThan(1);
    }
    // The money cards carry numbers: the owner reads them whole.
    expect(raisedCard(TERM_FLOOR_CARD).spec.payload.asked).toEqual({ fee: '210000' });
    expect(raisedCard(TERM_DECISION_CARD).spec.payload.terms).toBeDefined();
    expect(raisedCard(TERM_PROPOSAL_CARD).spec.payload.terms).toBeDefined();
  });

  it('the task list: which card and which negotiation, nothing else', async () => {
    const res = await router.handle(
      brain('GET', '/v1/workflow/tasks', {
        query: { kind: 'approval', state: 'pending_approval' },
      }),
    );
    expect(res.status).toBe(200);
    const listed = tasksOf(res);
    expect(listed).toHaveLength(5);
    for (const type of FIVE_TYPES) {
      const { spec } = raisedCard(type);
      const task = listed.find((t) => t.id === spec.cardId);
      expect(task === undefined ? null : JSON.parse(task.payload)).toEqual(redactedPayload(spec));
    }
    expectNothingOwnerOnly(res.body, cards.values());
  });

  it.each(FIVE_TYPES)(
    'a single %s task, read or echoed by /running, is the same projection',
    async (type) => {
      const { spec } = raisedCard(type);
      const read = await router.handle(
        brain('GET', `/v1/workflow/tasks/${spec.cardId}`, { params: { id: spec.cardId } }),
      );
      expect(read.status).toBe(200);
      const task = (read.body as { task: TaskView }).task;
      expect(JSON.parse(task.payload)).toEqual(redactedPayload(spec));
      // §7.4: no description carries a price — no digit at all.
      expect(task.description).not.toMatch(/\d/);
      expectNothingOwnerOnly(read.body, [raisedCard(type)]);

      const running = await router.handle(
        brain('POST', `/v1/workflow/tasks/${spec.cardId}/running`, { params: { id: spec.cardId } }),
      );
      expect(running.status).toBe(200);
      expect(JSON.parse((running.body as TaskView).payload)).toEqual(redactedPayload(spec));
      expectNothingOwnerOnly(running.body, [raisedCard(type)]);
    },
  );

  it.each(FIVE_TYPES)('Brain may not approve, deny or fail a %s card', async (type) => {
    const { spec } = raisedCard(type);
    for (const verb of ['approve', 'cancel', 'fail']) {
      const res = await router.handle(
        brain('POST', `/v1/workflow/tasks/${spec.cardId}/${verb}`, {
          params: { id: spec.cardId },
          body: { error: 'brain says no', reason: 'brain says no' },
        }),
      );
      expect({ verb, status: res.status }).toEqual({ verb, status: 403 });
    }
    expect(workflow.store().getById(spec.cardId)?.status).toBe('pending_approval');
    expect(raisedCard(type).owner.store.getCard(spec.cardId)?.state).toBe('pending');
  });

  it.each(FIVE_TYPES)('Brain may not mint a %s card', async (type) => {
    const res = await router.handle(
      brain('POST', '/v1/workflow/tasks', {
        body: {
          id: `forged-${type}`,
          kind: 'approval',
          description: 'forged',
          payload: JSON.stringify({ type, card_id: `forged-${type}`, request_id: 'treq-x' }),
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('reserved_payload_type');
    expect(workflow.store().getById(`forged-${type}`)).toBeNull();
  });

  it('on the phone, Brain’s in-process client reads the cards redacted and cannot decide them; the owner’s reads them whole (R-10)', async () => {
    const brainClient = new InProcessTransport(router, undefined, { workflowCaller: 'brain' });
    const ownerClient = new InProcessTransport(router);
    const asBrain = await brainClient.listWorkflowTasks({ kind: 'approval', state: 'pending_approval' });
    const asOwner = await ownerClient.listWorkflowTasks({ kind: 'approval', state: 'pending_approval' });
    for (const type of FIVE_TYPES) {
      const { spec } = raisedCard(type);
      const brainView = asBrain.find((t) => t.id === spec.cardId);
      expect([type, JSON.parse(brainView?.payload ?? '{}')]).toEqual([type, redactedPayload(spec)]);
      expect(JSON.parse((await brainClient.getWorkflowTask(spec.cardId))?.payload ?? '{}')).toEqual(
        redactedPayload(spec),
      );
      const ownerView = asOwner.find((t) => t.id === spec.cardId);
      expect(JSON.parse(ownerView?.payload ?? '{}')).toEqual(spec.payload);
      await expect(brainClient.approveWorkflowTask(spec.cardId)).rejects.toThrow(/403/);
      expect(workflow.store().getById(spec.cardId)?.status).toBe('pending_approval');
    }
  });

  it('a yes the engine refuses closes its task as failed, in the owner’s words — never as decided (§7.1 step 6)', async () => {
    const { spec, owner: node } = raisedCard(TERM_DECISION_CARD);
    installCommerceRuntime({ terms: node.engine } as unknown as CommerceRuntime);
    // The store paused renting between the card and the yes: nothing binds.
    node.packActive.seller = false;
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const approved = await router.handle(
      owner('POST', `/v1/workflow/tasks/${spec.cardId}/approve`, { params: { id: spec.cardId } }),
    );
    expect(approved.status).toBe(200);
    expect(workflow.store().getById(spec.cardId)).toMatchObject({
      status: 'failed',
      error: 'no longer available',
    });
  });

  it('after the owner decides every card, the events feed and the closed tasks stay redacted', async () => {
    for (const type of FIVE_TYPES) {
      const { spec, owner: node } = raisedCard(type);
      installCommerceRuntime({ terms: node.engine } as unknown as CommerceRuntime);
      await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
      const approved = await router.handle(
        owner('POST', `/v1/workflow/tasks/${spec.cardId}/approve`, {
          params: { id: spec.cardId },
        }),
      );
      expect({ type, status: approved.status }).toEqual({ type, status: 200 });
    }
    // The owner's yes reached each engine (so each `approved` event embeds a real card).
    for (const type of FIVE_TYPES) {
      const { spec, owner: node } = raisedCard(type);
      expect({ type, state: node.store.getCard(spec.cardId)?.state }).toEqual({
        type,
        state: 'approved',
      });
    }

    for (const query of [{}, { needs_delivery: 'true' }] as Record<string, string>[]) {
      const events = await router.handle(brain('GET', '/v1/workflow/events', { query }));
      expect(events.status).toBe(200);
      const list = (events.body as { events: { task_id: string; details: string }[] }).events;
      for (const type of FIVE_TYPES) {
        const { spec } = raisedCard(type);
        const embedded = list
          .filter((e) => e.task_id === spec.cardId)
          .map((e) => (JSON.parse(e.details) as { task_payload?: string }).task_payload)
          .filter((p): p is string => typeof p === 'string');
        // One `approved` event per card embeds the payload: Brain gets the projection.
        expect(embedded.map((p) => JSON.parse(p) as unknown)).toEqual([redactedPayload(spec)]);
      }
      expectNothingOwnerOnly(events.body, cards.values());
    }

    const closed = await router.handle(
      brain('GET', '/v1/workflow/tasks', { query: { kind: 'approval', state: 'completed' } }),
    );
    expect(
      tasksOf(closed)
        .map((t) => t.id)
        .sort(),
    ).toEqual(FIVE_TYPES.map((t) => raisedCard(t).spec.cardId).sort());
    for (const task of tasksOf(closed)) {
      const type = (JSON.parse(task.payload) as { type: string }).type;
      expect(JSON.parse(task.payload)).toEqual(redactedPayload(raisedCard(type).spec));
    }
    expectNothingOwnerOnly(closed.body, cards.values());
  });

  it('a card taken down without a decision (lapsed) reads the same', async () => {
    const { spec, owner: node } = raisedCard(TERM_STRANGER_CARD);
    // The stranger card's decide-by is the request's respond_by (3 days); the sweep lapses it.
    const fleet = fleets[0];
    if (fleet === undefined) throw new Error('no fleet');
    fleet.advance(3 * DAY + HOUR);
    node.engine.sweep();
    expect(node.closed).toContain(spec.cardId);
    const read = await router.handle(
      brain('GET', `/v1/workflow/tasks/${spec.cardId}`, { params: { id: spec.cardId } }),
    );
    const task = (read.body as { task: TaskView }).task;
    expect(task.status).toBe('cancelled');
    expect(JSON.parse(task.payload)).toEqual(redactedPayload(spec));
    expectNothingOwnerOnly(read.body, [raisedCard(TERM_STRANGER_CARD)]);
  });

  it('the notification log Brain reads carries no term card: Core writes none there', async () => {
    const res = await router.handle(brain('GET', '/v1/notifications'));
    expect(res.status).toBe(200);
    expect((res.body as { notifications: unknown[] }).notifications).toEqual([]);
  });
});

describe('R-07 — no term route is Brain’s', () => {
  const DIGEST = 'a'.repeat(64);
  const ROUTES: [CoreRequest['method'], string, Record<string, string>][] = [
    ['POST', '/v1/commerce/terms/install/begin', {}],
    ['GET', '/v1/commerce/terms/policy', {}],
    ['PUT', '/v1/commerce/terms/policy', {}],
    ['GET', '/v1/commerce/terms/listings', {}],
    ['POST', '/v1/commerce/terms/listings', {}],
    ['DELETE', '/v1/commerce/terms/listings/slot-3', { id: 'slot-3' }],
    ['POST', '/v1/commerce/terms/negotiations', {}],
    ['GET', '/v1/commerce/terms/negotiations', {}],
    ['GET', '/v1/commerce/terms/agreements', {}],
    ['GET', `/v1/commerce/terms/agreements/${DIGEST}`, { digest: DIGEST }],
    ['POST', `/v1/commerce/terms/agreements/${DIGEST}/terminate`, { digest: DIGEST }],
    ['POST', `/v1/commerce/terms/agreements/${DIGEST}/settlements`, { digest: DIGEST }],
    ['POST', `/v1/commerce/terms/settlements/${DIGEST}/ack`, { digest: DIGEST }],
  ];

  it.each(ROUTES)('%s %s: the authz matrix admits the owner and refuses Brain', (method, p) => {
    expect(isAuthorized('owner', method, p)).toBe(true);
    expect(isAuthorized('brain', method, p)).toBe(false);
  });

  it.each(ROUTES)('%s %s: the handler refuses Brain in-process too', async (method, p, params) => {
    const { owner: store } = raisedCard(TERM_FLOOR_CARD);
    installCommerceRuntime({ terms: store.engine } as unknown as CommerceRuntime);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    const res = await router.handle(brain(method, p, { params, body: {} }));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('access_denied');
    // The store's policy floors never come back.
    expect(JSON.stringify(res.body)).not.toMatch(/150000|240000|250000/);
  });

  it('the policy route answers the owner (so the refusal above is about the caller)', async () => {
    const { owner: store } = raisedCard(TERM_FLOOR_CARD);
    installCommerceRuntime({ terms: store.engine } as unknown as CommerceRuntime);
    const res = await router.handle(owner('GET', '/v1/commerce/terms/policy'));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('240000');
  });

  it('Brain’s code names no commerce route, so no /ask tool can reach term data', () => {
    const brainSrc = path.resolve(__dirname, '../../../../brain/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(brainSrc);
    // Sanity: the tree is there (the ask loop's tools live in it).
    expect(files.length).toBeGreaterThan(50);
    const naming = files.filter((f) =>
      /\/v1\/commerce|commerce\/terms/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(naming.map((f) => path.relative(brainSrc, f))).toEqual([]);
    // Nor do the two transports that carry Brain's CoreClient calls — the
    // server's signed HTTP one and the phone's in-process one. (The interface,
    // core-client.ts, names no paths at all, so scanning it proved nothing.)
    for (const transport of ['http-transport.ts', 'in-process-transport.ts']) {
      const text = fs.readFileSync(path.resolve(__dirname, '../../../src/client', transport), 'utf8');
      // Sanity: the file does carry routes, so the scan can find one.
      expect([transport, /\/v1\/workflow\/tasks/.test(text)]).toEqual([transport, true]);
      expect([transport, text.match(/\/v1\/commerce\/terms[^'`"]*/g)]).toEqual([transport, null]);
    }
  });
});
