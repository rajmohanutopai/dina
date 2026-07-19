/**
 * ISVC-10 — pull response-correlation ingress (INTERACTIVE_SERVICES §7).
 * Runs against a REAL SQLite engine so the guarded enqueue-commit CAS + payload
 * store + classification hand-off are proven end-to-end.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';
import { AdmissionService } from '../../src/run/admission';
import { RunClassifyService , SQLiteClassificationJobRepository } from '../../src/run/classification';
import { RunDispatchService } from '../../src/run/dispatch';
import { RunEngine } from '../../src/run/engine';
import { InMemoryErasureKeyStore } from '../../src/run/erasure_store';
import { RunResponseIngest, type VerifiedRunMessage } from '../../src/run/ingest';
import { SQLiteMessageRepository } from '../../src/run/message';
import { PayloadStore, type PersonaCipher } from '../../src/run/payload_store';
import { SQLiteRunRepository } from '../../src/run/repository';
import { SQLiteReservationRepository } from '../../src/run/reservation';
import { RunService } from '../../src/run/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CreateRunParams } from '../../src/run/domain';

const enc = new TextEncoder();
const dec = new TextDecoder();
const NOW = 1_700_000_000_000;

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

class StubPersonaCipher implements PersonaCipher {
  private readonly keys = new Map<string, Uint8Array>();
  open(persona: string, key: Uint8Array = generateAeadKey()): void {
    this.keys.set(persona, key);
  }
  lock(persona: string): void {
    this.keys.delete(persona);
  }
  isOpen(persona: string): boolean {
    return this.keys.has(persona);
  }
  wrap(persona: string, pt: Uint8Array): Uint8Array | null {
    const k = this.keys.get(persona);
    return k ? aeadEncrypt(k, pt) : null;
  }
  unwrap(persona: string, ct: Uint8Array): Uint8Array | null {
    const k = this.keys.get(persona);
    return k ? aeadDecrypt(k, ct) : null;
  }
}

let dir: string;
let adapter: NodeSQLiteAdapter;

interface Harness {
  runService: RunService;
  runs: SQLiteRunRepository;
  reservations: SQLiteReservationRepository;
  messages: SQLiteMessageRepository;
  jobs: SQLiteClassificationJobRepository;
  admission: AdmissionService;
  classify: RunClassifyService;
  payloads: PayloadStore;
  cipher: StubPersonaCipher;
  ingest: RunResponseIngest;
}

function runParams(over: Partial<CreateRunParams> = {}): CreateRunParams {
  return {
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: `idem-${randomBytes(4).toString('hex')}`,
    interval_ms: 0,
    expires_at: NOW + 3_600_000,
    queue_cap: 5,
    ...over,
  };
}

function verifiedMsg(over: Partial<VerifiedRunMessage> = {}): VerifiedRunMessage {
  return {
    message_id: 'msg-1',
    sequence: 1,
    dedup_key: 'dk-1',
    kind: 'action',
    action_type: 'book',
    expires_at: NOW + 60_000,
    content_digest: 'canon-digest-1',
    payload: enc.encode('PROVIDER-RESPONSE'),
    ...over,
  };
}

function setup(): Harness {
  dir = mkdtempSync(path.join(tmpdir(), 'isvc10-ingest-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const runs = new SQLiteRunRepository(adapter);
  const reservations = new SQLiteReservationRepository(adapter);
  const messages = new SQLiteMessageRepository(adapter);
  const jobs = new SQLiteClassificationJobRepository(adapter);
  const cipher = new StubPersonaCipher();
  cipher.open('general');
  const runService = new RunService({ repository: runs, nowMsFn: () => NOW });
  const admission = new AdmissionService({
    runRepo: runs,
    reservationRepo: reservations,
    tx: (fn) => adapter.transaction(fn),
    nowMsFn: () => NOW,
  });
  const classify = new RunClassifyService({
    messageRepo: messages,
    jobRepo: jobs,
    runRepo: runs,
    nowMsFn: () => NOW,
  });
  const payloads = new PayloadStore({
    db: adapter,
    erasureStore: new InMemoryErasureKeyStore(),
    personaCipher: cipher,
  });
  const ingest = new RunResponseIngest({
    runRepo: runs,
    reservationRepo: reservations,
    messageRepo: messages,
    admission,
    runService,
    classify,
    payloadStore: payloads,
    isPersonaOpen: (p) => cipher.isOpen(p),
    nowMsFn: () => NOW,
    tx: (fn) => adapter.transaction(fn),
  });
  return { runService, runs, reservations, messages, jobs, admission, classify, payloads, cipher, ingest };
}

afterEach(() => {
  adapter?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Reserve a slot on a fresh run and tag it with a correlation id. */
function reserveAndTag(h: Harness, correlationId: string, over: Partial<CreateRunParams> = {}): string {
  const run = h.runService.create(runParams(over));
  const res = h.admission.reserve(run.run_id);
  if (!res.ok) throw new Error(`reserve failed: ${JSON.stringify(res)}`);
  expect(h.reservations.setQueryCorrelation(res.reservation_id, correlationId, NOW)).toBe(true);
  return run.run_id;
}

describe('RunResponseIngest.ingestPullResponse (§7)', () => {
  it('admits an ACTION response: stores the payload, commits, enqueues, self-classifies', () => {
    const h = setup();
    const runId = reserveAndTag(h, 'corr-1');

    const out = h.ingest.ingestPullResponse('corr-1', verifiedMsg());

    expect(out).toEqual({ outcome: 'enqueued', message_id: 'msg-1' });
    const msg = h.messages.getById('msg-1');
    // Action messages self-tier via beginClassification (no Brain).
    expect(msg?.state).toBe('classified');
    expect(msg?.final_tier).not.toBeNull();
    expect(msg?.payload_ref).not.toBeNull();
    // SECURITY (F5/§9.1): risk_class is Core-derived (null → owner confirm), NEVER
    // the provider's claim — a provider cannot pre-label an action to bypass the gate.
    expect(msg?.risk_class).toBeNull();
    // The verified payload is retrievable under the open persona.
    expect(dec.decode(need(h.payloads.getPayload('msg-1', 'general')))).toBe('PROVIDER-RESPONSE');
    // The reservation committed + the run cursor advanced exactly once.
    expect(h.reservations.getByCorrelation('corr-1')?.state).toBe('committed');
    expect(h.runs.getById(runId)?.produced_count).toBe(1);
    expect(h.runs.getById(runId)?.fetch_cursor).toBe(1);
  });

  it('an INFORMATIONAL response enqueues + creates a durable Brain classify job', () => {
    const h = setup();
    reserveAndTag(h, 'corr-info');

    const out = h.ingest.ingestPullResponse(
      'corr-info',
      verifiedMsg({ message_id: 'msg-info', kind: 'informational', action_type: null }),
    );

    expect(out).toEqual({ outcome: 'enqueued', message_id: 'msg-info' });
    expect(h.messages.getById('msg-info')?.state).toBe('classification_pending');
    // A pending classify job exists for Brain to pull (§12.6).
    expect(h.jobs.getByMessage('msg-info')?.state).toBe('pending');
  });

  it('is idempotent: a duplicate response for an already-admitted message is ignored', () => {
    const h = setup();
    reserveAndTag(h, 'corr-1');
    h.ingest.ingestPullResponse('corr-1', verifiedMsg());

    const again = h.ingest.ingestPullResponse('corr-1', verifiedMsg());

    expect(again).toEqual({ outcome: 'duplicate', message_id: 'msg-1' });
  });

  it('dedups by (run_id, dedup_key): a fresh message_id with a used dedup_key is a duplicate (F4/§7.1)', () => {
    const h = setup();
    const run = h.runService.create(runParams({ queue_cap: 5 }));
    // Slot 1 admits the original item.
    const r1 = h.admission.reserve(run.run_id);
    if (!r1.ok) throw new Error('reserve r1 failed');
    expect(h.reservations.setQueryCorrelation(r1.reservation_id, 'corr-1', NOW)).toBe(true);
    expect(
      h.ingest.ingestPullResponse('corr-1', verifiedMsg({ message_id: 'orig', dedup_key: 'dk-shared' }))
        .outcome,
    ).toBe('enqueued');
    const cursorAfter = h.runs.getById(run.run_id)?.fetch_cursor;
    const producedAfter = h.runs.getById(run.run_id)?.produced_count;

    // Slot 2: a provider RETRY of the same logical item under a NEW message_id.
    const r2 = h.admission.reserve(run.run_id);
    if (!r2.ok) throw new Error('reserve r2 failed');
    expect(h.reservations.setQueryCorrelation(r2.reservation_id, 'corr-2', NOW)).toBe(true);
    const out = h.ingest.ingestPullResponse(
      'corr-2',
      verifiedMsg({ message_id: 'retry', dedup_key: 'dk-shared' }),
    );

    expect(out).toEqual({ outcome: 'duplicate', message_id: 'orig' });
    // No second admission: no new message, cursor + produced_count unchanged, and
    // the retry slot is released (not leaked, not committed).
    expect(h.messages.getById('retry')).toBeNull();
    expect(h.runs.getById(run.run_id)?.fetch_cursor).toBe(cursorAfter);
    expect(h.runs.getById(run.run_id)?.produced_count).toBe(producedAfter);
    expect(h.reservations.getById(r2.reservation_id)?.state).toBe('released');
  });

  it('returns no_slot for an unknown / already-handled correlation id', () => {
    const h = setup();
    expect(h.ingest.ingestPullResponse('nope', verifiedMsg())).toEqual({ outcome: 'no_slot' });
  });

  it('a locked persona is reported persona_locked and admits nothing', () => {
    const h = setup();
    reserveAndTag(h, 'corr-1');
    h.cipher.lock('general');

    const out = h.ingest.ingestPullResponse('corr-1', verifiedMsg());

    expect(out).toEqual({ outcome: 'persona_locked' });
    expect(h.messages.getById('msg-1')).toBeNull();
    // No payload stored; the slot stays reserved for the locked-arrival path.
    expect(h.payloads.getPayload('msg-1', 'general')).toBeNull();
    expect(h.reservations.getByCorrelation('corr-1')?.state).toBe('reserved');
  });

  it('a persona locking BETWEEN payload-store and commit fails closed: shred + release (F3/§7)', () => {
    const h = setup();
    const runId = reserveAndTag(h, 'corr-1');
    // isPersonaOpen returns true for the pre-store check, then false for the
    // pre-commit recheck — the cipher stays open so putPayload itself succeeds,
    // isolating the commit-point hard-bound recheck.
    let calls = 0;
    const ingest = new RunResponseIngest({
      runRepo: h.runs,
      reservationRepo: h.reservations,
      messageRepo: h.messages,
      admission: h.admission,
      runService: h.runService,
      classify: h.classify,
      payloadStore: h.payloads,
      isPersonaOpen: () => {
        calls += 1;
        return calls === 1;
      },
      nowMsFn: () => NOW,
      tx: (fn) => adapter.transaction(fn),
    });

    const out = ingest.ingestPullResponse('corr-1', verifiedMsg());

    expect(out).toEqual({ outcome: 'persona_locked' });
    expect(h.messages.getById('msg-1')).toBeNull(); // not admitted
    expect(h.payloads.getPayload('msg-1', 'general')).toBeNull(); // stored ciphertext shredded
    expect(h.reservations.getByCorrelation('corr-1')?.state).toBe('released');
    expect(h.runs.getById(runId)?.produced_count).toBe(0); // no cursor/count advance
  });

  it('a crash mid-commit rolls back atomically: no message, no cursor advance, slot stays reserved (F2/§8)', () => {
    const h = setup();
    const runId = reserveAndTag(h, 'corr-1');
    // A classify service that throws mid-commit — simulates a crash AFTER the
    // reservation CAS but before the lifecycle + payload publish complete.
    const boom = {
      beginClassification: () => {
        throw new Error('crash-mid-commit');
      },
    } as unknown as RunClassifyService;
    const ingest = new RunResponseIngest({
      runRepo: h.runs,
      reservationRepo: h.reservations,
      messageRepo: h.messages,
      admission: h.admission,
      runService: h.runService,
      classify: boom,
      payloadStore: h.payloads,
      isPersonaOpen: () => true,
      nowMsFn: () => NOW,
      tx: (fn) => adapter.transaction(fn),
    });

    // The error propagates (a genuine fault, not an outcome) — the Tier-0 tx aborts.
    expect(() => ingest.ingestPullResponse('corr-1', verifiedMsg())).toThrow('crash-mid-commit');

    // ALL-OR-NOTHING (F2): no message admitted, cursor + produced_count unmoved,
    // and the reservation rolled back to `reserved` (its CAS was undone). A crash
    // can never leave an advanced cursor with no message.
    expect(h.messages.getById('msg-1')).toBeNull();
    expect(h.runs.getById(runId)?.produced_count).toBe(0);
    expect(h.runs.getById(runId)?.fetch_cursor).toBe(0);
    expect(h.reservations.getByCorrelation('corr-1')?.state).toBe('reserved');
    // The payload was only PREPARED (never published) — no served orphan.
    expect(h.payloads.getPayload('msg-1', 'general')).toBeNull();
  });

  it('a barrier that raced the commit shreds the ciphertext and admits nothing (§7)', () => {
    const h = setup();
    const runId = reserveAndTag(h, 'corr-1');
    // A stop barrier lands between the (already-issued) query and the response.
    h.runService.stop(runId);

    const out = h.ingest.ingestPullResponse('corr-1', verifiedMsg());

    expect(out).toEqual({ outcome: 'barrier_raced' });
    expect(h.messages.getById('msg-1')).toBeNull();
    // The stored ciphertext was crypto-shredded (leaf key gone → unrecoverable).
    expect(h.payloads.getPayload('msg-1', 'general')).toBeNull();
    // No cursor advance after the barrier.
    expect(h.runs.getById(runId)?.produced_count).toBe(0);
  });

  it('an EXHAUSTED marker drains a stop_on_exhaustion run + releases the slot (F10/§7.1)', () => {
    const h = setup();
    const runId = reserveAndTag(h, 'corr-1', { stop_on_exhaustion: true });

    const out = h.ingest.ingestExhausted('corr-1');

    expect(out).toEqual({ outcome: 'exhausted', barrier_set: true });
    // The permissive exhaustion barrier drained the run; the slot is released.
    expect(h.runs.getById(runId)?.state).toBe('draining');
    expect(h.runs.getById(runId)?.drain_cause).toBe('exhaustion');
    expect(h.reservations.getByCorrelation('corr-1')?.state).toBe('released');
    // No message admitted, no cursor advance.
    expect(h.runs.getById(runId)?.produced_count).toBe(0);
    expect(h.runs.getById(runId)?.fetch_cursor).toBe(0);
  });

  it('an EXHAUSTED marker on a NON-stop_on_exhaustion run releases the slot but keeps paging (F10)', () => {
    const h = setup();
    const runId = reserveAndTag(h, 'corr-1', { stop_on_exhaustion: false });

    const out = h.ingest.ingestExhausted('corr-1');

    expect(out).toEqual({ outcome: 'exhausted', barrier_set: false });
    expect(h.runs.getById(runId)?.state).toBe('active'); // still paging
    expect(h.reservations.getByCorrelation('corr-1')?.state).toBe('released');
  });

  it('ENGINE→INGRESS integration: the pacer-stamped correlation resolves the slot with NO manual tag (F1)', async () => {
    const h = setup();
    h.runService.create(runParams());
    // The engine's pacer reserves + stamps the correlation id itself; we capture
    // the id the egress effect is handed — nothing calls setQueryCorrelation.
    let capturedCorrelation = '';
    const dispatch = new RunDispatchService({ messageRepo: h.messages, runRepo: h.runs, nowMsFn: () => NOW });
    const engine = new RunEngine({
      runRepo: h.runs,
      messageRepo: h.messages,
      reservationRepo: h.reservations,
      admission: h.admission,
      runService: h.runService,
      dispatch,
      nowMsFn: () => NOW,
      emitQuery: ({ correlationId }) => {
        capturedCorrelation = correlationId;
        return Promise.resolve();
      },
      emitDelegation: () => Promise.resolve(),
    });

    const report = await engine.pacerTick();
    expect(report.reserved).toBe(1);
    expect(capturedCorrelation).not.toBe('');

    // Feed the provider response back under the engine-stamped id — the ingress
    // resolves the slot end-to-end with no test-injected tagging.
    const out = h.ingest.ingestPullResponse(capturedCorrelation, verifiedMsg());
    expect(out).toEqual({ outcome: 'enqueued', message_id: 'msg-1' });
    expect(h.messages.getById('msg-1')?.state).toBe('classified');
  });
});
