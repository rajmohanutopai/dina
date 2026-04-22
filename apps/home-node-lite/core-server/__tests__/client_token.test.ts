/**
 * Task 4.25 — CLIENT_TOKEN bearer auth tests.
 */

import {
  extractBearerToken,
  InMemoryClientTokenStore,
  authenticateBearer,
} from '../src/auth/client_token';

describe('extractBearerToken (task 4.25)', () => {
  it('extracts a plain Bearer token', () => {
    expect(extractBearerToken('Bearer abc123xyz')).toEqual({
      ok: true,
      token: 'abc123xyz',
    });
  });

  it('accepts case-insensitive scheme', () => {
    expect(extractBearerToken('bearer abc')).toEqual({ ok: true, token: 'abc' });
    expect(extractBearerToken('BEARER abc')).toEqual({ ok: true, token: 'abc' });
    expect(extractBearerToken('BeArEr abc')).toEqual({ ok: true, token: 'abc' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractBearerToken('  Bearer abc  ')).toEqual({ ok: true, token: 'abc' });
    expect(extractBearerToken('Bearer\tabc')).toEqual({ ok: true, token: 'abc' });
  });

  it('rejects undefined / null / empty as missing', () => {
    expect(extractBearerToken(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(extractBearerToken(null)).toEqual({ ok: false, reason: 'missing' });
    expect(extractBearerToken('')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects non-Bearer schemes as malformed', () => {
    expect(extractBearerToken('Basic abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(extractBearerToken('Token abc')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects Bearer with no token as malformed', () => {
    expect(extractBearerToken('Bearer')).toEqual({ ok: false, reason: 'malformed' });
    expect(extractBearerToken('Bearer ')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('InMemoryClientTokenStore (task 4.25)', () => {
  it('validates a known token', async () => {
    const store = new InMemoryClientTokenStore();
    await store.add('secret-1', { deviceLabel: 'phone' });
    const res = await store.validate('secret-1');
    expect(res).toEqual({ ok: true, deviceLabel: 'phone' });
  });

  it('rejects an unknown token', async () => {
    const store = new InMemoryClientTokenStore();
    await store.add('secret-1', { deviceLabel: 'phone' });
    expect(await store.validate('not-registered')).toEqual({
      ok: false,
      reason: 'unknown_token',
    });
  });

  it('rejects an empty token as missing', async () => {
    const store = new InMemoryClientTokenStore();
    expect(await store.validate('')).toEqual({ ok: false, reason: 'missing' });
  });

  it('different raw tokens produce different hashes (collision resistance)', async () => {
    const store = new InMemoryClientTokenStore();
    await store.add('alpha', { deviceLabel: 'a' });
    await store.add('beta', { deviceLabel: 'b' });
    expect(await store.validate('alpha')).toEqual({ ok: true, deviceLabel: 'a' });
    expect(await store.validate('beta')).toEqual({ ok: true, deviceLabel: 'b' });
    // A sibling string whose SHA-256 differs must not accidentally match.
    expect((await store.validate('alphas')).ok).toBe(false);
  });

  it('revoke removes a token', async () => {
    const store = new InMemoryClientTokenStore();
    await store.add('secret-1', { deviceLabel: 'phone' });
    expect(await store.revoke('secret-1')).toBe(true);
    expect(await store.validate('secret-1')).toEqual({
      ok: false,
      reason: 'unknown_token',
    });
  });

  it('revoke of an unknown token returns false', async () => {
    const store = new InMemoryClientTokenStore();
    expect(await store.revoke('nothing-here')).toBe(false);
  });

  describe('expiry', () => {
    it('accepts a token before its expiry', async () => {
      let now = 1_000_000;
      const store = new InMemoryClientTokenStore({ nowMsFn: () => now });
      await store.add('live', { deviceLabel: 'p', expiresAtMs: 2_000_000 });
      const res = await store.validate('live');
      expect(res).toEqual({ ok: true, deviceLabel: 'p' });
    });

    it('rejects a token after its expiry', async () => {
      let now = 1_000_000;
      const store = new InMemoryClientTokenStore({ nowMsFn: () => now });
      await store.add('soon-dead', { deviceLabel: 'p', expiresAtMs: 1_500_000 });
      now = 2_000_000;
      expect(await store.validate('soon-dead')).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('rejects a token exactly at its expiry (boundary: <=)', async () => {
      let now = 1_000_000;
      const store = new InMemoryClientTokenStore({ nowMsFn: () => now });
      await store.add('edge', { deviceLabel: 'p', expiresAtMs: 1_000_000 });
      expect(await store.validate('edge')).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('expiresAtMs = 0 means no expiry', async () => {
      let now = 10_000_000_000;
      const store = new InMemoryClientTokenStore({ nowMsFn: () => now });
      await store.add('forever', { deviceLabel: 'p', expiresAtMs: 0 });
      const res = await store.validate('forever');
      expect(res).toEqual({ ok: true, deviceLabel: 'p' });
    });

    it('undefined expiresAtMs means no expiry', async () => {
      let now = 10_000_000_000;
      const store = new InMemoryClientTokenStore({ nowMsFn: () => now });
      await store.add('forever', { deviceLabel: 'p' });
      const res = await store.validate('forever');
      expect(res.ok).toBe(true);
    });
  });

  describe('size + clear', () => {
    it('tracks size across add / revoke / clear', async () => {
      const store = new InMemoryClientTokenStore();
      expect(store.size()).toBe(0);
      await store.add('a', { deviceLabel: 'x' });
      await store.add('b', { deviceLabel: 'y' });
      expect(store.size()).toBe(2);
      await store.revoke('a');
      expect(store.size()).toBe(1);
      store.clear();
      expect(store.size()).toBe(0);
    });
  });
});

describe('authenticateBearer (task 4.25 one-shot)', () => {
  it('extracts + validates in a single call (happy path)', async () => {
    const store = new InMemoryClientTokenStore();
    await store.add('top-secret', { deviceLabel: 'admin-ui' });
    const res = await authenticateBearer('Bearer top-secret', store);
    expect(res).toEqual({ ok: true, deviceLabel: 'admin-ui' });
  });

  it('propagates extraction failures through', async () => {
    const store = new InMemoryClientTokenStore();
    expect(await authenticateBearer(undefined, store)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(await authenticateBearer('Basic xyz', store)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('extracted-but-unknown token rejects with unknown_token', async () => {
    const store = new InMemoryClientTokenStore();
    const res = await authenticateBearer('Bearer never-registered', store);
    expect(res).toEqual({ ok: false, reason: 'unknown_token' });
  });
});
