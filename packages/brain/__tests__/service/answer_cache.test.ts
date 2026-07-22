/**
 * Tier-1 provider answer cache — the bounded/TTL/LRU store, the stable key
 * builder, and the process-wide singleton. Cost-control primitive: repeated
 * identical service queries share one cached answer within the freshness window.
 */

import {
  Tier1AnswerCache,
  answerCacheKey,
  stableStringify,
  getTier1AnswerCache,
  setTier1AnswerCache,
  resetTier1AnswerCache,
} from '../../src/service/answer_cache';

describe('Tier1AnswerCache', () => {
  it('returns a miss for an unknown key and a hit within the TTL', () => {
    let now = 1000;
    const cache = new Tier1AnswerCache({ nowMsFn: () => now });
    expect(cache.get('k')).toEqual({ hit: false });
    cache.set('k', { eta: 7 }, 5000);
    expect(cache.get('k')).toEqual({ hit: true, value: { eta: 7 } });
    now = 4999;
    expect(cache.get('k')).toEqual({ hit: true, value: { eta: 7 } });
  });

  it('expires an entry once the TTL elapses', () => {
    let now = 1000;
    const cache = new Tier1AnswerCache({ nowMsFn: () => now });
    cache.set('k', 'v', 5000);
    now = 1000 + 5000; // expiresAt is inclusive → miss
    expect(cache.get('k')).toEqual({ hit: false });
    expect(cache.size).toBe(0); // expired entry is dropped on read
  });

  it('treats a non-positive TTL as "do not cache"', () => {
    const cache = new Tier1AnswerCache({ nowMsFn: () => 0 });
    cache.set('k', 'v', 0);
    cache.set('k2', 'v', -1);
    expect(cache.get('k')).toEqual({ hit: false });
    expect(cache.size).toBe(0);
  });

  it('evicts the least-recently-used entry past maxEntries', () => {
    const cache = new Tier1AnswerCache({ nowMsFn: () => 0, maxEntries: 2 });
    cache.set('a', 1, 10_000);
    cache.set('b', 2, 10_000);
    cache.get('a'); // touch a → b is now LRU
    cache.set('c', 3, 10_000); // evicts b
    expect(cache.get('a')).toEqual({ hit: true, value: 1 });
    expect(cache.get('b')).toEqual({ hit: false });
    expect(cache.get('c')).toEqual({ hit: true, value: 3 });
  });
});

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it('recurses into nested objects and arrays', () => {
    expect(stableStringify({ x: { b: 1, a: 2 }, y: [3, { d: 4, c: 5 }] })).toBe(
      stableStringify({ y: [3, { c: 5, d: 4 }], x: { a: 2, b: 1 } }),
    );
  });
});

describe('answerCacheKey', () => {
  const base = { rkey: 'self', capability: 'eta_query', params: { route_id: '42' } };

  it('collapses param key-order differences to one key', () => {
    const k1 = answerCacheKey({ ...base, params: { route_id: '42', stop: 'Castro' } });
    const k2 = answerCacheKey({ ...base, params: { stop: 'Castro', route_id: '42' } });
    expect(k1).toBe(k2);
  });

  it('segregates by rkey, capability, params, schemaHash, and instructionUpdatedAt', () => {
    const k = answerCacheKey(base);
    expect(answerCacheKey({ ...base, rkey: 'other' })).not.toBe(k);
    expect(answerCacheKey({ ...base, capability: 'flight_status' })).not.toBe(k);
    expect(answerCacheKey({ ...base, params: { route_id: '99' } })).not.toBe(k);
    expect(answerCacheKey({ ...base, schemaHash: 'h1' })).not.toBe(k);
    expect(answerCacheKey({ ...base, instructionUpdatedAt: 123 })).not.toBe(k);
  });

  it('busts the key when the provider edits the instruction (instructionUpdatedAt)', () => {
    const before = answerCacheKey({ ...base, instructionUpdatedAt: 100 });
    const after = answerCacheKey({ ...base, instructionUpdatedAt: 200 });
    expect(before).not.toBe(after);
  });
});

describe('process-wide singleton', () => {
  afterEach(() => resetTier1AnswerCache());

  it('returns one shared instance until reset', () => {
    const a = getTier1AnswerCache();
    expect(getTier1AnswerCache()).toBe(a);
    resetTier1AnswerCache();
    expect(getTier1AnswerCache()).not.toBe(a);
  });

  it('honours an injected instance', () => {
    const injected = new Tier1AnswerCache({ nowMsFn: () => 0 });
    setTier1AnswerCache(injected);
    expect(getTier1AnswerCache()).toBe(injected);
  });
});
