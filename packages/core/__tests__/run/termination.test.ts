/**
 * ISVC-7 — termination + drain_deadline force-terminate + count barrier +
 * durable command receipts + the sweeper (§5.1/§7/§12.5).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { AdmissionService } from '../../src/run/admission';
import {
  InMemoryCommandReceiptRepository,
  recordOrReplayCommand,
  setCommandReceiptRepository,
} from '../../src/run/command_receipt';
import { InMemoryMessageRepository, type MessageRecord } from '../../src/run/message';
import { InMemoryRunRepository, SQLiteRunRepository } from '../../src/run/repository';
import { InMemoryReservationRepository, SQLiteReservationRepository, type ReservationRecord } from '../../src/run/reservation';
import { RunService } from '../../src/run/service';
import { RunSweeper, RunTerminationService } from '../../src/run/termination';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CreateRunParams } from '../../src/run/domain';

const NOW = 1_700_000_000_000;

function params(over: Partial<CreateRunParams> = {}): CreateRunParams {
  return {
    service_uri: 'at://x/y/z',
    provider_did: 'did:plc:p',
    persona: 'general',
    idempotency_key: `idem-${Math.random()}`,
    interval_ms: 0,
    expires_at: NOW + 3_600_000,
    drain_deadline_ms: 10_000,
    ...over,
  };
}

function makeMsg(over: Partial<MessageRecord>): MessageRecord {
  return {
    message_id: 'm',
    run_id: 'r',
    reservation_id: null,
    dedup_key: 'd',
    sequence: 1,
    kind: 'informational',
    action_type: null,
    risk_class: null,
    state: 'classified',
    decision: null,
    decision_revision: 0,
    delegation_id: null,
    expires_at: NOW + 60_000,
    payload_ref: null,
    content_digest: null,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

describe('forceTerminate (§5.1)', () => {
  it('fences undecided, reconciles claimed, invalidates reservations, finalizes', () => {
    const runs = new InMemoryRunRepository();
    const messages = new InMemoryMessageRepository();
    const reservations = new InMemoryReservationRepository();
    const runService = new RunService({ repository: runs, nowMsFn: () => NOW, idFn: () => 'r' });
    const run = runService.create(params());
    runService.stop(run.run_id); // → draining (cancel_pending, fencing)

    messages.create(makeMsg({ message_id: 'undecided', run_id: run.run_id, state: 'classified' }));
    messages.create(makeMsg({ message_id: 'claimed', run_id: run.run_id, state: 'dispatched' }));
    reservations.create({
      reservation_id: 'held', run_id: run.run_id, cursor: 0, state: 'held_by_lock',
      message_id: null, dedup_key: 'd', content_digest: null, sealed_response_ref: 'spool-1',
      error_reason: null, error_at: null, lease_expires_at: null, query_correlation_id: null,
      created_at: NOW, updated_at: NOW,
    });

    const fencedJobs: string[] = [];
    const discarded: string[] = [];
    let shredScheduled = false;
    const termination = new RunTerminationService({
      runRepo: runs,
      runService,
      messageRepo: messages,
      reservationRepo: reservations,
      // forceTerminate only fires at/after `drain_deadline_at` (§5.1); the run's
      // deadline is NOW + drain_deadline_ms, so the sweep clock is past it.
      nowMsFn: () => NOW + 20_000,
      fenceClassificationJob: (id) => fencedJobs.push(id),
      reconcileClaimed: (id) => {
        messages.transition(id, 'dispatched', 'outcome_unknown', NOW);
      },
      discardHeld: (r: ReservationRecord) => discarded.push(r.reservation_id),
      shredPayloads: () => {
        shredScheduled = true;
      },
    });

    const result = termination.forceTerminate(run.run_id);
    expect(result.terminated).toBe(true);
    expect(result.state).toBe('stopped'); // cancel_pending → stopped
    expect(messages.getById('undecided')?.state).toBe('cancelled'); // fenced
    expect(messages.getById('claimed')?.state).toBe('outcome_unknown'); // reconciled
    expect(fencedJobs).toEqual(['undecided']); // job cancelled for the fenced message
    expect(discarded).toEqual(['held']); // held blob discarded
    expect(reservations.getById('held')?.state).toBe('released');
    expect(shredScheduled).toBe(true);
  });

  it('is a no-op on a non-draining run', () => {
    const runs = new InMemoryRunRepository();
    const runService = new RunService({ repository: runs, nowMsFn: () => NOW, idFn: () => 'r' });
    runService.create(params());
    const termination = new RunTerminationService({
      runRepo: runs,
      runService,
      messageRepo: new InMemoryMessageRepository(),
      reservationRepo: new InMemoryReservationRepository(),
      nowMsFn: () => NOW,
    });
    expect(termination.forceTerminate('r').terminated).toBe(false);
  });
});

describe('applyTerminationCause monotonicity from committed state (NEW-01/§5.1)', () => {
  it('a STALE snapshot cannot WEAKEN a committed fencing barrier to permissive', () => {
    const runs = new InMemoryRunRepository();
    const runService = new RunService({ repository: runs, nowMsFn: () => NOW, idFn: () => 'r' });
    const stale = runService.create(params()); // snapshot captured while ACTIVE (no barrier)

    // A fencing expiry barrier commits first (e.g. the sweeper past the hard TTL).
    const fresh = runs.getById('r');
    if (fresh === null) throw new Error('run missing');
    runService.applyTerminationCause(fresh, 'expiry');
    expect(runs.getById('r')?.drain_strength).toBe('fencing');
    expect(runs.getById('r')?.drain_cause).toBe('expiry');

    // A permissive exhaustion cause now arrives carrying the STALE (pre-barrier)
    // snapshot. Deciding monotonicity from the fresh in-tx state (NEW-01) means it
    // is a no-op — it must NOT overwrite/weaken the committed fencing barrier.
    runService.applyTerminationCause(stale, 'exhaustion');
    expect(runs.getById('r')?.drain_strength).toBe('fencing'); // unchanged
    expect(runs.getById('r')?.drain_cause).toBe('expiry');
  });
});

describe('onBarrier — atomic invalidation/fence at barrier SET (RR-01b/R2-02/§5.1)', () => {
  it('an owner cancel_pending stop fences the uncommitted set + invalidates held reservations NOW', () => {
    const runs = new InMemoryRunRepository();
    const messages = new InMemoryMessageRepository();
    const reservations = new InMemoryReservationRepository();
    const runService = new RunService({ repository: runs, nowMsFn: () => NOW, idFn: () => 'r' });
    const run = runService.create(params());
    messages.create(makeMsg({ message_id: 'undecided', run_id: run.run_id, state: 'classified' }));
    messages.create(makeMsg({ message_id: 'claimed', run_id: run.run_id, state: 'dispatched' }));
    reservations.create({
      reservation_id: 'held', run_id: run.run_id, cursor: 0, state: 'held_by_lock',
      message_id: null, dedup_key: 'd', content_digest: null, sealed_response_ref: 'spool-1',
      error_reason: null, error_at: null, lease_expires_at: null, query_correlation_id: null,
      created_at: NOW, updated_at: NOW,
    });

    const fencedJobs: string[] = [];
    const discarded: string[] = [];
    const termination = new RunTerminationService({
      runRepo: runs, runService, messageRepo: messages, reservationRepo: reservations, nowMsFn: () => NOW,
      fenceClassificationJob: (id) => fencedJobs.push(id),
      discardHeld: (r: ReservationRecord) => discarded.push(r.reservation_id),
    });
    // Compose the hook (breaks the RunService ↔ termination cycle).
    runService.setOnBarrier((r) => termination.onBarrier(r.run_id));

    runService.stop(run.run_id); // cancel_pending → fencing barrier → hook fires NOW

    // The run stays draining (claimed work drains until the deadline) …
    expect(runs.getById(run.run_id)?.state).toBe('draining');
    // … but the UNCOMMITTED set + reservations are fenced/invalidated at SET time,
    // not at the deadline sweep.
    expect(messages.getById('undecided')?.state).toBe('cancelled');
    expect(messages.getById('claimed')?.state).toBe('dispatched'); // claimed NOT fenced
    expect(reservations.getById('held')?.state).toBe('released');
    expect(discarded).toEqual(['held']); // held ciphertext crypto-shredded at SET
    expect(fencedJobs).toEqual(['undecided']);
  });

  it('a PERMISSIVE barrier invalidates outstanding reservations but does NOT fence messages (R2-02/§5.1)', () => {
    const runs = new InMemoryRunRepository();
    const messages = new InMemoryMessageRepository();
    const reservations = new InMemoryReservationRepository();
    const runService = new RunService({ repository: runs, nowMsFn: () => NOW, idFn: () => 'r' });
    // finish_pending → a PERMISSIVE drain (decided work still completes).
    const run = runService.create(params({ on_stop: 'finish_pending' }));
    messages.create(makeMsg({ message_id: 'undecided', run_id: run.run_id, state: 'classified' }));
    reservations.create({
      reservation_id: 'ahead', run_id: run.run_id, cursor: 1, state: 'reserved',
      message_id: null, dedup_key: null, content_digest: null, sealed_response_ref: null,
      error_reason: null, error_at: null, lease_expires_at: NOW + 60_000, query_correlation_id: null,
      created_at: NOW, updated_at: NOW,
    });

    const fencedJobs: string[] = [];
    const termination = new RunTerminationService({
      runRepo: runs, runService, messageRepo: messages, reservationRepo: reservations, nowMsFn: () => NOW,
      fenceClassificationJob: (id) => fencedJobs.push(id),
    });
    runService.setOnBarrier((r) => termination.onBarrier(r.run_id));

    runService.stop(run.run_id); // finish_pending → permissive drain → hook fires

    expect(runs.getById(run.run_id)?.state).toBe('draining');
    expect(runs.getById(run.run_id)?.drain_strength).toBe('permissive');
    // Outstanding (fetch-ahead) reservation invalidated even on a PERMISSIVE barrier …
    expect(reservations.getById('ahead')?.state).toBe('released');
    // … but the undecided message is NOT fenced (decided work still completes).
    expect(messages.getById('undecided')?.state).toBe('classified');
    expect(fencedJobs).toEqual([]);
  });
});

describe('produced-basis count barrier at commit (§5.1)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  afterEach(() => {
    adapter?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the commit taking produced_count to max_count sets the permissive count barrier', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'isvc7-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    const runRepo = new SQLiteRunRepository(adapter);
    const resRepo = new SQLiteReservationRepository(adapter);
    const runService = new RunService({ repository: runRepo, nowMsFn: () => NOW });
    const admission = new AdmissionService({
      runRepo,
      reservationRepo: resRepo,
      tx: (fn) => adapter.transaction(fn),
      nowMsFn: () => NOW,
    });
    const run = runService.create(params({ max_count: 1, max_count_basis: 'produced', drain_deadline_ms: 5_000 }));
    const r = admission.reserve(run.run_id);
    if (!r.ok) throw new Error('reserve failed');
    admission.commit(r.reservation_id, { message_id: 'm1', dedup_key: 'd1', content_digest: 'c1' });
    const after = runService.get(run.run_id);
    expect(after?.state).toBe('draining');
    expect(after?.drain_cause).toBe('count');
    expect(after?.drain_strength).toBe('permissive');
    expect(after?.drain_deadline_at).toBe(NOW + 5_000);
  });
});

describe('durable command receipts (§12.5)', () => {
  afterEach(() => setCommandReceiptRepository(null));

  it('replays a stored response without re-executing; a replayed old command is a no-op', () => {
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    let executions = 0;
    const run = () =>
      recordOrReplayCommand({
        ownerPrincipal: 'owner', runId: 'r1', route: 'resume', idempotencyKey: 'k1', requestBody: { a: 1 },
        compute: () => {
          executions++;
          return { state: 'active' };
        },
      });
    const first = run();
    expect(first).toEqual({ response: { state: 'active' }, replayed: false });
    const second = run();
    expect(second).toEqual({ response: { state: 'active' }, replayed: true });
    expect(executions).toBe(1); // never re-executed
  });

  it('rejects a key reused with a different request body', () => {
    setCommandReceiptRepository(new InMemoryCommandReceiptRepository());
    recordOrReplayCommand({
      ownerPrincipal: 'o', runId: 'r', route: 'update', idempotencyKey: 'k', requestBody: { x: 1 },
      compute: () => ({ ok: true }),
    });
    expect(() =>
      recordOrReplayCommand({
        ownerPrincipal: 'o', runId: 'r', route: 'update', idempotencyKey: 'k', requestBody: { x: 2 },
        compute: () => ({ ok: true }),
      }),
    ).toThrow(/different request body/);
  });
});

describe('RunSweeper', () => {
  function setup() {
    const runs = new InMemoryRunRepository();
    const reservations = new InMemoryReservationRepository();
    const messages = new InMemoryMessageRepository();
    let nowMs = NOW;
    const runService = new RunService({ repository: runs, nowMsFn: () => nowMs, idFn: () => `run-${Math.random()}` });
    const termination = new RunTerminationService({
      runRepo: runs, runService, messageRepo: messages, reservationRepo: reservations, nowMsFn: () => nowMs,
    });
    const sweeper = new RunSweeper({
      runRepo: runs, reservationRepo: reservations, runService, termination, nowMsFn: () => nowMs,
    });
    return { runs, reservations, runService, sweeper, setNow: (v: number) => (nowMs = v) };
  }

  it('sets the expiry barrier for an active run past its hard TTL', () => {
    const h = setup();
    const run = h.runService.create(params({ expires_at: NOW + 1000 }));
    h.setNow(NOW + 2000);
    const report = h.sweeper.runTick();
    expect(report.expired).toBe(1);
    expect(h.runService.get(run.run_id)?.state).toBe('draining');
    expect(h.runService.get(run.run_id)?.drain_cause).toBe('expiry');
  });

  it('sets the expiry barrier for a PAUSED run past its hard TTL (VERIF #7)', () => {
    // A paused run still counts against its hard TTL; before the fix the sweeper
    // only looked at `active` runs, so a paused run lingered forever past its TTL.
    const h = setup();
    const run = h.runService.create(params({ expires_at: NOW + 1000 }));
    h.runService.pause(run.run_id);
    expect(h.runService.get(run.run_id)?.state).toBe('paused');
    h.setNow(NOW + 2000);
    const report = h.sweeper.runTick();
    expect(report.expired).toBe(1);
    expect(h.runService.get(run.run_id)?.state).toBe('draining');
    expect(h.runService.get(run.run_id)?.drain_cause).toBe('expiry');
  });

  it('strengthens a draining-PERMISSIVE run to expiry past its TTL (VERIF #9)', () => {
    // A run draining on a permissive cause (e.g. finish_pending) that then blows
    // past its hard TTL must be strengthened to a fencing `expiry` cause so it
    // finalizes as `expired`, not mislabeled, and stops lingering.
    const h = setup();
    const run = h.runService.create(params({ expires_at: NOW + 1000, drain_deadline_ms: 10_000 }));
    h.runService.stop(run.run_id, 'finish_pending'); // → draining, permissive
    expect(h.runService.get(run.run_id)?.drain_strength).toBe('permissive');
    h.setNow(NOW + 2000);
    const report = h.sweeper.runTick();
    expect(report.expired).toBe(1);
    const after = h.runService.get(run.run_id);
    expect(after?.drain_cause).toBe('expiry');
    expect(after?.drain_strength).toBe('fencing');
  });

  it('force-terminates a draining run past its deadline', () => {
    const h = setup();
    const run = h.runService.create(params({ drain_deadline_ms: 1000 }));
    h.runService.stop(run.run_id); // → draining, deadline = NOW + 1000
    h.setNow(NOW + 2000);
    const report = h.sweeper.runTick();
    expect(report.force_terminated).toBe(1);
    expect(h.runService.get(run.run_id)?.state).toBe('stopped');
  });

  it('reclaims lease-expired reserved slots', () => {
    const h = setup();
    const run = h.runService.create(params());
    h.reservations.create({
      reservation_id: 'stale', run_id: run.run_id, cursor: 0, state: 'reserved',
      message_id: null, dedup_key: null, content_digest: null, sealed_response_ref: null,
      error_reason: null, error_at: null, lease_expires_at: NOW + 100, query_correlation_id: null,
      created_at: NOW, updated_at: NOW,
    });
    h.setNow(NOW + 200);
    expect(h.sweeper.runTick().reservations_reclaimed).toBe(1);
    expect(h.reservations.getById('stale')?.state).toBe('released');
  });
});
