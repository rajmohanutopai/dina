/**
 * PSVC-4 — owner-only `/v1/watch/*` management API. Same boundary as
 * `/v1/run/*` (§12.5): a non-owner caller is rejected; the owner lists + steers.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWatchRoutes, type WatchListItem } from '../../../src/server/routes/watch';
import { parseWatchPollPayload } from '../../../src/watch/payload';
import { WatchService, setWatchService } from '../../../src/watch/service';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';

const NOW = 1_700_000_000_000;
const OWNER_CAP = 'test-owner-capability-secret';

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
    // Only the genuine owner holds the boot-minted capability (F15).
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

const NON_OWNER: (string | undefined)[] = [undefined, 'brain', 'agent', 'plugin', 'connector', 'device', 'service'];

describe('/v1/watch/* — owner boundary + management', () => {
  let router: CoreRouter;
  let svc: WatchService;

  function makeWatch(sub: string): string {
    return svc.createPollWatch({
      subscription_id: sub,
      persona: 'general',
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      capability: 'flight_status',
      query: { flight: 'BA117' },
      poll_interval_sec: 300,
      condition: 'delay > 30m',
    }).id;
  }

  beforeEach(() => {
    svc = new WatchService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW });
    setWatchService(svc);
    router = new CoreRouter();
    registerWatchRoutes(router, OWNER_CAP);
  });

  afterEach(() => setWatchService(null));

  it('rejects every non-owner caller on list + steer + create (403)', async () => {
    const routes: [CoreRequest['method'], string][] = [
      ['GET', '/v1/watch/list'],
      ['POST', '/v1/watch/create'],
      ['POST', '/v1/watch/w1/pause'],
      ['POST', '/v1/watch/w1/resume'],
      ['POST', '/v1/watch/w1/cancel'],
    ];
    for (const [method, path] of routes) {
      for (const ct of NON_OWNER) {
        const resp = await router.handle(req(method, path, ct));
        expect(resp.status).toBe(403);
      }
    }
  });

  it('owner creates a watch (#7) → 201, and it appears in the active list', async () => {
    const createBody = {
      subscription_id: 'sub-new',
      persona: 'general',
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      capability: 'flight_status',
      poll_interval_sec: 300,
      query: { flight: 'BA117' },
    };
    const created = await router.handle(req('POST', '/v1/watch/create', 'owner', createBody));
    expect(created.status).toBe(201);
    expect((created.body as { subscription_id: string }).subscription_id).toBe('sub-new');

    const list = (
      (await router.handle(req('GET', '/v1/watch/list', 'owner'))).body as { watches: WatchListItem[] }
    ).watches;
    expect(list.map((w) => w.subscription_id)).toContain('sub-new');
  });

  it('owner create is idempotent on subscription_id (#7)', async () => {
    const body = {
      subscription_id: 'sub-idem',
      persona: 'general',
      service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
      provider_did: 'did:plc:prov',
      capability: 'flight_status',
      poll_interval_sec: 300,
    };
    const a = await router.handle(req('POST', '/v1/watch/create', 'owner', body));
    const b = await router.handle(req('POST', '/v1/watch/create', 'owner', body));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body as { watch_id: string }).watch_id).toBe((b.body as { watch_id: string }).watch_id);
    const list = (
      (await router.handle(req('GET', '/v1/watch/list', 'owner'))).body as { watches: WatchListItem[] }
    ).watches;
    expect(list.filter((w) => w.subscription_id === 'sub-idem')).toHaveLength(1);
  });

  it('owner create rejects a missing required field (400)', async () => {
    const resp = await router.handle(
      req('POST', '/v1/watch/create', 'owner', { subscription_id: 'sub-x', persona: 'general' }),
    );
    expect(resp.status).toBe(400);
  });

  it('owner create persists a wake filter, retrievable via deliveryPolicyFor (R2-04/R3-02)', async () => {
    const resp = await router.handle(
      req('POST', '/v1/watch/create', 'owner', {
        subscription_id: 'sub-flt',
        persona: 'general',
        service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
        provider_did: 'did:plc:prov',
        capability: 'flight_status',
        poll_interval_sec: 300,
        filter: { contains: 'delayed' },
      }),
    );
    expect(resp.status).toBe(201);
    expect(svc.deliveryPolicyFor('sub-flt')).toEqual({ active: true, filter: { contains: 'delayed' } });
    // R5-07 — a PRESENT-but-malformed filter is REJECTED (400), never silently
    // dropped to "fire always"; the watch is not created (fail closed).
    const bad = await router.handle(
      req('POST', '/v1/watch/create', 'owner', {
        subscription_id: 'sub-badfilter',
        persona: 'general',
        service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
        provider_did: 'did:plc:prov',
        capability: 'flight_status',
        poll_interval_sec: 300,
        filter: { contains: '' },
      }),
    );
    expect(bad.status).toBe(400);
    expect(svc.deliveryPolicyFor('sub-badfilter')).toEqual({ active: false });
  });

  it('floors the poll interval at the provider freshness (never polls faster than the data changes)', async () => {
    // Requester asks for 60s but the provider declares 300s freshness → the
    // watch polls every 300s (asking sooner only burns cost).
    const resp = await router.handle(
      req('POST', '/v1/watch/create', 'owner', {
        subscription_id: 'sub-fresh',
        persona: 'general',
        service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
        provider_did: 'did:plc:prov',
        capability: 'eta_query',
        poll_interval_sec: 60,
        freshness_sec: 300,
      }),
    );
    expect(resp.status).toBe(201);
    expect((resp.body as { watch?: WatchListItem }).watch?.poll_interval_sec).toBe(300);
  });

  it('owner create pins a schema_hash into the stored payload (GAP-SH-01 forwarding)', async () => {
    // A provider that publishes a versioned schema rejects a hash-less poll as
    // `schema_hash_required`; the subscription must pin + persist the hash so the
    // sweeper forwards it on every fire.
    const resp = await router.handle(
      req('POST', '/v1/watch/create', 'owner', {
        subscription_id: 'sub-hash',
        persona: 'general',
        service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/route-42',
        provider_did: 'did:plc:prov',
        capability: 'eta_query',
        poll_interval_sec: 300,
        schema_hash: 'deadbeef',
      }),
    );
    expect(resp.status).toBe(201);
    const task = svc.listActive().find((t) => t.description.includes('eta_query'));
    expect(parseWatchPollPayload(task?.payload)?.schema_hash).toBe('deadbeef');
  });

  it('owner lists active watches with display fields', async () => {
    makeWatch('sub-1');
    const resp = await router.handle(req('GET', '/v1/watch/list', 'owner'));
    expect(resp.status).toBe(200);
    const items = (resp.body as { watches: WatchListItem[] }).watches;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subscription_id: 'sub-1',
      persona: 'general',
      provider_did: 'did:plc:prov',
      capability: 'flight_status',
      condition: 'delay > 30m',
      poll_interval_sec: 300,
      status: 'active',
    });
    expect(items[0].next_run_at).toBe(Math.floor(NOW / 1000) + 300);
  });

  it('owner pauses → status paused; resume → active; cancel → gone from list', async () => {
    const id = makeWatch('sub-1');

    expect((await router.handle(req('POST', `/v1/watch/${id}/pause`, 'owner'))).status).toBe(200);
    let items = (
      (await router.handle(req('GET', '/v1/watch/list', 'owner'))).body as { watches: WatchListItem[] }
    ).watches;
    expect(items[0].status).toBe('paused');
    expect(items[0].next_run_at).toBeNull();

    expect((await router.handle(req('POST', `/v1/watch/${id}/resume`, 'owner'))).status).toBe(200);
    items = ((await router.handle(req('GET', '/v1/watch/list', 'owner'))).body as { watches: WatchListItem[] })
      .watches;
    expect(items[0].status).toBe('active');

    expect((await router.handle(req('POST', `/v1/watch/${id}/cancel`, 'owner'))).status).toBe(200);
    items = ((await router.handle(req('GET', '/v1/watch/list', 'owner'))).body as { watches: WatchListItem[] })
      .watches;
    expect(items).toHaveLength(0); // cancelled watches leave the active list
  });

  it('steering an unknown watch is a 404', async () => {
    const resp = await router.handle(req('POST', '/v1/watch/nope/cancel', 'owner'));
    expect(resp.status).toBe(404);
  });

  it('503 when the watch service is not wired', async () => {
    setWatchService(null);
    const resp = await router.handle(req('GET', '/v1/watch/list', 'owner'));
    expect(resp.status).toBe(503);
  });
});
