/**
 * CORE-P0-009 — Idempotency cache tests.
 */

import { IdempotencyCache, DEFAULT_IDEMPOTENCY_TTL_MS } from '../../src/rpc/idempotency_cache';
import type { RPCInnerResponse } from '../../src/rpc/types';

function makeResponse(body: string): RPCInnerResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(body),
  };
}

function fakeClock() {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('IdempotencyCache — construction', () => {
  it('default TTL is 5 minutes', () => {
    expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('rejects non-positive ttlMs', () => {
    expect(() => new IdempotencyCache({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => new IdempotencyCache({ ttlMs: -1 })).toThrow(/ttlMs/);
  });

  it('rejects non-positive maxEntries', () => {
    expect(() => new IdempotencyCache({ maxEntries: 0 })).toThrow(/maxEntries/);
  });
});

describe('IdempotencyCache — get / put', () => {
  it('returns null on miss', () => {
    const c = new IdempotencyCache();
    expect(c.get('did:plc:a', 'req-1')).toBeNull();
  });

  it('returns the stored response on hit', () => {
    const c = new IdempotencyCache();
    const res = makeResponse('{"ok":true}');
    c.put('did:plc:a', 'req-1', res);
    expect(c.get('did:plc:a', 'req-1')).toBe(res);
  });

  it('isolates entries by (senderDid, requestId) tuple', () => {
    const c = new IdempotencyCache();
    c.put('did:plc:a', 'req-1', makeResponse('{"a":1}'));
    c.put('did:plc:b', 'req-1', makeResponse('{"b":2}'));
    c.put('did:plc:a', 'req-2', makeResponse('{"a2":1}'));
    expect(new TextDecoder().decode(c.get('did:plc:a', 'req-1')!.body)).toBe('{"a":1}');
    expect(new TextDecoder().decode(c.get('did:plc:b', 'req-1')!.body)).toBe('{"b":2}');
    expect(new TextDecoder().decode(c.get('did:plc:a', 'req-2')!.body)).toBe('{"a2":1}');
    expect(c.size()).toBe(3);
  });

  it('guards against key-collision via delimiter (NUL byte)', () => {
    // A naive `${a}:${b}` key would collide for `did:plc:a:rq=1` (sender=a, req=:1)
    // vs (sender=a:rq, req=1). Using NUL prevents the collision.
    const c = new IdempotencyCache();
    c.put('did:plc:a', ':1', makeResponse('{"x":1}'));
    c.put('did:plc:a:', '1', makeResponse('{"y":2}'));
    expect(new TextDecoder().decode(c.get('did:plc:a', ':1')!.body)).toBe('{"x":1}');
    expect(new TextDecoder().decode(c.get('did:plc:a:', '1')!.body)).toBe('{"y":2}');
  });
});

describe('IdempotencyCache — expiration', () => {
  it('treats past-deadline entries as absent', () => {
    const clock = fakeClock();
    const c = new IdempotencyCache({ nowMsFn: clock.now, ttlMs: 1_000 });
    c.put('did:plc:a', 'req-1', makeResponse('{}'));
    expect(c.get('did:plc:a', 'req-1')).not.toBeNull();
    clock.advance(1_001);
    expect(c.get('did:plc:a', 'req-1')).toBeNull();
  });

  it('expires entry exactly at ttlMs (strict <= check)', () => {
    const clock = fakeClock();
    const c = new IdempotencyCache({ nowMsFn: clock.now, ttlMs: 1_000 });
    c.put('did:plc:a', 'req-1', makeResponse('{}'));
    clock.advance(1_000);
    expect(c.get('did:plc:a', 'req-1')).toBeNull();
  });

  it('lazy-drops expired entries on miss (size shrinks)', () => {
    const clock = fakeClock();
    const c = new IdempotencyCache({ nowMsFn: clock.now, ttlMs: 1_000 });
    c.put('did:plc:a', 'req-1', makeResponse('{}'));
    clock.advance(1_001);
    c.get('did:plc:a', 'req-1'); // triggers lazy-drop
    expect(c.size()).toBe(0);
  });
});

describe('IdempotencyCache — overflow eviction', () => {
  it('evicts oldest entries when maxEntries exceeded', () => {
    const clock = fakeClock();
    const c = new IdempotencyCache({
      nowMsFn: clock.now,
      ttlMs: 60_000,
      maxEntries: 3,
    });
    c.put('did:a', '1', makeResponse('1'));
    c.put('did:a', '2', makeResponse('2'));
    c.put('did:a', '3', makeResponse('3'));
    c.put('did:a', '4', makeResponse('4')); // triggers eviction
    expect(c.size()).toBe(3);
    expect(c.get('did:a', '1')).toBeNull(); // oldest evicted
    expect(c.get('did:a', '4')).not.toBeNull();
  });
});

describe('IdempotencyCache — clear', () => {
  it('drops all entries', () => {
    const c = new IdempotencyCache();
    c.put('did:a', '1', makeResponse('1'));
    c.put('did:b', '2', makeResponse('2'));
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
  });
});
