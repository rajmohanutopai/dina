/**
 * The gateway's delivery half (design §7.5): the stream hub (every stream of
 * a task gets the same events in order, each once, and ends with the task)
 * and the delivery loop (stream events reported at once; webhook POSTs no
 * more than its free slots, each answer mapped to a report).
 */

import { pino } from 'pino';

import { DeliveryPump, webhookOutcome } from '../src/delivery_pump';
import { StreamHub, StreamSlots } from '../src/stream_hub';

import type { CoreLink } from '../src/core_link';
import type { DeliveryAck, DeliveryClaim, JsonObject } from '@dina/a2a';
import type { A2AHttpRequest, A2AHttpResult } from '@dina/core';

const status = (task: string, state: string): JsonObject => ({
  statusUpdate: { taskId: task, contextId: 'c', status: { state } },
});

/** Two clients' opaque stream keys, as Core sends them. */
const ALICE = 'a'.repeat(32);
const BOB = 'b'.repeat(32);
/** A stream's start for `client` and an event's mark, under credential generation `gen` (0 until a credential ends). */
const from = (afterSeq: number, gen = 0, client = ALICE) => ({ afterSeq, client, credentialGen: gen });
const at = (seq: number, gen = 0) => ({ seq, credentialGen: gen });

function sink() {
  const got: JsonObject[] = [];
  let ended = false;
  return {
    got,
    ended: () => ended,
    sink: {
      send: (e: JsonObject) => got.push(e),
      end: () => {
        ended = true;
      },
    },
  };
}

describe('StreamHub', () => {
  let now = 0;
  const hub = () =>
    new StreamHub({
      maxStreams: 3,
      bufferMs: 1_000,
      bufferEvents: 4,
      bufferTasks: 2,
      bufferBytes: 1 << 20,
      now: () => now,
    });

  it('every stream of a task gets each event after its cursor, once, in order', () => {
    const h = hub();
    const a = sink();
    const b = sink();
    h.open('t', from(0), a.sink);
    h.open('t', from(1), b.sink);
    h.publish('t', at(1), status('t', 'TASK_STATE_SUBMITTED'));
    h.publish('t', at(2), status('t', 'TASK_STATE_WORKING'));
    h.publish('t', at(2), status('t', 'TASK_STATE_WORKING')); // claimed again after a restart
    expect(
      a.got.map((e) => (e.statusUpdate as { status: { state: string } }).status.state),
    ).toEqual(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']);
    expect(b.got).toHaveLength(1);
  });

  it('a terminal event ends every stream of the task, and frees their places', () => {
    const h = hub();
    const a = sink();
    h.open('t', from(0), a.sink);
    h.publish('t', at(1), status('t', 'TASK_STATE_FAILED'));
    expect(a.ended()).toBe(true);
    expect(h.size).toBe(0);
  });

  it('keeps nothing while no streaming call is on its way', () => {
    const h = hub();
    h.publish('t', at(1), status('t', 'TASK_STATE_WORKING'));
    expect(h.bufferedBytes).toBe(0);
    const s = sink();
    h.open('t', from(0), s.sink);
    expect(s.got).toHaveLength(0);
  });

  it('while a call is on its way, replays recent events to a stream that opens after them, until they age out', () => {
    const h = hub();
    h.expect();
    h.publish('t', at(1), status('t', 'TASK_STATE_WORKING'));
    const early = sink();
    h.open('t', from(0), early.sink);
    expect(early.got).toHaveLength(1);
    now += 1_001;
    const late = sink();
    h.open('t', from(0), late.sink);
    expect(late.got).toHaveLength(0);
  });

  it('a replayed terminal event ends the new stream before open returns', () => {
    const h = hub();
    h.expect();
    h.publish('t', at(1), status('t', 'TASK_STATE_COMPLETED'));
    const s = sink();
    h.open('t', from(0), s.sink);
    expect(s.ended()).toBe(true);
    expect(h.size).toBe(0);
  });

  it('frees the memory of tasks nobody touches once they age out, and all of it when no call is on its way', () => {
    const h = hub();
    h.expect();
    h.publish('a', at(1), status('a', 'TASK_STATE_WORKING'));
    expect(h.bufferedBytes).toBeGreaterThan(0);
    now += 1_001;
    h.publish('b', at(1), status('b', 'TASK_STATE_WORKING'));
    const a = sink();
    h.open('a', from(0), a.sink);
    expect(a.got).toHaveLength(0);
    h.arrived();
    expect(h.bufferedBytes).toBe(0);
  });

  it('keeps recent events for a bounded number of tasks, events and bytes', () => {
    const h = hub();
    h.expect();
    for (let i = 1; i <= 6; i += 1) h.publish('a', at(i), status('a', 'TASK_STATE_WORKING'));
    h.publish('b', at(1), status('b', 'TASK_STATE_WORKING'));
    h.publish('c', at(1), status('c', 'TASK_STATE_WORKING'));
    const a = sink();
    h.open('a', from(0), a.sink);
    expect(a.got).toHaveLength(0); // 'a' was the oldest of three tasks
    const c = sink();
    h.open('c', from(0), c.sink);
    expect(c.got).toHaveLength(1);
    const small = new StreamHub({
      maxStreams: 3,
      bufferMs: 1_000,
      bufferEvents: 4,
      bufferTasks: 10,
      bufferBytes: 300,
      now: () => now,
    });
    small.expect();
    const big = {
      artifactUpdate: {
        taskId: 'x',
        contextId: 'c',
        artifact: { artifactId: 'r', parts: [{ text: 'y'.repeat(400) }] },
      },
    };
    small.publish('x', at(1), big);
    expect(small.bufferedBytes).toBe(0);
  });

  it('refuses a stream past its capacity; close ends a task’s streams with nothing sent', () => {
    const h = hub();
    for (let i = 0; i < 3; i += 1) expect(h.open('t', from(0), sink().sink)).not.toBeNull();
    expect(h.open('t', from(0), sink().sink)).toBeNull();
    h.close('t');
    expect(h.size).toBe(0);
  });

  describe('credential generations (design §10: a credential that ends takes its streams with it)', () => {
    const states = (got: JsonObject[]) => got.map((e) => (e.statusUpdate as { status: { state: string } }).status.state);

    it('a stream opened under an earlier generation ends at the first event of a later one, and gets nothing of it', () => {
      const h = hub();
      const old = sink();
      const fresh = sink();
      h.open('t', from(0, 0), old.sink);
      h.open('t', from(0, 1), fresh.sink);
      h.publish('t', at(1, 0), status('t', 'TASK_STATE_SUBMITTED'));
      h.publish('t', at(2, 1), status('t', 'TASK_STATE_WORKING'));
      expect(states(old.got)).toEqual(['TASK_STATE_SUBMITTED']);
      expect(old.ended()).toBe(true);
      expect(states(fresh.got)).toEqual(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']);
      expect(fresh.ended()).toBe(false);
      expect(h.size).toBe(1);
    });

    it('a stream newer than an event still gets it: the client is the same, under its new credential', () => {
      const h = hub();
      const s = sink();
      h.open('t', from(0, 2), s.sink);
      h.publish('t', at(1, 1), status('t', 'TASK_STATE_WORKING'));
      expect(s.got).toHaveLength(1);
      expect(s.ended()).toBe(false);
    });

    it('a fence ends the client’s older streams on every task at once, and keeps its newer ones and other clients’', () => {
      const h = hub();
      const old = sink();
      const oldOther = sink();
      const fresh = sink();
      const bob = sink();
      h.open('t', from(0, 0), old.sink);
      h.open('u', from(0, 0), oldOther.sink);
      h.open('t', from(0, 1), fresh.sink);
      h.open('t', from(0, 0, BOB), bob.sink);
      h.setFences([{ client: ALICE, before_gen: 1 }]);
      expect([old.ended(), oldOther.ended(), fresh.ended(), bob.ended()]).toEqual([true, true, false, false]);
      expect(old.got).toEqual([]);
      // Ended means ended: nothing more reaches it.
      h.publish('t', at(1, 1), status('t', 'TASK_STATE_WORKING'));
      expect(old.got).toEqual([]);
      expect(fresh.got).toHaveLength(1);
    });

    it('an older stream that registers after the fence is refused, buffered events and all; a newer one opens and gets them', () => {
      const h = hub();
      h.expect();
      // An event Core handed over before the credential ended, kept for a call on its way.
      h.publish('t', at(1, 0), status('t', 'TASK_STATE_WORKING'));
      h.setFences([{ client: ALICE, before_gen: 1 }]);
      const late = sink();
      expect(h.open('t', from(0, 0), late.sink)).toBeNull();
      expect(late.got).toEqual([]);
      expect(h.size).toBe(0);
      // The client under its new credential: opens, and gets the kept event.
      const fresh = sink();
      expect(h.open('t', from(0, 1), fresh.sink)).not.toBeNull();
      expect(fresh.got).toHaveLength(1);
    });

    it('the fences are the last claim’s: one Core no longer holds lets an older stream open again', () => {
      const h = hub();
      h.setFences([{ client: ALICE, before_gen: 2 }]);
      expect(h.open('t', from(0, 1), sink().sink)).toBeNull();
      h.setFences([]);
      expect(h.open('t', from(0, 1), sink().sink)).not.toBeNull();
    });

    it('an older stream that registers late is ended by a kept event of a later generation before open returns', () => {
      const h = hub();
      h.expect();
      h.publish('t', at(1, 1), status('t', 'TASK_STATE_WORKING'));
      const late = sink();
      expect(h.open('t', from(0, 0), late.sink)).not.toBeNull();
      expect(late.got).toEqual([]);
      expect(late.ended()).toBe(true);
      expect(h.size).toBe(0);
    });
  });

  it('stream slots: per client, and never past the hub’s capacity counting calls on their way', () => {
    const h = hub();
    const slots = new StreamSlots(h, 2);
    expect(slots.take('1.1.1.1')).toBe(true);
    expect(slots.take('1.1.1.1')).toBe(true);
    expect(slots.take('1.1.1.1')).toBe(false);
    expect(slots.take('2.2.2.2')).toBe(true);
    expect(slots.take('3.3.3.3')).toBe(false); // three pending fill the hub's three
    slots.answered();
    slots.release('1.1.1.1');
    expect(slots.take('3.3.3.3')).toBe(true);
  });
});

describe('webhookOutcome', () => {
  it.each([
    [{ ok: true, status: 204, body: '', connectedAddress: 'x' }, 'delivered'],
    [{ ok: true, status: 500, body: '', connectedAddress: 'x' }, 'retry'],
    [{ ok: true, status: 429, body: '', connectedAddress: 'x' }, 'retry'],
    [{ ok: true, status: 408, body: '', connectedAddress: 'x' }, 'retry'],
    [{ ok: true, status: 404, body: '', connectedAddress: 'x' }, 'failed'],
    [{ ok: true, status: 401, body: '', connectedAddress: 'x' }, 'failed'],
    [{ ok: false, error: 'address_blocked', sent: false }, 'failed'],
    [{ ok: false, error: 'url_refused', sent: false }, 'failed'],
    [{ ok: false, error: 'redirect_refused', sent: true }, 'failed'],
    [{ ok: false, error: 'timeout', sent: true }, 'retry'],
    [{ ok: false, error: 'dns_failed', sent: false }, 'retry'],
    [{ ok: false, error: 'tls_failed', sent: false }, 'retry'],
  ] as [A2AHttpResult, string][])('%j → %s', (result, outcome) => {
    expect(webhookOutcome(result)).toBe(outcome);
  });
});

describe('DeliveryPump', () => {
  const hook = { url: 'https://hooks.example.test/a', headers: { authorization: 'Bearer s' } };
  let claims: { limit: number; webhookLimit: number }[];
  let acks: DeliveryAck[][];
  let next: DeliveryClaim[];
  let posts: A2AHttpRequest[];
  let answer: (req: A2AHttpRequest) => Promise<A2AHttpResult>;

  const core = (): CoreLink => ({
    forward: async () => ({ ok: false, status: 'unreachable' }),
    card: async () => ({ ok: false, status: 'unreachable' }),
    ucpWebhook: async () => ({ ok: false, status: 'unreachable' }),
    ucpOauthCallback: async () => ({ ok: false, status: 'unreachable' }),
    claimEvents: async (limit, webhookLimit) => {
      claims.push({ limit, webhookLimit });
      return { ok: true, claim: next.shift() ?? { items: [], closed: [], fenced: [] } };
    },
    ackEvents: async (batch) => {
      acks.push([...batch]);
      return { ok: true, applied: batch.length };
    },
  });

  beforeEach(() => {
    claims = [];
    acks = [];
    next = [];
    posts = [];
    answer = async () => ({ ok: true, status: 200, body: '', connectedAddress: '203.0.113.5' });
  });

  const pump = (hub: StreamHub, concurrency = 2) =>
    new DeliveryPump({
      core: core(),
      hub,
      transport: (req) => {
        posts.push(req);
        return answer(req);
      },
      logger: pino({ level: 'silent' }),
      intervalMs: 10,
      webhookConcurrency: concurrency,
      claimLimit: 100,
    });

  it('publishes stream events and reports them in the same turn; POSTs webhooks as A2A JSON; reports them next turn', async () => {
    const hub = new StreamHub({
      maxStreams: 4,
      bufferMs: 1_000,
      bufferEvents: 4,
      bufferTasks: 4,
      bufferBytes: 1 << 20,
    });
    const s = sink();
    hub.open('t', from(0), s.sink);
    next.push({
      items: [
        {
          id: 1,
          claim_id: 'k1',
          target: 'sse',
          task_id: 't',
          seq: 1,
          event: status('t', 'TASK_STATE_WORKING'),
          credential_gen: 0,
        },
        {
          id: 2,
          claim_id: 'k2',
          target: 'webhook',
          task_id: 't',
          seq: 1,
          event: status('t', 'TASK_STATE_WORKING'),
          webhook: hook,
        },
      ],
      closed: [],
      fenced: [],
    });
    const p = pump(hub);
    await p.turn();
    expect(s.got).toHaveLength(1);
    expect(acks).toEqual([[{ id: 1, claim_id: 'k1', outcome: 'delivered' }]]);
    expect(posts[0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: hook.url,
        headers: hook.headers,
        body: JSON.stringify(status('t', 'TASK_STATE_WORKING')),
        contentType: 'application/a2a+json',
        response: 'status',
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await p.turn();
    expect(acks[1]).toEqual([{ id: 2, claim_id: 'k2', outcome: 'delivered' }]);
  });

  it('claims no more webhook events than it has free slots', async () => {
    const hub = new StreamHub({
      maxStreams: 4,
      bufferMs: 1_000,
      bufferEvents: 4,
      bufferTasks: 4,
      bufferBytes: 1 << 20,
    });
    let release: () => void = () => undefined;
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, body: '', connectedAddress: 'x' });
      });
    next.push({
      items: [
        {
          id: 2,
          claim_id: 'k2',
          target: 'webhook',
          task_id: 't',
          seq: 1,
          event: status('t', 'TASK_STATE_WORKING'),
          webhook: hook,
        },
      ],
      closed: [],
      fenced: [],
    });
    const p = pump(hub, 2);
    await p.turn();
    await p.turn();
    expect(claims.map((c) => c.webhookLimit)).toEqual([2, 1]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await p.turn();
    expect(claims.at(-1)?.webhookLimit).toBe(2);
  });

  // Cold audit C3-14: each of these fails if the pump drops the claim's fences, or applies them late.
  const smallHub = () =>
    new StreamHub({ maxStreams: 8, bufferMs: 1_000, bufferEvents: 4, bufferTasks: 4, bufferBytes: 1 << 20 });

  it('a fence alone ends the client’s older streams, on a task with nothing new to say', async () => {
    const hub = smallHub();
    const idle = sink();
    const other = sink();
    hub.open('idle', from(0, 0, ALICE), idle.sink);
    hub.open('elsewhere', from(0, 0, BOB), other.sink);
    next.push({ items: [], closed: [], fenced: [{ client: ALICE, before_gen: 1 }] });
    await pump(hub).turn();
    expect([idle.ended(), idle.got]).toEqual([true, []]);
    // Only the fenced client: another client's stream runs on.
    expect(other.ended()).toBe(false);
  });

  it('after a claim that fences a client, its older streams cannot open, even onto a buffered event', async () => {
    const hub = smallHub();
    // An event waits in the buffer for a stream on its way.
    hub.publish('t', at(1, 0), status('t', 'TASK_STATE_WORKING'));
    next.push({ items: [], closed: [], fenced: [{ client: ALICE, before_gen: 1 }] });
    await pump(hub).turn();
    const late = sink();
    expect(hub.admits(ALICE, 0)).toBe(false);
    expect(hub.open('t', from(0, 0, ALICE), late.sink)).toBeNull();
    expect(late.got).toEqual([]);
    // The current generation, and another client, still open.
    expect(hub.admits(ALICE, 1)).toBe(true);
    expect(hub.open('t', from(0, 0, BOB), sink().sink)).not.toBeNull();
  });

  it('a claim’s fences come before its events: a fenced stream gets none of them, even one of its own generation', async () => {
    const hub = smallHub();
    const fencedOut = sink();
    const fresh = sink();
    hub.open('t', from(0, 1, ALICE), fencedOut.sink);
    hub.open('t', from(0, 2, ALICE), fresh.sink);
    next.push({
      items: [{ id: 1, claim_id: 'k1', target: 'sse', task_id: 't', seq: 1, event: status('t', 'TASK_STATE_WORKING'), credential_gen: 1 }],
      closed: [],
      fenced: [{ client: ALICE, before_gen: 2 }],
    });
    await pump(hub).turn();
    // Core stamps events with the current generation, so this pairing is the pump's order alone on trial.
    expect([fencedOut.ended(), fencedOut.got]).toEqual([true, []]);
    expect(fresh.ended()).toBe(false);
    expect(acks).toEqual([[{ id: 1, claim_id: 'k1', outcome: 'delivered' }]]);
  });

  it('Core’s order to close a task ends its streams', async () => {
    const hub = new StreamHub({
      maxStreams: 4,
      bufferMs: 1_000,
      bufferEvents: 4,
      bufferTasks: 4,
      bufferBytes: 1 << 20,
    });
    const s = sink();
    hub.open('t', from(0), s.sink);
    next.push({ items: [], closed: ['t'], fenced: [] });
    await pump(hub).turn();
    expect(s.ended()).toBe(true);
    expect(s.got).toEqual([]);
  });

  it('stop lets a POST in flight finish and reports it', async () => {
    const hub = new StreamHub({
      maxStreams: 4,
      bufferMs: 1_000,
      bufferEvents: 4,
      bufferTasks: 4,
      bufferBytes: 1 << 20,
    });
    next.push({
      items: [
        {
          id: 2,
          claim_id: 'k2',
          target: 'webhook',
          task_id: 't',
          seq: 1,
          event: status('t', 'TASK_STATE_WORKING'),
          webhook: hook,
        },
      ],
      closed: [],
      fenced: [],
    });
    answer = async () => ({ ok: true, status: 503, body: '', connectedAddress: 'x' });
    const p = pump(hub);
    p.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await p.stop();
    expect(acks.flat()).toContainEqual({ id: 2, claim_id: 'k2', outcome: 'retry' });
  });
});
