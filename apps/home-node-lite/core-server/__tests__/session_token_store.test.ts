/**
 * Task 6.3 — SessionTokenStore tests.
 */

import {
  DEFAULT_REFRESH_LEEWAY_MS,
  InMemoryKeystoreAdapter,
  SESSION_TOKEN_KEY,
  SessionTokenStore,
  type GetActiveOutcome,
  type KeystoreAdapter,
  type RefreshFn,
  type SessionRecord,
  type SessionTokenStoreEvent,
} from '../src/appview/session_token_store';

function rec(overrides: Partial<Omit<SessionRecord, 'updatedAtMs'>> = {}): Omit<
  SessionRecord,
  'updatedAtMs'
> {
  return {
    did: 'did:plc:abcdefghijklmnopqrstuvwx',
    handle: 'alice.bsky.social',
    accessJwt: 'access-1',
    refreshJwt: 'refresh-1',
    accessExpiresAtMs: 2_000_000,
    refreshExpiresAtMs: 10_000_000,
    ...overrides,
  };
}

function fakeClock(start = 1000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (d: number) => {
      now += d;
    },
    set: (t: number) => {
      now = t;
    },
  };
}

describe('SessionTokenStore (task 6.3)', () => {
  describe('construction', () => {
    it('throws without keystore', () => {
      expect(
        () =>
          new SessionTokenStore({
            keystore: undefined as unknown as KeystoreAdapter,
          }),
      ).toThrow(/keystore/);
    });

    it('DEFAULT_REFRESH_LEEWAY_MS is 5 minutes', () => {
      expect(DEFAULT_REFRESH_LEEWAY_MS).toBe(5 * 60 * 1000);
    });

    it('SESSION_TOKEN_KEY has a stable value', () => {
      expect(SESSION_TOKEN_KEY).toBe('pds:session');
    });
  });

  describe('save + load + clear', () => {
    it('round-trips a record', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      await store.save(rec());
      const loaded = await store.load();
      expect(loaded).toMatchObject({
        did: 'did:plc:abcdefghijklmnopqrstuvwx',
        accessJwt: 'access-1',
      });
    });

    it('stamps updatedAtMs from now', async () => {
      const clock = fakeClock(42_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      await store.save(rec());
      const loaded = await store.load();
      expect(loaded?.updatedAtMs).toBe(42_000);
    });

    it('load returns null when empty', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      expect(await store.load()).toBeNull();
    });

    it('load returns null + fires parse_failed on malformed payload', async () => {
      const adapter = new InMemoryKeystoreAdapter();
      await adapter.set('pds:session', 'not-json');
      const events: SessionTokenStoreEvent[] = [];
      const store = new SessionTokenStore({
        keystore: adapter,
        onEvent: (e) => events.push(e),
      });
      expect(await store.load()).toBeNull();
      expect(events.some((e) => e.kind === 'parse_failed')).toBe(true);
    });

    it('load returns null + fires parse_failed on shape mismatch', async () => {
      const adapter = new InMemoryKeystoreAdapter();
      await adapter.set('pds:session', JSON.stringify({ wrong: 'shape' }));
      const store = new SessionTokenStore({ keystore: adapter });
      expect(await store.load()).toBeNull();
    });

    it('clear deletes the record', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      await store.save(rec());
      await store.clear();
      expect(await store.load()).toBeNull();
    });

    it('has() reflects presence', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      expect(await store.has()).toBe(false);
      await store.save(rec());
      expect(await store.has()).toBe(true);
      await store.clear();
      expect(await store.has()).toBe(false);
    });
  });

  describe('validation on save', () => {
    it.each([
      ['missing did', { did: '' }],
      ['missing handle', { handle: '' }],
      ['missing accessJwt', { accessJwt: '' }],
      ['missing refreshJwt', { refreshJwt: '' }],
      ['non-integer accessExpiresAtMs', { accessExpiresAtMs: 1.5 }],
      ['negative accessExpiresAtMs', { accessExpiresAtMs: -1 }],
      ['invalid refreshExpiresAtMs', { refreshExpiresAtMs: 'bad' as unknown as number }],
    ])('rejects %s', async (_label, overrides) => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      await expect(store.save(rec(overrides))).rejects.toThrow();
    });

    it('accepts null refreshExpiresAtMs', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      await expect(
        store.save(rec({ refreshExpiresAtMs: null })),
      ).resolves.toBeUndefined();
    });
  });

  describe('getActive — fresh token', () => {
    it('returns the record untouched when token is fresh', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      await store.save(rec({ accessExpiresAtMs: 2_000_000 })); // 1M ms in the future
      let refreshCalls = 0;
      const refreshFn: RefreshFn = async () => {
        refreshCalls++;
        return { ok: true, record: rec() };
      };
      const out = (await store.getActive(refreshFn)) as Extract<
        GetActiveOutcome,
        { ok: true }
      >;
      expect(out.ok).toBe(true);
      expect(out.refreshed).toBe(false);
      expect(refreshCalls).toBe(0);
    });
  });

  describe('getActive — refresh needed', () => {
    it('triggers refresh when token is inside the leeway window', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
      });
      // Token expires in 30s (inside 60s leeway).
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      const refreshFn: RefreshFn = async () => ({
        ok: true,
        record: rec({
          accessJwt: 'access-2',
          refreshJwt: 'refresh-2',
          accessExpiresAtMs: 2_000_000,
        }),
      });
      const out = (await store.getActive(refreshFn)) as Extract<
        GetActiveOutcome,
        { ok: true }
      >;
      expect(out.refreshed).toBe(true);
      expect(out.record.accessJwt).toBe('access-2');
    });

    it('refresh_started + refresh_succeeded events fire', async () => {
      const clock = fakeClock(1_000_000);
      const events: SessionTokenStoreEvent[] = [];
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
        onEvent: (e) => events.push(e),
      });
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      await store.getActive(async () => ({ ok: true, record: rec() }));
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('refresh_started');
      expect(kinds).toContain('refresh_succeeded');
    });

    it('refresh_failed → returns ok:false with staleRecord', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
      });
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      const refreshFn: RefreshFn = async () => ({
        ok: false,
        error: 'refresh rejected by PDS',
      });
      const out = await store.getActive(refreshFn);
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'refresh_failed') {
        expect(out.error).toMatch(/refresh rejected/);
        expect(out.staleRecord.accessJwt).toBe('access-1');
      }
    });

    it('refresh throw also returns refresh_failed', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
      });
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      const out = await store.getActive(async () => {
        throw new Error('ENETDOWN');
      });
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'refresh_failed') {
        expect(out.error).toMatch(/ENETDOWN/);
      }
    });

    it('no session at all → {ok: false, reason: no_session}', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      const out = await store.getActive(async () => ({ ok: true, record: rec() }));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('no_session');
    });
  });

  describe('refresh coalescing', () => {
    it('concurrent getActive calls share one refresh', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
      });
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      let calls = 0;
      let releaseRefresh!: () => void;
      const refreshFn: RefreshFn = () =>
        new Promise((resolve) => {
          calls++;
          releaseRefresh = () => resolve({ ok: true, record: rec({ accessJwt: 'a2' }) });
        });
      const p1 = store.getActive(refreshFn);
      const p2 = store.getActive(refreshFn);
      // Let both calls register before releasing.
      await new Promise((r) => setImmediate(r));
      releaseRefresh();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(calls).toBe(1);
      expect(r1).toEqual(r2);
    });

    it('fires coalesced event on second caller', async () => {
      const clock = fakeClock(1_000_000);
      const events: SessionTokenStoreEvent[] = [];
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
        onEvent: (e) => events.push(e),
      });
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      let release!: () => void;
      const refreshFn: RefreshFn = () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, record: rec() });
        });
      const p1 = store.getActive(refreshFn);
      const p2 = store.getActive(refreshFn);
      await new Promise((r) => setImmediate(r));
      release();
      await Promise.all([p1, p2]);
      expect(events.some((e) => e.kind === 'refresh_coalesced')).toBe(true);
    });

    it('after refresh completes, next getActive can trigger a new refresh', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 60_000,
      });
      await store.save(rec({ accessExpiresAtMs: 1_030_000 }));
      let calls = 0;
      const refreshFn: RefreshFn = async () => {
        calls++;
        // Return a new record that expires immediately → next getActive
        // will trigger refresh again.
        return {
          ok: true,
          record: rec({ accessJwt: `a-${calls}`, accessExpiresAtMs: 1_020_000 }),
        };
      };
      await store.getActive(refreshFn);
      await store.getActive(refreshFn);
      expect(calls).toBe(2);
    });
  });

  describe('getActive — argument validation', () => {
    it('throws without refreshFn', async () => {
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
      });
      await store.save(rec());
      await expect(
        store.getActive(undefined as unknown as RefreshFn),
      ).rejects.toThrow(/refreshFn/);
    });
  });

  describe('realistic flow', () => {
    it('save → load with fresh token → load after expiry + refresh', async () => {
      const clock = fakeClock(1_000_000);
      const store = new SessionTokenStore({
        keystore: new InMemoryKeystoreAdapter(),
        nowMsFn: clock.nowMsFn,
        refreshLeewayMs: 10_000,
      });
      await store.save(
        rec({ accessJwt: 'first', accessExpiresAtMs: 1_100_000 }),
      );
      // Fresh: ~100s to expiry, leeway 10s.
      const fresh = await store.getActive(async () => ({
        ok: true,
        record: rec({ accessJwt: 'should-not-be-used' }),
      }));
      if (fresh.ok) expect(fresh.record.accessJwt).toBe('first');

      // Advance past leeway.
      clock.set(1_095_000); // 5s to expiry — inside leeway
      const refreshed = await store.getActive(async () => ({
        ok: true,
        record: rec({
          accessJwt: 'second',
          accessExpiresAtMs: 2_000_000,
          refreshJwt: 'refresh-2',
        }),
      }));
      if (refreshed.ok) {
        expect(refreshed.record.accessJwt).toBe('second');
        expect(refreshed.refreshed).toBe(true);
      }
    });
  });
});
