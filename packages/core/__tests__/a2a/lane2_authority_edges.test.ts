/**
 * Lane 2 authority at its edges (design §5.1, §5.2, §7.2 step 9, §7.3,
 * §7.4, §10; notes M2, M3): what a grant opens and when it stops, what a
 * listing or binding change does to a call already accepted, what Brain may
 * not touch, and what one listing answers to D2D and to A2A.
 */

import {
  ackDeliveries,
  claimDeliveries,
  createA2AClient,
  ingressGetExtendedAgentCard,
  ingressGetTask,
  ingressSendMessage,
  inboundProjectionListings,
  issueA2AGrant,
  revokeA2AClient,
  revokeA2AGrant,
  bindRunner,
  settleInbound,
  sweepA2AInbound,
  admitInboundClaimWith,
  type A2ACardConfig,
} from '../../src/a2a';
import { deriveP256SigningKey } from '../../src/crypto';
import { claimPluginTask } from '../../src/plugins/claim_guard';
import { SQLitePluginDecisionRepository, getPluginDecisionRepository, setPluginDecisionRepository } from '../../src/plugins/decisions';
import { SQLiteDrainAuthorizationRepository, setDrainAuthorizationRepository } from '../../src/plugins/drain_authorizations';
import {
  SQLitePluginInstallRepository,
  getPluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { UpdateRebindCoordinator } from '../../src/plugins/update_rebind';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { evaluateServiceIngressBypass } from '../../src/service/bypass';
import { rebindListingsForUpdate } from '../../src/service/listing_rebind';
import { ServiceQueryIngress } from '../../src/service/query_ingress';
import { clearServiceConfigDurable, getServiceConfig } from '../../src/service/service_config';
import { WorkflowTaskKind, WorkflowTaskState } from '../../src/workflow/domain';

import {
  BOOK_PARAMS,
  BOOK_RESULT,
  ETA_PARAMS,
  ETA_RESULT,
  InboundWorld,
  bookingListing,
  errorOf,
  listing,
  resultOf,
  save,
  sentTask,
} from './inbound_fixture';

import type { PluginManifest } from '@dina/protocol';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const stateOfSent = (answer: { body?: unknown }) => (sentTask(answer).status as { state: string }).state;
const read = (id: string) => resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id }), id));
const readState = (id: string) => (read(id).status as { state: string }).state;
const reasonOf = (answer: { body?: unknown }) => iw.opOf(sentTask(answer).id as string).reason_code;

/** A known_only listing offering eta_query and price_check on the bound lane. */
async function privateListing(rkey = 'private'): Promise<void> {
  await save(
    listing({
      discoverability: 'known_only',
      isDiscoverable: false,
      capabilities: {
        eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' },
        price_check: { mcpServer: 'transit', mcpTool: 'get_price', responsePolicy: 'auto', category: 'commerce' },
      },
      capabilitySchemas: {
        eta_query: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-eta' },
        price_check: { params: ETA_PARAMS, result: ETA_RESULT, schemaHash: 'h-price' },
      },
    }),
    rkey,
  );
}

function grant(rkey: string, capability: string, expiresAt?: number): string {
  const issued = issueA2AGrant(
    iw.world.store,
    iw.grants,
    { client_id: iw.clientId, service_rkey: rkey, capability, ...(expiresAt === undefined ? {} : { expires_at: expiresAt }) },
    iw.world.clock,
  );
  if (!issued.ok) throw new Error(issued.reason);
  return issued.grant.grantId;
}

describe('a grant opens exactly its own door (§5.2)', () => {
  // Plan C86
  it('a grant for one capability opens no other capability on its listing, nor its capability on another listing', async () => {
    await privateListing('private');
    await privateListing('other');
    const g = grant('private', 'eta_query');
    expect(stateOfSent(iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: g }))).toBe('TASK_STATE_SUBMITTED');
    expect(stateOfSent(iw.call({ skill: 'price_check@private', params: { route_id: '2' }, grant_id: g }))).toBe('TASK_STATE_REJECTED');
    expect(stateOfSent(iw.call({ skill: 'eta_query@other', params: { route_id: '3' }, grant_id: g }))).toBe('TASK_STATE_REJECTED');
    // By the grant alone (no rkey), the grant's own listing and capability only.
    expect(stateOfSent(iw.call({ skill: 'price_check', params: { route_id: '4' }, grant_id: g }))).toBe('TASK_STATE_REJECTED');
    // Control: each refused door opens with its own grant, so the refusals above came from the grant.
    const p = grant('private', 'price_check');
    expect(stateOfSent(iw.call({ skill: 'price_check@private', params: { route_id: '5' }, grant_id: p }))).toBe('TASK_STATE_SUBMITTED');
    const o = grant('other', 'eta_query');
    expect(stateOfSent(iw.call({ skill: 'eta_query@other', params: { route_id: '6' }, grant_id: o }))).toBe('TASK_STATE_SUBMITTED');
  });

  // Plan C87
  it('an expired grant opens nothing', async () => {
    await privateListing();
    const g = grant('private', 'eta_query', Math.floor(iw.world.clock / 1000) + 60);
    expect(stateOfSent(iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: g }))).toBe('TASK_STATE_SUBMITTED');
    iw.world.clock += 61_000;
    const late = iw.call({ skill: 'eta_query@private', params: { route_id: '2' }, grant_id: g });
    expect(stateOfSent(late)).toBe('TASK_STATE_REJECTED');
    expect(reasonOf(late)).toBe('grant_not_authorized');
  });

  // Plan C88
  it('a revoked grant refuses the next call', async () => {
    await privateListing();
    const g = grant('private', 'eta_query');
    expect(stateOfSent(iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: g }))).toBe('TASK_STATE_SUBMITTED');
    expect(revokeA2AGrant(iw.grants, g, iw.world.clock)).toBe(true);
    const next = iw.call({ skill: 'eta_query@private', params: { route_id: '2' }, grant_id: g });
    expect(stateOfSent(next)).toBe('TASK_STATE_REJECTED');
    expect(reasonOf(next)).toBe('grant_not_authorized');
  });

  // Plan C129
  it('a grant that expires after the result settled: the next read is FAILED, and it never flips back', async () => {
    await privateListing();
    const g = grant('private', 'eta_query', Math.floor(iw.world.clock / 1000) + 60);
    const id = sentTask(iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: g })).id as string;
    iw.runChild(id, { eta_minutes: 2 });
    expect(readState(id)).toBe('TASK_STATE_COMPLETED');
    iw.world.clock += 61_000;
    expect(readState(id)).toBe('TASK_STATE_FAILED');
    expect(read(id).artifacts).toBeUndefined();
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    // The result stays the owner's.
    expect(iw.opOf(id).result_json).not.toBeNull();
    // A fresh grant for the same door does not bring the old result back.
    grant('private', 'eta_query');
    expect(readState(id)).toBe('TASK_STATE_FAILED');
    expect(read(id).artifacts).toBeUndefined();
  });
});

describe('a grant on a public listing adds nothing, on the card or at the call (§7.3; notes M3)', () => {
  const CARD = {
    nodeDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    config: {
      key: { privateKey: deriveP256SigningKey(new Uint8Array(32).fill(3), 0).privateKey, generation: 0 },
      publicOrigin: 'https://dina.example.org',
    } satisfies A2ACardConfig,
  };
  const cardFor = async (token: string) =>
    ingressGetExtendedAgentCard(iw.rt, iw.request('GetExtendedAgentCard', undefined, {}, `Bearer ${token}`), CARD);
  const callAs = (token: string, skill: string, grantId: string) =>
    ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', iw.message({ skill, params: { route_id: '1' }, grant_id: grantId }), {}, `Bearer ${token}`),
    );

  // Plan C36, C166
  it('a client scoped away from a public skill, holding a grant for it, finds it on no extended card and cannot call it, named or bare', async () => {
    const scoped = createA2AClient(iw.world.store, { display_name: 'Scoped', scope: ['price_check'] }, iw.world.clock);
    if (!scoped.ok) throw new Error(scoped.reason);
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: scoped.client.client_id, service_rkey: 'bus', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    // The extended card shows the client nothing: the grant adds no skill, and its scope holds none on offer.
    expect(errorOf(await cardFor(scoped.token))).toEqual({ code: -32007, reason: 'no_skills_for_client' });
    // The call agrees, by the bare name and by reference.
    for (const skill of ['eta_query', 'eta_query@bus']) {
      const answer = callAs(scoped.token, skill, issued.grant.grantId);
      expect([skill, stateOfSent(answer)]).toEqual([skill, 'TASK_STATE_REJECTED']);
    }
    // Control: the scope is the cause. A client scoped to the skill sees it on its extended card.
    const allowed = createA2AClient(iw.world.store, { display_name: 'Scoped in', scope: ['eta_query'] }, iw.world.clock);
    if (!allowed.ok) throw new Error(allowed.reason);
    expect((resultOf(await cardFor(allowed.token)) as unknown as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual([
      'eta_query@bus',
    ]);
    // And the world's client, whose scope is every public skill, sees it on its card and its call runs.
    const card = resultOf(await cardFor(iw.token)) as unknown as { skills: { id: string }[] };
    expect(card.skills.map((s) => s.id)).toEqual(['eta_query@bus']);
    expect(stateOfSent(iw.call({ skill: 'eta_query@bus', params: { route_id: '2' } }))).toBe('TASK_STATE_SUBMITTED');
  });
});

describe('one authorization model across surfaces (A2A-I3, §5.2)', () => {
  // Extra X-3
  it('an A2A client cannot use a D2D contact’s grant, and a D2D peer cannot use an A2A client’s grant', async () => {
    await privateListing();
    const nowSec = Math.floor(iw.world.clock / 1000);
    iw.grants.create({
      grantId: 'g_d2d_peer',
      granteeDid: 'did:plc:d2dpeer',
      serviceRkey: 'private',
      capability: 'eta_query',
      grantType: 'standing',
      createdAt: nowSec,
    });
    const viaPeerGrant = iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: 'g_d2d_peer' });
    expect(stateOfSent(viaPeerGrant)).toBe('TASK_STATE_REJECTED');
    // The same one collapsed refusal as every other cause (A2A-I4).
    const control = iw.call({ skill: 'eta_query@private', params: { route_id: '2' } });
    // The receipt id is the hash of each caller's own request (§7.6), so it differs by request and says nothing of the cause.
    const shape = (a: { body?: unknown }) => {
      const t = sentTask(a) as {
        status: { state: string; message?: unknown };
        artifacts?: unknown;
        metadata?: Record<string, { receiptId?: string }>;
      };
      const ext = Object.fromEntries(
        Object.entries(t.metadata ?? {}).map(([k, v]) => [k, { ...v, receiptId: typeof v.receiptId }]),
      );
      return { state: t.status.state, message: t.status.message, artifacts: t.artifacts, metadata: ext };
    };
    expect(shape(viaPeerGrant)).toEqual(shape(control));

    const a2aGrant = grant('private', 'eta_query');
    const d2dQuery = (grantId: string) =>
      evaluateServiceIngressBypass(
        'service.query',
        'did:plc:d2dpeer',
        JSON.stringify({
          query_id: 'q-1',
          capability: 'eta_query',
          params: { route_id: '1' },
          ttl_seconds: 60,
          service_uri: 'at://did:plc:providernode/com.dinakernel.service.profile/private',
          grant_id: grantId,
        }),
        {
          recipientDID: 'did:plc:providernode',
          knownOnlyCapabilityConfigured: () => true,
          isGrantAuthorized: (args) => iw.grants.isAuthorized({ ...args, nowSec }),
        },
      );
    expect(d2dQuery(a2aGrant).kind).toBe('deny');
    // Control: the peer's own grant passes the same gate.
    expect(d2dQuery('g_d2d_peer').kind).toBe('allow');
  });
});

describe('a change between acceptance and claim voids the call (§7.2 step 9, §9)', () => {
  // Plan C109
  it('a runner-binding write between acceptance and claim voids the call as stale authority', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    // The owner binds the lane again (the same runner): every binding write moves the revision.
    const rebound = bindRunner(iw.world.store, { lane: 'transit', device_did: iw.runnerDid }, iw.world.clock);
    expect(rebound.ok).toBe(true);
    expect(iw.claimChild(id).verdict).toBe('refused');
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'stale_authority' }));
  });

  // Extra X-17
  it('a listing deleted and made again under its rkey: the revision continues above the old, and the waiting call never runs', async () => {
    const id = sentTask(iw.call({ skill: 'eta_query@bus', params: { route_id: '1' } })).id as string;
    const revisionOf = () =>
      (iw.world.store.db.query("SELECT revision FROM service_configs WHERE rkey = 'bus'") as { revision: number }[])[0]?.revision ?? -1;
    const before = revisionOf();
    await clearServiceConfigDurable('bus');
    iw.world.clock += 1_000;
    await save(listing({}), 'bus');
    expect(revisionOf()).toBeGreaterThan(before);
    expect(iw.claimChild(id).verdict).toBe('refused');
    // Notes M3: a listing made again is another listing, so the call lost its authority for good.
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    expect(iw.childOf(id).status).toBe('failed');
  });
});

describe('the owner decides review cards; approval re-checks authority (§7.3, notes M2)', () => {
  beforeEach(async () => {
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } },
      }),
      'bus',
    );
  });

  // Plan C138
  it('approval after the client was revoked mints nothing', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    const card = iw.childOf(id).id;
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    iw.world.workflow.approve(card);
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }));
    expect(iw.world.workflow.store().getById(`a2a-in-exec-${id}-g0`)).toBeNull();
    expect(iw.world.store.permitsOf(iw.opOf(id).id)).toHaveLength(0);
  });

  // Plan C122
  it.each(['approve', 'cancel', 'fail'])('Brain cannot %s the inbound review card (403); the card stays pending', async (verb) => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    const card = iw.childOf(id).id;
    const router = new CoreRouter();
    registerWorkflowRoutes(router);
    const resp = await router.handle({
      method: 'POST',
      path: `/v1/workflow/tasks/${card}/${verb}`,
      query: {},
      headers: { 'x-did': 'did:key:brain' },
      body: { error: 'x', reason: 'x' },
      rawBody: new Uint8Array(),
      params: { id: card },
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    expect(resp.status).toBe(403);
    expect(iw.world.workflow.store().getById(card)?.status).toBe('pending_approval');
    expect(iw.opOf(id).state).toBe('open');
  });

  // Extra X-12
  it('a grant revoked while a review call waits: nothing more is sent, the call can never run, and its end closes its streams', async () => {
    await save(
      listing({
        discoverability: 'known_only',
        isDiscoverable: false,
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } },
      }),
      'private',
    );
    const g = grant('private', 'eta_query');
    const id = sentTask(iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: g })).id as string;
    revokeA2AGrant(iw.grants, g, iw.world.clock);
    // No new event: the stream has nothing to send and is not told to close (notes M3 residual).
    const quiet = claimDeliveries(iw.rt, { claimant: 'did:key:z6MkGateway', limit: 100, webhookLimit: 100 });
    expect(quiet.items.filter((i) => i.task_id === id)).toEqual([]);
    expect(quiet.closed).not.toContain(id);
    // GetTask hands out nothing.
    expect(read(id).artifacts).toBeUndefined();
    // The owner's yes cannot run it.
    iw.world.workflow.approve(iw.childOf(id).id);
    expect(iw.world.workflow.store().getById(`a2a-in-exec-${id}-g0`)).toBeNull();
    expect(readState(id)).toBe('TASK_STATE_FAILED');
    // The end is final: the next claim sends nothing and closes the task's streams.
    const after = claimDeliveries(iw.rt, { claimant: 'did:key:z6MkGateway', limit: 100, webhookLimit: 100 });
    expect(after.items.filter((i) => i.task_id === id)).toEqual([]);
    expect(after.closed).toContain(id);
  });

  // Cold audit C5-6: a card the owner can no longer act on is withdrawn, not left to lapse a day later
  it('a review card whose grant was revoked is withdrawn by the sweep: the call FAILED, the card cancelled, in one step', async () => {
    await save(
      listing({
        discoverability: 'known_only',
        isDiscoverable: false,
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } },
      }),
      'private',
    );
    const g = grant('private', 'eta_query');
    const id = sentTask(iw.call({ skill: 'eta_query@private', params: { route_id: '1' }, grant_id: g })).id as string;
    const card = iw.childOf(id);
    // Control: while the grant holds, the sweep leaves the card waiting.
    sweepA2AInbound(iw.rt);
    expect(iw.world.workflow.store().getById(card.id)?.status).toBe('pending_approval');
    expect(readState(id)).toBe('TASK_STATE_WORKING');
    revokeA2AGrant(iw.grants, g, iw.world.clock);
    expect(sweepA2AInbound(iw.rt)).toEqual(expect.objectContaining({ settled: 1, failed: 0 }));
    expect(iw.world.workflow.store().getById(card.id)?.status).toBe('cancelled');
    expect(iw.world.store.getTaskByExternal('inbound', `a2a:${iw.clientId}`, id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }),
    );
    expect(readState(id)).toBe('TASK_STATE_FAILED');
    // Once is enough: the next sweep has nothing to do.
    expect(sweepA2AInbound(iw.rt)).toEqual(expect.objectContaining({ settled: 0, failed: 0 }));
  });
});

describe('Silence First for auto calls (A2A-I7, §11 Law 1)', () => {
  // Extra X-5
  it('an auto call that runs and completes, or is refused, raises no owner card; a review call raises exactly one', async () => {
    const approvals = () =>
      (iw.world.store.db.query("SELECT COUNT(*) AS n FROM workflow_tasks WHERE kind = 'approval'") as { n: number }[])[0]?.n ?? 0;
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    iw.runChild(id, { eta_minutes: 5 });
    expect(readState(id)).toBe('TASK_STATE_COMPLETED');
    expect(stateOfSent(iw.call({ skill: 'appointment_status', params: {} }))).toBe('TASK_STATE_REJECTED');
    expect(approvals()).toBe(0);
    // The only task the auto call made is its execution child, which nobody decides.
    const tasks = iw.world.store.db.query('SELECT kind, state FROM workflow_tasks') as { kind: string; state: string }[];
    expect(tasks).toEqual([{ kind: 'delegation', state: 'completed' }]);
    // Control: review policy is the one way to the owner.
    await save(
      listing({
        capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'review', category: 'transit' } },
      }),
      'bus',
    );
    sentTask(iw.call({ skill: 'eta_query', params: { route_id: '2' } }));
    expect(approvals()).toBe(1);
  });

  // Found while fixing cold audit C6-7: Brain's event consumer posts a delegation task's result in the owner's chat
  it('an inbound call’s execution child hands Brain’s delivery feed nothing: no result in the owner’s chat, whatever its end', () => {
    const undeliveredFor = (taskId: string) =>
      iw.world.repo.listUndeliveredEvents(Number.MAX_SAFE_INTEGER, 0, 1_000).filter((e) => e.task_id === taskId);
    const done = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    const doneChild = iw.childOf(done).id;
    iw.runChild(done, { eta_minutes: 5 });
    const failed = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '2' } })).id as string;
    const { taskId: failedChild } = iw.claimChild(failed);
    iw.world.workflow.fail(failedChild, 'tool exited 1', iw.runnerDid);
    expect([readState(done), readState(failed)]).toEqual(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED']);
    for (const child of [doneChild, failedChild]) {
      expect(undeliveredFor(child)).toEqual([]);
      // The audit stream keeps them.
      expect(iw.world.repo.listEventsForTask(child).map((e) => e.event_kind)).toEqual(expect.arrayContaining(['created']));
    }
    expect(iw.world.repo.listEventsForTask(doneChild).map((e) => e.event_kind)).toContain('completed');
    // Control: a delegation task of the owner's own still reaches Brain's feed.
    iw.world.workflow.create({ id: 'owner-task', kind: WorkflowTaskKind.Delegation, description: 'mine', payload: '{}' });
    expect(undeliveredFor('owner-task').map((e) => e.event_kind)).toEqual(['created']);
  });
});

describe('expiry and fail-closed states (§7.3, §7.4, §9)', () => {
  // Plan C123
  it('a child and permit past their shared deadline: the lane skips it, the boundary refuses it, and the permit goes void, never consumed', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    const [permit] = iw.world.store.permitsOf(iw.opOf(id).id);
    if (permit === undefined) throw new Error('no permit');
    iw.world.clock = permit.expires_at + 1;
    // The lane's claim skips the expired child...
    expect(iw.world.repo.claimDelegationTask(iw.runnerDid, iw.world.clock, 30_000, 'transit')).toBeNull();
    // ...and the effect boundary refuses it even if handed it.
    expect(admitInboundClaimWith(iw.rt, iw.childOf(id), iw.runnerDid)).toBe('refused');
    expect(iw.opOf(id).reason_code).toBe('permit_unavailable');
    expect(iw.world.store.permitsOf(iw.opOf(id).id)[0]?.state).toBe('void');
    expect(iw.opOf(id).effect_phase).not.toBe('effect_started');
  });

  // Plan C123
  it('a permit that expires while its child is still live: the claim is refused, the permit void, no effect begun', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    const op = iw.opOf(id);
    expect(iw.world.store.permitsOf(op.id).map((p) => p.state)).toEqual(['minted']);
    // Only the permit's time runs out; the child's does not.
    iw.world.store.db.execute('UPDATE a2a_permits SET expires_at = ? WHERE operation_ref = ?', [iw.world.clock - 1, op.id]);
    expect(iw.childOf(id).status).toBe('queued');
    const { verdict } = iw.claimChild(id);
    expect(verdict).toBe('refused');
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'permit_unavailable' }));
    expect(iw.world.store.permitsOf(op.id).map((p) => p.state)).toEqual(['void']);
    expect(iw.opOf(id).effect_phase).not.toBe('effect_started');
  });

  // Plan C123 (control)
  it('the same call with its permit in time is admitted, and the permit consumed', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    expect(iw.claimChild(id).verdict).toBe('admitted');
    expect(iw.world.store.permitsOf(iw.opOf(id).id).map((p) => p.state)).toEqual(['consumed']);
  });

  // Plan C146
  it('a child that ends recorded reads FAILED (fail-closed)', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    const child = iw.childOf(id).id;
    iw.world.store.db.execute("UPDATE workflow_tasks SET state = 'recorded' WHERE id = ?", [child]);
    settleInbound(iw.rt, iw.opOf(id));
    expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'child_recorded' }));
    expect(readState(id)).toBe('TASK_STATE_FAILED');
    expect(read(id).artifacts).toBeUndefined();
  });
});

describe('delivery reports are claim-bound (§10 "claim/ack CAS")', () => {
  // Plan C189
  it('a report under another claimant’s DID changes nothing', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    iw.claimChild(id);
    const claim = claimDeliveries(iw.rt, { claimant: 'did:key:z6MkGatewayA', limit: 10, webhookLimit: 0 });
    expect(claim.items).toHaveLength(1);
    const item = claim.items[0];
    if (item === undefined) throw new Error('no item');
    const acks = [{ id: item.id, claim_id: item.claim_id, outcome: 'delivered' as const }];
    expect(ackDeliveries(iw.rt, { claimant: 'did:key:z6MkGatewayB', acks })).toBe(0);
    expect(iw.world.store.getOutboxRow(item.id)?.status).toBe('claimed');
    expect(ackDeliveries(iw.rt, { claimant: 'did:key:z6MkGatewayA', acks })).toBe(1);
    expect(iw.world.store.getOutboxRow(item.id)?.status).toBe('delivered');
  });
});

describe('plugin executors need a live install with provider consent (§7.1 executor rule)', () => {
  const PLUGIN_DEVICE = 'did:plc:lane2plugindevice';
  const READ_CAP = 'com.acme.transit.eta';
  let installs: SQLitePluginInstallRepository;
  let installId: string;

  function manifest(cid: string, kinds: string[] = ['provider']): PluginManifest {
    return {
      $type: 'com.dinakernel.plugin.release',
      plugin_id: 'com.acme.transit',
      version: cid === 'bafyreitransit1' ? '0.1.0' : '0.2.0',
      display_name: 'Transit',
      execution: { mode: 'runner' },
      capabilities: [
        {
          id: READ_CAP,
          display_name: 'ETA',
          interaction: 'query',
          action_class: 'read',
          privacy_class: 'personal',
          kinds,
          result_schema: ETA_RESULT,
        },
      ],
    } as unknown as PluginManifest;
  }

  beforeEach(() => {
    installs = new SQLitePluginInstallRepository(iw.world.store.db);
    setPluginInstallRepository(installs);
    setPluginDecisionRepository(new SQLitePluginDecisionRepository(iw.world.store.db));
  });
  afterEach(() => {
    setPluginInstallRepository(null);
    setPluginDecisionRepository(null);
  });

  function install(kinds: string[] = ['provider']): void {
    installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.transit',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreitransit1',
      currentVersion: '0.1.0',
      manifest: manifest('bafyreitransit1', kinds),
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [READ_CAP]: 'e'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(iw.world.clock / 1000) + 900,
      nowMs: iw.world.clock,
    });
    installs.activate(installId, PLUGIN_DEVICE, iw.world.clock);
  }

  async function etaOnPlugin(): Promise<void> {
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            category: 'transit',
            pluginInstallId: installId,
            pluginManifestCid: 'bafyreitransit1',
            pluginCapabilityId: READ_CAP,
          },
        },
      }),
      'bus',
    );
  }

  const onCard = () =>
    inboundProjectionListings(iw.world.store)
      .flatMap((l) => l.capabilities)
      .find((c) => c.capability === 'eta_query')?.executor ?? null;
  const refusedBothWays = () => {
    for (const skill of ['eta_query', 'eta_query@bus']) {
      const answer = iw.call({ skill, params: { route_id: '1' } });
      expect(stateOfSent(answer)).toBe('TASK_STATE_REJECTED');
    }
  };

  // Extra X-14
  it('an install the owner paused is off the card and refused, by bare name and by reference', async () => {
    install();
    await etaOnPlugin();
    expect(onCard()).not.toBeNull();
    expect(installs.pause(installId, iw.world.clock)).toBe(true);
    expect(onCard()).toBeNull();
    refusedBothWays();
  });

  // Extra X-14
  it('an uninstalled plugin whose listing row stays is off the card and refused', async () => {
    install();
    await etaOnPlugin();
    installs.remove(installId);
    expect(onCard()).toBeNull();
    refusedBothWays();
  });

  // Extra X-14
  it('a capability its install never consented to serve peers (not a provider kind) is off the card and refused', async () => {
    install(['tool']);
    await save(
      listing({
        capabilities: {
          eta_query: {
            responsePolicy: 'auto',
            category: 'transit',
            pluginInstallId: installId,
            pluginManifestCid: 'bafyreitransit1',
            pluginCapabilityId: READ_CAP,
          },
        },
      }),
      'bus',
    ).catch(async () => {
      // The listing validator refuses it; a row it never saw must still be refused at call time.
      const { saveUnchecked } = await import('./inbound_fixture');
      await saveUnchecked(
        listing({
          capabilities: {
            eta_query: {
              responsePolicy: 'auto',
              category: 'transit',
              pluginInstallId: installId,
              pluginManifestCid: 'bafyreitransit1',
              pluginCapabilityId: READ_CAP,
            },
          },
        }),
        'bus',
      );
    });
    expect(onCard()).toBeNull();
    refusedBothWays();
  });

  // Plan C110
  it('a plugin-update rebind voids a call pinned to the old release', async () => {
    install();
    await etaOnPlugin();
    const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: '1' } })).id as string;
    expect(iw.opOf(id).state).toBe('open');
    const drains = new SQLiteDrainAuthorizationRepository(iw.world.store.db);
    setDrainAuthorizationRepository(drains);
    iw.world.clock += 1_000;
    try {
      // The update as the node applies it: the new release, its drain authorizations, the listings rebound, in one commit.
      const coordinator = new UpdateRebindCoordinator({
        installs: () => installs,
        drains: () => drains,
        rebindListings: (args) => rebindListingsForUpdate(iw.world.store.db, args),
        tx: (fn) => iw.world.store.db.transaction(fn),
        now: () => iw.world.clock,
      });
      const outcome = coordinator.apply({
        installId,
        cid: 'bafyreitransit2',
        version: '0.2.0',
        manifest: manifest('bafyreitransit2'),
        installScopeHash: 's'.repeat(64),
        capabilityHashes: { [READ_CAP]: 'f'.repeat(64) },
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
      });
      expect(outcome.ok).toBe(true);
      expect(getServiceConfig('bus')?.capabilities.eta_query?.pluginManifestCid).toBe('bafyreitransit2');
      const current = getPluginInstallRepository()?.getById(installId);
      if (current == null) throw new Error('install');
      const claim = claimPluginTask({ repo: iw.world.repo, install: current, deviceDid: PLUGIN_DEVICE, nowMs: iw.world.clock, leaseMs: 30_000 });
      // The plugin gets nothing, and the call is void.
      expect(claim.task).toBeNull();
      expect(readState(id)).toBe('TASK_STATE_FAILED');
      expect(iw.opOf(id)).toEqual(expect.objectContaining({ state: 'failed', reason_code: 'stale_authority' }));
      // Cold audit C3-8: the child is failed under the claim just made, not left running under the plugin's lease.
      const child = iw.childOf(id);
      expect(child.status).toBe('failed');
      expect(iw.world.repo.listEventsForTask(child.id).map((e) => e.event_kind)).not.toContain('late_report');
      expect(getPluginDecisionRepository()?.listByInstall(installId, 10).map((d) => d.decision)).not.toContain('late_report_received');
      // The lease lapsing changes nothing: no requeue, no claim again, no false "may have acted".
      iw.world.clock += 31_000;
      iw.world.repo.expireLeasedTasks(iw.world.clock);
      expect(iw.world.repo.getById(child.id)?.status).toBe('failed');
      expect(claimPluginTask({ repo: iw.world.repo, install: current, deviceDid: PLUGIN_DEVICE, nowMs: iw.world.clock, leaseMs: 30_000 }).task).toBeNull();
    } finally {
      setDrainAuthorizationRepository(null);
    }
  });
});

describe('one listing to D2D and to A2A: the same verdicts (A2A-I3, plan §3.5)', () => {
  // Extra X-2
  it('accepts and refuses alike, and strips alike, apart from the recorded differences', async () => {
    // The same listing at `self`, where a D2D query with no service_uri lands.
    await save(listing({}), 'self');
    const d2dReplies: { status: string; error?: string }[] = [];
    const ingress = new ServiceQueryIngress({
      workflow: iw.world.workflow,
      readConfig: (rkey) => getServiceConfig(rkey ?? 'self'),
      directResponder: async (_to, body) => {
        d2dReplies.push({ status: body.status, ...(body.error === undefined ? {} : { error: body.error }) });
      },
    });
    let n = 0;
    const d2d = async (params: Record<string, unknown>): Promise<{ accepted: boolean; params?: unknown }> => {
      n += 1;
      const before = d2dReplies.length;
      await ingress.admitQuery('did:plc:d2dpeer', {
        query_id: `q-${n}`,
        capability: 'eta_query',
        params,
        ttl_seconds: 60,
        schema_hash: 'h-eta',
      });
      if (d2dReplies.length > before) return { accepted: false };
      const rows = iw.world.store.db.query(
        "SELECT payload FROM workflow_tasks WHERE kind = 'delegation' AND payload LIKE ?",
        [`%"q-${n}"%`],
      ) as { payload: string }[];
      const payload = rows[0] === undefined ? null : (JSON.parse(rows[0].payload) as { params?: unknown });
      return payload === null ? { accepted: false } : { accepted: true, params: payload.params };
    };
    const a2a = (params: Record<string, unknown>): { accepted: boolean; params?: unknown } => {
      const answer = iw.call({ skill: 'eta_query@self', params });
      const task = sentTask(answer);
      if ((task.status as { state: string }).state === 'TASK_STATE_REJECTED') return { accepted: false };
      return { accepted: true, params: (JSON.parse(iw.childOf(task.id as string).payload) as { params?: unknown }).params };
    };
    const cases: Record<string, unknown>[] = [
      { route_id: '42' },
      { route_id: '42', extra: 'dropped' },
      { route_id: '' },
      {},
      { route_id: 42 },
    ];
    for (const params of cases) {
      const viaD2D = await d2d(params);
      const viaA2A = a2a(params);
      expect([JSON.stringify(params), viaA2A]).toEqual([JSON.stringify(params), viaD2D]);
    }
    // Recorded difference 1 (notes, ingress move): the schema hash is optional on A2A, required on D2D.
    const before = d2dReplies.length;
    await ingress.admitQuery('did:plc:d2dpeer', { query_id: 'q-nohash', capability: 'eta_query', params: { route_id: '1' }, ttl_seconds: 60 });
    expect(d2dReplies.slice(before)).toEqual([{ status: 'error', error: 'schema_hash_required' }]);
    expect(a2a({ route_id: '1' }).accepted).toBe(true);
  });
});

describe('a compromised Brain against inbound execution (§10 "Compromised Brain corrupts inbound execution")', () => {
  const router = new CoreRouter();
  registerWorkflowRoutes(router);
  const asBrain = (verb: string, id: string, body: Record<string, unknown> = {}) =>
    router.handle({
      method: 'POST',
      path: verb === 'claim' ? '/v1/workflow/tasks/claim' : `/v1/workflow/tasks/${id}/${verb}`,
      query: {},
      headers: { 'x-did': 'did:key:brain' },
      body,
      rawBody: new Uint8Array(),
      params: verb === 'claim' ? {} : { id },
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);

  const VERBS = ['complete', 'fail', 'heartbeat', 'progress', 'input-required'] as const;

  // Cold audit C6-7: the reads follow the rule the comment and the notes state
  it('Brain reads no inbound execution child, pinned or in-process: the single read and /running refuse it, its list leaves it out', async () => {
    await save(
      listing({ capabilities: { eta_query: { responsePolicy: 'auto', instruction: 'Answer from the timetable.', category: 'transit' } } }),
      'local',
    );
    const pinned = iw.childOf(sentTask(iw.call({ skill: 'eta_query@bus', params: { route_id: '1' } })).id as string).id;
    const local = iw.childOf(sentTask(iw.call({ skill: 'eta_query@local', params: { route_id: '2' } })).id as string).id;
    expect(iw.world.store.getChild(pinned)?.pep_did).toEqual(expect.any(String));
    expect(iw.world.store.getChild(local)?.pep_did).toBeNull();
    iw.world.workflow.create({ id: 'owner-task', kind: WorkflowTaskKind.Delegation, description: 'mine', payload: '{}', initialState: WorkflowTaskState.Queued });
    const as = (callerType: 'brain' | 'admin', method: 'GET' | 'POST', path: string, params: Record<string, string> = {}, query: Record<string, string> = {}) =>
      router.handle({
        method,
        path,
        query,
        headers: { 'x-did': `did:key:${callerType}` },
        body: {},
        rawBody: new Uint8Array(),
        params,
        trustedInProcess: true,
        callerType,
        callerDID: `did:key:${callerType}`,
      } as unknown as CoreRequest);
    const listed = async (callerType: 'brain' | 'admin') =>
      ((await as(callerType, 'GET', '/v1/workflow/tasks', {}, { kind: 'delegation', state: 'queued' })).body as { tasks: { id: string }[] }).tasks
        .map((t) => t.id)
        .sort();
    for (const child of [pinned, local]) {
      expect((await as('brain', 'GET', `/v1/workflow/tasks/${child}`, { id: child })).status).toBe(403);
      expect((await as('brain', 'POST', `/v1/workflow/tasks/${child}/running`, { id: child })).status).toBe(403);
    }
    expect(await listed('brain')).toEqual(['owner-task']);
    // Controls: Brain reads the owner's own task; the owner's admin reads and lists them all.
    expect((await as('brain', 'GET', '/v1/workflow/tasks/owner-task', { id: 'owner-task' })).status).toBe(200);
    expect((await as('admin', 'GET', `/v1/workflow/tasks/${pinned}`, { id: pinned })).status).toBe(200);
    expect(await listed('admin')).toEqual([local, 'owner-task', pinned].sort());
  });

  // Extra X-24
  it.each(VERBS)('Brain cannot %s an inbound child on a bound lane before any claim (403); the child and its permit stand', async (verb) => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    const child = iw.childOf(id).id;
    const resp = await asBrain(verb, child, {
      result: '{"booked":true}',
      error: 'x',
      message: 'x',
      claim_id: 'guess',
      prompt: 'x',
      input_schema: { type: 'object' },
    });
    expect(resp.status).toBe(403);
    expect(iw.childOf(id).status).toBe('queued');
    expect(iw.world.store.permitsOf(iw.opOf(id).id)[0]?.state).toBe('minted');
  });

  // Extra X-24
  it.each(VERBS)(
    'Brain cannot %s an inbound child the runner holds, even with its claim token (403); the runner keeps it',
    async (verb) => {
      await save(bookingListing(), 'bus');
      const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
      iw.world.workflow.approve(iw.childOf(id).id);
      const { verdict, taskId } = iw.claimChild(id);
      expect(verdict).toBe('admitted');
      const held = iw.world.workflow.store().getById(taskId);
      expect(held?.claim_id).toEqual(expect.any(String));
      const resp = await asBrain(verb, taskId, {
        result: '{"booked":true}',
        error: 'x',
        message: 'x',
        claim_id: held?.claim_id,
        prompt: 'x',
        input_schema: { type: 'object' },
      });
      expect(resp.status).toBe(403);
      const after = iw.world.workflow.store().getById(taskId);
      expect([after?.status, after?.agent_did, after?.claim_id]).toEqual(['running', iw.runnerDid, held?.claim_id]);
      expect(iw.opOf(id).state).toBe('open');
      expect(iw.world.store.permitsOf(iw.opOf(id).id)[0]?.state).toBe('consumed');
      // Control: the runner itself, with that token, completes it.
      iw.world.workflow.complete(taskId, JSON.stringify({ booked: true }), 'done', iw.runnerDid, held?.claim_id);
      expect(iw.world.workflow.store().getById(taskId)?.status).toBe('completed');
    },
  );

  /** An instruction-only booking: its child runs in process, on dina.local, pinned to no device. */
  async function inProcessBooking(): Promise<string> {
    await save(
      listing({
        capabilities: {
          appointment_book: { responsePolicy: 'review', instruction: 'Book it.', category: 'appointments' },
        },
        capabilitySchemas: { appointment_book: { params: BOOK_PARAMS, result: BOOK_RESULT, schemaHash: 'h-book' } },
      }),
      'bus',
    );
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    expect(iw.childOf(id).requested_runner).toBe('dina.local');
    return id;
  }

  // Extra X-24
  it('Brain cannot claim an in-process inbound child on dina.local', async () => {
    const id = await inProcessBooking();
    const resp = await asBrain('claim', '', { runner_filter: 'dina.local', lease_ms: 30_000 });
    expect(resp.status).toBe(403);
    expect(iw.childOf(id).status).toBe('queued');
    expect(iw.world.store.permitsOf(iw.opOf(id).id)[0]?.state).toBe('minted');
  });

  // Extra X-24
  it('Brain cannot claim an inbound child on a bound lane', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    const resp = await asBrain('claim', '', { runner_filter: 'transit', lease_ms: 30_000 });
    expect((resp.body as { id?: string } | undefined)?.id).not.toBe(iw.childOf(id).id);
    expect(iw.childOf(id).status).toBe('queued');
    expect(iw.world.store.permitsOf(iw.opOf(id).id)[0]?.state).toBe('minted');
  });
});

