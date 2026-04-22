/**
 * event_stream tests.
 */

import { EventStream } from '../src/brain/event_stream';

interface DemoEvent {
  kind: 'a' | 'b';
  payload: number;
}

describe('EventStream — subscribe + emit', () => {
  it('single subscriber receives every event', () => {
    const s = new EventStream<DemoEvent>();
    const seen: DemoEvent[] = [];
    s.subscribe((e) => seen.push(e));
    s.emit({ kind: 'a', payload: 1 });
    s.emit({ kind: 'b', payload: 2 });
    expect(seen).toHaveLength(2);
  });

  it('multiple subscribers each receive', () => {
    const s = new EventStream<DemoEvent>();
    const a: DemoEvent[] = [];
    const b: DemoEvent[] = [];
    s.subscribe((e) => a.push(e));
    s.subscribe((e) => b.push(e));
    s.emit({ kind: 'a', payload: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('subscribe with non-function throws', () => {
    const s = new EventStream<DemoEvent>();
    expect(() => s.subscribe('x' as unknown as () => void)).toThrow(/function/);
  });

  it('subscribe with non-function filter throws', () => {
    const s = new EventStream<DemoEvent>();
    expect(() =>
      s.subscribe(() => {}, { filter: 'bogus' as unknown as () => boolean }),
    ).toThrow(/filter/);
  });

  it('size reflects active subscriptions', () => {
    const s = new EventStream<DemoEvent>();
    s.subscribe(() => {});
    const sub = s.subscribe(() => {});
    expect(s.size()).toBe(2);
    sub.unsubscribe();
    expect(s.size()).toBe(1);
  });
});

describe('EventStream — filter', () => {
  it('filter skips handler when returning false', () => {
    const s = new EventStream<DemoEvent>();
    const only: DemoEvent[] = [];
    s.subscribe((e) => only.push(e), { filter: (e) => e.kind === 'a' });
    s.emit({ kind: 'a', payload: 1 });
    s.emit({ kind: 'b', payload: 2 });
    expect(only).toHaveLength(1);
    expect(only[0]!.kind).toBe('a');
  });
});

describe('EventStream — unsubscribe', () => {
  it('unsubscribed handler stops receiving', () => {
    const s = new EventStream<DemoEvent>();
    const seen: DemoEvent[] = [];
    const sub = s.subscribe((e) => seen.push(e));
    s.emit({ kind: 'a', payload: 1 });
    sub.unsubscribe();
    s.emit({ kind: 'a', payload: 2 });
    expect(seen).toHaveLength(1);
  });

  it('unsubscribe is idempotent', () => {
    const s = new EventStream<DemoEvent>();
    const sub = s.subscribe(() => {});
    sub.unsubscribe();
    expect(() => sub.unsubscribe()).not.toThrow();
    expect(sub.active).toBe(false);
  });

  it('self-unsubscribe during emit does NOT affect current broadcast', () => {
    const s = new EventStream<DemoEvent>();
    const received: string[] = [];
    let sub1: { unsubscribe(): void };
    // handler A unsubscribes itself on first event
    sub1 = s.subscribe((e) => {
      received.push(`a:${e.payload}`);
      sub1.unsubscribe();
    });
    s.subscribe((e) => received.push(`b:${e.payload}`));
    s.emit({ kind: 'a', payload: 1 });
    s.emit({ kind: 'a', payload: 2 });
    // During first emit, A + B both received. Second emit only B.
    expect(received).toEqual(['a:1', 'b:1', 'b:2']);
  });
});

describe('EventStream — error isolation', () => {
  it('throwing handler does not prevent others', () => {
    const s = new EventStream<DemoEvent>();
    const b: DemoEvent[] = [];
    s.subscribe(() => { throw new Error('bad'); });
    s.subscribe((e) => b.push(e));
    s.emit({ kind: 'a', payload: 1 });
    expect(b).toHaveLength(1);
  });

  it('onError fires for thrown handlers', () => {
    const errors: unknown[] = [];
    const s = new EventStream<DemoEvent>({ onError: (e) => errors.push(e) });
    s.subscribe(() => { throw new Error('bad'); });
    s.emit({ kind: 'a', payload: 1 });
    expect(errors).toHaveLength(1);
  });

  it('emit with no subscribers is a no-op', () => {
    const s = new EventStream<DemoEvent>();
    expect(() => s.emit({ kind: 'a', payload: 1 })).not.toThrow();
  });
});

describe('EventStream.emitAsync', () => {
  it('awaits every async handler and returns delivered count', async () => {
    const s = new EventStream<DemoEvent>();
    const finished: number[] = [];
    s.subscribeAsync(async (e) => {
      await new Promise((r) => setTimeout(r, 10));
      finished.push(e.payload);
    });
    s.subscribeAsync(async (e) => {
      finished.push(e.payload * 10);
    });
    const result = await s.emitAsync({ kind: 'a', payload: 1 });
    expect(result).toEqual({ delivered: 2, failed: 0 });
    expect(finished.sort()).toEqual([1, 10]);
  });

  it('rejecting handler counts as failed + fires onError', async () => {
    const errors: unknown[] = [];
    const s = new EventStream<DemoEvent>({ onError: (e) => errors.push(e) });
    s.subscribeAsync(async () => { throw new Error('reject'); });
    s.subscribeAsync(async () => {});
    const r = await s.emitAsync({ kind: 'a', payload: 1 });
    expect(r).toEqual({ delivered: 1, failed: 1 });
    expect(errors).toHaveLength(1);
  });

  it('filter honoured in emitAsync', async () => {
    const s = new EventStream<DemoEvent>();
    let called = false;
    s.subscribeAsync(async () => { called = true; }, { filter: (e) => e.kind === 'b' });
    const r = await s.emitAsync({ kind: 'a', payload: 1 });
    expect(called).toBe(false);
    expect(r.delivered).toBe(0);
  });

  it('sync handlers also counted in emitAsync', async () => {
    const s = new EventStream<DemoEvent>();
    s.subscribe(() => {});
    const r = await s.emitAsync({ kind: 'a', payload: 1 });
    expect(r.delivered).toBe(1);
  });
});

describe('EventStream — clear', () => {
  it('clear drops every subscriber', () => {
    const s = new EventStream<DemoEvent>();
    const seen: DemoEvent[] = [];
    const sub = s.subscribe((e) => seen.push(e));
    s.clear();
    expect(s.size()).toBe(0);
    expect(sub.active).toBe(false);
    s.emit({ kind: 'a', payload: 1 });
    expect(seen).toHaveLength(0);
  });
});

describe('EventStream — typed payloads', () => {
  it('compile-time type safety (runtime check)', () => {
    const s = new EventStream<{ id: string }>();
    s.subscribe((e) => {
      // Compile-time: e.id is string. Runtime: check via typeof.
      expect(typeof e.id).toBe('string');
    });
    s.emit({ id: 'hi' });
  });
});
