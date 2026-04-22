/**
 * Task 4.23 — nonce-replay guard tests.
 */

import { NonceGuard, DEFAULT_NONCE_TTL_MS } from '../src/auth/nonce_guard';

const HOME_DID = 'did:plc:home';
const SENDER_A = 'did:plc:alice';
const SENDER_B = 'did:plc:bob';

describe('NonceGuard (task 4.23)', () => {
  it('accepts a first-sighting nonce', () => {
    const guard = new NonceGuard({ homeNodeDid: HOME_DID });
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: true });
  });

  it('rejects an immediate duplicate from the same sender', () => {
    const guard = new NonceGuard({ homeNodeDid: HOME_DID });
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: true });
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: false, reason: 'replay' });
  });

  it('same nonce from a different sender is accepted (per-sender scope)', () => {
    const guard = new NonceGuard({ homeNodeDid: HOME_DID });
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: true });
    // Different sender → different cache key.
    expect(guard.observe(SENDER_B, 'n1')).toEqual({ ok: true });
  });

  it('expired nonce is accepted again (ttl window)', () => {
    let now = 1_000_000;
    const guard = new NonceGuard({
      homeNodeDid: HOME_DID,
      ttlMs: 1000,
      nowMsFn: () => now,
    });
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: true });
    now += 500;
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: false, reason: 'replay' });
    now += 10_000; // way past TTL
    expect(guard.observe(SENDER_A, 'n1')).toEqual({ ok: true });
  });

  it('rejects empty homeNodeDid at construction', () => {
    expect(() => new NonceGuard({ homeNodeDid: '' })).toThrow(/homeNodeDid is required/);
  });

  it('rejects undefined-like homeNodeDid', () => {
    // @ts-expect-error — explicit missing to exercise the runtime guard
    expect(() => new NonceGuard({})).toThrow(/homeNodeDid is required/);
  });

  it('size + clear reflect cache state', () => {
    const guard = new NonceGuard({ homeNodeDid: HOME_DID });
    expect(guard.size()).toBe(0);
    guard.observe(SENDER_A, 'n1');
    guard.observe(SENDER_A, 'n2');
    guard.observe(SENDER_B, 'n1');
    expect(guard.size()).toBe(3);
    guard.clear();
    expect(guard.size()).toBe(0);
  });

  it('re-exports DEFAULT_NONCE_TTL_MS = 5 min (matches timestamp window)', () => {
    expect(DEFAULT_NONCE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('honours maxEntries eviction', () => {
    const guard = new NonceGuard({ homeNodeDid: HOME_DID, maxEntries: 3 });
    guard.observe(SENDER_A, 'n1');
    guard.observe(SENDER_A, 'n2');
    guard.observe(SENDER_A, 'n3');
    guard.observe(SENDER_A, 'n4'); // triggers eviction of oldest
    expect(guard.size()).toBeLessThanOrEqual(3);
  });
});
