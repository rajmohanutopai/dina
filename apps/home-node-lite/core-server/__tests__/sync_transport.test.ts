/**
 * sync_transport tests.
 */

import { SyncEventLog, type SyncEvent } from '../src/brain/sync_event_log';
import {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  SyncTransport,
  type TransportEvent,
} from '../src/brain/sync_transport';

interface ToyPayload { v: number }

function freshRig(opts: { maxConsecutiveFailures?: number } = {}) {
  const log = new SyncEventLog<ToyPayload>();
  const events: TransportEvent[] = [];
  const transport = new SyncTransport<ToyPayload>(log, {
    onEvent: (e) => events.push(e),
    ...(opts.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: opts.maxConsecutiveFailures }
      : {}),
  });
  return { log, transport, events };
}

function collector() {
  const seen: SyncEvent<ToyPayload>[] = [];
  return {
    send: async (e: SyncEvent<ToyPayload>) => {
      seen.push(e);
    },
    seen,
  };
}

describe('SyncTransport — construction', () => {
  it('throws without log', () => {
    expect(
      () => new SyncTransport(undefined as unknown as SyncEventLog),
    ).toThrow(/log/);
  });

  it.each([0, -1, 1.5])(
    'rejects invalid maxConsecutiveFailures=%s',
    (bad) => {
      expect(
        () =>
          new SyncTransport(new SyncEventLog(), {
            maxConsecutiveFailures: bad,
          }),
      ).toThrow(/maxConsecutiveFailures/);
    },
  );

  it('DEFAULT_MAX_CONSECUTIVE_FAILURES is 5', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBe(5);
  });

  it('new transport has zero subscriptions', () => {
    const { transport } = freshRig();
    expect(transport.size()).toBe(0);
    expect(transport.list()).toEqual([]);
  });
});

describe('SyncTransport — subscribe + replay', () => {
  it('subscribe with since=0 replays everything synchronously', async () => {
    const { log, transport } = freshRig();
    log.append({ topic: 't', kind: 'x', payload: { v: 1 } });
    log.append({ topic: 't', kind: 'x', payload: { v: 2 } });
    const c = collector();
    const r = await transport.subscribe({ send: c.send, since: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.replayedCount).toBe(2);
    }
    expect(c.seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(transport.size()).toBe(1);
  });

  it('subscribe with since=tailSeq replays nothing', async () => {
    const { log, transport } = freshRig();
    log.append({ topic: 't', kind: 'x', payload: { v: 1 } });
    log.append({ topic: 't', kind: 'x', payload: { v: 2 } });
    const c = collector();
    const r = await transport.subscribe({ send: c.send, since: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replayedCount).toBe(0);
    expect(c.seen).toHaveLength(0);
  });

  it('subscribe with stale cursor → cursor_behind_retention', async () => {
    const log = new SyncEventLog<ToyPayload>({ maxRetained: 3 });
    const transport = new SyncTransport<ToyPayload>(log);
    for (let i = 0; i < 10; i++) {
      log.append({ topic: 't', kind: 'x', payload: { v: i } });
    }
    const r = await transport.subscribe({ send: async () => {}, since: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cursor_behind_retention');
      expect(r.earliestRetainedSeq).toBe(8);
      expect(r.tailSeq).toBe(10);
    }
    // Failed subscribe did NOT register a client.
    expect(transport.size()).toBe(0);
  });

  it('topic filter applies to replay', async () => {
    const { log, transport } = freshRig();
    log.append({ topic: 'a', kind: 'x', payload: { v: 1 } });
    log.append({ topic: 'b', kind: 'x', payload: { v: 2 } });
    log.append({ topic: 'a', kind: 'x', payload: { v: 3 } });
    const c = collector();
    const r = await transport.subscribe({ send: c.send, topic: 'a' });
    expect(r.ok).toBe(true);
    expect(c.seen.map((e) => e.payload.v)).toEqual([1, 3]);
  });

  it('throws without send fn', async () => {
    const { transport } = freshRig();
    await expect(
      transport.subscribe(
        {} as unknown as Parameters<typeof transport.subscribe>[0],
      ),
    ).rejects.toThrow(/send/);
  });

  it('accepts a caller-supplied id', async () => {
    const { transport } = freshRig();
    const r = await transport.subscribe({ id: 'custom', send: async () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.subscription.id).toBe('custom');
  });

  it('emits subscribed event', async () => {
    const { transport, events } = freshRig();
    await transport.subscribe({ send: async () => {}, since: 3 });
    expect(events[0]).toEqual({ kind: 'subscribed', id: expect.any(String), since: 3 });
  });
});

describe('SyncTransport — publishFromLog', () => {
  it('pushes to every matching client', async () => {
    const { log, transport } = freshRig();
    const a = collector();
    const b = collector();
    await transport.subscribe({ send: a.send });
    await transport.subscribe({ send: b.send });
    const seq = log.append({ topic: 't', kind: 'x', payload: { v: 99 } });
    // publishFromLog is a manual hook — call it as the caller wiring would.
    const event = log.tail(1)[0]!;
    expect(event.seq).toBe(seq);
    await transport.publishFromLog(event);
    expect(a.seen.map((e) => e.seq)).toEqual([seq]);
    expect(b.seen.map((e) => e.seq)).toEqual([seq]);
  });

  it('honours topic filter at push time', async () => {
    const { log, transport } = freshRig();
    const a = collector();
    const b = collector();
    await transport.subscribe({ send: a.send, topic: 'vault' });
    await transport.subscribe({ send: b.send }); // no filter
    log.append({ topic: 'contact', kind: 'x', payload: { v: 1 } });
    await transport.publishFromLog(log.tail(1)[0]!);
    expect(a.seen).toHaveLength(0);
    expect(b.seen).toHaveLength(1);
  });

  it('send throw does NOT propagate; marks broken after N failures', async () => {
    const { log, transport, events } = freshRig({ maxConsecutiveFailures: 3 });
    let attempts = 0;
    const badSend = async () => {
      attempts++;
      throw new Error('socket closed');
    };
    await transport.subscribe({ id: 'bad', send: badSend });
    for (let i = 1; i <= 3; i++) {
      log.append({ topic: 't', kind: 'x', payload: { v: i } });
      await transport.publishFromLog(log.tail(1)[0]!);
    }
    expect(attempts).toBe(3);
    const failed = events.filter((e) => e.kind === 'send_failed');
    expect(failed).toHaveLength(3);
    const broken = events.filter((e) => e.kind === 'marked_broken');
    expect(broken).toHaveLength(1);
    // After being marked broken, no more pushes.
    log.append({ topic: 't', kind: 'x', payload: { v: 4 } });
    await transport.publishFromLog(log.tail(1)[0]!);
    expect(attempts).toBe(3);
  });

  it('successful send resets consecutiveFailures counter', async () => {
    const { log, transport, events } = freshRig({ maxConsecutiveFailures: 3 });
    let failOnce = true;
    const send = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('flaky');
      }
    };
    await transport.subscribe({ id: 's', send });
    for (let i = 1; i <= 5; i++) {
      log.append({ topic: 't', kind: 'x', payload: { v: i } });
      await transport.publishFromLog(log.tail(1)[0]!);
    }
    const broken = events.filter((e) => e.kind === 'marked_broken');
    expect(broken).toHaveLength(0);
  });
});

describe('SyncTransport — ack + minAckedCursor', () => {
  it('ack monotonically advances cursor', async () => {
    const { transport } = freshRig();
    const r = await transport.subscribe({ id: 'a', send: async () => {} });
    expect(r.ok).toBe(true);
    transport.ack('a', 5);
    transport.ack('a', 3); // retreat is ignored
    expect(transport.list()[0]!.ackedCursor).toBe(5);
  });

  it('ack for unknown id is a no-op', () => {
    const { transport } = freshRig();
    expect(() => transport.ack('missing', 1)).not.toThrow();
  });

  it('ack throws on invalid cursor', async () => {
    const { transport } = freshRig();
    await transport.subscribe({ id: 'a', send: async () => {} });
    expect(() => transport.ack('a', -1)).toThrow(/cursor/);
    expect(() => transport.ack('a', 1.5)).toThrow(/cursor/);
  });

  it('minAckedCursor returns floor across healthy subscriptions', async () => {
    const { transport } = freshRig();
    await transport.subscribe({ id: 'a', send: async () => {} });
    await transport.subscribe({ id: 'b', send: async () => {} });
    await transport.subscribe({ id: 'c', send: async () => {} });
    transport.ack('a', 10);
    transport.ack('b', 5);
    transport.ack('c', 7);
    expect(transport.minAckedCursor()).toBe(5);
  });

  it('broken subscriptions excluded from minAckedCursor', async () => {
    const { log, transport } = freshRig({ maxConsecutiveFailures: 1 });
    await transport.subscribe({
      id: 'broken',
      send: async () => { throw new Error('x'); },
    });
    await transport.subscribe({ id: 'healthy', send: async () => {} });
    log.append({ topic: 't', kind: 'x', payload: { v: 1 } });
    await transport.publishFromLog(log.tail(1)[0]!);
    transport.ack('healthy', 1);
    // broken sub has ackedCursor=0; it's excluded → min = 1.
    expect(transport.minAckedCursor()).toBe(1);
  });

  it('no subscribers → Infinity', () => {
    const { transport } = freshRig();
    expect(transport.minAckedCursor()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('SyncTransport — unsubscribe + close', () => {
  it('unsubscribe returns true once + false after', async () => {
    const { transport } = freshRig();
    await transport.subscribe({ id: 'x', send: async () => {} });
    expect(transport.unsubscribe('x')).toBe(true);
    expect(transport.unsubscribe('x')).toBe(false);
    expect(transport.size()).toBe(0);
  });

  it('close drops all subscriptions + rejects future subscribe', async () => {
    const { transport } = freshRig();
    await transport.subscribe({ send: async () => {} });
    await transport.subscribe({ send: async () => {} });
    transport.close();
    expect(transport.size()).toBe(0);
    await expect(
      transport.subscribe({ send: async () => {} }),
    ).rejects.toThrow(/close/);
  });

  it('publish after close is a no-op', async () => {
    const { log, transport } = freshRig();
    const c = collector();
    await transport.subscribe({ send: c.send });
    transport.close();
    log.append({ topic: 't', kind: 'x', payload: { v: 1 } });
    await transport.publishFromLog(log.tail(1)[0]!);
    expect(c.seen).toHaveLength(0);
  });
});

describe('SyncTransport — list snapshot', () => {
  it('returns a read-only snapshot per subscription', async () => {
    const { transport } = freshRig();
    await transport.subscribe({ id: 'a', send: async () => {}, topic: 'vault' });
    await transport.subscribe({ id: 'b', send: async () => {} });
    const snap = transport.list();
    expect(snap).toHaveLength(2);
    expect(snap.find((s) => s.id === 'a')?.topic).toBe('vault');
    expect(snap.find((s) => s.id === 'b')?.topic).toBeUndefined();
  });
});
