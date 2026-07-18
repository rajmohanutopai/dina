/**
 * ISVC-1 — owner-only /v1/run/* boundary (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §12.5). "A real boundary, not `trustedInProcess`." Two enforcement layers:
 *   (A) in-handler owner guard — the in-process path (trustedInProcess bypasses
 *       the authz matrix), so every non-owner caller (incl. Brain's undefined
 *       callerType) must be rejected by the handler; only `callerType='owner'`
 *       passes.
 *   (B) authz matrix — a signed brain/connector/device caller is denied at the
 *       authorization layer (`/v1/run → {owner}`), before the handler runs.
 */

import { TEST_ED25519_SEED } from '@dina/test-harness';

import { registerService, resetCallerTypeState } from '../../../src/auth/caller_type';
import { signRequest } from '../../../src/auth/canonical';
import { registerPublicKeyResolver, resetMiddlewareState } from '../../../src/auth/middleware';
import { getPublicKey } from '../../../src/crypto/ed25519';
import { deriveDIDKey } from '../../../src/identity/did';
import { InMemoryRunRepository, setRunRepository } from '../../../src/run/repository';
import { RunService, setRunService } from '../../../src/run/service';
import { createCoreRouter } from '../../../src/server/core_server';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerRunRoutes } from '../../../src/server/routes/run';

const NOW = 1_700_000_000_000;

function req(
  method: CoreRequest['method'],
  path: string,
  callerType: string | undefined,
  body: Record<string, unknown> = {},
): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
  };
}

const NON_OWNER: (string | undefined)[] = [
  undefined, // Brain's shared in-process transport carries no callerType
  'brain',
  'admin',
  'connector',
  'device',
  'agent',
  'plugin',
  'service',
];

function startBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: `idem-${Math.random()}`,
    ttl_seconds: 3600,
    ...over,
  };
}

describe('(A) in-handler owner guard — in-process path', () => {
  let router: CoreRouter;

  beforeEach(() => {
    const repo = new InMemoryRunRepository();
    setRunRepository(repo);
    setRunService(new RunService({ repository: repo, nowMsFn: () => NOW }));
    router = new CoreRouter();
    registerRunRoutes(router);
  });

  afterEach(() => {
    setRunService(null);
    setRunRepository(null);
  });

  it('rejects every non-owner caller on /v1/run/start (403)', async () => {
    for (const ct of NON_OWNER) {
      const resp = await router.handle(req('POST', '/v1/run/start', ct, startBody()));
      expect(resp.status).toBe(403);
      expect((resp.body as { error: string }).error).toBe('access_denied');
    }
  });

  it('rejects non-owner callers on every control mutation (403)', async () => {
    const routes: [CoreRequest['method'], string][] = [
      ['POST', '/v1/run/r1/pause'],
      ['POST', '/v1/run/r1/resume'],
      ['POST', '/v1/run/r1/stop'],
      ['POST', '/v1/run/r1/update'],
      ['GET', '/v1/run/r1/status'],
    ];
    for (const [method, path] of routes) {
      for (const ct of ['brain', 'agent', 'plugin', 'connector', undefined]) {
        const resp = await router.handle(req(method, path, ct));
        expect(resp.status).toBe(403);
      }
    }
  });

  it('admits the owner: start → steer → status', async () => {
    const start = await router.handle(req('POST', '/v1/run/start', 'owner', startBody()));
    expect(start.status).toBe(201);
    const runId = (start.body as { run_id: string }).run_id;
    expect(runId).toMatch(/^run-/);
    expect((start.body as { erasure_mode: string }).erasure_mode).toBe('logical_deletion');

    const status = await router.handle(req('GET', `/v1/run/${runId}/status`, 'owner'));
    expect(status.status).toBe(200);
    expect((status.body as { state: string }).state).toBe('active');

    const pause = await router.handle(req('POST', `/v1/run/${runId}/pause`, 'owner'));
    expect((pause.body as { state: string }).state).toBe('paused');

    const stop = await router.handle(
      req('POST', `/v1/run/${runId}/stop`, 'owner', { on_stop: 'cancel_pending' }),
    );
    expect((stop.body as { state: string }).state).toBe('draining');
  });

  it('owner /start validates: rejects a fiduciary ceiling and a missing TTL', async () => {
    const fid = await router.handle(
      req('POST', '/v1/run/start', 'owner', startBody({ priority_ceiling: 'fiduciary' })),
    );
    expect(fid.status).toBe(400);

    const noTtl = await router.handle(
      req('POST', '/v1/run/start', 'owner', {
        service_uri: 'at://x/y/z',
        provider_did: 'did:plc:p',
        persona: 'general',
        idempotency_key: 'k',
      }),
    );
    expect(noTtl.status).toBe(400);
  });

  it('owner /update enforces config_version + lower-only ceiling', async () => {
    const start = await router.handle(
      req('POST', '/v1/run/start', 'owner', startBody({ priority_ceiling: 'solicited' })),
    );
    const runId = (start.body as { run_id: string }).run_id;

    // lower-only: solicited → engagement is quieter (allowed)
    const ok = await router.handle(
      req('POST', `/v1/run/${runId}/update`, 'owner', {
        priority_ceiling: 'engagement',
        config_version: 0,
      }),
    );
    expect(ok.status).toBe(200);
    expect((ok.body as { config_version: number }).config_version).toBe(1);

    // raising back to solicited (louder) is rejected
    const louder = await router.handle(
      req('POST', `/v1/run/${runId}/update`, 'owner', {
        priority_ceiling: 'solicited',
        config_version: 1,
      }),
    );
    expect(louder.status).toBe(400);

    // stale config_version → 409
    const stale = await router.handle(
      req('POST', `/v1/run/${runId}/update`, 'owner', { muted: true, config_version: 0 }),
    );
    expect(stale.status).toBe(409);
  });
});

describe('(B) authz matrix — signed callers denied on /v1/run', () => {
  const BRAIN_SEED = TEST_ED25519_SEED;
  const BRAIN_PUB = getPublicKey(BRAIN_SEED);
  const BRAIN_DID = deriveDIDKey(BRAIN_PUB);

  beforeEach(() => {
    resetMiddlewareState();
    resetCallerTypeState();
    const repo = new InMemoryRunRepository();
    setRunRepository(repo);
    setRunService(new RunService({ repository: repo }));
    registerPublicKeyResolver((d) => (d === BRAIN_DID ? BRAIN_PUB : null));
    registerService(BRAIN_DID, 'brain');
  });

  afterEach(() => {
    setRunService(null);
    setRunRepository(null);
    resetMiddlewareState();
    resetCallerTypeState();
  });

  it('a signed brain caller is denied on /v1/run/start (403, before the handler)', async () => {
    const router = createCoreRouter();
    const body = startBody();
    const raw = new TextEncoder().encode(JSON.stringify(body));
    const headers = signRequest('POST', '/v1/run/start', '', raw, BRAIN_SEED, BRAIN_DID);
    const resp = await router.handle({
      method: 'POST',
      path: '/v1/run/start',
      query: {},
      headers: {
        'x-did': headers['X-DID'],
        'x-timestamp': headers['X-Timestamp'],
        'x-nonce': headers['X-Nonce'],
        'x-signature': headers['X-Signature'],
      },
      body,
      rawBody: raw,
      params: {},
    });
    expect(resp.status).toBe(403);
  });
});
