/**
 * ISVC-1 — SQLiteRunRepository validated against a REAL SQLite engine (the v20
 * migration + every CAS statement). Runs the identical assertions the in-memory
 * repo would, so the SQL is proven, not just the Map. INTERACTIVE §5/§13.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  InMemoryRunRepository,
  RunConflictError,
  SQLiteRunRepository,
  type RunRepository,
} from '../../src/run/repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { RunRecord } from '../../src/run/domain';

const NOW = 1_700_000_000_000;

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run-1',
    idempotency_key: 'idem-1',
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    transport: 'pull',
    push_grant_ref: null,
    provider_grant_id: null,
    provider_grant_expires_at_sec: null,
    interval_ms: 60_000,
    next_fetch_at: NOW,
    queue_cap: 4,
    action_risk_ceiling: 'MODERATE',
    priority_ceiling: 'solicited',
    classify_timeout_ms: 15_000,
    muted: false,
    on_stop: 'cancel_pending',
    erasure_mode: 'logical_deletion',
    paused_reason: null,
    stop_on_command: true,
    max_count: null,
    max_count_basis: 'decided',
    stop_on_exhaustion: true,
    expires_at: NOW + 3_600_000,
    drain_deadline_ms: 60_000,
    drain_deadline_at: null,
    drain_cause: null,
    drain_strength: null,
    config_version: 0,
    fetch_cursor: 0,
    last_commit_at: null,
    produced_count: 0,
    decided_count: 0,
    state: 'active',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function runSuite(makeRepo: () => RunRepository): void {
  it('round-trips a run record', () => {
    const repo = makeRepo();
    const run = makeRun();
    repo.create(run);
    expect(repo.getById('run-1')).toEqual(run);
    expect(repo.getByIdempotencyKey('idem-1')?.run_id).toBe('run-1');
    expect(repo.size()).toBe(1);
  });

  it('rejects a duplicate live idempotency key', () => {
    const repo = makeRepo();
    repo.create(makeRun({ run_id: 'a', idempotency_key: 'k' }));
    expect(() => repo.create(makeRun({ run_id: 'b', idempotency_key: 'k' }))).toThrow(
      RunConflictError,
    );
  });

  it('a terminal run frees its idempotency key for reuse', () => {
    const repo = makeRepo();
    repo.create(makeRun({ run_id: 'a', idempotency_key: 'k', state: 'draining' }));
    repo.finalize('a', 'stopped', NOW);
    // now the key is free
    repo.create(makeRun({ run_id: 'b', idempotency_key: 'k' }));
    expect(repo.getById('b')).not.toBeNull();
  });

  it('rejects a duplicate run_id', () => {
    const repo = makeRepo();
    repo.create(makeRun({ run_id: 'x', idempotency_key: 'k1' }));
    expect(() => repo.create(makeRun({ run_id: 'x', idempotency_key: 'k2' }))).toThrow(
      RunConflictError,
    );
  });

  it('CAS state transition only fires from the expected state and stamps updated_at', () => {
    const repo = makeRepo();
    repo.create(makeRun());
    expect(repo.transitionState('run-1', 'active', 'paused', NOW + 500)).toBe(true);
    expect(repo.transitionState('run-1', 'active', 'draining', NOW)).toBe(false);
    const r = repo.getById('run-1');
    expect(r?.state).toBe('paused');
    expect(r?.updated_at).toBe(NOW + 500); // stamped on the successful transition
  });

  it('pause/resume are state-gated', () => {
    const repo = makeRepo();
    repo.create(makeRun());
    expect(repo.pause('run-1', NOW)).toBe(true);
    expect(repo.pause('run-1', NOW)).toBe(false); // already paused
    expect(repo.resume('run-1', NOW)).toBe(true);
    expect(repo.resume('run-1', NOW)).toBe(false); // already active
  });

  it('resume clears paused_reason', () => {
    const repo = makeRepo();
    repo.create(makeRun());
    repo.pause('run-1', NOW);
    repo.setPausedReason('run-1', 'provider_grant_unavailable', NOW);
    expect(repo.getById('run-1')?.paused_reason).toBe('provider_grant_unavailable');
    repo.resume('run-1', NOW);
    expect(repo.getById('run-1')?.paused_reason).toBeNull();
  });

  it('applyBarrier sets draining + drain fields; finalize is draining-gated', () => {
    const repo = makeRepo();
    repo.create(makeRun());
    expect(repo.applyBarrier('run-1', 'cancel_pending', 'fencing', NOW + 60_000, NOW)).toBe(true);
    const r = repo.getById('run-1');
    expect(r?.state).toBe('draining');
    expect(r?.drain_cause).toBe('cancel_pending');
    expect(r?.drain_strength).toBe('fencing');
    expect(r?.drain_deadline_at).toBe(NOW + 60_000);
    expect(repo.finalize('run-1', 'stopped', NOW)).toBe(true);
    expect(repo.getById('run-1')?.state).toBe('stopped');
    // finalize on a terminal run is a no-op
    expect(repo.finalize('run-1', 'completed', NOW)).toBe(false);
  });

  it('applyBarrier is a no-op on a terminal run', () => {
    const repo = makeRepo();
    repo.create(makeRun({ state: 'draining' }));
    repo.finalize('run-1', 'expired', NOW);
    expect(repo.applyBarrier('run-1', 'expiry', 'fencing', NOW, NOW)).toBe(false);
  });

  it('updateConfig CAS bumps version and applies the patch; stale version rejected', () => {
    const repo = makeRepo();
    repo.create(makeRun());
    expect(repo.updateConfig('run-1', { queue_cap: 8, muted: true }, 0, NOW)).toBe(1);
    const r = repo.getById('run-1');
    expect(r?.queue_cap).toBe(8);
    expect(r?.muted).toBe(true);
    expect(repo.updateConfig('run-1', { muted: false }, 0, NOW)).toBeNull();
  });

  it('listByState / listActive filter correctly', () => {
    const repo = makeRepo();
    repo.create(makeRun({ run_id: 'a', idempotency_key: 'ka' }));
    repo.create(makeRun({ run_id: 'b', idempotency_key: 'kb', state: 'draining' }));
    repo.finalize('b', 'stopped', NOW);
    expect(repo.listByState('active').map((r) => r.run_id)).toEqual(['a']);
    expect(repo.listActive().map((r) => r.run_id)).toEqual(['a']);
  });
}

describe('InMemoryRunRepository', () => {
  runSuite(() => new InMemoryRunRepository());
});

describe('SQLiteRunRepository (real SQLite, v20 migration)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  runSuite(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'isvc1-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    return new SQLiteRunRepository(adapter);
  });

  afterEach(() => {
    adapter?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
