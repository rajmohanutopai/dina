/**
 * sync_event_log tests.
 */

import {
  DEFAULT_MAX_RETAINED,
  SyncEventLog,
  type SinceResult,
} from '../src/brain/sync_event_log';

class Clock {
  private t = 1_000;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
}

describe('SyncEventLog — construction', () => {
  it('DEFAULT_MAX_RETAINED is 10_000', () => {
    expect(DEFAULT_MAX_RETAINED).toBe(10_000);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fraction', 1.5],
  ] as const)('rejects %s maxRetained', (_l, bad) => {
    expect(() => new SyncEventLog({ maxRetained: bad })).toThrow(/maxRetained/);
  });

  it('new log is empty', () => {
    const log = new SyncEventLog();
    expect(log.size()).toBe(0);
    expect(log.tailSeq()).toBe(0);
    expect(log.earliestRetainedSeq()).toBe(0);
  });
});

describe('SyncEventLog — append', () => {
  it('assigns monotonic sequence starting at 1', () => {
    const log = new SyncEventLog();
    expect(log.append({ topic: 'vault', kind: 'created', payload: { id: 'v1' } })).toBe(1);
    expect(log.append({ topic: 'vault', kind: 'updated', payload: { id: 'v1' } })).toBe(2);
    expect(log.append({ topic: 'contact', kind: 'created', payload: { id: 'c1' } })).toBe(3);
    expect(log.tailSeq()).toBe(3);
    expect(log.size()).toBe(3);
  });

  it('uses injected clock for ts when not supplied', () => {
    const clock = new Clock();
    const log = new SyncEventLog({ nowMsFn: clock.now });
    log.append({ topic: 'v', kind: 'x', payload: {} });
    clock.advance(500);
    log.append({ topic: 'v', kind: 'y', payload: {} });
    const all = log.tail(10);
    expect(all[0]!.ts).toBe(1_000);
    expect(all[1]!.ts).toBe(1_500);
  });

  it('uses explicit ts override when provided', () => {
    const log = new SyncEventLog({ nowMsFn: () => 9 });
    log.append({ topic: 'v', kind: 'x', payload: {}, ts: 42 });
    expect(log.tail(1)[0]!.ts).toBe(42);
  });

  it.each([
    ['null input', null],
    ['empty topic', { topic: '', kind: 'k', payload: {} }],
    ['empty kind', { topic: 't', kind: '', payload: {} }],
    ['non-finite ts', { topic: 't', kind: 'k', payload: {}, ts: Number.POSITIVE_INFINITY }],
  ] as const)('throws on %s', (_l, bad) => {
    const log = new SyncEventLog();
    expect(() =>
      log.append(bad as unknown as Parameters<typeof log.append>[0]),
    ).toThrow();
  });
});

describe('SyncEventLog — since()', () => {
  it('cursor 0 returns all events', () => {
    const log = new SyncEventLog();
    log.append({ topic: 't', kind: 'a', payload: 1 });
    log.append({ topic: 't', kind: 'b', payload: 2 });
    const r = log.since(0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(r.tailSeq).toBe(2);
    }
  });

  it('cursor at tailSeq returns empty list (all caught up)', () => {
    const log = new SyncEventLog();
    log.append({ topic: 't', kind: 'x', payload: 0 });
    log.append({ topic: 't', kind: 'y', payload: 0 });
    const r = log.since(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.events).toHaveLength(0);
  });

  it('filters by topic when supplied', () => {
    const log = new SyncEventLog();
    log.append({ topic: 'vault', kind: 'x', payload: 1 });
    log.append({ topic: 'contact', kind: 'x', payload: 2 });
    log.append({ topic: 'vault', kind: 'y', payload: 3 });
    const r = log.since(0, 'vault');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.events.map((e) => e.kind)).toEqual(['x', 'y']);
    }
  });

  it.each([
    ['negative', -1],
    ['fraction', 1.5],
  ] as const)('throws on %s cursor', (_l, bad) => {
    const log = new SyncEventLog();
    expect(() => log.since(bad)).toThrow(/cursor/);
  });

  it('empty log + non-zero cursor → ok with empty events', () => {
    const log = new SyncEventLog();
    const r = log.since(5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.events).toEqual([]);
  });

  it('cursor behind retention horizon → cursor_behind_retention', () => {
    const log = new SyncEventLog({ maxRetained: 3 });
    for (let i = 0; i < 10; i++) {
      log.append({ topic: 't', kind: 'x', payload: i });
    }
    // First event is seq=8 (after 7 evictions). Cursor=3 is behind.
    const r = log.since(3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cursor_behind_retention');
      expect(r.earliestRetainedSeq).toBe(8);
      expect(r.tailSeq).toBe(10);
    }
  });

  it('cursor = tailSeq always returns ok even if behind retention', () => {
    const log = new SyncEventLog({ maxRetained: 3 });
    for (let i = 0; i < 10; i++) {
      log.append({ topic: 't', kind: 'x', payload: i });
    }
    // Client caught up fully — no stale-cursor error.
    const r = log.since(10);
    expect(r.ok).toBe(true);
  });
});

describe('SyncEventLog — retention', () => {
  it('ring evicts oldest when maxRetained exceeded', () => {
    const log = new SyncEventLog({ maxRetained: 3 });
    for (let i = 1; i <= 5; i++) {
      log.append({ topic: 't', kind: 'x', payload: i });
    }
    expect(log.size()).toBe(3);
    expect(log.earliestRetainedSeq()).toBe(3);
    expect(log.tailSeq()).toBe(5);
    // tail returns the retained ones, newest-last.
    const t = log.tail(10);
    expect(t.map((e) => e.payload)).toEqual([3, 4, 5]);
  });
});

describe('SyncEventLog — tail()', () => {
  it('returns last N events', () => {
    const log = new SyncEventLog();
    for (let i = 1; i <= 5; i++) {
      log.append({ topic: 't', kind: 'x', payload: i });
    }
    expect(log.tail(2).map((e) => e.payload)).toEqual([4, 5]);
  });

  it('default limit 20', () => {
    const log = new SyncEventLog();
    for (let i = 1; i <= 25; i++) {
      log.append({ topic: 't', kind: 'x', payload: i });
    }
    expect(log.tail()).toHaveLength(20);
  });

  it('filters by topic', () => {
    const log = new SyncEventLog();
    log.append({ topic: 'a', kind: 'x', payload: 1 });
    log.append({ topic: 'b', kind: 'x', payload: 2 });
    log.append({ topic: 'a', kind: 'x', payload: 3 });
    expect(log.tail(10, 'a').map((e) => e.payload)).toEqual([1, 3]);
  });

  it('limit 0 returns empty', () => {
    const log = new SyncEventLog();
    log.append({ topic: 't', kind: 'x', payload: 1 });
    expect(log.tail(0)).toEqual([]);
  });

  it.each([
    ['negative', -1],
    ['fraction', 1.5],
  ] as const)('throws on %s limit', (_l, bad) => {
    const log = new SyncEventLog();
    expect(() => log.tail(bad)).toThrow(/limit/);
  });
});

describe('SyncEventLog — compact()', () => {
  it('drops events at or below the cursor', () => {
    const log = new SyncEventLog();
    for (let i = 1; i <= 5; i++) {
      log.append({ topic: 't', kind: 'x', payload: i });
    }
    const dropped = log.compact(3);
    expect(dropped).toBe(3);
    expect(log.size()).toBe(2);
    expect(log.earliestRetainedSeq()).toBe(4);
  });

  it('compact(0) is a no-op', () => {
    const log = new SyncEventLog();
    log.append({ topic: 't', kind: 'x', payload: 1 });
    expect(log.compact(0)).toBe(0);
    expect(log.size()).toBe(1);
  });

  it('throws on negative cursor', () => {
    const log = new SyncEventLog();
    expect(() => log.compact(-1)).toThrow(/beforeCursor/);
  });
});

describe('SyncEventLog — reset()', () => {
  it('clears events and resets sequence', () => {
    const log = new SyncEventLog();
    log.append({ topic: 't', kind: 'x', payload: 1 });
    log.append({ topic: 't', kind: 'x', payload: 2 });
    expect(log.tailSeq()).toBe(2);
    log.reset();
    expect(log.size()).toBe(0);
    expect(log.tailSeq()).toBe(0);
    // Next append starts at 1 again.
    expect(log.append({ topic: 't', kind: 'x', payload: 1 })).toBe(1);
  });
});

describe('SyncEventLog — snapshotCursor()', () => {
  it('returns the current tail sequence', () => {
    const log = new SyncEventLog();
    log.append({ topic: 't', kind: 'x', payload: 0 });
    log.append({ topic: 't', kind: 'x', payload: 0 });
    expect(log.snapshotCursor()).toBe(2);
  });
});

describe('SyncEventLog — end-to-end client pattern', () => {
  it('append-on-server, since-from-client, catch up, ack cursor', () => {
    const log = new SyncEventLog<{ id: string }>();
    // Server appends a burst.
    log.append({ topic: 'vault', kind: 'created', payload: { id: 'v1' } });
    log.append({ topic: 'vault', kind: 'updated', payload: { id: 'v1' } });
    // Client connects with cursor 0 → gets both.
    const first = log.since(0) as Extract<SinceResult<{ id: string }>, { ok: true }>;
    expect(first.events.length).toBe(2);
    const clientCursor = first.tailSeq;
    expect(clientCursor).toBe(2);
    // Server appends more.
    log.append({ topic: 'contact', kind: 'created', payload: { id: 'c1' } });
    // Client resumes from its cursor — gets only the new one.
    const second = log.since(clientCursor) as Extract<SinceResult<{ id: string }>, { ok: true }>;
    expect(second.events.length).toBe(1);
    expect(second.events[0]!.topic).toBe('contact');
  });
});
