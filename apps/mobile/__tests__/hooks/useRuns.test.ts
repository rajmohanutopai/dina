/**
 * ISVC-9 — `useRuns` data hook. Drives the list/steer functions through the
 * owner-only control client (InProcessOwnerRunClient → /v1/run/* route guards),
 * the same owner-marked dispatch mobile boot registers via `setOwnerRunClient` —
 * NOT the raw `getRunService()` global (which Brain shares in-process, §20).
 */

import {
  RunService,
  setRunService,
  setRunRepository,
  InMemoryRunRepository,
  InProcessOwnerRunClient,
  createCoreRouter,
} from '@dina/core';

import { getActiveRuns, pauseRun, resumeRun, stopRun } from '../../src/hooks/useRuns';
import { setOwnerRunClient } from '../../src/services/owner_run_client';

const NOW = 1_700_000_000_000;

function wireRuns(): RunService {
  const repo = new InMemoryRunRepository();
  setRunRepository(repo);
  const svc = new RunService({ repository: repo, nowMsFn: () => NOW });
  setRunService(svc);
  // The owner UI reaches runs ONLY through this owner-marked dispatch.
  setOwnerRunClient(new InProcessOwnerRunClient(createCoreRouter({ ownerCapability: 'test-owner-cap' }), 'test-owner-cap'));
  return svc;
}

function makeRun(svc: RunService, key: string): string {
  return svc.create({
    service_uri: 'at://did:plc:prov/x/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: key,
    expires_at: NOW + 3_600_000,
    max_count: 10,
  }).run_id;
}

afterEach(() => {
  setRunService(null);
  setRunRepository(null);
  setOwnerRunClient(null);
});

describe('useRuns', () => {
  it('returns [] when no owner client is wired', async () => {
    setOwnerRunClient(null);
    expect(await getActiveRuns()).toEqual([]);
  });

  it('lists active runs with a progress label', async () => {
    const svc = wireRuns();
    makeRun(svc, 'r-1');
    const items = await getActiveRuns();
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe('active');
    expect(items[0].progressLabel).toBe('0 / 10');
    expect(items[0].provider_did).toBe('did:plc:prov');
    expect(items[0].terminal).toBe(false);
  });

  it('pause → paused; resume → active; stop → draining', async () => {
    const svc = wireRuns();
    const id = makeRun(svc, 'r-1');
    expect(await pauseRun(id)).toBe('paused');
    expect(await resumeRun(id)).toBe('active');
    expect(await stopRun(id)).toBe('draining');
  });

  it('steering a missing run is a safe null (no throw)', async () => {
    wireRuns();
    expect(await pauseRun('nope')).toBeNull();
    expect(await resumeRun('nope')).toBeNull();
    expect(await stopRun('nope')).toBeNull();
  });
});
