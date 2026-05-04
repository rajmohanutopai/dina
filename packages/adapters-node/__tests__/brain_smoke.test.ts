/**
 * Task 3.52 — Brain + Node adapters + InProcessTransport smoke.
 *
 * Composition proof for the mobile / in-process deployment shape: Brain,
 * Node adapters, and `InProcessTransport` plug together through the
 * typed `CoreClient` surface — no HTTP hop, no BrainCoreClient-era
 * compatibility layer.
 *
 * What this test actually exercises:
 *
 *   1. **`InProcessTransport` + `CoreRouter` wiring.** A minimal router
 *      registers the `/healthz` + `/v1/vault/{store,query}` routes that
 *      Brain's reasoning pipeline calls against. The transport dispatches
 *      the typed method calls through the router.
 *
 *   2. **Brain's production staging drain runs on `CoreClient`.** A
 *      staged `/remember` item is claimed and resolved through
 *      `InProcessTransport`, proving Brain depends on the same typed
 *      transport surface mobile boots with.
 *
 *   3. **Adapters-node `Crypto` + signer stay useful on the mobile path.**
 *      Brain still signs outbound D2D envelopes (messages to OTHER Dinas'
 *      Cores), so the Ed25519 signer is part of the composition even when
 *      Brain → own Core uses `InProcessTransport`.
 *
 * **Not a deep test.** Exhaustive CoreClient and staging-drain behavior
 * lives in `@dina/core` and `@dina/brain` own test suites. This smoke
 * proves the imports compose cleanly and the greenfield happy path works.
 */

import {
  InProcessTransport,
  CoreRouter,
  type CoreClient,
  type VaultQuery,
  type VaultItemInput,
} from '@dina/core';
import { runStagingDrainTick } from '@dina/brain';
import { Crypto, createCanonicalRequestSigner } from '@dina/adapters-node';

jest.setTimeout(10_000);

interface StoredItem {
  id: string;
  persona: string;
  type: string;
  content: unknown;
}

function buildRouterWithVault(): CoreRouter {
  const router = new CoreRouter();
  const items: StoredItem[] = [];
  let seq = 0;

  router.get(
    '/healthz',
    () => ({
      status: 200,
      body: { status: 'ok', did: 'did:plc:smoke', version: '0.0.0-smoke' },
    }),
    { auth: 'public' },
  );

  router.post(
    '/v1/vault/store',
    (req) => {
      // InProcessTransport.vaultStore wire-format: `{persona, ...item}` —
      // persona is a top-level field, item fields are spread alongside.
      const body = req.body as {
        persona: string;
        type?: string;
        content?: unknown;
        source?: string;
      };
      seq += 1;
      const id = `smoke-item-${seq}`;
      items.push({
        id,
        persona: body.persona,
        type: body.type ?? 'note',
        content: body.content,
      });
      return { status: 201, body: { id, storedAt: '2026-04-21T00:00:00Z' } };
    },
    { auth: 'public' },
  );

  router.post(
    '/v1/vault/query',
    (req) => {
      const body = req.body as { persona: string; q?: string };
      const matched = items.filter((i) => {
        if (i.persona !== body.persona) return false;
        if (!body.q) return true;
        return JSON.stringify(i.content).includes(body.q);
      });
      return {
        status: 200,
        body: {
          items: matched.map((i) => ({
            id: i.id,
            type: i.type,
            content: i.content,
          })),
          count: matched.length,
        },
      };
    },
    { auth: 'public' },
  );

  return router;
}

describe('brain × adapters-node × InProcessTransport — Phase 3g smoke (task 3.52)', () => {
  it('InProcessTransport round-trips a typed vault store + query through a CoreRouter', async () => {
    const transport: CoreClient = new InProcessTransport(buildRouterWithVault());

    const health = await transport.healthz();
    expect(health.status).toBe('ok');
    expect(health.did).toBe('did:plc:smoke');

    const item: VaultItemInput = {
      type: 'note',
      content: { summary: 'Bus 42 to Castro — 3pm demo run' },
      source: 'smoke-test',
    };

    const store = await transport.vaultStore('general', item);
    expect(store.id).toBe('smoke-item-1');

    const query: VaultQuery = { q: 'Bus 42' };
    const result = await transport.vaultQuery('general', query);
    expect(result.count).toBe(1);
    const first = result.items[0] as { id: string } | undefined;
    expect(first?.id).toBe('smoke-item-1');

    // Persona isolation holds through the transport.
    const empty = await transport.vaultQuery('health', query);
    expect(empty.count).toBe(0);
  });

  it('Brain staging drain claims and resolves through the typed CoreClient surface', async () => {
    const router = new CoreRouter();
    let claimed = false;
    let resolvedBody: Record<string, unknown> | null = null;

    router.get(
      '/healthz',
      () => ({ status: 200, body: { status: 'ok', did: 'x', version: 'x' } }),
      { auth: 'public' },
    );
    router.post(
      '/v1/staging/claim',
      () => {
        if (claimed) return { status: 200, body: { items: [], count: 0 } };
        claimed = true;
        return {
          status: 200,
          body: {
            items: [
              {
                id: 'stage-1',
                source: 'mobile',
                source_id: 'note-1',
                data: {
                  type: 'note',
                  source: 'self',
                  sender: 'Raj',
                  summary: 'Adapter smoke runtime note',
                  body: 'Confirm Brain drain talks to Core through the typed transport.',
                },
              },
            ],
            count: 1,
          },
        };
      },
      { auth: 'public' },
    );
    router.post(
      '/v1/staging/resolve',
      (req) => {
        resolvedBody = req.body as Record<string, unknown>;
        return {
          status: 200,
          body: {
            id: resolvedBody.id,
            status: 'stored',
            personas: resolvedBody.personas,
          },
        };
      },
      { auth: 'public' },
    );
    router.post(
      '/v1/staging/fail',
      (req) => {
        const body = req.body as { id?: string };
        return { status: 200, body: { id: body.id ?? 'unknown', retry_count: 1 } };
      },
      { auth: 'public' },
    );
    router.post(
      '/v1/staging/extend-lease',
      (req) => {
        const body = req.body as { id?: string; seconds?: number };
        return {
          status: 200,
          body: { id: body.id ?? 'unknown', extended_by: body.seconds ?? 0 },
        };
      },
      { auth: 'public' },
    );

    const transport: CoreClient = new InProcessTransport(router);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let result: Awaited<ReturnType<typeof runStagingDrainTick>>;
    try {
      result = await runStagingDrainTick(transport, {
        limit: 1,
        setInterval: () => 'heartbeat',
        clearInterval: () => undefined,
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(result.claimed).toBe(1);
    expect(result.stored).toBe(1);
    expect(result.failed).toBe(0);
    expect(resolvedBody).not.toBeNull();
    if (resolvedBody === null) {
      throw new Error('expected staging resolve to run');
    }

    const resolved = resolvedBody as {
      id?: string;
      personas?: unknown;
      data?: Record<string, unknown>;
      persona_access?: unknown;
    };
    expect(resolved.id).toBe('stage-1');
    expect(Array.isArray(resolved.personas)).toBe(true);
    expect((resolved.personas as unknown[]).length).toBeGreaterThan(0);
    expect(resolved.data?.staging_id).toBe('stage-1');
    expect(typeof resolved.data?.content_l0).toBe('string');
    expect(resolved.persona_access).toBeTruthy();
  });

  it('adapters-node Crypto still composes the D2D signer path on the mobile target', async () => {
    // Even when Brain → own Core uses InProcessTransport, outbound D2D
    // envelopes to OTHER Dinas' Cores still need Ed25519 signatures.
    // Confirm the adapters-node signer builds cleanly alongside the
    // in-process transport.
    const crypto = new Crypto();
    const seed = new Uint8Array(32).fill(0x5a);
    const { privateKey } = await crypto.ed25519DerivePath(seed, "m/9999'/3'/0'");

    const signer = createCanonicalRequestSigner({
      did: 'did:plc:brain-01',
      privateKey,
      sign: (priv, msg) => crypto.ed25519Sign(priv, msg),
    });

    const signed = await signer({
      method: 'POST',
      path: '/v1/d2d/deliver',
      query: '',
      body: new TextEncoder().encode('{"envelope": "outbound"}'),
    });

    expect(signed.did).toBe('did:plc:brain-01');
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/);
    // Timestamp is RFC3339; nonce is 32 hex chars (16 random bytes).
    expect(signed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(signed.nonce).toMatch(/^[0-9a-f]{32}$/);
  });
});
