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
import {
  InMemoryCommandReceiptRepository,
  setCommandReceiptRepository,
} from '../../../src/run/command_receipt';
import { InMemoryMessageRepository, setMessageRepository } from '../../../src/run/message';
import { InMemoryRunRepository, setRunRepository } from '../../../src/run/repository';
import { RunService, setRunService } from '../../../src/run/service';
import { createCoreRouter } from '../../../src/server/core_server';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerRunRoutes } from '../../../src/server/routes/run';

const NOW = 1_700_000_000_000;
const OWNER_CAP = 'test-owner-capability-secret';

let reqKeySeq = 0;
function req(
  method: CoreRequest['method'],
  path: string,
  callerType: string | undefined,
  body: Record<string, unknown> = {},
): CoreRequest {
  // Owner mutations now REQUIRE a durable idempotency_key (§12.5). Inject a
  // default for POST /v1/run/:id/{pause,resume,stop,update,decide} unless the
  // test supplied one; /start carries its own key (the run's idempotency_key).
  const needsKey =
    method === 'POST' &&
    /\/v1\/run\/[^/]+\/(pause|resume|stop|update|decide)$/.test(path) &&
    body.idempotency_key === undefined;
  const finalBody = needsKey ? { idempotency_key: `k-${++reqKeySeq}`, ...body } : body;
  return {
    method,
    path,
    query: {},
    headers: {},
    body: finalBody,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    // Only the genuine owner holds the boot-minted capability (F15). Non-owner
    // callers (Brain/agent/etc.) never get it — that's the whole point.
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
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
    registerRunRoutes(router, OWNER_CAP);
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

describe('owner run — validation + durable idempotency + list (dual-review remediation)', () => {
  let router: CoreRouter;
  let svcRef: RunService;

  beforeEach(() => {
    const repo = new InMemoryRunRepository();
    setRunRepository(repo);
    svcRef = new RunService({ repository: repo, nowMsFn: () => NOW });
    setRunService(svcRef);
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    setMessageRepository(new InMemoryMessageRepository());
    router = new CoreRouter();
    registerRunRoutes(router, OWNER_CAP);
  });

  afterEach(() => {
    setRunService(null);
    setRunRepository(null);
    setCommandReceiptRepository(null);
    setMessageRepository(null);
  });

  async function start(over: Record<string, unknown> = {}): Promise<string> {
    const s = await router.handle(req('POST', '/v1/run/start', 'owner', startBody(over)));
    return (s.body as { run_id: string }).run_id;
  }

  it('L-UPDATE: rejects out-of-range interval_ms / queue_cap and an invalid priority enum', async () => {
    const id = await start();
    for (const patch of [
      { interval_ms: -5 },
      { interval_ms: 1.5 },
      { queue_cap: 0 },
      { queue_cap: 9999 },
      { priority_ceiling: 'loudest' },
    ]) {
      const r = await router.handle(
        req('POST', `/v1/run/${id}/update`, 'owner', { ...patch, config_version: 0 }),
      );
      expect(r.status).toBe(400);
    }
    // the run's config was never mutated by any rejected update
    const st = await router.handle(req('GET', `/v1/run/${id}/status`, 'owner'));
    expect((st.body as { config_version: number }).config_version).toBe(0);
  });

  it('L-UPDATE: an interval change recomputes next_fetch_at on a committed run (§11)', async () => {
    const id = await start({ interval_ms: 3_600_000 });
    // Simulate one committed fetch: last_commit_at = NOW, next_fetch_at = NOW + interval.
    svcRef.store().incrementProducedAndAdvance(id, NOW, 3_600_000);
    const before = (await router.handle(req('GET', `/v1/run/${id}/status`, 'owner'))).body as {
      next_fetch_at: number;
    };
    expect(before.next_fetch_at).toBe(NOW + 3_600_000);

    const upd = await router.handle(
      req('POST', `/v1/run/${id}/update`, 'owner', { interval_ms: 1000, config_version: 0 }),
    );
    expect(upd.status).toBe(200);
    const after = (await router.handle(req('GET', `/v1/run/${id}/status`, 'owner'))).body as {
      next_fetch_at: number;
    };
    // recomputed = max(NOW, last_commit_at(NOW) + 1000) = NOW + 1000 — the shorter
    // cadence takes effect now instead of waiting out the old hour.
    expect(after.next_fetch_at).toBe(NOW + 1000);
  });

  it('L-UPDATE: an interval change does NOT delay a never-committed run first fetch', async () => {
    const id = await start({ interval_ms: 3_600_000 });
    const before = (await router.handle(req('GET', `/v1/run/${id}/status`, 'owner'))).body as {
      next_fetch_at: number;
    };
    await router.handle(req('POST', `/v1/run/${id}/update`, 'owner', { interval_ms: 1000, config_version: 0 }));
    const after = (await router.handle(req('GET', `/v1/run/${id}/status`, 'owner'))).body as {
      next_fetch_at: number;
    };
    expect(after.next_fetch_at).toBe(before.next_fetch_at);
  });

  it('L-UPDATE: rejects a config change on a terminal run (§5.1 absorbing)', async () => {
    const id = await start();
    await router.handle(req('POST', `/v1/run/${id}/stop`, 'owner', { on_stop: 'cancel_pending' }));
    svcRef.finalize(id); // draining → stopped (terminal)
    const r = await router.handle(
      req('POST', `/v1/run/${id}/update`, 'owner', { muted: true, config_version: 0 }),
    );
    expect(r.status).toBe(409);
    expect((r.body as { reason: string }).reason).toMatch(/terminal|frozen/);
  });

  it('L-IDEM: a replayed update returns the stored response, not a spurious config_version 409', async () => {
    const id = await start();
    const first = await router.handle(
      req('POST', `/v1/run/${id}/update`, 'owner', {
        muted: true,
        config_version: 0,
        idempotency_key: 'u1',
      }),
    );
    expect(first.status).toBe(200);
    expect((first.body as { config_version: number }).config_version).toBe(1);
    // Same key + same body, but config_version has moved on. Without the durable
    // receipt this would 409; the receipt replays the original 200.
    const replay = await router.handle(
      req('POST', `/v1/run/${id}/update`, 'owner', {
        muted: true,
        config_version: 0,
        idempotency_key: 'u1',
      }),
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { config_version: number }).config_version).toBe(1);
  });

  it('L-IDEM: a replayed ttl_seconds start returns the SAME run_id (raw-body hash, not derived expires_at)', async () => {
    // The request hash must key on the raw ttl_seconds, not the derived absolute
    // expires_at (which is now-dependent), so a genuine retry replays the stored
    // 201 instead of a spurious "key reused" 409.
    const body = startBody({ idempotency_key: 'ttl-1', ttl_seconds: 3600 });
    const first = await router.handle(req('POST', '/v1/run/start', 'owner', body));
    expect(first.status).toBe(201);
    const runId = (first.body as { run_id: string }).run_id;
    const replay = await router.handle(req('POST', '/v1/run/start', 'owner', body));
    expect(replay.status).toBe(201);
    expect((replay.body as { run_id: string }).run_id).toBe(runId);
  });

  it('L-IDEM: a same-key start with a DIFFERENT body is a 409 (key reuse)', async () => {
    const a = await router.handle(
      req('POST', '/v1/run/start', 'owner', startBody({ idempotency_key: 's1', persona: 'general' })),
    );
    expect(a.status).toBe(201);
    const b = await router.handle(
      req('POST', '/v1/run/start', 'owner', startBody({ idempotency_key: 's1', persona: 'work' })),
    );
    expect(b.status).toBe(409);
  });

  it('L-BOUNDARY: GET /v1/run/list is owner-only and returns display DTOs', async () => {
    const id = await start();
    // non-owner rejected
    for (const ct of ['brain', 'agent', undefined]) {
      expect((await router.handle(req('GET', '/v1/run/list', ct))).status).toBe(403);
    }
    const list = await router.handle(req('GET', '/v1/run/list', 'owner'));
    expect(list.status).toBe(200);
    const runs = (list.body as { runs: { run_id: string; state: string }[] }).runs;
    expect(runs.some((r) => r.run_id === id && r.state === 'active')).toBe(true);
    // the DTO never leaks raw config/crypto fields
    expect(runs[0]).not.toHaveProperty('erasure_mode');
    expect(runs[0]).not.toHaveProperty('provider_grant_id');
  });

  it('R2-07: an owner mutation without a durable idempotency_key is rejected (400)', async () => {
    const id = await start();
    for (const path of [
      `/v1/run/${id}/pause`,
      `/v1/run/${id}/resume`,
      `/v1/run/${id}/stop`,
      `/v1/run/${id}/update`,
    ]) {
      // idempotency_key: '' suppresses the helper's default so the route sees a
      // missing key.
      const r = await router.handle(req('POST', path, 'owner', { idempotency_key: '', config_version: 0 }));
      expect(r.status).toBe(400);
      expect((r.body as { field: string }).field).toBe('idempotency_key');
    }
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
    const router = createCoreRouter({ ownerCapability: OWNER_CAP });
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
