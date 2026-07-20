/**
 * R5-01 — the locked-arrival lane END-TO-END through the composed plane
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §7 "unlock-commit"):
 *
 *   lock-raced verified response → durably staged (device-sealed SQLite spool)
 *   → reservation `held_by_lock` → persona unlocks → replay admits EXACTLY ONCE
 *   through the guarded enqueue-commit → finalize (spool ack + staged-key
 *   destroy). Loss on replay → `response_lost` + paused run + owner
 *   notification; the owner's skip frees the run.
 *
 * Runs against real SQLite (reservations, messages, spool) — the same stores
 * both product boots use.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';
import { getPublicKey } from '../../src/crypto/ed25519';
import {
  SQLiteClassificationJobRepository,
  setClassificationJobRepository,
} from '../../src/run/classification';
import {
  SQLiteCompletionReceiptRepository,
  setCompletionReceiptRepository,
} from '../../src/run/completion';
import { InMemoryErasureKeyStore } from '../../src/run/erasure_store';
import { buildEnqueuedMessageRow, parseHeldMessageMeta } from '../../src/run/ingest';
import { NaclDeviceSealer, SQLiteRunSpool } from '../../src/run/locked_arrival';
import { SQLiteMessageRepository, setMessageRepository } from '../../src/run/message';
import { type PersonaCipher } from '../../src/run/payload_store';
import { wireRunPlane, type RunPlane } from '../../src/run/plane';
import { fireHeldReplay, setHeldReplayHook } from '../../src/run/replay_registry';
import { SQLiteRunRepository, setRunRepository } from '../../src/run/repository';
import { SQLiteReservationRepository, setReservationRepository } from '../../src/run/reservation';
import { setRunService } from '../../src/run/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CreateRunParams, RunRecord } from '../../src/run/domain';
import type { VerifiedRunMessage } from '../../src/run/ingest';
import type { ReservationRecord } from '../../src/run/reservation';

const NOW = 1_700_000_000_000;
const enc = new TextEncoder();

class StubPersonaCipher implements PersonaCipher {
  private readonly keys = new Map<string, Uint8Array>();
  open(persona: string): void {
    if (!this.keys.has(persona)) this.keys.set(persona, generateAeadKey());
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

interface Composed {
  plane: RunPlane;
  cipher: StubPersonaCipher;
  runs: SQLiteRunRepository;
  reservations: SQLiteReservationRepository;
  messages: SQLiteMessageRepository;
  spool: SQLiteRunSpool;
  erasure: InMemoryErasureKeyStore;
  lostEvents: { runId: string; reservationId: string; reason: string }[];
  queries: { correlationId: string; runId: string }[];
  now: () => number;
}

function compose(): Composed {
  dir = mkdtempSync(path.join(tmpdir(), 'r501-held-'));
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
  const receipts = new SQLiteCompletionReceiptRepository(adapter);
  setRunRepository(runs);
  setReservationRepository(reservations);
  setMessageRepository(messages);
  setClassificationJobRepository(jobs);
  setCompletionReceiptRepository(receipts);

  const cipher = new StubPersonaCipher();
  cipher.open('general');

  const spool = new SQLiteRunSpool(adapter);
  const erasure = new InMemoryErasureKeyStore();
  const seed = randomBytes(32);
  const lostEvents: { runId: string; reservationId: string; reason: string }[] = [];
  const queries: { correlationId: string; runId: string }[] = [];

  const plane = wireRunPlane({
    db: adapter,
    runRepo: runs,
    reservationRepo: reservations,
    messageRepo: messages,
    jobRepo: jobs,
    completionReceiptRepo: receipts,
    personaCipher: cipher,
    erasureStore: erasure,
    isPersonaOpen: (p) => cipher.isOpen(p),
    emitQuery: async ({ run, correlationId }) => {
      queries.push({ correlationId, runId: run.run_id });
    },
    emitDelegation: async () => undefined,
    verifyReceipt: () => true,
    buildClassificationView: (m) => ({ title: `run:${m.run_id}`, body: '', content_digest: m.dedup_key }),
    runSpool: spool,
    deviceSealer: new NaclDeviceSealer(getPublicKey(seed), seed),
    onResponseLost: (run: RunRecord, res: ReservationRecord, reason: string) => {
      lostEvents.push({ runId: run.run_id, reservationId: res.reservation_id, reason });
    },
    nowMsFn: () => NOW,
  });

  return { plane, cipher, runs, reservations, messages, spool, erasure, lostEvents, queries, now: () => NOW };
}

afterEach(() => {
  setHeldReplayHook(null);
  setRunRepository(null);
  setReservationRepository(null);
  setMessageRepository(null);
  setClassificationJobRepository(null);
  setCompletionReceiptRepository(null);
  setRunService(null);
  adapter?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function pullRun(over: Partial<CreateRunParams> = {}): CreateRunParams {
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
    message_id: `msg-${randomBytes(4).toString('hex')}`,
    sequence: 1,
    dedup_key: `dk-${randomBytes(4).toString('hex')}`,
    kind: 'informational',
    action_type: null,
    expires_at: NOW + 600_000,
    content_digest: `digest-${randomBytes(4).toString('hex')}`,
    payload: enc.encode('HELD-WHILE-LOCKED'),
    ...over,
  };
}

/** Reserve a slot via the pacer and return its correlation id. */
async function reserve(c: Composed): Promise<string> {
  const before = c.queries.length;
  await c.plane.engine.pacerTick();
  const q = c.queries[before];
  if (q === undefined) throw new Error('pacer reserved no slot');
  return q.correlationId;
}

describe('R5-01 — held_by_lock end-to-end (§7)', () => {
  it('a lock-raced response is durably STAGED + held_by_lock (nothing enqueued, nothing consumed)', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);

    c.cipher.lock('general');
    const msg = verifiedMsg();
    const outcome = c.plane.ingestPullResponse(corr, msg);
    expect(outcome.outcome).toBe('held_by_lock');

    const res = c.reservations.listByRun(run.run_id)[0];
    expect(res.state).toBe('held_by_lock');
    expect(res.sealed_response_ref).not.toBeNull();
    // The FULL verified metadata rides the reservation for the replay.
    const meta = parseHeldMessageMeta(res.held_message_json);
    expect(meta?.message_id).toBe(msg.message_id);
    // Durably staged: spool blob present + staging leaf key live.
    const ref = JSON.parse(res.sealed_response_ref ?? '') as { spool_id: string };
    expect(c.spool.peek(ref.spool_id)).not.toBeNull();
    expect(c.erasure.has(`staged:${msg.message_id}`)).toBe(true);
    // NOT admitted: no message row, run produced nothing.
    expect(c.messages.getById(msg.message_id)).toBeNull();
    expect(c.runs.getById(run.run_id)?.produced_count).toBe(0);
  });

  it('unlock replay admits the held response EXACTLY ONCE (message + classify + publish + finalize)', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');
    const heldRef = JSON.parse(
      c.reservations.listByRun(run.run_id)[0].sealed_response_ref ?? '',
    ) as { spool_id: string };

    // Unlock → replay.
    c.cipher.open('general');
    const report = c.plane.replayHeldForPersona('general');
    expect(report).toEqual({ published: 1, lost: 0, deferred: 0 });

    // Admitted through the SAME guarded commit as the live ingest:
    const stored = c.messages.getById(msg.message_id);
    expect(stored?.state).toBe('classification_pending');
    expect(stored?.run_id).toBe(run.run_id);
    const res = c.reservations.listByRun(run.run_id)[0];
    expect(res.state).toBe('committed');
    expect(res.message_id).toBe(msg.message_id);
    expect(c.runs.getById(run.run_id)?.produced_count).toBe(1);
    // The payload decrypts from the persona store (published pin).
    expect(c.plane.payloads.getPayload(msg.message_id, 'general')).not.toBeNull();
    // Finalized: spool blob acked + staging key destroyed.
    expect(c.spool.peek(heldRef.spool_id)).toBeNull();
    expect(c.erasure.has(`staged:${msg.message_id}`)).toBe(false);

    // Exactly-once: a second replay finds nothing held.
    expect(c.plane.replayHeldForPersona('general')).toEqual({ published: 0, lost: 0, deferred: 0 });
    expect(c.messages.listByRun(run.run_id)).toHaveLength(1);
  });

  it('a replay while the persona is STILL locked defers (nothing consumed, retried next unlock)', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    expect(c.plane.ingestPullResponse(corr, verifiedMsg()).outcome).toBe('held_by_lock');

    const report = c.plane.replayHeldForPersona('general');
    expect(report).toEqual({ published: 0, lost: 0, deferred: 1 });
    expect(c.reservations.listByRun(run.run_id)[0].state).toBe('held_by_lock');
  });

  it('the unlock points reach the plane through the fireHeldReplay hook registry', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');

    c.cipher.open('general');
    // The persona-unlock choke point (`openPersonaVault`) fires the registry —
    // the plane registered its hook at composition.
    fireHeldReplay('general');
    expect(c.messages.getById(msg.message_id)?.state).toBe('classification_pending');
    expect(c.reservations.listByRun(run.run_id)[0].state).toBe('committed');
  });

  it('recoverOnBoot replays held responses whose persona is already open (crash after unlock)', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');

    c.cipher.open('general');
    c.plane.recoverOnBoot();
    expect(c.messages.getById(msg.message_id)?.state).toBe('classification_pending');
    expect(c.reservations.listByRun(run.run_id)[0].state).toBe('committed');
  });

  it('crash between commit and finalize: the retry detects the admitted message and just finalizes', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');

    // Simulate the crash window (§7): the message row EXISTS (the Tier-0 commit
    // landed) but the reservation converge + spool finalize never ran.
    const res = c.reservations.listByRun(run.run_id)[0];
    const meta = parseHeldMessageMeta(res.held_message_json);
    const storedRun = c.runs.getById(run.run_id);
    if (meta === null || storedRun === null) throw new Error('held meta / run missing');
    c.messages.create(buildEnqueuedMessageRow(meta, storedRun, res, 'content-x', NOW));
    const heldRef = JSON.parse(res.sealed_response_ref ?? '') as { spool_id: string };

    c.cipher.open('general');
    const report = c.plane.replayHeldForPersona('general');
    expect(report).toEqual({ published: 1, lost: 0, deferred: 0 });
    // No double-admit; reservation converged; staged copy finalized.
    expect(c.messages.listByRun(run.run_id)).toHaveLength(1);
    expect(c.reservations.listByRun(run.run_id)[0].state).toBe('committed');
    expect(c.spool.peek(heldRef.spool_id)).toBeNull();
    expect(c.erasure.has(`staged:${msg.message_id}`)).toBe(false);
  });

  it('an unrecoverable staged blob → response_lost + paused run + owner notification; skip frees the run', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');

    // Simulate storage loss of the staged blob before unlock.
    const held = c.reservations.listByRun(run.run_id)[0];
    const ref = JSON.parse(held.sealed_response_ref ?? '') as { spool_id: string };
    c.spool.ack(ref.spool_id);

    c.cipher.open('general');
    const report = c.plane.replayHeldForPersona('general');
    expect(report).toEqual({ published: 0, lost: 1, deferred: 0 });

    const lost = c.reservations.listByRun(run.run_id)[0];
    expect(lost.state).toBe('response_lost');
    expect(lost.error_reason).toBe('blob_missing');
    expect(c.runs.getById(run.run_id)?.paused_reason).toBe('response_lost');
    expect(c.lostEvents).toEqual([
      { runId: run.run_id, reservationId: held.reservation_id, reason: 'blob_missing' },
    ]);

    // The owner's skip: terminal `skipped`; the freed cursor lets a provider
    // RETRY re-fill the position through the live ingest.
    expect(c.reservations.skipLost(held.reservation_id, NOW + 1)).toBe(true);
    expect(c.reservations.listByRun(run.run_id)[0].state).toBe('skipped');
  });

  it('SQLiteRunSpool stores durable ciphertext blobs (store → peek → ack)', () => {
    const c = compose();
    const blob = randomBytes(64);
    const id = c.spool.store(new Uint8Array(blob));
    expect(Buffer.from(c.spool.peek(id) ?? new Uint8Array())).toEqual(blob);
    // A SECOND spool instance over the same Tier-0 db sees the committed row
    // (the durable table, not instance memory); process-restart durability is
    // the adapter/WAL contract covered by the adapter conformance suite.
    const spool2 = new SQLiteRunSpool(adapter);
    expect(Buffer.from(spool2.peek(id) ?? new Uint8Array())).toEqual(blob);
    spool2.ack(id);
    expect(c.spool.peek(id)).toBeNull();
  });
});
