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
import {
  SQLiteMessageRepository,
  setMessageRepository,
  type MessageRecord,
} from '../../src/run/message';
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
  receipts: SQLiteCompletionReceiptRepository;
  spool: SQLiteRunSpool;
  erasure: InMemoryErasureKeyStore;
  lostEvents: { runId: string; reservationId: string; reason: string }[];
  queries: { correlationId: string; runId: string }[];
  now: () => number;
}

function compose(
  opts: {
    onMessageClassified?: (m: MessageRecord, run: RunRecord) => void;
    messageShredWindowMs?: number;
    reconcilePageSize?: number;
  } = {},
): Composed {
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
    ...(opts.onMessageClassified !== undefined
      ? { onMessageClassified: opts.onMessageClassified }
      : {}),
    ...(opts.messageShredWindowMs !== undefined
      ? { messageShredWindowMs: opts.messageShredWindowMs }
      : {}),
    ...(opts.reconcilePageSize !== undefined
      ? { reconcilePageSize: opts.reconcilePageSize }
      : {}),
    nowMsFn: () => NOW,
  });

  return { plane, cipher, runs, reservations, messages, receipts, spool, erasure, lostEvents, queries, now: () => NOW };
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
    const ref = JSON.parse(res.sealed_response_ref ?? '') as { spool_id: string; staged_key_id: string };
    expect(c.spool.peek(ref.spool_id)).not.toBeNull();
    expect(ref.staged_key_id.startsWith(`staged:${msg.message_id}:`)).toBe(true);
    expect(c.erasure.has(ref.staged_key_id)).toBe(true);
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
    ) as { spool_id: string; staged_key_id: string };

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
    expect(c.erasure.has(heldRef.staged_key_id)).toBe(false);

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
    const heldRef = JSON.parse(res.sealed_response_ref ?? '') as { spool_id: string; staged_key_id: string };

    c.cipher.open('general');
    const report = c.plane.replayHeldForPersona('general');
    expect(report).toEqual({ published: 1, lost: 0, deferred: 0 });
    // No double-admit; reservation converged; staged copy finalized.
    expect(c.messages.listByRun(run.run_id)).toHaveLength(1);
    expect(c.reservations.listByRun(run.run_id)[0].state).toBe('committed');
    expect(c.spool.peek(heldRef.spool_id)).toBeNull();
    expect(c.erasure.has(heldRef.staged_key_id)).toBe(false);
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

  it('A-01: commit-crash residue (committed row still carrying its staged ref) is finalized by boot maintenance', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');
    const held = c.reservations.listByRun(run.run_id)[0];
    const meta = parseHeldMessageMeta(held.held_message_json);
    const storedRun = c.runs.getById(run.run_id);
    if (meta === null || storedRun === null) throw new Error('setup');
    const ref = JSON.parse(held.sealed_response_ref ?? '') as { spool_id: string };

    // Simulate the crash WINDOW (§7): the Tier-0 commit landed (message row +
    // reservation committed) but finalize/clear never ran — the committed row
    // still CARRIES its staged ref, spool blob, and staging key.
    c.cipher.open('general');
    c.messages.create(buildEnqueuedMessageRow(meta, storedRun, held, 'content-x', NOW));
    expect(
      c.reservations.commit(
        held.reservation_id,
        { message_id: meta.message_id, dedup_key: meta.dedup_key, content_digest: meta.content_digest },
        NOW,
        'held_by_lock',
      ),
    ).toBe(true);
    expect(c.spool.peek(ref.spool_id)).not.toBeNull();
    const stagedKeyId = (ref as { staged_key_id?: string }).staged_key_id ?? '';
    expect(c.erasure.has(stagedKeyId)).toBe(true);

    // Boot maintenance (the residue sweep) finds the committed-with-ref row:
    // staged key shredded, spool blob acked, ref cleared — no second admit.
    c.plane.recoverOnBoot();
    expect(c.spool.peek(ref.spool_id)).toBeNull();
    expect(c.erasure.has(stagedKeyId)).toBe(false);
    expect(c.reservations.getById(held.reservation_id)?.sealed_response_ref).toBeNull();
    expect(c.messages.listByRun(run.run_id)).toHaveLength(1);
  });

  it('A-02: corrupt held METADATA still shreds the REAL staging key (ref-pinned id), never a guessed one', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');
    const held = c.reservations.listByRun(run.run_id)[0];
    const ref = JSON.parse(held.sealed_response_ref ?? '') as { spool_id: string };
    // Corrupt ONLY the held metadata (the ref stays parseable).
    adapter.run('UPDATE run_reservations SET held_message_json = ? WHERE reservation_id = ?', [
      'not-json',
      held.reservation_id,
    ]);

    c.cipher.open('general');
    const report = c.plane.replayHeldForPersona('general');
    expect(report).toEqual({ published: 0, lost: 1, deferred: 0 });
    // The REAL staging key is gone even though the message id was
    // unrecoverable from the metadata — the ref pinned its exact id.
    expect(c.erasure.has((ref as { staged_key_id?: string }).staged_key_id ?? '')).toBe(false);
    expect(c.spool.peek(ref.spool_id)).toBeNull();
    const lost = c.reservations.getById(held.reservation_id);
    expect(lost?.state).toBe('response_lost');
    expect(lost?.sealed_response_ref).toBeNull();
  });

  it('A-03: response_lost PAUSES fetch; owner resume re-polls; the retry commit supersedes the stale lost row', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    const msg = verifiedMsg();
    expect(c.plane.ingestPullResponse(corr, msg).outcome).toBe('held_by_lock');
    // Lose the staged blob → replay marks response_lost + pauses the run.
    const held = c.reservations.listByRun(run.run_id)[0];
    const ref = JSON.parse(held.sealed_response_ref ?? '') as { spool_id: string };
    c.spool.ack(ref.spool_id);
    c.cipher.open('general');
    expect(c.plane.replayHeldForPersona('general')).toEqual({ published: 0, lost: 1, deferred: 0 });
    expect(c.runs.getById(run.run_id)?.paused_reason).toBe('response_lost');

    // The pause is ENFORCED: the pacer opens no new slot while paused.
    const paused = await c.plane.engine.pacerTick();
    expect(paused.reserved).toBe(0);

    // Owner RESUME = "wait for the provider's retry": pause clears, the pacer
    // re-polls the un-advanced cursor.
    c.plane.runService.resume(run.run_id);
    expect(c.runs.getById(run.run_id)?.paused_reason).toBeNull();
    const resumed = await c.plane.engine.pacerTick();
    expect(resumed.reserved).toBe(1);
    const retryCorr = c.queries[c.queries.length - 1].correlationId;

    // The provider's retry re-fills cursor 0; the commit SUPERSEDES the stale
    // lost row (terminal `skipped`) so /status lost[] converges.
    const retryMsg = verifiedMsg();
    expect(c.plane.ingestPullResponse(retryCorr, retryMsg).outcome).toBe('enqueued');
    expect(c.reservations.getById(held.reservation_id)?.state).toBe('skipped');
    expect(c.runs.getById(run.run_id)?.paused_reason).toBeNull();
    expect(c.runs.getById(run.run_id)?.produced_count).toBe(1);
  });

  it('A-04: a device-sealed result card staged under lock is re-wrapped + attached on unlock', () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const lockedArrival = c.plane.lockedArrival;
    if (lockedArrival === null) throw new Error('locked arrival not composed');
    const card = enc.encode('{"title":"Booked","body":"Seat 12A"}');
    const stagedRef = lockedArrival.stage('result-d1', card);
    c.receipts.upsert({
      delegation_id: 'd1',
      message_id: 'm1',
      run_id: run.run_id,
      status: 'completed',
      result_card_ref: null,
      result_card_digest: 'digest-1',
      result_card_staged_ref: JSON.stringify(stagedRef),
      receipt_state: 'advanced',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });

    // Unlock replay attaches the persona-wrapped card + finalizes the staging.
    c.plane.replayHeldForPersona('general');
    const receipt = c.receipts.getByDelegationId('d1');
    expect(receipt?.result_card_ref).not.toBeNull();
    expect(receipt?.result_card_staged_ref).toBeNull();
    expect(c.plane.payloads.getPayload('result-d1', 'general')).not.toBeNull();
    expect(c.spool.peek(stagedRef.spool_id)).toBeNull();
    expect(c.erasure.has(stagedRef.staged_key_id ?? '')).toBe(false);
  });

  it('A-04: a staged card whose run is GONE/terminal is crypto-shred-discarded by maintenance', () => {
    const c = compose();
    const lockedArrival = c.plane.lockedArrival;
    if (lockedArrival === null) throw new Error('locked arrival not composed');
    const stagedRef = lockedArrival.stage('result-d2', enc.encode('x'));
    c.receipts.upsert({
      delegation_id: 'd2',
      message_id: 'm2',
      run_id: 'run-that-does-not-exist',
      status: 'completed',
      result_card_ref: null,
      result_card_digest: 'digest-2',
      result_card_staged_ref: JSON.stringify(stagedRef),
      receipt_state: 'advanced',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });

    c.plane.recoverOnBoot();
    const receipt = c.receipts.getByDelegationId('d2');
    expect(receipt?.result_card_ref).toBeNull();
    expect(receipt?.result_card_staged_ref).toBeNull();
    expect(c.spool.peek(stagedRef.spool_id)).toBeNull();
    expect(c.erasure.has(stagedRef.staged_key_id ?? '')).toBe(false);
  });

  it('NEW-5: a staged result card under a STILL-LOCKED persona survives the stale-spool GC and attaches on unlock', () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const lockedArrival = c.plane.lockedArrival;
    if (lockedArrival === null) throw new Error('locked arrival not composed');
    const stagedRef = lockedArrival.stage('result-d3', enc.encode('{"title":"Late card"}'));
    c.receipts.upsert({
      delegation_id: 'd3',
      message_id: 'm3',
      run_id: run.run_id,
      status: 'completed',
      result_card_ref: null,
      result_card_digest: 'digest-3',
      result_card_staged_ref: JSON.stringify(stagedRef),
      receipt_state: 'advanced',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    // Age the spool blob PAST the 24h orphan-GC TTL relative to the plane's
    // (fixed) clock — a sensitive persona routinely stays locked for days.
    adapter.run('UPDATE run_spool SET created_at = ? WHERE spool_id = ?', [
      NOW - 48 * 3_600_000,
      stagedRef.spool_id,
    ]);
    c.cipher.lock('general');

    // Maintenance runs with the persona locked: the staged card is a LIVE §13
    // reference — the GC must not reap it.
    c.plane.recoverOnBoot();
    expect(c.spool.peek(stagedRef.spool_id)).not.toBeNull();
    expect(c.receipts.getByDelegationId('d3')?.result_card_staged_ref).not.toBeNull();

    // Unlock: the card attaches (§13 — "re-wrapped under the persona DEK").
    c.cipher.open('general');
    c.plane.replayHeldForPersona('general');
    expect(c.receipts.getByDelegationId('d3')?.result_card_ref).not.toBeNull();
    expect(c.plane.payloads.getPayload('result-d3', 'general')).not.toBeNull();
    expect(c.spool.peek(stagedRef.spool_id)).toBeNull();
  });

  it('NEW-6: after an owner skip the pacer fetches the NEXT position — the dead cursor is never re-handed', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const corr = await reserve(c);
    c.cipher.lock('general');
    expect(c.plane.ingestPullResponse(corr, verifiedMsg()).outcome).toBe('held_by_lock');
    // Lose the staged blob → replay → response_lost at cursor 0 + pause.
    const held = c.reservations.listByRun(run.run_id)[0];
    const ref = JSON.parse(held.sealed_response_ref ?? '') as { spool_id: string };
    c.spool.ack(ref.spool_id);
    c.cipher.open('general');
    expect(c.plane.replayHeldForPersona('general')).toEqual({ published: 0, lost: 1, deferred: 0 });

    // Owner SKIP (the route semantics): terminal skip + cursor advance + pause
    // recompute — a permanent gap, unlike RESUME which re-polls the position.
    expect(c.reservations.skipLost(held.reservation_id, NOW + 1)).toBe(true);
    expect(c.runs.advanceCursorPastSkipped(run.run_id, held.cursor, NOW + 1)).toBe(true);
    c.runs.setPausedReason(run.run_id, null, NOW + 1);

    const report = await c.plane.engine.pacerTick();
    expect(report.reserved).toBe(1);
    const fresh = c.reservations
      .listByRun(run.run_id)
      .filter((r) => r.state === 'reserved');
    expect(fresh).toHaveLength(1);
    // The new slot targets the NEXT position — never the skipped cursor 0.
    expect(fresh[0].cursor).toBe(held.cursor + 1);
  });

  it('C-02: a crash-orphaned staged blob is crypto-shredded (key destroyed) before the GC deletes it', () => {
    const c = compose();
    const lockedArrival = c.plane.lockedArrival;
    if (lockedArrival === null) throw new Error('locked arrival not composed');
    // Stage a card but NEVER adopt it (simulate a crash between stage() and the
    // reservation/receipt write): the spool row names its unique staging key.
    const ref = lockedArrival.stage('result-orphan', enc.encode('{"x":1}'));
    expect(c.erasure.has(ref.staged_key_id ?? '')).toBe(true);
    // Age it past the 24h orphan TTL relative to the plane's (fixed) clock; no
    // live reservation/receipt references it.
    adapter.run('UPDATE run_spool SET created_at = ? WHERE spool_id = ?', [
      NOW - 48 * 3_600_000,
      ref.spool_id,
    ]);
    c.plane.recoverOnBoot();
    // The GC destroyed the NAMED key (crypto-shred) AND deleted the blob — the
    // key never outlives the ciphertext (C-02).
    expect(c.erasure.has(ref.staged_key_id ?? '')).toBe(false);
    expect(c.spool.peek(ref.spool_id)).toBeNull();
  });

  it('C-01: a duplicate lock-time completion does not orphan the incumbent staged key (first-writer)', () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    const first = c.receipts;
    const lockedArrival = c.plane.lockedArrival;
    if (lockedArrival === null) throw new Error('locked arrival not composed');
    const cardA = lockedArrival.stage('result-dupe', enc.encode('{"card":"A"}'));
    first.upsert({
      delegation_id: 'dupe',
      message_id: 'm-dupe',
      run_id: run.run_id,
      status: 'completed',
      result_card_ref: null,
      result_card_digest: 'dig-A',
      result_card_staged_ref: JSON.stringify(cardA),
      receipt_state: 'verified_pending',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    // A duplicate arrives while still verified_pending with its OWN staged card.
    const cardB = lockedArrival.stage('result-dupe', enc.encode('{"card":"B"}'));
    first.upsert({
      delegation_id: 'dupe',
      message_id: 'm-dupe',
      run_id: run.run_id,
      status: 'completed',
      result_card_ref: null,
      result_card_digest: 'dig-A',
      result_card_staged_ref: JSON.stringify(cardB),
      receipt_state: 'verified_pending',
      issued_at: NOW,
      received_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    });
    // First-writer: the receipt still points at card A; A's key survives.
    expect(c.receipts.getByDelegationId('dupe')?.result_card_staged_ref).toBe(JSON.stringify(cardA));
    expect(c.erasure.has(cardA.staged_key_id ?? '')).toBe(true);
  });

  it('C-04: an out-of-order skip then earlier repair never resumes onto the skipped cursor', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun({ queue_cap: 5 }));
    // Two held responses race a lock: cursors 0 and 1.
    const corr0 = await reserve(c);
    c.cipher.lock('general');
    expect(c.plane.ingestPullResponse(corr0, verifiedMsg()).outcome).toBe('held_by_lock');
    c.cipher.open('general');
    const corr1 = await reserve(c); // opens cursor 1
    c.cipher.lock('general');
    expect(c.plane.ingestPullResponse(corr1, verifiedMsg()).outcome).toBe('held_by_lock');
    // Both lost.
    for (const held of c.reservations.listByRun(run.run_id)) {
      const ref = JSON.parse(held.sealed_response_ref ?? '') as { spool_id: string };
      c.spool.ack(ref.spool_id);
    }
    c.cipher.open('general');
    c.plane.replayHeldForPersona('general'); // both → response_lost
    const byCursor = new Map(c.reservations.listByRun(run.run_id).map((r) => [r.cursor, r]));
    const lostAt1 = byCursor.get(1);
    if (lostAt1 === undefined) throw new Error('expected a lost reservation at cursor 1');
    // Owner skips the LATER loss (cursor 1) first — out of order. fetch_cursor
    // stays 0 (skip of a non-current cursor doesn't advance).
    expect(c.reservations.skipLost(lostAt1.reservation_id, NOW + 1)).toBe(true);
    expect(c.runs.getById(run.run_id)?.fetch_cursor).toBe(0);
    // Resume + provider repairs cursor 0 → commit advances the cursor AND skips
    // through the already-skipped cursor 1 (C-04).
    c.runs.setPausedReason(run.run_id, null, NOW + 2);
    const retry = await c.plane.engine.pacerTick();
    expect(retry.reserved).toBe(1);
    const corrRetry = c.queries[c.queries.length - 1].correlationId;
    expect(c.plane.ingestPullResponse(corrRetry, verifiedMsg()).outcome).toBe('enqueued');
    // The run cursor jumped PAST the skipped cursor 1 → next reserve targets 2.
    expect(c.runs.getById(run.run_id)?.fetch_cursor).toBe(2);
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

/** Build + insert a message row with a stored payload (payload_id == message_id,
 *  §13). Returns the message id. */
function seedMessageWithPayload(
  c: Composed,
  runId: string,
  messageId: string,
  over: Partial<MessageRecord>,
): string {
  const ref = c.plane.payloads.putPayload({
    payloadId: messageId,
    runId,
    persona: 'general',
    plaintext: enc.encode(`PAYLOAD-${messageId}`),
  });
  c.messages.create({
    message_id: messageId,
    run_id: runId,
    reservation_id: null,
    dedup_key: `dk-${messageId}`,
    sequence: 1,
    kind: 'informational',
    action_type: null,
    risk_class: null,
    state: 'classified',
    decision: null,
    decision_revision: 0,
    delegation_id: null,
    expires_at: NOW + 600_000,
    payload_ref: ref.content_id,
    content_digest: `digest-${messageId}`,
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    shred_after: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  });
  return messageId;
}

describe('CA-3 — per-message crypto-shred past the bounded window (§13)', () => {
  it('shreds a TERMINAL message payload mid-run, leaving live siblings decryptable', () => {
    const c = compose({ messageShredWindowMs: 60_000 });
    // An ACTIVE run (so whole-run shredRun never fires) with a terminal message
    // aged past the window + a live sibling still classified.
    const run = c.plane.runService.create(pullRun());
    seedMessageWithPayload(c, run.run_id, 'm-term', {
      state: 'completed',
      updated_at: NOW - 120_000, // stamped deadline = updated_at + 60s < NOW → due
    });
    seedMessageWithPayload(c, run.run_id, 'm-live', { state: 'classified', updated_at: NOW });

    // Both decryptable before maintenance.
    expect(c.plane.payloads.getPayload('m-term', 'general')).not.toBeNull();
    expect(c.plane.payloads.getPayload('m-live', 'general')).not.toBeNull();

    c.plane.recoverOnBoot(); // runs the terminal-shred sweep

    // The terminal message's leaf key is destroyed (ciphertext inert); the live
    // sibling is untouched (per-payload isolation).
    expect(c.plane.payloads.getPayload('m-term', 'general')).toBeNull();
    expect(c.erasure.has('m-term')).toBe(false);
    expect(c.plane.payloads.getPayload('m-live', 'general')).not.toBeNull();
    // Drained: shred_after marked done (0), so a second pass is a no-op and the
    // live sibling stays decryptable (idempotent across restart).
    expect(c.messages.getById('m-term')?.shred_after).toBe(0);
    c.plane.recoverOnBoot();
    expect(c.plane.payloads.getPayload('m-term', 'general')).toBeNull();
    expect(c.plane.payloads.getPayload('m-live', 'general')).not.toBeNull();
  });

  it('does NOT shred a terminal message still inside the audit/replay window', () => {
    const c = compose({ messageShredWindowMs: 3_600_000 });
    const run = c.plane.runService.create(pullRun());
    seedMessageWithPayload(c, run.run_id, 'm-recent', {
      state: 'deny',
      updated_at: NOW - 1_000, // deadline = updated_at + 1h ≫ NOW → NOT yet due
    });
    c.plane.recoverOnBoot();
    // Retained for late-completion reconciliation until the window elapses.
    expect(c.plane.payloads.getPayload('m-recent', 'general')).not.toBeNull();
    const after = c.messages.getById('m-recent')?.shred_after;
    expect(after !== null && after !== undefined && after > NOW).toBe(true);
  });
});

describe('CA-9 — classified→Activity notification reconciliation on boot', () => {
  it('re-fires the sink for a still-classified message (lost best-effort entry restored)', () => {
    const fired: string[] = [];
    const c = compose({ onMessageClassified: (m) => fired.push(m.message_id) });
    const run = c.plane.runService.create(pullRun());
    // A message that durably reached `classified` but whose best-effort inbox
    // entry was lost (crash in the post-commit gap / persistent write failure).
    seedMessageWithPayload(c, run.run_id, 'm-cls', { state: 'classified' });
    // A decided (terminal) message must NOT be re-notified as needing review.
    seedMessageWithPayload(c, run.run_id, 'm-done', { state: 'acknowledged' });

    c.plane.recoverOnBoot();

    expect(fired).toEqual(['m-cls']);
  });

  it('pages the FULL classified set to exhaustion (a 501st lost entry is not stranded)', () => {
    const fired: string[] = [];
    // Page size 2 with 3 classified messages: a fixed oldest-N window would
    // re-fire only the first page every boot and never reach the 3rd. The
    // keyset loop must re-fire all three in ONE recoverOnBoot.
    const c = compose({ onMessageClassified: (m) => fired.push(m.message_id), reconcilePageSize: 2 });
    const run = c.plane.runService.create(pullRun());
    seedMessageWithPayload(c, run.run_id, 'a', { state: 'classified', created_at: NOW + 1 });
    seedMessageWithPayload(c, run.run_id, 'b', { state: 'classified', created_at: NOW + 2 });
    seedMessageWithPayload(c, run.run_id, 'c', { state: 'classified', created_at: NOW + 3 });

    c.plane.recoverOnBoot();

    expect(new Set(fired)).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('CA-3 — whole-run + boot re-shred coexist with per-message shred', () => {
  it('whole-run shredRun destroys EVERY payload (incl a per-message-shredded one), idempotently', () => {
    const c = compose({ messageShredWindowMs: 60_000 });
    const run = c.plane.runService.create(pullRun());
    seedMessageWithPayload(c, run.run_id, 'm-term', {
      state: 'completed',
      updated_at: NOW - 120_000,
    });
    seedMessageWithPayload(c, run.run_id, 'm-live', { state: 'classified', updated_at: NOW });

    // Per-message path shreds the terminal one; the live sibling survives.
    c.plane.recoverOnBoot();
    expect(c.plane.payloads.getPayload('m-term', 'general')).toBeNull();
    expect(c.plane.payloads.getPayload('m-live', 'general')).not.toBeNull();

    // Whole-run terminal shred then destroys EVERY remaining payload key.
    const shredded = c.plane.payloads.shredRun(run.run_id);
    expect(shredded).toBeGreaterThanOrEqual(1);
    expect(c.plane.payloads.getPayload('m-live', 'general')).toBeNull();
    // Idempotent: a re-shred (boot recovery path) never throws.
    expect(() => c.plane.payloads.shredRun(run.run_id)).not.toThrow();
  });

  it('boot re-shred crypto-shreds a finalized-terminal run whose payload was still live (crash gap)', () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());
    seedMessageWithPayload(c, run.run_id, 'm-live', { state: 'classified' });
    // Simulate a crash AFTER the run finalized terminal but BEFORE its post-commit
    // shred: drive it to a `completed` terminal state with a live payload key.
    expect(c.runs.transitionState(run.run_id, 'active', 'draining', NOW)).toBe(true);
    expect(c.runs.finalize(run.run_id, 'completed', NOW)).toBe(true);
    expect(c.plane.payloads.getPayload('m-live', 'general')).not.toBeNull();

    c.plane.recoverOnBoot(); // reshred loop finds the terminal run → shredRun

    expect(c.plane.payloads.getPayload('m-live', 'general')).toBeNull();
    expect(c.erasure.has('m-live')).toBe(false);
  });
});
