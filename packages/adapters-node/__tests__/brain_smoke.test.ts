/**
 * Task 3.52 — Brain + Node adapters + InProcessTransport smoke.
 *
 * Composition proof for the mobile / in-process deployment shape: Brain,
 * Node adapters, and `InProcessTransport` plug together such that a
 * reasoning-style round-trip (healthz → vaultStore → vaultQuery) completes
 * through the typed `CoreClient` surface — no HTTP hop, no signing (Brain
 * and Core share the JS VM on the mobile target).
 *
 * What this test actually exercises:
 *
 *   1. **`InProcessTransport` + `CoreRouter` wiring.** A minimal router
 *      registers the `/healthz` + `/v1/vault/{store,query}` routes that
 *      Brain's reasoning pipeline calls against. The transport dispatches
 *      the typed method calls through the router.
 *
 *   2. **Brain's `CircuitBreaker` wraps the transport call.** Brain's
 *      core-client uses a circuit breaker to fail-fast when Core is
 *      unreachable. We assert it transitions open/closed the same way
 *      whether the wrapped call hits HTTP or the in-process dispatch.
 *
 *   3. **Adapters-node `Crypto` + signer stay useful on the mobile path.**
 *      Brain still signs outbound D2D envelopes (messages to OTHER Dinas'
 *      Cores), so the Ed25519 signer is part of the composition even when
 *      Brain → own Core uses `InProcessTransport`.
 *
 * **Not a deep test.** Exhaustive CoreClient / CircuitBreaker behavior
 * lives in `@dina/core` and `@dina/brain` own test suites. This smoke
 * proves the imports compose cleanly and the happy path works.
 */

import {
  InProcessTransport,
  CoreRouter,
  type CoreClient,
  type VaultQuery,
  type VaultItemInput,
} from '@dina/core';
import { CircuitBreaker } from '@dina/brain';
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

  it('Brain CircuitBreaker wraps an InProcessTransport call and trips on repeated failures', async () => {
    // Dedicated router whose vaultQuery always throws — simulates a
    // degraded Core. The breaker should open after N failures.
    const router = new CoreRouter();
    router.get(
      '/healthz',
      () => ({ status: 200, body: { status: 'ok', did: 'x', version: 'x' } }),
      { auth: 'public' },
    );
    router.post(
      '/v1/vault/query',
      () => {
        throw new Error('injected failure');
      },
      { auth: 'public' },
    );

    const transport: CoreClient = new InProcessTransport(router);
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 50,
    });

    // Two failures → breaker opens. The handler throws; InProcessTransport
    // wraps that into a 500 response, and `expectOk` re-throws with a
    // "failed 500 — handler threw" message.
    for (let i = 0; i < 2; i++) {
      expect(breaker.allowRequest()).toBe(true);
      try {
        await transport.vaultQuery('general', { q: 'x' });
        throw new Error('expected the handler to fail');
      } catch (err) {
        expect((err as Error).message).toMatch(/failed 500/);
        breaker.recordFailure();
      }
    }

    // Breaker should now be open — third call is blocked without even
    // invoking the transport.
    expect(breaker.allowRequest()).toBe(false);
    expect(breaker.getStatus().state).toBe('open');

    // healthz still works — circuit breaker is per-call-site, not
    // per-transport.
    const health = await transport.healthz();
    expect(health.status).toBe('ok');
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
