/**
 * PSVC-4 — `useSubscriptions` data hook. Drives the list/steer functions through
 * the owner-only control client (InProcessOwnerRunClient → /v1/watch/* route
 * guards), the same owner-marked dispatch mobile boot registers via
 * `setOwnerRunClient` — NOT the raw `getWatchService()` global (§20).
 */

import {
  WatchService,
  setWatchService,
  InMemoryWorkflowRepository,
  InProcessOwnerRunClient,
  createCoreRouter,
  parseWatchPollPayload,
} from '@dina/core';

import {
  getActiveSubscriptions,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  createSubscription,
} from '../../src/hooks/useSubscriptions';
import { setOwnerRunClient } from '../../src/services/owner_run_client';

const NOW = 1_700_000_000_000;

function wireWatch(): WatchService {
  const svc = new WatchService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW });
  setWatchService(svc);
  // The owner UI reaches watches ONLY through this owner-marked dispatch.
  setOwnerRunClient(new InProcessOwnerRunClient(createCoreRouter({ ownerCapability: 'test-owner-cap' }), 'test-owner-cap'));
  return svc;
}

function makeWatch(svc: WatchService, sub: string, intervalSec = 300): string {
  return svc.createPollWatch({
    subscription_id: sub,
    persona: 'general',
    service_uri: 'at://did:plc:prov/x/self',
    provider_did: 'did:plc:prov',
    capability: 'flight_status',
    poll_interval_sec: intervalSec,
    condition: 'delay > 30m',
  }).id;
}

afterEach(() => {
  setWatchService(null);
  setOwnerRunClient(null);
});

describe('useSubscriptions', () => {
  it('returns [] when no owner client is wired', async () => {
    setOwnerRunClient(null);
    expect(await getActiveSubscriptions()).toEqual([]);
  });

  it('lists active subscriptions with a human cadence label', async () => {
    const svc = wireWatch();
    makeWatch(svc, 'sub-1', 300); // 5 min
    makeWatch(svc, 'sub-2', 3600); // 1 hour
    const items = await getActiveSubscriptions();
    expect(items.map((i) => i.subscription_id).sort()).toEqual(['sub-1', 'sub-2']);
    const bySub = Object.fromEntries(items.map((i) => [i.subscription_id, i]));
    expect(bySub['sub-1'].cadenceLabel).toBe('every 5 min');
    expect(bySub['sub-1'].status).toBe('active');
    expect(bySub['sub-2'].cadenceLabel).toBe('every hour');
    expect(bySub['sub-1'].condition).toBe('delay > 30m');
  });

  it('pause → paused status; resume → active; cancel → gone', async () => {
    const svc = wireWatch();
    const id = makeWatch(svc, 'sub-1');

    expect(await pauseSubscription(id)).toBe(true);
    let items = await getActiveSubscriptions();
    expect(items[0].status).toBe('paused');

    expect(await resumeSubscription(id)).toBe(true);
    items = await getActiveSubscriptions();
    expect(items[0].status).toBe('active');

    expect(await cancelSubscription(id)).toBe(true);
    items = await getActiveSubscriptions();
    expect(items).toHaveLength(0);
  });

  it('steering with no owner client wired is a safe no-op (false)', async () => {
    setOwnerRunClient(null);
    expect(await pauseSubscription('x')).toBe(false);
    expect(await resumeSubscription('x')).toBe(false);
    expect(await cancelSubscription('x')).toBe(false);
  });

  describe('createSubscription (#7 / R3-06 / R2-04)', () => {
    const baseInput = {
      persona: 'general',
      serviceUri: 'at://did:plc:prov/x/self',
      providerDid: 'did:plc:prov',
      capability: 'flight_status',
      pollIntervalSec: 300,
    };

    it('parses the target string into a poll query and the condition into a wake filter', async () => {
      const svc = wireWatch();
      const watchId = await createSubscription({ ...baseInput, target: 'flight=BA117', condition: 'delayed' });
      expect(watchId).not.toBeNull();
      const active = svc.listActive();
      expect(active).toHaveLength(1);
      const payload = parseWatchPollPayload(active[0].payload);
      // R3-06 — the poll TARGET (what to poll) becomes the query params...
      expect(payload?.query).toEqual({ flight: 'BA117' });
      // R2-04 — ...and the wake CONDITION (when to notify) becomes the filter.
      expect(payload?.filter).toEqual({ contains: 'delayed' });
      expect(payload?.condition).toBe('delayed');
    });

    it('an explicit query object wins over the target string', async () => {
      const svc = wireWatch();
      await createSubscription({ ...baseInput, query: { flight: 'AA1' }, target: 'flight=BA117' });
      expect(parseWatchPollPayload(svc.listActive()[0].payload)?.query).toEqual({ flight: 'AA1' });
    });

    it('omitting the condition sets no wake filter (fire on every poll)', async () => {
      const svc = wireWatch();
      await createSubscription({ ...baseInput });
      expect(parseWatchPollPayload(svc.listActive()[0].payload)?.filter).toBeUndefined();
    });

    it('returns null when no owner client is wired', async () => {
      setOwnerRunClient(null);
      expect(await createSubscription({ ...baseInput })).toBeNull();
    });
  });
});
