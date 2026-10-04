/**
 * Task-event delivery (design §7.5, §12 M3 done-when): streamed = polled
 * truth; exactly once per (transition, target_kind, target_id), repeated
 * recording included; restart survival mid-claim; suppression on
 * revocation; webhook retries bounded; a deleted config gets nothing more.
 */

import {
  INBOUND_REVIEW_DEADLINE_SECONDS,
  DELIVERY_LEASE_MS,
  WEBHOOK_RETRY_DELAYS_MS,
  ackDeliveries,
  claimDeliveries,
  createA2AClient,
  ingressCreatePushConfig,
  ingressCancelTask,
  ingressGetTask,
  ingressSendMessage,
  issueA2AGrant,
  purgeEndedA2AOperations,
  recordInboundChange,
  revokeA2AClient,
  revokeA2AGrant,
  sweepA2AInbound,
} from '../../src/a2a';
import { DUE_STREAM_ROWS_SQL, DUE_WEBHOOK_HEADS_SQL } from '../../src/a2a/store';
import { clearServiceConfigDurable } from '../../src/service/service_config';

import { InboundWorld, bookingListing, listing, resultOf, save, sentTask } from './inbound_fixture';

import type { OutboxRow } from '../../src/a2a/store';

const GATEWAY = 'did:key:z6MkGateway';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => iw.close());

const eta = () =>
  sentTask(iw.call({ skill: 'eta_query', params: { route_id: '42' } })).id as string;
const rows = (id: string, kind?: 'sse' | 'webhook'): OutboxRow[] =>
  iw.world.store
    .outboxOf(iw.opOf(id).id)
    .filter((r) => kind === undefined || r.target_kind === kind);
const events = (id: string, kind: 'sse' | 'webhook' = 'sse') =>
  rows(id, kind).map((r) => JSON.parse(r.event_json) as Record<string, Record<string, unknown>>);
/** What each stream event says: a status state, or `artifact`. */
const story = (id: string, kind: 'sse' | 'webhook' = 'sse') =>
  events(id, kind).map((e) =>
    e.statusUpdate === undefined ? 'artifact' : (e.statusUpdate.status as { state: string }).state,
  );
const getTask = (id: string) => resultOf(ingressGetTask(iw.rt, iw.request('GetTask', { id }), id));
const claim = (limit = 100, webhookLimit = 100) =>
  claimDeliveries(iw.rt, { claimant: GATEWAY, limit, webhookLimit });
/** Streamed = polled: the task's last event says what GetTask says now. */
const finalAgrees = (id: string) => {
  expect(events(id).at(-1)?.statusUpdate?.status).toEqual(getTask(id).status);
};
const advance = (ms: number) => {
  iw.world.clock += ms;
};

describe('recording: one event per visible change, the same truth GetTask tells', () => {
  it('auto call: no event for its creation, then WORKING, the result, COMPLETED', async () => {
    const id = eta();
    expect(rows(id)).toEqual([]);
    advance(1_000);
    expect(iw.claimChild(id).verdict).toBe('admitted');
    expect(story(id)).toEqual(['TASK_STATE_WORKING']);
    // Streamed = polled: the event says what GetTask says, timestamp and all.
    expect(events(id)[0]?.statusUpdate?.status).toEqual(getTask(id).status);
    advance(1_000);
    iw.world.workflow.complete(
      iw.opOf(id).internal_id ?? '',
      JSON.stringify({ eta_minutes: 7 }),
      'done',
      iw.runnerDid,
    );
    await Promise.resolve();
    expect(story(id)).toEqual(['TASK_STATE_WORKING', 'artifact', 'TASK_STATE_COMPLETED']);
    const polled = getTask(id);
    const [, artifact, done] = events(id);
    expect(artifact?.artifactUpdate).toEqual({
      taskId: id,
      contextId: polled.contextId,
      artifact: (polled.artifacts as unknown[])[0],
      lastChunk: true,
    });
    expect(done?.statusUpdate?.status).toEqual(polled.status);
    expect(rows(id).map((r) => [r.seq, r.source_event_id])).toEqual([
      [1, `${id}#1`],
      [2, `${id}#2`],
      [3, `${id}#3`],
    ]);
  });

  it('review call: WORKING while the owner decides, SUBMITTED once approved, then WORKING', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } }))
      .id as string;
    expect(rows(id)).toEqual([]);
    advance(1_000);
    iw.world.workflow.approve(iw.childOf(id).id);
    expect(story(id)).toEqual(['TASK_STATE_SUBMITTED']);
    expect(iw.claimChild(id).verdict).toBe('admitted');
    expect(story(id)).toEqual(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']);
  });

  it('a lapsed lease before any effect: SUBMITTED again, stamped inside the requeue', () => {
    const id = eta();
    iw.claimChild(id, 1_000);
    advance(5_000);
    expect(iw.world.repo.expireLeasedTasks(iw.world.clock)).toHaveLength(1);
    expect(story(id)).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED']);
    expect(iw.opOf(id).status_updated_at).toBe(iw.world.clock);
    expect(getTask(id).status).toEqual(events(id)[1]?.statusUpdate?.status);
  });

  it('a lapsed lease after the effect began: never SUBMITTED again; FAILED with the outcome unknown', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } }))
      .id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    expect(iw.claimChild(id, 1_000).verdict).toBe('admitted');
    advance(5_000);
    iw.world.repo.expireLeasedTasks(iw.world.clock);
    sweepA2AInbound(iw.rt);
    expect(story(id)).toEqual(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_FAILED']);
    const last = events(id).at(-1)?.statusUpdate;
    expect(last?.metadata).toEqual(getTask(id).metadata);
    expect(JSON.stringify(last?.metadata)).toContain('"outcome":"unknown"');
  });

  it('a cancel is one CANCELED event', () => {
    const id = eta();
    advance(1_000);
    ingressCancelTask(iw.rt, iw.request('CancelTask', { id }), id);
    expect(story(id)).toEqual(['TASK_STATE_CANCELED']);
  });

  it('a refused call records nothing: its REJECTED answer was the whole story', () => {
    const id = sentTask(iw.call({ skill: 'eta_query', params: {} })).id as string;
    expect(iw.opOf(id).state).toBe('rejected');
    expect(rows(id)).toEqual([]);
  });

  it('the same change recorded again writes nothing, and the outbox refuses a second row per target', () => {
    const id = eta();
    iw.claimChild(id);
    const op = iw.opOf(id);
    iw.world.store.transaction(() => recordInboundChange(iw.rt, op.id));
    sweepA2AInbound(iw.rt);
    expect(rows(id)).toHaveLength(1);
    const first = rows(id)[0] as OutboxRow;
    iw.world.store.insertOutboxRow({ ...first, target_kind: 'sse', target_id: '' });
    expect(rows(id)).toHaveLength(1);
  });

  it('a change whose record was lost (no observer installed) is recorded by the sweep', async () => {
    iw.world.repo.observeRequeues(null);
    const id = eta();
    iw.claimChild(id, 1_000);
    advance(5_000);
    iw.world.repo.expireLeasedTasks(iw.world.clock);
    expect(story(id)).toEqual(['TASK_STATE_WORKING']);
    advance(1_000);
    sweepA2AInbound(iw.rt);
    expect(story(id)).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED']);
  });

  it('an inline webhook gets every event the streams get', async () => {
    const answer = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', {
        ...iw.message({ skill: 'eta_query', params: { route_id: '42' } }),
        configuration: {
          taskPushNotificationConfig: { url: 'https://hooks.example.test/a2a', token: 't-1' },
        },
      }),
    );
    const id = sentTask(answer).id as string;
    iw.runChild(id, { eta_minutes: 3 });
    await Promise.resolve();
    expect(story(id, 'webhook')).toEqual(story(id, 'sse'));
    expect(story(id, 'webhook')).toEqual([
      'TASK_STATE_WORKING',
      'artifact',
      'TASK_STATE_COMPLETED',
    ]);
  });
});

describe('claiming and reporting', () => {
  async function webhookCall(url = 'https://hooks.example.test/a2a'): Promise<string> {
    const answer = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', {
        ...iw.message({ skill: 'eta_query', params: { route_id: '42' } }),
        configuration: {
          taskPushNotificationConfig: {
            url,
            token: 'tok',
            authentication: { scheme: 'Bearer', credentials: 'sekrit' },
          },
        },
      }),
    );
    const id = sentTask(answer).id as string;
    iw.runChild(id, { eta_minutes: 3 });
    await Promise.resolve();
    return id;
  }

  it('streams take every due event in order; a webhook only its next one, with its address and credentials', async () => {
    const id = await webhookCall();
    const first = claim();
    const sse = first.items.filter((i) => i.target === 'sse');
    expect(sse.map((i) => i.seq)).toEqual([1, 2, 3]);
    // A stream event carries the client's credential generation and no webhook.
    expect(sse.every((i) => i.task_id === id && !('webhook' in i) && 'credential_gen' in i && i.credential_gen === 0)).toBe(true);
    const hooks = first.items.filter((i) => i.target === 'webhook');
    expect(hooks.map((i) => i.seq)).toEqual([1]);
    expect(hooks[0]?.webhook).toEqual({
      url: 'https://hooks.example.test/a2a',
      headers: { authorization: 'Bearer sekrit', 'x-a2a-notification-token': 'tok' },
    });
    // The next webhook event waits until the first is reported.
    expect(claim().items).toEqual([]);
    expect(
      ackDeliveries(iw.rt, {
        claimant: GATEWAY,
        acks: first.items.map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' })),
      }),
    ).toBe(4);
    expect(claim().items.map((i) => [i.target, i.seq])).toEqual([['webhook', 2]]);
  });

  it('takes no more webhook events than the gateway can start now', async () => {
    const a = await webhookCall('https://hooks.example.test/a');
    const b = await webhookCall('https://hooks.example.test/b');
    const only = claim(100, 1).items.filter((i) => i.target === 'webhook');
    expect(only.map((i) => i.task_id)).toEqual([a]);
    expect(claim(100, 0).items.filter((i) => i.target === 'webhook')).toEqual([]);
    expect(
      claim(100, 5)
        .items.filter((i) => i.target === 'webhook')
        .map((i) => i.task_id),
    ).toEqual([b]);
  });

  it('a claim survives a gateway restart: the lapsed lease is claimed again, and only the new claim may report', async () => {
    const id = eta();
    iw.claimChild(id);
    const before = claim().items;
    expect(before).toHaveLength(1);
    // The gateway died holding it; nothing is claimable while the lease lives.
    advance(DELIVERY_LEASE_MS - 1);
    expect(claim().items).toEqual([]);
    advance(2);
    const again = claim().items;
    expect(again.map((i) => i.id)).toEqual(before.map((i) => i.id));
    expect(again[0]?.claim_id).not.toBe(before[0]?.claim_id);
    const stale = {
      id: before[0]?.id ?? 0,
      claim_id: before[0]?.claim_id ?? '',
      outcome: 'delivered' as const,
    };
    expect(ackDeliveries(iw.rt, { claimant: GATEWAY, acks: [stale] })).toBe(0);
    expect(
      ackDeliveries(iw.rt, {
        claimant: 'did:key:z6MkOther',
        acks: [{ ...stale, claim_id: again[0]?.claim_id ?? '' }],
      }),
    ).toBe(0);
    expect(
      ackDeliveries(iw.rt, {
        claimant: GATEWAY,
        acks: [{ ...stale, claim_id: again[0]?.claim_id ?? '' }],
      }),
    ).toBe(1);
    expect(rows(id)[0]?.status).toBe('delivered');
    expect(rows(id)[0]?.attempts).toBe(2);
  });

  it('a failing webhook is retried with growing waits, and its sixth failure is final', async () => {
    const id = await webhookCall();
    const ackSse = (items: ReturnType<typeof claim>['items']) =>
      ackDeliveries(iw.rt, {
        claimant: GATEWAY,
        acks: items
          .filter((i) => i.target === 'sse')
          .map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' })),
      });
    let items = claim().items;
    ackSse(items);
    for (const delay of WEBHOOK_RETRY_DELAYS_MS) {
      const hook = items.find((i) => i.target === 'webhook');
      expect(hook?.seq).toBe(1);
      ackDeliveries(iw.rt, {
        claimant: GATEWAY,
        acks: [{ id: hook?.id ?? 0, claim_id: hook?.claim_id ?? '', outcome: 'retry' }],
      });
      advance(delay - 1);
      expect(claim().items.filter((i) => i.target === 'webhook')).toEqual([]);
      advance(1);
      items = claim().items;
    }
    const last = items.find((i) => i.target === 'webhook');
    ackDeliveries(iw.rt, {
      claimant: GATEWAY,
      acks: [{ id: last?.id ?? 0, claim_id: last?.claim_id ?? '', outcome: 'retry' }],
    });
    expect(rows(id, 'webhook')[0]).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 6 }),
    );
    // A failed event does not hold back the next one.
    expect(claim().items.map((i) => [i.target, i.seq])).toEqual([['webhook', 2]]);
  });

  it('when the client is revoked, waiting events are suppressed and the task’s streams are told to close', () => {
    const id = eta();
    iw.claimChild(id);
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    const out = claim();
    expect(out.items).toEqual([]);
    expect(out.closed).toEqual([id]);
    expect(rows(id).map((r) => r.status)).toEqual(['suppressed']);
  });

  it('a paused listing starts no new work but does not hold back work already done', async () => {
    const id = await webhookCall();
    await save(listing({ status: 'paused' }), 'bus');
    const out = claim();
    expect(out.closed).toEqual([]);
    expect(out.items.filter((i) => i.target === 'sse').map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(out.items.filter((i) => i.target === 'webhook').map((i) => i.seq)).toEqual([1]);
    const polled = getTask(id);
    expect((polled.status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    expect(events(id).at(-1)?.statusUpdate?.status).toEqual(polled.status);
    // A call made before the pause, not yet run, is refused at its claim.
    await save(listing({}), 'bus');
    const queued = eta();
    await save(listing({ status: 'paused' }), 'bus');
    expect(iw.claimChild(queued).verdict).toBe('refused');
    expect(story(queued)).toEqual(['TASK_STATE_FAILED']);
  });

  it('a stream event is never stuck behind a webhook backlog larger than the claim', async () => {
    const backlog = await webhookCall('https://hooks.example.test/slow');
    // More due webhook rows than one claim holds, all recorded first.
    for (let i = 0; i < 3; i += 1) {
      const more = ingressCreatePushConfig(
        iw.rt,
        iw.request('CreateTaskPushNotificationConfig', {
          taskId: backlog,
          url: `https://hooks.example.test/${i}`,
        }),
        backlog,
      );
      expect(more.status).toBe(200);
    }
    for (let i = 0; i < 40; i += 1) {
      const id = sentTask(
        ingressSendMessage(
          iw.rt,
          iw.request('SendMessage', {
            ...iw.message({ skill: 'eta_query', params: { route_id: String(i) } }),
            configuration: {
              taskPushNotificationConfig: { url: `https://hooks.example.test/t${i}` },
            },
          }),
        ),
      ).id as string;
      ingressCancelTask(iw.rt, iw.request('CancelTask', { id }), id);
    }
    // Every task's stream event is already claimed and reported; drain them.
    for (let round = claim(100, 0); round.items.length > 0; round = claim(100, 0)) {
      ackDeliveries(iw.rt, {
        claimant: GATEWAY,
        acks: round.items.map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' })),
      });
    }
    const id = eta();
    iw.claimChild(id);
    const out = claim(5, 0);
    expect(out.items.map((i) => [i.target, i.task_id])).toEqual([['sse', id]]);
  });

  it('webhook slots are shared in turn between clients', async () => {
    // Two older tasks of one client, each with a due webhook event, ahead of
    // another client's one: by age alone, the first client would take both slots.
    const mine = await webhookCall('https://hooks.example.test/mine');
    const alsoMine = await webhookCall('https://hooks.example.test/mine-2');
    const other = createA2AClient(iw.world.store, { display_name: 'Other' }, iw.world.clock);
    if (!other.ok) throw new Error(other.reason);
    const theirs = sentTask(
      ingressSendMessage(
        iw.rt,
        iw.request(
          'SendMessage',
          {
            ...iw.message({ skill: 'eta_query', params: { route_id: '7' } }),
            configuration: {
              taskPushNotificationConfig: { url: 'https://hooks.example.test/theirs' },
            },
          },
          {},
          `Bearer ${other.token}`,
        ),
      ),
    ).id as string;
    ingressCancelTask(
      iw.rt,
      iw.request('CancelTask', { id: theirs }, {}, `Bearer ${other.token}`),
      theirs,
    );
    const hooks = claim(100, 2).items.filter((i) => i.target === 'webhook');
    expect(hooks.map((i) => i.task_id).sort()).toEqual([mine, theirs].sort());
    expect(hooks.map((i) => i.task_id)).not.toContain(alsoMine);
  });

  it('a revoked grant suppresses a granted call’s events', async () => {
    await save(listing({ discoverability: 'known_only' }), 'private');
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      iw.call({
        skill: 'eta_query@private',
        grant_id: issued.grant.grantId,
        params: { route_id: '42' },
      }),
    ).id as string;
    expect(iw.claimChild(id).verdict).toBe('admitted');
    revokeA2AGrant(iw.grants, issued.grant.grantId, iw.world.clock);
    expect(claim().closed).toContain(id);
  });

  it('a webhook config deleted mid-flight gets nothing more', async () => {
    const id = await webhookCall();
    const op = iw.opOf(id);
    const config = iw.world.store.pushConfigsOf(op.id)[0];
    iw.world.store.transaction(() => iw.world.store.deletePushConfig(op.id, config?.id ?? ''));
    expect(rows(id, 'webhook').every((r) => r.status === 'suppressed')).toBe(true);
    expect(claim().items.every((i) => i.target === 'sse')).toBe(true);
  });

  it('purging an ended task takes its events and configs with it', async () => {
    const id = await webhookCall();
    const ref = iw.opOf(id).id;
    advance(31 * 24 * 60 * 60_000);
    purgeEndedA2AOperations(iw.world.runtime);
    expect(iw.world.store.outboxOf(ref)).toEqual([]);
    expect(iw.world.store.pushConfigsOf(ref)).toEqual([]);
  });
});

describe('every way a task ends is one event, and it says what GetTask says', () => {
  async function reviewed(): Promise<string> {
    await save(bookingListing(), 'bus');
    return sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } })).id as string;
  }

  it('the owner says no', async () => {
    const id = await reviewed();
    advance(1_000);
    iw.world.workflow.cancel(iw.childOf(id).id, 'denied_by_owner');
    expect(story(id)).toEqual(['TASK_STATE_FAILED']);
    finalAgrees(id);
  });

  it('the owner never answers', async () => {
    const id = await reviewed();
    advance((INBOUND_REVIEW_DEADLINE_SECONDS + 1) * 1000);
    iw.world.workflow.expireTasks(Math.floor(iw.world.clock / 1000), iw.world.clock);
    sweepA2AInbound(iw.rt);
    expect(story(id)).toEqual(['TASK_STATE_FAILED']);
    finalAgrees(id);
  });

  it('the claim is refused: the listing changed since the call was accepted', async () => {
    const id = eta();
    await save(listing({ name: 'Bus 42, renamed' }), 'bus');
    advance(1_000);
    expect(iw.claimChild(id).verdict).toBe('refused');
    expect(story(id)).toEqual(['TASK_STATE_FAILED']);
    finalAgrees(id);
  });

  it('the run fails', () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    advance(1_000);
    iw.world.workflow.fail(taskId, 'boom', iw.runnerDid);
    sweepA2AInbound(iw.rt);
    expect(story(id)).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_FAILED']);
    finalAgrees(id);
  });

  it('a result settled after the grant went: FAILED, kept for the owner, and the event itself suppressed', async () => {
    await save(listing({ discoverability: 'known_only' }), 'private');
    const issued = issueA2AGrant(
      iw.world.store,
      iw.grants,
      { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query' },
      iw.world.clock,
    );
    if (!issued.ok) throw new Error(issued.reason);
    const id = sentTask(
      iw.call({
        skill: 'eta_query@private',
        grant_id: issued.grant.grantId,
        params: { route_id: '42' },
      }),
    ).id as string;
    const { taskId } = iw.claimChild(id);
    revokeA2AGrant(iw.grants, issued.grant.grantId, iw.world.clock);
    advance(1_000);
    iw.world.workflow.complete(taskId, JSON.stringify({ eta_minutes: 1 }), 'done', iw.runnerDid);
    await Promise.resolve();
    expect(story(id)).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_FAILED']);
    expect(iw.opOf(id).result_json).not.toBeNull();
    expect(claim().closed).toContain(id);
    expect(rows(id).map((r) => r.status)).toEqual(['suppressed', 'suppressed']);
  });
});

describe('a task created before migration v57', () => {
  /** As v57 leaves an inbound row that existed before it: no events, no recorded state. */
  const asBeforeV57 = (id: string) => {
    const ref = iw.opOf(id).id;
    iw.world.store.db.run('DELETE FROM a2a_push_outbox WHERE operation_ref = ?', [ref]);
    iw.world.store.db.run('UPDATE a2a_tasks SET event_seq = 0, event_state = NULL WHERE id = ?', [
      ref,
    ]);
  };

  it('its next change is an event, so a stream opened on it sees its end', async () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    asBeforeV57(id);
    iw.world.workflow.complete(taskId, JSON.stringify({ eta_minutes: 2 }), 'done', iw.runnerDid);
    await Promise.resolve();
    expect(story(id)).toEqual(['artifact', 'TASK_STATE_COMPLETED']);
    finalAgrees(id);
  });

  it('the sweep records where it stands once, then nothing more', () => {
    const id = eta();
    iw.claimChild(id);
    asBeforeV57(id);
    sweepA2AInbound(iw.rt);
    sweepA2AInbound(iw.rt);
    expect(story(id)).toEqual(['TASK_STATE_WORKING']);
  });
});

describe('the claim queries, a listing made again, a pause, dead rows, a lost result', () => {
  it('each claim query checks earlier rows through the per-target index, never by scanning the outbox', () => {
    for (const sql of [DUE_STREAM_ROWS_SQL, DUE_WEBHOOK_HEADS_SQL]) {
      const plan = iw.world.store.db
        .query(
          `EXPLAIN QUERY PLAN ${sql}`,
          [0, 0, 0, 0, 1].slice(0, (sql.match(/\?/g) ?? []).length),
        )
        .map((r) => String((r as { detail: unknown }).detail));
      const inner = plan.filter((d) => / e\b| e /.test(` ${d} `) || d.includes('AS e'));
      expect(inner.length).toBeGreaterThan(0);
      expect(inner.every((d) => d.includes('idx_a2a_push_outbox_target'))).toBe(true);
    }
  });

  it('a listing deleted and made again under its name gives the old call no authority back', async () => {
    const id = await webhookTask();
    await clearServiceConfigDurable('bus');
    expect(claim().closed).toEqual([id]);
    await save(listing({}), 'bus');
    expect(claim()).toEqual({ items: [], closed: [], fenced: [] });
    expect((getTask(id).status as { state: string }).state).toBe('TASK_STATE_FAILED');
    expect(getTask(id).artifacts).toBeUndefined();
    expect(iw.opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }),
    );
    expect(rows(id).every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('…even when nothing read or claimed in between', async () => {
    const id = await webhookTask();
    await clearServiceConfigDurable('bus');
    await save(listing({}), 'bus');
    expect((getTask(id).status as { state: string }).state).toBe('TASK_STATE_FAILED');
    expect(claim().closed).toEqual([id]);
  });

  it('a pause while a call runs: its result is still released, once, as polled', async () => {
    const id = eta();
    const { taskId } = iw.claimChild(id);
    await save(listing({ status: 'paused' }), 'bus');
    advance(1_000);
    iw.world.workflow.complete(taskId, JSON.stringify({ eta_minutes: 4 }), 'done', iw.runnerDid);
    await Promise.resolve();
    expect(iw.opOf(id).state).toBe('completed');
    expect(claim().items.map((i) => i.seq)).toEqual([1, 2, 3]);
    finalAgrees(id);
  });

  it('dead rows, more than one claim holds, never keep a live task’s event out of the claim', async () => {
    for (let i = 0; i < 110; i += 1) {
      if (i % 50 === 49) advance(60_000); // within the client's 60-a-minute budget
      const id = sentTask(iw.call({ skill: 'eta_query', params: { route_id: String(i) } }))
        .id as string;
      ingressCancelTask(iw.rt, iw.request('CancelTask', { id }), id);
    }
    await save(listing({ name: 'Bus 43' }), 'bus2');
    await clearServiceConfigDurable('bus');
    const live = sentTask(iw.call({ skill: 'eta_query@bus2', params: { route_id: '1' } }))
      .id as string;
    iw.claimChild(live);
    const out = claim(100, 0);
    expect(out.items.map((i) => i.task_id)).toEqual([live]);
    expect(out.closed).toHaveLength(110);
  });

  it('a revoked effectful result ends outcome_unknown, as settle would have ended it', async () => {
    await save(bookingListing(), 'bus');
    const id = sentTask(iw.call({ skill: 'appointment_book', params: { slot: '9am' } }))
      .id as string;
    iw.world.workflow.approve(iw.childOf(id).id);
    iw.runChild(id, { booked: true });
    await Promise.resolve();
    expect(iw.opOf(id).state).toBe('completed');
    revokeA2AClient(iw.world.store, iw.grants, iw.clientId, iw.world.clock);
    claim();
    expect(iw.opOf(id)).toEqual(
      expect.objectContaining({ state: 'outcome_unknown', reason_code: 'authority_revoked' }),
    );
    expect(iw.opOf(id).result_json).not.toBeNull();
  });

  it('a read that finds the egress lost ends the result for good; the next claim drops its events and closes its streams', async () => {
    const id = await webhookTask();
    await clearServiceConfigDurable('bus');
    expect((getTask(id).status as { state: string }).state).toBe('TASK_STATE_FAILED');
    expect(iw.opOf(id)).toEqual(
      expect.objectContaining({ state: 'failed', reason_code: 'authority_revoked' }),
    );
    expect(claim()).toEqual({ items: [], closed: [id], fenced: [] });
    expect(rows(id).every((r) => r.status === 'suppressed')).toBe(true);
  });

  it('a call accepted before the pin existed: a listing made after it is still another listing', async () => {
    const id = await webhookTask();
    // As a call accepted before M3 pinned the listing's creation time.
    const op = iw.opOf(id);
    const snapshot = JSON.parse(op.snapshot_json ?? '{}') as Record<string, unknown>;
    delete snapshot.listing_created_at;
    iw.world.store.db.run('UPDATE a2a_tasks SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(snapshot),
      op.id,
    ]);
    expect((getTask(id).status as { state: string }).state).toBe('TASK_STATE_COMPLETED');
    await clearServiceConfigDurable('bus');
    await save(listing({}), 'bus');
    // Listings are stamped with the wall clock and A2A rows with this world's
    // clock; in production both are the system clock. State "made after the
    // call" in the listing's own terms.
    iw.world.store.db.run('UPDATE service_configs SET created_at = ? WHERE rkey = ?', [
      op.created_at + 1,
      'bus',
    ]);
    expect((getTask(id).status as { state: string }).state).toBe('TASK_STATE_FAILED');
    expect(claim()).toEqual({ items: [], closed: [id], fenced: [] });
  });

  async function webhookTask(): Promise<string> {
    const answer = ingressSendMessage(
      iw.rt,
      iw.request('SendMessage', {
        ...iw.message({ skill: 'eta_query', params: { route_id: '42' } }),
        configuration: { taskPushNotificationConfig: { url: 'https://hooks.example.test/r2' } },
      }),
    );
    const id = sentTask(answer).id as string;
    iw.runChild(id, { eta_minutes: 5 });
    await Promise.resolve();
    return id;
  }
});
