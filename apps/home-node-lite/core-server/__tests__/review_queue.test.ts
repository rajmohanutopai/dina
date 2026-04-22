/**
 * review_queue tests.
 */

import {
  DEFAULT_MAX_PENDING,
  DEFAULT_TTL_MS,
  ReviewQueue,
  type ReviewEvent,
} from '../src/brain/review_queue';

class Clock {
  private t = 0;
  now = (): number => this.t;
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

describe('ReviewQueue — construction', () => {
  it.each([
    ['zero maxPending', { maxPending: 0 }],
    ['negative maxPending', { maxPending: -1 }],
    ['fraction maxPending', { maxPending: 1.5 }],
    ['zero ttl', { defaultTtlMs: 0 }],
    ['negative ttl', { defaultTtlMs: -1 }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() => new ReviewQueue(bad)).toThrow();
  });

  it('defaults are 100 pending + 24h TTL', () => {
    expect(DEFAULT_MAX_PENDING).toBe(100);
    expect(DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('ReviewQueue.enqueue', () => {
  it('enqueue returns the item with generated id + pending status', () => {
    const clock = new Clock();
    clock.set(1000);
    const q = new ReviewQueue({ nowMsFn: clock.now });
    const item = q.enqueue({ payload: { x: 1 }, summary: 'Pay $5 to X' });
    expect(item.status).toBe('pending');
    expect(item.id).toMatch(/^rv-\d+$/);
    expect(item.enqueuedAtMs).toBe(1000);
    expect(item.resolvedAtMs).toBeNull();
    expect(item.expiresAtMs).toBe(1000 + DEFAULT_TTL_MS);
    expect(item.summary).toBe('Pay $5 to X');
  });

  it('caller-supplied id honoured', () => {
    const q = new ReviewQueue();
    const item = q.enqueue({ id: 'custom-1', payload: {}, summary: 'x' });
    expect(item.id).toBe('custom-1');
  });

  it('id collision throws', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'dup', payload: {}, summary: 'x' });
    expect(() =>
      q.enqueue({ id: 'dup', payload: {}, summary: 'y' }),
    ).toThrow(/collision/);
  });

  it('ttlMs override per entry', () => {
    const clock = new Clock();
    clock.set(1000);
    const q = new ReviewQueue({ nowMsFn: clock.now });
    const item = q.enqueue({ payload: {}, summary: 'x', ttlMs: 5000 });
    expect(item.expiresAtMs).toBe(6000);
  });

  it('risk echoed when present', () => {
    const q = new ReviewQueue();
    const item = q.enqueue({ payload: {}, summary: 'x', risk: 'pay' });
    expect(item.risk).toBe('pay');
  });

  it.each([
    ['null input', null],
    ['missing summary', { payload: {} }],
    ['empty summary', { payload: {}, summary: '   ' }],
    ['empty id when supplied', { payload: {}, summary: 'x', id: '' }],
  ] as const)('rejects %s', (_l, bad) => {
    const q = new ReviewQueue();
    expect(() =>
      q.enqueue(bad as unknown as Parameters<typeof q.enqueue>[0]),
    ).toThrow();
  });

  it('summary is trimmed', () => {
    const q = new ReviewQueue();
    const item = q.enqueue({ payload: {}, summary: '  hi  ' });
    expect(item.summary).toBe('hi');
  });

  it('enqueue emits enqueued event', () => {
    const events: ReviewEvent[] = [];
    const q = new ReviewQueue({ onEvent: (e) => events.push(e) });
    q.enqueue({ payload: {}, summary: 'x' });
    expect(events[0]!.kind).toBe('enqueued');
  });
});

describe('ReviewQueue.get / list', () => {
  it('get returns a defensive copy', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    const a = q.get('a')!;
    a.summary = 'hacked';
    expect(q.get('a')!.summary).toBe('x');
  });

  it('get unknown id → null', () => {
    const q = new ReviewQueue();
    expect(q.get('nope')).toBeNull();
  });

  it('list sorted most-recent-first', () => {
    const clock = new Clock();
    const q = new ReviewQueue({ nowMsFn: clock.now });
    clock.set(1);
    q.enqueue({ id: 'old', payload: {}, summary: '1' });
    clock.set(10);
    q.enqueue({ id: 'new', payload: {}, summary: '2' });
    const items = q.list();
    expect(items.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('list filters by status', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.enqueue({ id: 'b', payload: {}, summary: 'y' });
    q.approve('a');
    expect(q.list({ status: 'pending' }).map((i) => i.id)).toEqual(['b']);
    expect(q.list({ status: 'approved' }).map((i) => i.id)).toEqual(['a']);
  });

  it('list honours limit', () => {
    const q = new ReviewQueue();
    for (let i = 0; i < 5; i++) {
      q.enqueue({ id: `r${i}`, payload: {}, summary: `s${i}` });
    }
    expect(q.list({ limit: 2 })).toHaveLength(2);
  });
});

describe('ReviewQueue.approve / reject', () => {
  it('approve transitions pending → approved', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    const out = q.approve('a', 'looks good');
    expect(out!.status).toBe('approved');
    expect(out!.decisionNote).toBe('looks good');
    expect(out!.resolvedAtMs).not.toBeNull();
  });

  it('approve emits approved event', () => {
    const events: ReviewEvent[] = [];
    const q = new ReviewQueue({ onEvent: (e) => events.push(e) });
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.approve('a');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['enqueued', 'approved']);
  });

  it('reject transitions pending → rejected with reason', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    const out = q.reject('a', 'too risky');
    expect(out!.status).toBe('rejected');
    expect(out!.decisionNote).toBe('too risky');
  });

  it('reject requires non-empty reason', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    expect(() => q.reject('a', '')).toThrow(/reason/);
    expect(() => q.reject('a', '   ')).toThrow(/reason/);
  });

  it('approve on unknown id → null', () => {
    const q = new ReviewQueue();
    expect(q.approve('nope')).toBeNull();
  });

  it('approve twice → second call returns null (already terminal)', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    expect(q.approve('a')).not.toBeNull();
    expect(q.approve('a')).toBeNull();
  });

  it('approve after reject → null', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.reject('a', 'no');
    expect(q.approve('a')).toBeNull();
  });
});

describe('ReviewQueue — TTL expiry', () => {
  it('expired entries move to status=expired via cleanupExpired', () => {
    const clock = new Clock();
    clock.set(1000);
    const q = new ReviewQueue({ nowMsFn: clock.now, defaultTtlMs: 1000 });
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    clock.advance(2000);
    const dropped = q.cleanupExpired();
    expect(dropped).toBe(1);
    expect(q.get('a')!.status).toBe('expired');
  });

  it('cleanupExpired emits expired event with reason=ttl', () => {
    const clock = new Clock();
    clock.set(1000);
    const events: ReviewEvent[] = [];
    const q = new ReviewQueue({
      nowMsFn: clock.now,
      defaultTtlMs: 500,
      onEvent: (e) => events.push(e),
    });
    q.enqueue({ payload: {}, summary: 'x' });
    clock.advance(600);
    q.cleanupExpired();
    const exp = events.filter((e) => e.kind === 'expired')[0];
    expect(exp).toBeDefined();
    if (exp && exp.kind === 'expired') expect(exp.reason).toBe('ttl');
  });

  it('list() auto-runs cleanupExpired', () => {
    const clock = new Clock();
    clock.set(1000);
    const q = new ReviewQueue({ nowMsFn: clock.now, defaultTtlMs: 500 });
    q.enqueue({ payload: {}, summary: 'x' });
    clock.advance(600);
    const pending = q.list({ status: 'pending' });
    expect(pending).toHaveLength(0);
  });

  it('approved entries never auto-expire', () => {
    const clock = new Clock();
    clock.set(1000);
    const q = new ReviewQueue({ nowMsFn: clock.now, defaultTtlMs: 500 });
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.approve('a');
    clock.advance(1000);
    q.cleanupExpired();
    expect(q.get('a')!.status).toBe('approved');
  });
});

describe('ReviewQueue — capacity eviction', () => {
  it('over-capacity pending → oldest evicted as expired capacity_exceeded', () => {
    const events: ReviewEvent[] = [];
    const clock = new Clock();
    const q = new ReviewQueue({
      maxPending: 2,
      nowMsFn: clock.now,
      onEvent: (e) => events.push(e),
    });
    clock.set(1);
    q.enqueue({ id: 'a', payload: {}, summary: '1' });
    clock.set(2);
    q.enqueue({ id: 'b', payload: {}, summary: '2' });
    clock.set(3);
    q.enqueue({ id: 'c', payload: {}, summary: '3' });
    expect(q.get('a')!.status).toBe('expired');
    const exp = events.find(
      (e) => e.kind === 'expired' && (e as { reason: string }).reason === 'capacity_exceeded',
    );
    expect(exp).toBeDefined();
    expect(q.size(true)).toBe(2); // b + c still pending
  });

  it('approved entries don\'t count toward capacity', () => {
    const clock = new Clock();
    const q = new ReviewQueue({ maxPending: 2, nowMsFn: clock.now });
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.approve('a');
    q.enqueue({ id: 'b', payload: {}, summary: 'x' });
    q.enqueue({ id: 'c', payload: {}, summary: 'x' });
    expect(q.get('a')!.status).toBe('approved');
    expect(q.get('b')!.status).toBe('pending');
    expect(q.get('c')!.status).toBe('pending');
  });
});

describe('ReviewQueue — purge + clear', () => {
  it('purgeResolved drops approved + rejected + expired, keeps pending', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'keep', payload: {}, summary: 'x' });
    q.enqueue({ id: 'gone', payload: {}, summary: 'y' });
    q.approve('gone');
    const n = q.purgeResolved();
    expect(n).toBe(1);
    expect(q.get('keep')).not.toBeNull();
    expect(q.get('gone')).toBeNull();
  });

  it('clear empties everything', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.clear();
    expect(q.size()).toBe(0);
  });
});

describe('ReviewQueue — size', () => {
  it('size() returns total count', () => {
    const q = new ReviewQueue();
    q.enqueue({ id: 'a', payload: {}, summary: 'x' });
    q.enqueue({ id: 'b', payload: {}, summary: 'y' });
    q.approve('a');
    expect(q.size()).toBe(2);
    expect(q.size(true)).toBe(1);
  });
});
