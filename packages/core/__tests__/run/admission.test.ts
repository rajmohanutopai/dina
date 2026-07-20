/**
 * ISVC-3 — atomic bounded-queue admission + pull pacing
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§8/§18). SQLite-backed so the
 * barrier-guarded enqueue-commit CAS + rollback are exercised for real.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { AdmissionService, type AdmissionCounts } from '../../src/run/admission';
import { SQLiteRunRepository } from '../../src/run/repository';
import { SQLiteReservationRepository } from '../../src/run/reservation';
import { RunService } from '../../src/run/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CreateRunParams } from '../../src/run/domain';

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

const NOW = 1_700_000_000_000;

let dir: string;
let adapter: NodeSQLiteAdapter;

interface Harness {
  runService: RunService;
  runRepo: SQLiteRunRepository;
  resRepo: SQLiteReservationRepository;
  admission: AdmissionService;
  setNow: (ms: number) => void;
  now: () => number;
  setPersonaOpen: (v: boolean) => void;
}

let enqueuedUndecided = 0;

function setup(): Harness {
  dir = mkdtempSync(path.join(tmpdir(), 'isvc3-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const runRepo = new SQLiteRunRepository(adapter);
  const resRepo = new SQLiteReservationRepository(adapter);
  let nowMs = NOW;
  let personaOpen = true;
  const runService = new RunService({ repository: runRepo, nowMsFn: () => nowMs });
  const counts: AdmissionCounts = { enqueuedUndecided: () => enqueuedUndecided };
  const admission = new AdmissionService({
    runRepo,
    reservationRepo: resRepo,
    tx: (fn) => adapter.transaction(fn),
    counts,
    isPersonaOpen: () => personaOpen,
    nowMsFn: () => nowMs,
    leaseMs: 60_000,
  });
  return {
    runService,
    runRepo,
    resRepo,
    admission,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    now: () => nowMs,
    setPersonaOpen: (v: boolean) => {
      personaOpen = v;
    },
  };
}

afterEach(() => {
  enqueuedUndecided = 0;
  adapter?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runParams(over: Partial<CreateRunParams> = {}): CreateRunParams {
  return {
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: `idem-${Math.random()}`,
    interval_ms: 0, // eligible to fetch immediately after each commit
    expires_at: NOW + 3_600_000,
    ...over,
  };
}

describe('reserve — eligibility gates (§7)', () => {
  it('opens a slot when every gate holds', () => {
    const h = setup();
    const run = h.runService.create(runParams());
    const r = h.admission.reserve(run.run_id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cursor).toBe(0);
    expect(h.resRepo.countOpen(run.run_id)).toBe(1);
  });

  it('rejects when the run is not active (paused / draining)', () => {
    const h = setup();
    const run = h.runService.create(runParams());
    h.runService.pause(run.run_id);
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'not_active' });
    h.runService.resume(run.run_id);
    h.runService.stop(run.run_id); // → draining
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'not_active' });
  });

  it('rejects past the hard TTL', () => {
    const h = setup();
    const run = h.runService.create(runParams({ expires_at: NOW + 1000 }));
    h.setNow(NOW + 2000);
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'past_ttl' });
  });

  it('rejects before the pull cadence has elapsed', () => {
    const h = setup();
    const run = h.runService.create(runParams({ interval_ms: 10_000 }));
    // first reserve + commit advances next_fetch_at = now + 10s
    const r1 = h.admission.reserve(run.run_id);
    if (!r1.ok) throw new Error('reserve failed');
    h.admission.commit(r1.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' });
    // still within the interval → cadence_not_elapsed
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'cadence_not_elapsed' });
    h.setNow(NOW + 10_000);
    expect(h.admission.reserve(run.run_id).ok).toBe(true);
  });

  it('rejects when the queue is full (outstanding >= queue_cap)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 1 }));
    expect(h.admission.reserve(run.run_id).ok).toBe(true); // open reservation → outstanding 1
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'queue_full' });
  });

  it('rejects when the produced-basis count budget is exhausted', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 5, max_count: 2, max_count_basis: 'produced' }));
    // The budget gate counts open reservations (uncommitted_produced_reservations):
    // two open slots fill the produced budget before any commit sets the barrier.
    expect(h.admission.reserve(run.run_id).ok).toBe(true);
    expect(h.admission.reserve(run.run_id).ok).toBe(true);
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'count_exhausted' });
  });

  it('the commit taking produced_count to max_count sets the count barrier (§5.1)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 5, max_count: 1, max_count_basis: 'produced' }));
    const r = h.admission.reserve(run.run_id);
    if (!r.ok) throw new Error('reserve failed');
    h.admission.commit(r.reservation_id, { message_id: 'm0', dedup_key: 'd0', content_digest: 'c0' });
    // produced_count reached max_count → run drains; a further reserve is not_active
    expect(h.runRepo.getById(run.run_id)?.state).toBe('draining');
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'not_active' });
  });

  it('the produced-count barrier fires onBarrier IN-TX, invalidating any open slot (R2-02/§5.1)', () => {
    const h = setup();
    // Wire onBarrier (the composition wires this to RunTerminationService.onBarrier);
    // here it invalidates the run's open reservations, mirroring §5.1.
    const invalidated: string[] = [];
    const admission = new AdmissionService({
      runRepo: h.runRepo,
      reservationRepo: h.resRepo,
      tx: (fn) => adapter.transaction(fn),
      counts: { enqueuedUndecided: () => enqueuedUndecided },
      nowMsFn: h.now,
      leaseMs: 60_000,
      onBarrier: (run) => {
        for (const r of h.resRepo.invalidateOpen(run.run_id, h.now())) invalidated.push(r.reservation_id);
      },
    });
    const run = h.runService.create(runParams({ queue_cap: 5, max_count: 1, max_count_basis: 'produced' }));
    const r0 = admission.reserve(run.run_id);
    if (!r0.ok) throw new Error('reserve failed');

    // NOTE: under the produced-budget invariant `produced_count + open < max_count`
    // (checked at reserve, held_by_lock included), a commit reaching max_count has
    // NO open sibling — the barrier's invalidation set is normally empty. We inject
    // a stray open reservation to prove the wired hook invalidates ANY slot present
    // at barrier time IN THE COMMIT TX (defense-in-depth keeping every barrier path
    // uniform with RunService.applyTerminationCause; a future budget change can't
    // silently leave a fetch-ahead slot live past the cap).
    h.resRepo.create({
      reservation_id: 'stray',
      run_id: run.run_id,
      cursor: 9,
      state: 'reserved',
      message_id: null,
      dedup_key: null,
      content_digest: null,
      sealed_response_ref: null, held_message_json: null,
      error_reason: null,
      error_at: null,
      lease_expires_at: h.now() + 60_000,
      query_correlation_id: null,
      created_at: h.now(),
      updated_at: h.now(),
    });

    // Committing r0 takes produced_count to max_count → the count barrier is set →
    // onBarrier fires in the SAME tx and invalidates the stray open slot.
    expect(
      admission.commit(r0.reservation_id, { message_id: 'm0', dedup_key: 'd0', content_digest: 'c0' }).committed,
    ).toBe(true);
    expect(h.runRepo.getById(run.run_id)?.state).toBe('draining');
    // The committed slot is untouched; the stray open slot is invalidated.
    expect(invalidated).toEqual(['stray']);
    expect(h.resRepo.getById(r0.reservation_id)?.state).toBe('committed');
    expect(h.resRepo.getById('stray')?.state).toBe('released');
  });

  it('fetch-ahead reservations get DISTINCT cursors + commit strictly in order (RR-03/§7)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 3 }));
    const r1 = h.admission.reserve(run.run_id);
    const r2 = h.admission.reserve(run.run_id);
    if (!r1.ok || !r2.ok) throw new Error('reserve failed');
    // Distinct positions — the two fetch-ahead reservations do NOT both point at
    // cursor 0 (which would fetch the same provider item twice).
    expect(r1.cursor).toBe(0);
    expect(r2.cursor).toBe(1);

    // Out-of-order commit (position 1 while the run cursor is at 0) fails the
    // in-order CAS and releases the slot — no double/skip advance.
    expect(
      h.admission.commit(r2.reservation_id, { message_id: 'm2', dedup_key: 'd2', content_digest: 'c2' })
        .committed,
    ).toBe(false);
    expect(h.runRepo.getById(run.run_id)?.fetch_cursor).toBe(0);

    // In-order commit advances the run cursor exactly once.
    expect(
      h.admission.commit(r1.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' })
        .committed,
    ).toBe(true);
    expect(h.runRepo.getById(run.run_id)?.fetch_cursor).toBe(1);
  });

  it('a released reservation leaves NO cursor hole — the next reserve fills it (RR-03 R2)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 4 }));
    const r0 = h.admission.reserve(run.run_id);
    const r1 = h.admission.reserve(run.run_id);
    const r2 = h.admission.reserve(run.run_id);
    if (!r0.ok || !r1.ok || !r2.ok) throw new Error('reserve failed');
    expect([r0.cursor, r1.cursor, r2.cursor]).toEqual([0, 1, 2]);

    // Release the MIDDLE reservation (out-of-order commit fails + releases it):
    // open cursors are now {0, 2}, fetch_cursor still 0.
    expect(
      h.admission.commit(r1.reservation_id, { message_id: 'x', dedup_key: 'x', content_digest: 'x' })
        .committed,
    ).toBe(false);

    // The next reserve must FILL the hole (cursor 1), not re-hand cursor 2 (the
    // old `fetch_cursor + open` bug) and not leave an unfillable gap.
    const r1b = h.admission.reserve(run.run_id);
    if (!r1b.ok) throw new Error('reserve failed');
    expect(r1b.cursor).toBe(1);
  });

  it('rejects when the decided-basis budget is exhausted (via outstanding)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 5, max_count: 1, max_count_basis: 'decided' }));
    expect(h.admission.reserve(run.run_id).ok).toBe(true); // outstanding 1
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'count_exhausted' });
  });

  it('rejects when the persona is locked', () => {
    const h = setup();
    const run = h.runService.create(runParams());
    h.setPersonaOpen(false);
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'persona_locked' });
  });

  it('rejects when a bound provider grant has expired (mid-run, §10)', () => {
    const h = setup();
    const run = h.runService.create(
      runParams({ provider_grant_id: 'grant-1', provider_grant_expires_at_sec: Math.floor(NOW / 1000) - 10 }),
    );
    expect(h.admission.reserve(run.run_id)).toEqual({ ok: false, reason: 'grant_unavailable' });
  });
});

describe('commit — barrier-guarded enqueue-commit CAS (§7/§8)', () => {
  it('commits and advances produced_count + fetch_cursor + next_fetch_at', () => {
    const h = setup();
    const run = h.runService.create(runParams({ interval_ms: 5_000 }));
    const r = h.admission.reserve(run.run_id);
    if (!r.ok) throw new Error('reserve failed');
    expect(h.admission.commit(r.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' })).toEqual({ committed: true });
    const after = need(h.runRepo.getById(run.run_id));
    expect(after.produced_count).toBe(1);
    expect(after.fetch_cursor).toBe(1);
    expect(after.next_fetch_at).toBe(NOW + 5_000);
    expect(after.last_commit_at).toBe(NOW);
    // the reservation committed with its wire ids
    const res = need(h.resRepo.getById(r.reservation_id));
    expect(res.state).toBe('committed');
    expect(res.message_id).toBe('m1');
  });

  it('a barrier landing before commit rolls back — no admit, no cursor advance', () => {
    const h = setup();
    const run = h.runService.create(runParams());
    const r = h.admission.reserve(run.run_id);
    if (!r.ok) throw new Error('reserve failed');
    h.runService.stop(run.run_id); // barrier → draining
    const res = h.admission.commit(r.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' });
    expect(res).toEqual({ committed: false, reason: 'barrier_or_ttl_raced' });
    const after = need(h.runRepo.getById(run.run_id));
    expect(after.produced_count).toBe(0);
    expect(after.fetch_cursor).toBe(0); // NO cursor advance after a barrier
    expect(need(h.resRepo.getById(r.reservation_id)).state).toBe('released');
  });

  it('a TTL elapsing before commit rolls back the same way', () => {
    const h = setup();
    const run = h.runService.create(runParams({ expires_at: NOW + 1000 }));
    const r = h.admission.reserve(run.run_id);
    if (!r.ok) throw new Error('reserve failed');
    h.setNow(NOW + 2000); // now past the hard TTL
    const res = h.admission.commit(r.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' });
    expect(res.committed).toBe(false);
    expect(need(h.runRepo.getById(run.run_id)).produced_count).toBe(0);
    expect(need(h.resRepo.getById(r.reservation_id)).state).toBe('released');
  });

  it('commit succeeds when it wins the race (commit-before-barrier)', () => {
    const h = setup();
    const run = h.runService.create(runParams());
    const r = h.admission.reserve(run.run_id);
    if (!r.ok) throw new Error('reserve failed');
    expect(h.admission.commit(r.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' }).committed).toBe(true);
    h.runService.stop(run.run_id);
    expect(need(h.runRepo.getById(run.run_id)).produced_count).toBe(1); // the win stands
  });
});

describe('outstanding + invalidation (§7/§5.1)', () => {
  it('outstanding = enqueued_undecided + open_reservations', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 5 }));
    h.admission.reserve(run.run_id);
    h.admission.reserve(run.run_id);
    enqueuedUndecided = 2;
    expect(h.admission.outstanding(run.run_id)).toBe(4); // 2 open + 2 enqueued
  });

  it('invalidateOpen releases every open reservation (barrier)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 5 }));
    const a = h.admission.reserve(run.run_id);
    const b = h.admission.reserve(run.run_id);
    if (!a.ok || !b.ok) throw new Error('reserve failed');
    const invalidated = h.admission.invalidateOpen(run.run_id);
    expect(invalidated.length).toBe(2);
    expect(h.resRepo.countOpen(run.run_id)).toBe(0);
  });
});
