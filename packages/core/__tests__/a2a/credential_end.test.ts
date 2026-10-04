/**
 * Design §10 ("stolen bearer: expiry, rotation"): rotation is the owner's
 * answer to a stolen bearer, so what the old bearer set up ends with it. Its
 * webhooks are deleted. Its client's credential generation rises, and its
 * fence holds for A2A_STREAM_FENCE_HOLD_MS: every delivery claim meanwhile
 * names the client (by the opaque key its streams were opened with) and the
 * generation its streams must have reached, so the gateway ends the older
 * ones on every task and refuses one that registers late; every stream
 * event carries the generation too. A claim answer lost on its way loses
 * nothing: the next claim says the same. The same holds whenever a
 * client's credential ends: a bearer that runs out, a DID bind replacing
 * it, or revocation.
 */

import {
  A2A_CREDENTIAL_GEN_HEADER,
  A2A_STREAM_CLIENT_HEADER,
  A2A_STREAM_FENCE_HOLD_MS,
} from '@dina/a2a';

import {
  A2A_BEARER_LIFETIME_MS,
  ackDeliveries,
  admitInboundClaimWith,
  claimDeliveries,
  createA2AClient,
  endExpiredBearers,
  ingressSendMessage,
  ingressSubscribeToTask,
  revokeA2AClient,
  rotateA2AClientToken,
  streamClientKeyOf,
} from '../../src/a2a';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';

import { InboundWorld, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const GATEWAY = 'did:key:z6MkGateway';
const claim = () => claimDeliveries(iw.rt, { claimant: GATEWAY, limit: 100, webhookLimit: 100 });
const deliverAll = (items: ReturnType<typeof claim>['items']) =>
  ackDeliveries(iw.rt, { claimant: GATEWAY, acks: items.map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' as const })) });
const key = () => streamClientKeyOf(`a2a:${iw.clientId}`);

/** A streaming call that also set a webhook (as a thief holding the bearer might). */
function callWithWebhook(routeId: string): string {
  return sentTask(
    ingressSendMessage(
      iw.rt,
      iw.request('SendStreamingMessage', {
        ...iw.message({ skill: 'eta_query', params: { route_id: routeId } }, { messageId: `call-${routeId}` }),
        configuration: { taskPushNotificationConfig: { url: 'https://thief.example.test/hook' } },
      }),
      'SendStreamingMessage',
    ),
  ).id as string;
}

function rotate(): void {
  const rotated = rotateA2AClientToken(iw.world.store, iw.clientId, iw.world.clock);
  if (!rotated.ok) throw new Error(rotated.reason);
  iw.token = rotated.token;
}

/** What Core opens a stream on the task with, under the current bearer: its client key and generation. */
function opening(id: string): { client: string | undefined; gen: string | undefined } {
  const headers = ingressSubscribeToTask(iw.rt, iw.request('SubscribeToTask', { id }), id).headers;
  return { client: headers?.[A2A_STREAM_CLIENT_HEADER], gen: headers?.[A2A_CREDENTIAL_GEN_HEADER] };
}

const streamGens = (c: ReturnType<typeof claim>) => c.items.flatMap((i) => (i.target === 'sse' ? [i.credential_gen] : []));

it('a stream opens under its client’s key and generation; the key names no client', () => {
  const id = callWithWebhook('0');
  expect(opening(id)).toEqual({ client: key(), gen: '0' });
  expect(key()).toMatch(/^[0-9a-f]{32}$/);
  expect(key()).not.toContain(iw.clientId);
});

it('rotating the bearer fences the client at the next claim, first, and its webhook gets nothing more', () => {
  const id = callWithWebhook('1');
  rotate();
  iw.runChild(id, { eta_minutes: 4 });
  const after = claim();
  expect(after.fenced).toEqual([{ client: key(), before_gen: 1 }]);
  expect(after.closed).toEqual([]);
  // Every stream event carries the new generation, so a stream opened under the old bearer gets none of them.
  expect(streamGens(after).length).toBeGreaterThan(0);
  expect(new Set(streamGens(after))).toEqual(new Set([1]));
  expect(after.items.filter((i) => i.target === 'webhook')).toEqual([]);
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 0 }]);
});

it('the fence is in every claim while it holds, so a claim answer lost on its way loses nothing; then it lapses', () => {
  callWithWebhook('2');
  rotate();
  const fence = [{ client: key(), before_gen: 1 }];
  // The gateway never got this answer.
  expect(claim().fenced).toEqual(fence);
  iw.world.clock += A2A_STREAM_FENCE_HOLD_MS - 1;
  expect(claim().fenced).toEqual(fence);
  iw.world.clock += 1;
  expect(claim().fenced).toEqual([]);
});

it('the fence covers the client, not a task: a finished task whose events were all sent is behind it too', () => {
  // Ended, every event sent and reported: no row of it is waiting, yet a stream of it may still be on its way.
  const done = callWithWebhook('3');
  iw.runChild(done, { eta_minutes: 1 });
  deliverAll(claim().items);
  rotate();
  expect(claim().fenced).toEqual([{ client: key(), before_gen: 1 }]);
});

it('a stream opened under the new bearer opens at the new generation, which the fence lets through', () => {
  const id = callWithWebhook('4');
  rotate();
  expect(opening(id)).toEqual({ client: key(), gen: '1' });
  // The gateway refuses streams before generation 1 only.
  expect(claim().fenced).toEqual([{ client: key(), before_gen: 1 }]);
});

it('each credential that ends raises the generation again, and the fence names the newest', () => {
  const id = callWithWebhook('5');
  rotate();
  rotate();
  expect(claim().fenced).toEqual([{ client: key(), before_gen: 2 }]);
  expect(opening(id).gen).toBe('2');
});

// Cold audit C6-11: a bystander with setups of its own, so the scope of each end is on trial
describe('only the client whose credential ended is touched: another client’s webhook, events and streams go on', () => {
  /** A second client with a streaming call, an inline webhook and a result waiting; its principal and task. */
  function bystander(): { principal: string; id: string } {
    const other = createA2AClient(iw.world.store, { display_name: 'Other agent' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    const principal = `a2a:${other.client.client_id}`;
    const id = sentTask(
      ingressSendMessage(
        iw.rt,
        iw.request(
          'SendStreamingMessage',
          {
            ...iw.message({ skill: 'eta_query', params: { route_id: '77' } }, { messageId: 'bystander-call' }),
            configuration: { taskPushNotificationConfig: { url: 'https://bystander.example.test/hook' } },
          },
          {},
          `Bearer ${other.token}`,
        ),
        'SendStreamingMessage',
      ),
    ).id as string;
    const op = iw.world.store.getTaskByExternal('inbound', principal, id);
    const claimed = iw.world.repo.claimDelegationTask(iw.runnerDid, iw.world.clock, 60_000, 'transit');
    if (op === null || claimed === null || claimed.id !== op.internal_id) throw new Error('claim');
    admitInboundClaimWith(iw.rt, claimed, iw.runnerDid);
    iw.world.workflow.complete(claimed.id, JSON.stringify({ eta_minutes: 7 }), 'done', iw.runnerDid);
    return { principal, id };
  }
  const configsOf = (principal: string) =>
    iw.world.store.db.query(
      `SELECT COUNT(*) AS n FROM a2a_push_configs WHERE operation_ref IN (SELECT id FROM a2a_tasks WHERE direction = 'inbound' AND principal = ?)`,
      [principal],
    );

  it.each([
    ['rotation', 'live', () => rotate()],
    ['a bearer that runs out', 'live', () => (iw.world.clock += A2A_BEARER_LIFETIME_MS - 1_000)],
    ['revocation', 'lost', () => revokeA2AClient(iw.world.store, new SQLiteServiceGrantRepository(iw.world.store.db), iw.clientId, iw.world.clock)],
  ] as const)('%s', (_how, ended, end) => {
    const mine = callWithWebhook('8');
    iw.runChild(mine, { eta_minutes: 3 });
    // The bystander came a second later, so its bearer outlives the first one's.
    iw.world.clock += 1_000;
    const other = bystander();
    end();
    const after = claim();
    expect(after.fenced).toEqual([{ client: key(), before_gen: 1 }]);
    // The ended client's webhook is gone; the bystander's stands, and its events still go out.
    expect(configsOf(`a2a:${iw.clientId}`)).toEqual([{ n: 0 }]);
    expect(configsOf(other.principal)).toEqual([{ n: 1 }]);
    const ofTask = (id: string) => after.items.filter((i) => i.task_id === id);
    expect(ofTask(other.id).filter((i) => i.target === 'webhook').length).toBeGreaterThan(0);
    // Its stream events keep its own generation, so its open streams are not ended.
    const otherGens = ofTask(other.id).flatMap((i) => (i.target === 'sse' ? [i.credential_gen] : []));
    expect(otherGens.length).toBeGreaterThan(0);
    expect(new Set(otherGens)).toEqual(new Set([0]));
    // The ended client's stream events carry its new generation, or, revoked, none go out.
    const mineGens = ofTask(mine).flatMap((i) => (i.target === 'sse' ? [i.credential_gen] : []));
    expect(ended === 'live' ? new Set(mineGens) : mineGens.length).toEqual(ended === 'live' ? new Set([1]) : 0);
  });
});

describe('a bearer that runs out is a credential that ended (§5.1, §10)', () => {
  it('the next claim ends what it set up, once: the client fenced, its webhook gone, its stream events at the new generation', () => {
    const id = callWithWebhook('9');
    // The result is waiting to be delivered when the bearer runs out.
    iw.runChild(id, { eta_minutes: 2 });
    iw.world.clock += A2A_BEARER_LIFETIME_MS;
    const after = claim();
    expect(after.fenced).toEqual([{ client: key(), before_gen: 1 }]);
    expect(after.items.filter((i) => i.target === 'webhook')).toEqual([]);
    expect(new Set(streamGens(after))).toEqual(new Set([1]));
    expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 0 }]);
    // Taken once: later claims hold the same fence, and the generation rises no further.
    expect(endExpiredBearers(iw.world.store, iw.world.clock)).toBe(0);
    expect(claim().fenced).toEqual([{ client: key(), before_gen: 1 }]);
  });

  it('a bearer still within its life ends nothing', () => {
    callWithWebhook('10');
    iw.world.clock += A2A_BEARER_LIFETIME_MS - 1;
    expect(claim().fenced).toEqual([]);
    expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 1 }]);
  });

  it('a new bearer after it ran out opens streams at the newer generation, which no fence holds back', () => {
    const id = callWithWebhook('11');
    iw.world.clock += A2A_BEARER_LIFETIME_MS;
    expect(claim().fenced).toEqual([{ client: key(), before_gen: 1 }]);
    rotate();
    expect(opening(id)).toEqual({ client: key(), gen: '2' });
    expect(claim().fenced).toEqual([{ client: key(), before_gen: 2 }]);
  });
});

it('revoking the client ends what it set up the same way, and no stream of it can open again', () => {
  const id = callWithWebhook('6');
  const out = revokeA2AClient(iw.world.store, new SQLiteServiceGrantRepository(iw.world.store.db), iw.clientId, iw.world.clock);
  expect(out.ok).toBe(true);
  expect(claim().fenced).toEqual([{ client: key(), before_gen: 1 }]);
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 0 }]);
  expect(ingressSubscribeToTask(iw.rt, iw.request('SubscribeToTask', { id }), id).status).toBe(401);
});
