/**
 * PSVC-4 — `useSubscriptions` data hook. Drives the pure list/steer functions
 * against a wired in-process `WatchService` (the same singleton mobile boot
 * registers), so the subscription screen's data path is pinned without
 * `@testing-library/react-native`.
 */

import { WatchService, setWatchService, InMemoryWorkflowRepository } from '@dina/core';

import {
  getActiveSubscriptions,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
} from '../../src/hooks/useSubscriptions';

const NOW = 1_700_000_000_000;

function wireWatch(): WatchService {
  const svc = new WatchService({ repository: new InMemoryWorkflowRepository(), nowMsFn: () => NOW });
  setWatchService(svc);
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

afterEach(() => setWatchService(null));

describe('useSubscriptions', () => {
  it('returns [] when no watch service is wired', async () => {
    setWatchService(null);
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

  it('steering with no service wired is a safe no-op (false)', async () => {
    setWatchService(null);
    expect(await pauseSubscription('x')).toBe(false);
    expect(await resumeSubscription('x')).toBe(false);
    expect(await cancelSubscription('x')).toBe(false);
  });
});
