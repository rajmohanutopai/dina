/**
 * ISVC-1 — RunService lifecycle (create + steer + barrier composition).
 * INTERACTIVE_SERVICES_ARCHITECTURE.md §5/§5.1/§12.5.
 */

import { InMemoryRunRepository, RunConflictError } from '../../src/run/repository';
import { RunNotFoundError, RunService } from '../../src/run/service';

import type { CreateRunParams } from '../../src/run/domain';

const NOW = 1_700_000_000_000;

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

function setup(nowMs = NOW) {
  let seq = 0;
  const repo = new InMemoryRunRepository();
  const service = new RunService({
    repository: repo,
    nowMsFn: () => nowMs,
    idFn: () => `run-test-${++seq}`,
  });
  return { repo, service };
}

function params(over: Partial<CreateRunParams> = {}): CreateRunParams {
  return {
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: 'idem-1',
    expires_at: NOW + 3_600_000,
    ...over,
  };
}

describe('RunService.create', () => {
  it('creates an active pull run with a fresh cursor and immediate next_fetch', () => {
    const { service } = setup();
    const run = service.create(params());
    expect(run.state).toBe('active');
    expect(run.transport).toBe('pull');
    expect(run.fetch_cursor).toBe(0);
    expect(run.next_fetch_at).toBe(NOW);
    expect(run.config_version).toBe(0);
    expect(run.produced_count).toBe(0);
  });

  it('is idempotent by idempotency_key (returns the same live run)', () => {
    const { service } = setup();
    const a = service.create(params({ idempotency_key: 'k' }));
    const b = service.create(params({ idempotency_key: 'k' }));
    expect(b.run_id).toBe(a.run_id);
  });

  it('a fresh key mints a distinct run', () => {
    const { service } = setup();
    const a = service.create(params({ idempotency_key: 'k1' }));
    const b = service.create(params({ idempotency_key: 'k2' }));
    expect(b.run_id).not.toBe(a.run_id);
  });

  it('rejects a duplicate run_id from a colliding id generator', () => {
    const repo = new InMemoryRunRepository();
    const service = new RunService({ repository: repo, nowMsFn: () => NOW, idFn: () => 'dup' });
    service.create(params({ idempotency_key: 'a' }));
    expect(() => service.create(params({ idempotency_key: 'b' }))).toThrow(RunConflictError);
  });
});

describe('RunService steer — state-gated, version-unconditional (§5.1)', () => {
  it('pause only active→paused; resume only paused→active', () => {
    const { service } = setup();
    const run = service.create(params());
    expect(service.pause(run.run_id).state).toBe('paused');
    // pause again is an idempotent no-op (stays paused)
    expect(service.pause(run.run_id).state).toBe('paused');
    expect(service.resume(run.run_id).state).toBe('active');
    // resume on active is a no-op
    expect(service.resume(run.run_id).state).toBe('active');
  });

  it('stop opens a fencing barrier for cancel_pending (default)', () => {
    const { service, repo } = setup();
    const run = service.create(params({ on_stop: 'cancel_pending' }));
    expect(service.stop(run.run_id).state).toBe('draining');
    const r = need(repo.getById(run.run_id));
    expect(r.drain_cause).toBe('cancel_pending');
    expect(r.drain_strength).toBe('fencing');
    expect(r.drain_deadline_at).not.toBeNull();
  });

  it('stop opens a permissive barrier for finish_pending', () => {
    const { service, repo } = setup();
    const run = service.create(params({ on_stop: 'finish_pending' }));
    service.stop(run.run_id);
    const r = need(repo.getById(run.run_id));
    expect(r.drain_cause).toBe('finish_pending');
    expect(r.drain_strength).toBe('permissive');
  });

  it('a cancel_pending stop STRENGTHENS an in-progress permissive drain', () => {
    const { service, repo } = setup();
    const run = service.create(params({ on_stop: 'finish_pending' }));
    service.stop(run.run_id); // permissive
    service.stop(run.run_id, 'cancel_pending'); // strengthen → fencing
    const r = need(repo.getById(run.run_id));
    expect(r.drain_strength).toBe('fencing');
    expect(r.drain_cause).toBe('cancel_pending');
  });

  it('a finish_pending stop NEVER weakens a fencing drain (idempotent no-op)', () => {
    const { service, repo } = setup();
    const run = service.create(params({ on_stop: 'cancel_pending' }));
    service.stop(run.run_id); // fencing
    service.stop(run.run_id, 'finish_pending'); // no-op
    const r = need(repo.getById(run.run_id));
    expect(r.drain_strength).toBe('fencing');
    expect(r.drain_cause).toBe('cancel_pending');
  });

  it('stop on a terminal run is a no-op', () => {
    const { service } = setup();
    const run = service.create(params());
    service.stop(run.run_id);
    service.finalize(run.run_id); // → stopped
    expect(need(service.get(run.run_id)).state).toBe('stopped');
    // stop again does nothing
    expect(service.stop(run.run_id).state).toBe('stopped');
  });

  it('finalize maps the drain cause to the terminal state', () => {
    const { service } = setup();
    const cancel = service.create(params({ idempotency_key: 'c', on_stop: 'cancel_pending' }));
    service.stop(cancel.run_id);
    expect(service.finalize(cancel.run_id).state).toBe('stopped');

    const finish = service.create(params({ idempotency_key: 'f', on_stop: 'finish_pending' }));
    service.stop(finish.run_id);
    expect(service.finalize(finish.run_id).state).toBe('stopped');
  });

  it('throws RunNotFoundError for an unknown run', () => {
    const { service } = setup();
    expect(() => service.pause('nope')).toThrow(RunNotFoundError);
  });
});

describe('RunService.updateConfig — config_version CAS (§12.5)', () => {
  it('applies a patch and bumps config_version', () => {
    const { service } = setup();
    const run = service.create(params());
    const v = service.updateConfig(run.run_id, { queue_cap: 8, muted: true }, 0);
    expect(v).toBe(1);
    const r = need(service.get(run.run_id));
    expect(r.queue_cap).toBe(8);
    expect(r.muted).toBe(true);
  });

  it('rejects a stale config_version', () => {
    const { service } = setup();
    const run = service.create(params());
    service.updateConfig(run.run_id, { muted: true }, 0); // → v1
    expect(service.updateConfig(run.run_id, { muted: false }, 0)).toBeNull();
  });
});
