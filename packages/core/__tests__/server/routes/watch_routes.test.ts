/**
 * PSVC-4 — owner-only `/v1/watch/*` management API. Same boundary as
 * `/v1/run/*` (§12.5): a non-owner caller is rejected; the owner lists + steers.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerWatchRoutes, type WatchListItem } from '../../../src/server/routes/watch';
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

  it('rejects every non-owner caller on list + steer (403)', async () => {
    const routes: [CoreRequest['method'], string][] = [
      ['GET', '/v1/watch/list'],
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
