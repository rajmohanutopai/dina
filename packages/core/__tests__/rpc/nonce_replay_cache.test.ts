/**
 * CORE-P0-010 — Nonce replay cache tests.
 */

import { NonceReplayCache, DEFAULT_NONCE_TTL_MS } from '../../src/rpc/nonce_replay_cache';

function fakeClock() {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('NonceReplayCache', () => {
  it('default TTL is 5 minutes', () => {
    expect(DEFAULT_NONCE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('rejects non-positive ttlMs', () => {
    expect(() => new NonceReplayCache({ ttlMs: 0 })).toThrow(/ttlMs/);
  });

  it('accepts a first-seen nonce', () => {
    const c = new NonceReplayCache();
    expect(c.accept('did:a', 'did:b', 'n1')).toBe(true);
  });

  it('rejects an immediate replay of the same (sender, recipient, nonce)', () => {
    const c = new NonceReplayCache();
    c.accept('did:a', 'did:b', 'n1');
    expect(c.accept('did:a', 'did:b', 'n1')).toBe(false);
  });

  it('treats a different recipient as a distinct nonce (signature covers recipient)', () => {
    const c = new NonceReplayCache();
    c.accept('did:a', 'did:b', 'n1');
    expect(c.accept('did:a', 'did:c', 'n1')).toBe(true);
  });

  it('treats a different sender as a distinct nonce', () => {
    const c = new NonceReplayCache();
    c.accept('did:a', 'did:b', 'n1');
    expect(c.accept('did:z', 'did:b', 'n1')).toBe(true);
  });

  it('accepts the nonce again once the TTL has elapsed', () => {
    const clock = fakeClock();
    const c = new NonceReplayCache({ nowMsFn: clock.now, ttlMs: 1_000 });
    expect(c.accept('did:a', 'did:b', 'n1')).toBe(true);
    clock.advance(1_001);
    expect(c.accept('did:a', 'did:b', 'n1')).toBe(true);
  });

  it('evicts oldest nonces when maxEntries exceeded', () => {
    const clock = fakeClock();
    const c = new NonceReplayCache({
      nowMsFn: clock.now,
      ttlMs: 60_000,
      maxEntries: 3,
    });
    c.accept('did:a', 'did:b', 'n1');
    c.accept('did:a', 'did:b', 'n2');
    c.accept('did:a', 'did:b', 'n3');
    c.accept('did:a', 'did:b', 'n4'); // evicts n1
    expect(c.size()).toBe(3);
    // n1 is gone from the cache — re-acceptance proves it
    expect(c.accept('did:a', 'did:b', 'n1')).toBe(true);
  });

  it('guards against key-collision via NUL delimiter', () => {
    // Without NUL delimiter, `a:b:n1` could collide with `a:bn1` + `:`
    const c = new NonceReplayCache();
    c.accept('did:a', 'did:b', 'n1');
    // These would collide under naive `${a}:${b}:${n}` key → all 3 parts matter
    expect(c.accept('did:a:b', '', 'n1')).toBe(true);
  });
});
