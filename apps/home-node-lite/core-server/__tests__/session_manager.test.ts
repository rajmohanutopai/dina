/**
 * Task 6.2 — SessionManager tests.
 */

import {
  InMemoryKeystoreAdapter,
  SessionTokenStore,
  type SessionRecord,
} from '../src/appview/session_token_store';
import {
  SessionManager,
  type CreateAccountInput,
  type CreateSessionInput,
  type DeleteSessionOutcome,
  type PdsClientFn,
  type SessionManagerEvent,
  type SessionOutcome,
} from '../src/appview/session_manager';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    did: DID,
    handle: 'alice.bsky.social',
    accessJwt: 'access-1',
    refreshJwt: 'refresh-1',
    accessExpiresAtMs: 2_000_000,
    refreshExpiresAtMs: 10_000_000,
    ...overrides,
  };
}

function buildStore(): SessionTokenStore {
  return new SessionTokenStore({ keystore: new InMemoryKeystoreAdapter() });
}

function pds(
  results: Partial<Record<'createAccount' | 'createSession' | 'refreshSession' | 'deleteSession', {
    status: number;
    body: Record<string, unknown> | null;
  }>>,
): PdsClientFn {
  return async (kind) => {
    const entry = results[kind];
    if (!entry) {
      return { status: 500, body: { error: `no stub for ${kind}` } };
    }
    return entry;
  };
}

describe('SessionManager (task 6.2)', () => {
  describe('construction', () => {
    it('throws without pdsClient', () => {
      expect(() =>
        new SessionManager({
          pdsClient: undefined as unknown as PdsClientFn,
          tokenStore: buildStore(),
        }),
      ).toThrow(/pdsClient/);
    });

    it('throws without tokenStore', () => {
      expect(() =>
        new SessionManager({
          pdsClient: async () => ({ status: 200, body: null }),
          tokenStore: undefined as unknown as SessionTokenStore,
        }),
      ).toThrow(/tokenStore/);
    });
  });

  describe('createAccount', () => {
    const input: CreateAccountInput = {
      handle: 'alice.bsky.social',
      email: 'alice@example.com',
      password: 'hunter2',
    };

    it('200 → persists record + ok=true', async () => {
      const store = buildStore();
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: { status: 200, body: validBody() },
        }),
        tokenStore: store,
      });
      const out = (await mgr.createAccount(input)) as Extract<SessionOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.record.did).toBe(DID);
      expect(await store.has()).toBe(true);
    });

    it('409 with "taken" → account_exists', async () => {
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: { status: 409, body: { error: 'Handle is taken' } },
        }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createAccount(input);
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'account_exists') {
        expect(out.error).toMatch(/taken/);
      }
    });

    it('400 with "already" → account_exists', async () => {
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: {
            status: 400,
            body: { error: 'email already registered' },
          },
        }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createAccount(input);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('account_exists');
    });

    it('other 4xx → pds_error', async () => {
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: { status: 422, body: { error: 'bad email' } },
        }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createAccount(input);
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'pds_error') {
        expect(out.status).toBe(422);
      }
    });

    it('missing fields → rejects without hitting PDS', async () => {
      let calls = 0;
      const mgr = new SessionManager({
        pdsClient: async () => {
          calls++;
          return { status: 200, body: validBody() };
        },
        tokenStore: buildStore(),
      });
      const out = await mgr.createAccount({ ...input, handle: '' });
      expect(out.ok).toBe(false);
      expect(calls).toBe(0);
    });

    it('2xx with malformed body → malformed_response', async () => {
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: { status: 200, body: { did: DID } }, // missing fields
        }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createAccount(input);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('malformed_response');
    });

    it('network error → network_error', async () => {
      const mgr = new SessionManager({
        pdsClient: async () => {
          throw new Error('ENETDOWN');
        },
        tokenStore: buildStore(),
      });
      const out = await mgr.createAccount(input);
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'network_error') {
        expect(out.error).toMatch(/ENETDOWN/);
      }
    });

    it('fires account_created event', async () => {
      const events: SessionManagerEvent[] = [];
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: { status: 200, body: validBody() },
        }),
        tokenStore: buildStore(),
        onEvent: (e) => events.push(e),
      });
      await mgr.createAccount(input);
      expect(events.some((e) => e.kind === 'account_created')).toBe(true);
    });
  });

  describe('createSession', () => {
    const input: CreateSessionInput = {
      identifier: 'alice.bsky.social',
      password: 'hunter2',
    };

    it('200 → persists + ok=true', async () => {
      const store = buildStore();
      const mgr = new SessionManager({
        pdsClient: pds({
          createSession: { status: 200, body: validBody() },
        }),
        tokenStore: store,
      });
      const out = await mgr.createSession(input);
      expect(out.ok).toBe(true);
      expect(await store.load()).not.toBeNull();
    });

    it('401 → invalid_credentials', async () => {
      const mgr = new SessionManager({
        pdsClient: pds({
          createSession: { status: 401, body: { error: 'wrong password' } },
        }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createSession(input);
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'invalid_credentials') {
        expect(out.error).toMatch(/wrong password/);
      }
    });

    it('403 → invalid_credentials', async () => {
      const mgr = new SessionManager({
        pdsClient: pds({
          createSession: { status: 403, body: { error: 'account disabled' } },
        }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createSession(input);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid_credentials');
    });

    it('empty identifier rejected before PDS call', async () => {
      let calls = 0;
      const mgr = new SessionManager({
        pdsClient: async () => {
          calls++;
          return { status: 200, body: validBody() };
        },
        tokenStore: buildStore(),
      });
      const out = await mgr.createSession({ identifier: '', password: 'x' });
      expect(out.ok).toBe(false);
      expect(calls).toBe(0);
    });

    it('empty password rejected', async () => {
      const mgr = new SessionManager({
        pdsClient: async () => ({ status: 200, body: validBody() }),
        tokenStore: buildStore(),
      });
      const out = await mgr.createSession({ identifier: 'x', password: '' });
      expect(out.ok).toBe(false);
    });
  });

  describe('refreshSession', () => {
    it('no session → no_session without calling PDS', async () => {
      let calls = 0;
      const mgr = new SessionManager({
        pdsClient: async () => {
          calls++;
          return { status: 200, body: validBody() };
        },
        tokenStore: buildStore(),
      });
      const out = await mgr.refreshSession();
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('no_session');
      expect(calls).toBe(0);
    });

    it('200 → persists new record', async () => {
      const store = buildStore();
      await store.save({
        did: DID,
        handle: 'alice',
        accessJwt: 'old',
        refreshJwt: 'refresh-old',
        accessExpiresAtMs: 1_000,
        refreshExpiresAtMs: 10_000,
      });
      const mgr = new SessionManager({
        pdsClient: pds({
          refreshSession: {
            status: 200,
            body: validBody({ accessJwt: 'new-access' }),
          },
        }),
        tokenStore: store,
      });
      const out = (await mgr.refreshSession()) as Extract<SessionOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      expect(out.record.accessJwt).toBe('new-access');
    });

    it('401 on refresh → refresh_rejected', async () => {
      const store = buildStore();
      await store.save({
        did: DID,
        handle: 'alice',
        accessJwt: 'a',
        refreshJwt: 'r',
        accessExpiresAtMs: 1_000,
        refreshExpiresAtMs: null,
      });
      const mgr = new SessionManager({
        pdsClient: pds({
          refreshSession: {
            status: 401,
            body: { error: 'refresh jwt expired' },
          },
        }),
        tokenStore: store,
      });
      const out = await mgr.refreshSession();
      expect(out.ok).toBe(false);
      if (out.ok === false && out.reason === 'refresh_rejected') {
        expect(out.error).toMatch(/refresh jwt/);
      }
    });

    it('bearer = current refreshJwt passed through', async () => {
      const store = buildStore();
      await store.save({
        did: DID,
        handle: 'alice',
        accessJwt: 'a',
        refreshJwt: 'REFRESH-SECRET',
        accessExpiresAtMs: 1_000,
        refreshExpiresAtMs: null,
      });
      let seenBearer: string | undefined;
      const pdsClient: PdsClientFn = async (kind, _payload, bearer) => {
        if (kind === 'refreshSession') seenBearer = bearer;
        return { status: 200, body: validBody() };
      };
      const mgr = new SessionManager({ pdsClient, tokenStore: store });
      await mgr.refreshSession();
      expect(seenBearer).toBe('REFRESH-SECRET');
    });
  });

  describe('deleteSession', () => {
    it('no session → no_session without calling PDS', async () => {
      let calls = 0;
      const mgr = new SessionManager({
        pdsClient: async () => {
          calls++;
          return { status: 200, body: null };
        },
        tokenStore: buildStore(),
      });
      const out = await mgr.deleteSession();
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('no_session');
      expect(calls).toBe(0);
    });

    it('200 → clears local record', async () => {
      const store = buildStore();
      await store.save({
        did: DID,
        handle: 'alice',
        accessJwt: 'a',
        refreshJwt: 'r',
        accessExpiresAtMs: 1_000,
        refreshExpiresAtMs: null,
      });
      const mgr = new SessionManager({
        pdsClient: pds({ deleteSession: { status: 200, body: null } }),
        tokenStore: store,
      });
      const out = await mgr.deleteSession();
      expect(out.ok).toBe(true);
      expect(await store.has()).toBe(false);
    });

    it('PDS error still clears local record + returns pds_error', async () => {
      const store = buildStore();
      await store.save({
        did: DID,
        handle: 'alice',
        accessJwt: 'a',
        refreshJwt: 'r',
        accessExpiresAtMs: 1_000,
        refreshExpiresAtMs: null,
      });
      const mgr = new SessionManager({
        pdsClient: pds({
          deleteSession: { status: 500, body: { error: 'server error' } },
        }),
        tokenStore: store,
      });
      const out = (await mgr.deleteSession()) as Extract<DeleteSessionOutcome, { ok: false }>;
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('pds_error');
      expect(await store.has()).toBe(false); // still cleared locally
    });

    it('fires session_deleted event', async () => {
      const store = buildStore();
      await store.save({
        did: DID,
        handle: 'alice',
        accessJwt: 'a',
        refreshJwt: 'r',
        accessExpiresAtMs: 1_000,
        refreshExpiresAtMs: null,
      });
      const events: SessionManagerEvent[] = [];
      const mgr = new SessionManager({
        pdsClient: pds({ deleteSession: { status: 200, body: null } }),
        tokenStore: store,
        onEvent: (e) => events.push(e),
      });
      await mgr.deleteSession();
      expect(events.some((e) => e.kind === 'session_deleted')).toBe(true);
    });
  });

  describe('realistic flow', () => {
    it('createAccount → refreshSession → deleteSession round-trips cleanly', async () => {
      const store = buildStore();
      const mgr = new SessionManager({
        pdsClient: pds({
          createAccount: { status: 200, body: validBody({ accessJwt: 'a1' }) },
          refreshSession: { status: 200, body: validBody({ accessJwt: 'a2' }) },
          deleteSession: { status: 200, body: null },
        }),
        tokenStore: store,
      });
      const created = (await mgr.createAccount({
        handle: 'alice',
        email: 'alice@example.com',
        password: 'hunter2',
      })) as Extract<SessionOutcome, { ok: true }>;
      expect(created.record.accessJwt).toBe('a1');

      const refreshed = (await mgr.refreshSession()) as Extract<SessionOutcome, { ok: true }>;
      expect(refreshed.record.accessJwt).toBe('a2');

      const deleted = await mgr.deleteSession();
      expect(deleted.ok).toBe(true);
      expect(await store.has()).toBe(false);
    });
  });
});
