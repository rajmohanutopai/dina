/**
 * ISVC-9 — `useRuns` data hook. Drives the pure list/steer functions against a
 * wired in-process `RunService` (the same singleton mobile boot registers).
 */

import { RunService, setRunService, InMemoryRunRepository } from '@dina/core';

import { getActiveRuns, pauseRun, resumeRun, stopRun } from '../../src/hooks/useRuns';

const NOW = 1_700_000_000_000;

function wireRuns(): RunService {
  const svc = new RunService({ repository: new InMemoryRunRepository(), nowMsFn: () => NOW });
  setRunService(svc);
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

afterEach(() => setRunService(null));

describe('useRuns', () => {
  it('returns [] when no run service is wired', async () => {
    setRunService(null);
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
