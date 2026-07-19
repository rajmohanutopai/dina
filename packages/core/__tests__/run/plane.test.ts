/**
 * ISVC-10 — end-to-end composition test for `wireRunPlane`: proves the drivers,
 * once composed into the plane, run a real run THROUGH the live loop —
 * pacer reserves → `emitQuery` egress → provider RESPONSE → `ingestPullResponse`
 * → classify → (action) owner decide → dispatch → `emitDelegation` → completion.
 * Before ISVC-10 these drivers only ran in isolated unit tests; this is the
 * first test that a `/v1/run/start` actually PULLS + processes end-to-end.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';
import {
  SQLiteClassificationJobRepository,
  setClassificationJobRepository,
} from '../../src/run/classification';
import {
  SQLiteCompletionReceiptRepository,
  setCompletionReceiptRepository,
} from '../../src/run/completion';
import { InMemoryErasureKeyStore } from '../../src/run/erasure_store';
import { SQLiteMessageRepository, setMessageRepository } from '../../src/run/message';
import { type PersonaCipher } from '../../src/run/payload_store';
import { wireRunPlane, type RunPlane } from '../../src/run/plane';
import { SQLiteRunRepository, setRunRepository } from '../../src/run/repository';
import { SQLiteReservationRepository, setReservationRepository } from '../../src/run/reservation';
import { setRunService } from '../../src/run/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CreateRunParams } from '../../src/run/domain';
import type { EmitDelegationEffect, EmitQueryEffect } from '../../src/run/engine';
import type { VerifiedRunMessage } from '../../src/run/ingest';

const NOW = 1_700_000_000_000;
const enc = new TextEncoder();

/** Test persona cipher: an open persona has a 32-byte AEAD key. */
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

interface Composed {
  plane: RunPlane;
  cipher: StubPersonaCipher;
  runs: SQLiteRunRepository;
  messages: SQLiteMessageRepository;
  /** correlation ids the pacer emitted (one per reserved slot). */
  queries: { correlationId: string; runId: string }[];
  /** delegation ids the dispatch emitted. */
  delegations: { delegationId: string; messageId: string }[];
  now: () => number;
  setNow: (t: number) => void;
}

function compose(): Composed {
  dir = mkdtempSync(path.join(tmpdir(), 'isvc10-plane-'));
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
  // The plane reads the wired singletons for repos it isn't handed explicitly.
  setRunRepository(runs);
  setReservationRepository(reservations);
  setMessageRepository(messages);
  setClassificationJobRepository(jobs);
  setCompletionReceiptRepository(receipts);

  const cipher = new StubPersonaCipher();
  cipher.open('general');

  let clock = NOW;
  const now = (): number => clock;
  const setNow = (t: number): void => {
    clock = t;
  };

  const queries: { correlationId: string; runId: string }[] = [];
  const delegations: { delegationId: string; messageId: string }[] = [];

  const emitQuery: EmitQueryEffect = async ({ run, correlationId }) => {
    // Record the correlation id — the provider's async RESPONSE is fed back
    // separately via plane.ingestPullResponse (the D2D receive branch's job).
    queries.push({ correlationId, runId: run.run_id });
  };
  const emitDelegation: EmitDelegationEffect = async ({ message, delegationId }) => {
    delegations.push({ delegationId, messageId: message.message_id });
  };

  const plane = wireRunPlane({
    db: adapter,
    runRepo: runs,
    reservationRepo: reservations,
    messageRepo: messages,
    jobRepo: jobs,
    completionReceiptRepo: receipts,
    personaCipher: cipher,
    erasureStore: new InMemoryErasureKeyStore(),
    isPersonaOpen: (p) => cipher.isOpen(p),
    emitQuery,
    emitDelegation,
    // Test verifier: accept the completion so an action can advance to completed.
    verifyReceipt: () => true,
    // Minimal Core-owned classify-view builder (real boots decrypt the payload).
    buildClassificationView: (m) => ({ title: `run:${m.run_id}`, body: '', content_digest: m.dedup_key }),
    nowMsFn: now,
  });

  return { plane, cipher, runs, messages, queries, delegations, now, setNow };
}

afterEach(() => {
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
    expires_at: NOW + 60_000,
    content_digest: `digest-${randomBytes(4).toString('hex')}`,
    payload: enc.encode('PROVIDER-RESPONSE'),
    ...over,
  };
}

describe('wireRunPlane — live loop composition (ISVC-10)', () => {
  it('drives an informational run: pacer emits → response ingests → classify-timeout finalizes', async () => {
    const c = compose();
    // classify_timeout 15s; run TTL 1h; message TTL 1000s — so we can advance
    // PAST the classify window while staying WITHIN both hard expiries.
    const run = c.plane.runService.create(pullRun({ classify_timeout_ms: 15_000 }));

    // 1) The pacer opens a slot and emits the query (egress captured).
    const pacer = await c.plane.engine.pacerTick();
    expect(pacer.reserved).toBe(1);
    expect(pacer.sent).toBe(1);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0].runId).toBe(run.run_id);

    // 2) The provider's RESPONSE arrives (D2D receive branch → ingest).
    const msg = verifiedMsg({ kind: 'informational', expires_at: NOW + 1_000_000 });
    const outcome = c.plane.ingestPullResponse(c.queries[0].correlationId, msg);
    expect(outcome.outcome).toBe('enqueued');
    expect(c.messages.getById(msg.message_id)?.state).toBe('classification_pending');

    // 3) Brain never reports; advance just past classify_timeout (NOT past the
    // message/run hard expiry) → the classify-timeout sweep finalizes at the ceiling.
    c.setNow(NOW + 30_000);
    const finalized = c.plane.classify.sweepTimeouts();
    expect(finalized).toBeGreaterThanOrEqual(1);
    const stored = c.messages.getById(msg.message_id);
    expect(stored?.state).toBe('classified');
    expect(stored?.final_tier).not.toBeNull();
    // The run counted a produced message.
    expect(c.runs.getById(run.run_id)?.produced_count).toBe(1);
  });

  it('the classify-timeout sweep NEVER classifies content past its hard expiry (§18)', async () => {
    const c = compose();
    c.plane.runService.create(pullRun({ classify_timeout_ms: 15_000 }));
    await c.plane.engine.pacerTick();
    // A message whose own signed expiry is BEFORE its classify window elapses.
    const msg = verifiedMsg({ kind: 'informational', expires_at: NOW + 10_000 });
    expect(c.plane.ingestPullResponse(c.queries[0].correlationId, msg).outcome).toBe('enqueued');

    // Advance past BOTH the message expiry (10s) and the classify window (15s).
    c.setNow(NOW + 20_000);
    // The sweep must NOT surface expired content as a fresh `classified` decision.
    expect(c.plane.classify.sweepTimeouts()).toBe(0);
    expect(c.messages.getById(msg.message_id)?.state).not.toBe('classified');
  });

  it('drives an ACTION run through dispatch: ingest → self-classify → approve → dispatchTick emits delegation → completion', async () => {
    const c = compose();
    const run = c.plane.runService.create(pullRun());

    await c.plane.engine.pacerTick();
    const corr = c.queries[0].correlationId;
    // An action response self-classifies to the Tier-2 base at ingest (§9.1).
    const msg = verifiedMsg({ kind: 'action', action_type: 'book' });
    const outcome = c.plane.ingestPullResponse(corr, msg);
    expect(outcome.outcome).toBe('enqueued');
    const afterIngest = c.messages.getById(msg.message_id);
    expect(afterIngest?.kind).toBe('action');
    expect(afterIngest?.state).toBe('classified');

    // Owner approves (classified → approved).
    expect(
      c.messages.decide(msg.message_id, 'approve', (afterIngest?.decision_revision ?? 0) + 1, c.now()),
    ).toBe(true);

    // First dispatch tick: the risk gate runs. The provider does NOT sign
    // risk_class (ingest leaves it null → the fail-safe MODERATE), so the action
    // lands `risk_pending`, awaiting an explicit owner confirmation — it is NOT
    // dispatched yet (no auto-authorization of a MODERATE action).
    await c.plane.engine.dispatchTick();
    expect(c.messages.getById(msg.message_id)?.state).toBe('risk_pending');
    expect(c.delegations).toHaveLength(0);

    // Owner confirms the risk (risk_pending → risk_authorized).
    expect(c.plane.dispatch.authorizeRisk(msg.message_id)).toBe(true);

    // Second dispatch tick: atomic claim → sending → emitDelegation (captured)
    // → dispatched.
    const disp = await c.plane.engine.dispatchTick();
    expect(disp.claimed).toBeGreaterThanOrEqual(1);
    expect(c.delegations).toHaveLength(1);
    expect(c.delegations[0].messageId).toBe(msg.message_id);
    expect(c.messages.getById(msg.message_id)?.state).toBe('dispatched');

    // The signed completion returns (D2D receive branch → ingestCompletion).
    const done = c.plane.ingestCompletion({
      delegation_id: c.delegations[0].delegationId,
      message_id: msg.message_id,
      run_id: run.run_id,
      status: 'completed',
      result_card_ref: null,
      issued_at: c.now(),
    });
    expect(done).toBe('advanced');
    expect(c.messages.getById(msg.message_id)?.state).toBe('completed');
  });

  it('start()/stop() arm ALL FOUR loops via the injected timers + fire deterministically (idempotent)', () => {
    const c = compose();
    const scheduled: (() => void)[] = [];
    let cleared = 0;
    // Recompose with fake timers to prove every loop arms/disarms + fires under
    // the injected seam (no real wall clock).
    const plane = wireRunPlane({
      db: adapter,
      runRepo: c.runs,
      messageRepo: c.messages,
      personaCipher: c.cipher,
      isPersonaOpen: () => true,
      emitQuery: async () => undefined,
      emitDelegation: async () => undefined,
      buildClassificationView: (m) => ({ title: '', body: '', content_digest: m.dedup_key }),
      nowMsFn: c.now,
      setIntervalFn: ((cb: () => void) => {
        scheduled.push(cb);
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as (cb: () => void, ms: number) => ReturnType<typeof setInterval>,
      clearIntervalFn: () => {
        cleared += 1;
      },
    });
    plane.start();
    plane.start(); // idempotent — no double-arm
    // ALL FOUR cadence loops arm through the injected timer: engine (pacer+dispatch),
    // sweeper, classify-timeout wrapper, completion-recover wrapper.
    expect(scheduled).toHaveLength(4);
    // Fire every captured cadence callback — proves the interval→driver wiring
    // actually runs each driver (against empty stores → no throw, no work).
    for (const cb of scheduled) expect(() => cb()).not.toThrow();
    plane.recoverOnBoot(); // idempotent boot recovery must not throw
    plane.stop();
    plane.stop(); // idempotent
    expect(cleared).toBe(4);
  });
});
