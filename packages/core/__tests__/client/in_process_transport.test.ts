/**
 * InProcessTransport smoke — prove the adapter correctly dispatches
 * typed CoreClient method calls through a CoreRouter. Covers the
 * healthz + vault CRUD surface (task 1.30 scaffold scope).
 */

import { InProcessTransport } from '../../src/client/in-process-transport';
import { CoreRouter } from '../../src/server/router';

function buildRouter(): CoreRouter {
  const r = new CoreRouter();

  r.get(
    '/healthz',
    () => ({ status: 200, body: { status: 'ok', did: 'did:key:test', version: '0.0.0' } }),
    { auth: 'public' },
  );

  r.post(
    '/v1/vault/query',
    (req) => {
      const body = req.body as { persona?: string; q?: string; type?: string };
      return {
        status: 200,
        body: {
          items: [{ id: 'i1', persona: body.persona, q: body.q }],
          count: 1,
        },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/vault/store',
    (req) => {
      const body = req.body as { persona?: string; type?: string };
      return {
        status: 201,
        body: { id: 'item-new', storedAt: '2026-04-21T00:00:00Z' },
      };
    },
    { auth: 'public' },
  );

  r.get(
    '/v1/vault/list',
    (req) => ({
      status: 200,
      body: {
        items: [{ id: 'a' }, { id: 'b' }],
        count: 2,
        total: 42,
      },
    }),
    { auth: 'public' },
  );

  r.delete(
    '/v1/vault/items/:id',
    (req) => ({
      status: 200,
      body: { deleted: req.params.id === 'known' },
    }),
    { auth: 'public' },
  );

  // DID-sign routes (1.29b)

  r.post(
    '/v1/did/sign',
    (req) => {
      const body = req.body as { payload?: string };
      // Return a deterministic "signature" of the base64 payload length —
      // enough to prove the bytes arrived intact.
      const decoded = Buffer.from(body.payload ?? '', 'base64');
      return {
        status: 200,
        body: {
          signature: `sig-${decoded.length}`,
          did: 'did:plc:home',
        },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/did/sign-canonical',
    (req) => {
      const body = req.body as { method?: string; path?: string };
      return {
        status: 200,
        body: {
          did: 'did:plc:home',
          timestamp: '2026-04-21T12:00:00Z',
          nonce: 'ff'.repeat(8),
          signature: `canon-${body.method}-${body.path}`,
        },
      };
    },
    { auth: 'public' },
  );

  // Notify route (1.29d)

  r.post(
    '/v1/notify',
    (req) => {
      const body = req.body as { priority?: string; title?: string };
      // Echo priority + fake subscriber count based on priority. Fiduciary
      // "always" has at least 1 subscriber in this fake (prod's real count
      // comes from the WS hub's live connection map).
      const subscribers = body.priority === 'fiduciary' ? 2 : 1;
      return {
        status: 200,
        body: {
          accepted: true,
          notificationId: `notif-${body.priority ?? 'unknown'}-${body.title?.length ?? 0}`,
          subscribers,
        },
      };
    },
    { auth: 'public' },
  );

  // Persona gatekeeper routes (1.29e)

  r.get(
    '/v1/persona/status',
    (req) => {
      const persona = req.query.persona ?? '';
      if (persona === 'personal') {
        return {
          status: 200,
          body: {
            persona,
            tier: 'default',
            open: true,
            dekFingerprint: 'ab12cd34',
            openedAt: 1776700000,
          },
        };
      }
      if (persona === 'financial') {
        return {
          status: 200,
          body: {
            persona,
            tier: 'locked',
            open: false,
            dekFingerprint: null,
            openedAt: null,
          },
        };
      }
      return { status: 404, body: { error: `unknown persona: ${persona}` } };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/persona/unlock',
    (req) => {
      const body = req.body as { persona?: string; passphrase?: string };
      if (body.persona === 'financial' && body.passphrase === 'correct-passphrase') {
        return {
          status: 200,
          body: {
            persona: body.persona,
            unlocked: true,
            dekFingerprint: 'ef56gh78',
          },
        };
      }
      return {
        status: 200,
        body: {
          persona: body.persona,
          unlocked: false,
          dekFingerprint: null,
          error: 'wrong_passphrase',
        },
      };
    },
    { auth: 'public' },
  );

  // PII-scrub routes (1.29c)

  r.post(
    '/v1/pii/scrub',
    (req) => {
      const body = req.body as { text?: string };
      // Fake: replace any occurrence of "Alice" with "{{ENTITY:0}}".
      const scrubbed = (body.text ?? '').replace(/Alice/g, '{{ENTITY:0}}');
      return {
        status: 200,
        body: {
          scrubbed,
          sessionId: 'pii-session-abc',
          entityCount: scrubbed.includes('{{ENTITY:0}}') ? 1 : 0,
        },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/pii/rehydrate',
    (req) => {
      const body = req.body as { sessionId?: string; text?: string };
      // Only the exact session we minted restores entities; else passthrough.
      const rehydrated =
        body.sessionId === 'pii-session-abc'
          ? (body.text ?? '').replace(/\{\{ENTITY:0\}\}/g, 'Alice')
          : (body.text ?? '');
      return {
        status: 200,
        body: {
          rehydrated,
          sessionFound: body.sessionId === 'pii-session-abc',
        },
      };
    },
    { auth: 'public' },
  );

  // Service config + query routes (1.29f)

  r.get(
    '/v1/service/config',
    () => ({
      status: 200,
      body: {
        isDiscoverable: true,
        name: 'SF Transit Authority',
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'get_eta',
            responsePolicy: 'auto',
            schemaHash: 'a1b2c3d4',
          },
        },
      },
    }),
    { auth: 'public' },
  );

  r.post(
    '/v1/service/query',
    (req) => {
      const body = req.body as Record<string, unknown>;
      // Fake: echo the to_did + capability back into the task id so
      // the test can prove the snake_case conversion happened intact.
      return {
        status: 200,
        body: {
          task_id: `sq-${body.query_id}-fake`,
          query_id: body.query_id,
          // Dedupe only when schema_hash is "stale-pin" — lets the
          // deduped-path test exercise the optional field.
          ...(body.schema_hash === 'stale-pin' ? { deduped: true } : {}),
        },
      };
    },
    { auth: 'public' },
  );

  // Memory ToC route (1.29g)

  r.get(
    '/v1/memory/toc',
    (req) => {
      const personaFilter = req.query.persona ?? '';
      const limit = Number.parseInt(req.query.limit ?? '50', 10);
      // Fake: echo the persona filter back through entries so the
      // test can prove the comma-joined encoding worked.
      const allEntries = [
        {
          persona: 'personal',
          topic: 'dentist',
          kind: 'entity',
          salience: 0.92,
          last_update: 1776700000,
        },
        {
          persona: 'work',
          topic: 'q2-planning',
          kind: 'theme',
          salience: 0.45,
          last_update: 1776600000,
        },
      ];
      const filtered =
        personaFilter === ''
          ? allEntries
          : allEntries.filter((e) => personaFilter.split(',').includes(e.persona));
      return { status: 200, body: { entries: filtered, limit } };
    },
    { auth: 'public' },
  );

  return r;
}

describe('InProcessTransport (task 1.30)', () => {
  it('healthz round-trips via CoreRouter.handle', async () => {
    const t = new InProcessTransport(buildRouter());
    const h = await t.healthz();
    expect(h.status).toBe('ok');
    expect(h.did).toBe('did:key:test');
  });

  it('vaultQuery sends persona + query body', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.vaultQuery('personal', { q: 'dentist', type: 'contact' });
    expect(r.count).toBe(1);
    const first = (r.items as Array<Record<string, unknown>>)[0];
    expect(first?.persona).toBe('personal');
    expect(first?.q).toBe('dentist');
  });

  it('vaultStore returns the assigned id', async () => {
    const t = new InProcessTransport(buildRouter());
    const s = await t.vaultStore('personal', { type: 'note', content: { text: 'hi' } });
    expect(s.id).toBe('item-new');
    expect(s.storedAt).toMatch(/^2026/);
  });

  it('vaultList returns items + count', async () => {
    const t = new InProcessTransport(buildRouter());
    const l = await t.vaultList('personal', { limit: 10 });
    expect(l.count).toBe(2);
    expect(l.total).toBe(42);
  });

  it('vaultDelete uses path param and returns deleted=true for known id', async () => {
    const t = new InProcessTransport(buildRouter());
    const r1 = await t.vaultDelete('personal', 'known');
    expect(r1.deleted).toBe(true);

    const r2 = await t.vaultDelete('personal', 'unknown');
    expect(r2.deleted).toBe(false);
  });

  it('didSign round-trips bytes base64-encoded', async () => {
    const t = new InProcessTransport(buildRouter());
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await t.didSign(payload);
    // Fake route returned "sig-<len>" — confirms the bytes decoded intact.
    expect(r.signature).toBe('sig-5');
    expect(r.did).toBe('did:plc:home');
  });

  it('didSignCanonical returns the 4 request-signing headers', async () => {
    const t = new InProcessTransport(buildRouter());
    const h = await t.didSignCanonical({
      method: 'POST',
      path: '/v1/vault/store',
      query: '',
      body: new Uint8Array([9, 9, 9]),
    });
    expect(h.did).toBe('did:plc:home');
    expect(h.timestamp).toMatch(/^2026-/);
    expect(h.nonce).toHaveLength(16); // 8 bytes hex-encoded
    expect(h.signature).toBe('canon-POST-/v1/vault/store');
  });

  it('piiScrub replaces entities + returns session token', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.piiScrub('Hello Alice, how are you?');
    expect(r.scrubbed).toBe('Hello {{ENTITY:0}}, how are you?');
    expect(r.sessionId).toBe('pii-session-abc');
    expect(r.entityCount).toBe(1);
  });

  it('piiRehydrate restores entities on known session; passes through on unknown', async () => {
    const t = new InProcessTransport(buildRouter());
    const known = await t.piiRehydrate('pii-session-abc', 'Hello {{ENTITY:0}}, how are you?');
    expect(known.sessionFound).toBe(true);
    expect(known.rehydrated).toBe('Hello Alice, how are you?');

    const stale = await t.piiRehydrate('stale', 'Hello {{ENTITY:0}}');
    expect(stale.sessionFound).toBe(false);
    expect(stale.rehydrated).toBe('Hello {{ENTITY:0}}');
  });

  it('notify accepts fiduciary priority + echoes notification id', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.notify({
      priority: 'fiduciary',
      title: 'emergency',
      body: 'alert body',
    });
    expect(r.accepted).toBe(true);
    expect(r.notificationId).toBe('notif-fiduciary-9');
    expect(r.subscribers).toBe(2);
  });

  it('notify engagement priority routes to briefing (subscribers=1)', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.notify({
      priority: 'engagement',
      title: 'digest',
      body: 'weekly summary',
      meta: { category: 'news' },
    });
    expect(r.accepted).toBe(true);
    expect(r.subscribers).toBe(1);
  });

  it('personaStatus returns tier + open-state for known personas', async () => {
    const t = new InProcessTransport(buildRouter());
    const open = await t.personaStatus('personal');
    expect(open.tier).toBe('default');
    expect(open.open).toBe(true);
    expect(open.dekFingerprint).toBe('ab12cd34');

    const locked = await t.personaStatus('financial');
    expect(locked.tier).toBe('locked');
    expect(locked.open).toBe(false);
    expect(locked.dekFingerprint).toBeNull();
  });

  it('personaStatus throws on unknown persona (Core returns 404)', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.personaStatus('ghost')).rejects.toThrow(/404/);
  });

  it('personaUnlock succeeds with correct passphrase; returns fresh DEK fingerprint', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.personaUnlock('financial', 'correct-passphrase');
    expect(r.unlocked).toBe(true);
    expect(r.dekFingerprint).toBe('ef56gh78');
    expect(r.error).toBeUndefined();
  });

  it('personaUnlock surfaces wrong-passphrase as data, not exception', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.personaUnlock('financial', 'bad');
    expect(r.unlocked).toBe(false);
    expect(r.error).toBe('wrong_passphrase');
    expect(r.dekFingerprint).toBeNull();
  });

  it('throws on non-2xx responses (surfaces Core errors to Brain callers)', async () => {
    const r = new CoreRouter();
    r.get('/healthz', () => ({ status: 500, body: { error: 'simulated outage' } }), {
      auth: 'public',
    });
    const t = new InProcessTransport(r);
    await expect(t.healthz()).rejects.toThrow(/healthz failed 500 — simulated outage/);
  });

  it('serviceConfig returns published ServiceConfig on 200', async () => {
    const t = new InProcessTransport(buildRouter());
    const cfg = await t.serviceConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.name).toBe('SF Transit Authority');
    expect(cfg?.capabilities.eta_query?.mcpTool).toBe('get_eta');
    expect(cfg?.capabilities.eta_query?.schemaHash).toBe('a1b2c3d4');
  });

  it('serviceConfig returns null (not throw) when Core has no config (404)', async () => {
    // Route returns 404 → transport normalises to `null`. Proves the
    // "no config set" state isn't exceptional from Brain's POV.
    const r = new CoreRouter();
    r.get(
      '/v1/service/config',
      () => ({ status: 404, body: { error: 'service_config: not set' } }),
      { auth: 'public' },
    );
    const t = new InProcessTransport(r);
    await expect(t.serviceConfig()).resolves.toBeNull();
  });

  it('serviceQuery maps camelCase → snake_case + returns task handle', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.serviceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-abc',
      params: { route_id: '42', location: { lat: 37.762, lng: -122.435 } },
      ttlSeconds: 60,
      serviceName: 'SF Transit',
    });
    expect(r.taskId).toBe('sq-q-abc-fake');
    expect(r.queryId).toBe('q-abc');
    expect(r.deduped).toBeUndefined();
  });

  it('serviceQuery surfaces dedupe flag when server reports one in flight', async () => {
    // Use the stale-pin schema_hash fake-route branch to exercise the
    // deduped:true path. Verifies the optional field round-trips.
    const t = new InProcessTransport(buildRouter());
    const r = await t.serviceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-dup',
      params: { route_id: '42' },
      ttlSeconds: 60,
      schemaHash: 'stale-pin',
    });
    expect(r.deduped).toBe(true);
    expect(r.taskId).toBe('sq-q-dup-fake');
  });

  it('memoryToC walks all unlocked personas when none specified', async () => {
    const t = new InProcessTransport(buildRouter());
    const toc = await t.memoryToC();
    expect(toc.limit).toBe(50); // default the fake echoes back
    expect(toc.entries).toHaveLength(2);
    expect(toc.entries[0]?.topic).toBe('dentist');
    expect(toc.entries[0]?.persona).toBe('personal');
  });

  it('memoryToC restricts to the requested persona list', async () => {
    // Comma-join encoding is what the route's parsePersonaFilter expects.
    const t = new InProcessTransport(buildRouter());
    const toc = await t.memoryToC({ personas: ['personal'], limit: 25 });
    expect(toc.limit).toBe(25);
    expect(toc.entries).toHaveLength(1);
    expect(toc.entries[0]?.persona).toBe('personal');
  });
});
