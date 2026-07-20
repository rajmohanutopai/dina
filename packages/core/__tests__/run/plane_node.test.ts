/**
 * ISVC-10 — BOOT-LEVEL end-to-end test for `wireRunPlaneNode`: the full pull loop
 * as a shipping boot runs it — a run starts, the pacer emits a signed
 * `service.query`, a (fake) provider returns a runtime-issuer-SIGNED `RunMessage`
 * in a `service.response`, and `handleServiceResponse` verifies it at the trust
 * boundary (§6.2) and ingests it into the lifecycle → classify-timeout finalize.
 * Nothing is stubbed on the loop's critical path except the D2D transport (a
 * capturing `sendD2D`) and the runtime-key resolver.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  buildRunMessageProjection,
  buildRunExhaustedProjection,
  buildRunResultProjection,
} from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import {
  SQLiteClassificationJobRepository,
  setClassificationJobRepository,
} from '../../src/run/classification';
import {
  SQLiteCompletionReceiptRepository,
  setCompletionReceiptRepository,
} from '../../src/run/completion';
import { SQLiteMessageRepository, setMessageRepository } from '../../src/run/message';
import { type PersonaCipher } from '../../src/run/payload_store';
import { wireRunPlaneNode } from '../../src/run/plane_node';
import { SQLiteRunRepository, setRunRepository } from '../../src/run/repository';
import { SQLiteReservationRepository, setReservationRepository } from '../../src/run/reservation';
import { setRunService } from '../../src/run/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { CreateRunParams } from '../../src/run/domain';

const NOW = 1_700_000_000_000;
const enc = new TextEncoder();

const PROVIDER_DID = 'did:plc:prov';
const SERVICE_URI = 'at://did:plc:prov/com.dinakernel.service.profile/self';
const providerPriv = randomBytes(32);
const providerPub = getPublicKey(providerPriv);

class StubPersonaCipher implements PersonaCipher {
  private readonly keys = new Map<string, Uint8Array>();
  open(persona: string): void {
    this.keys.set(persona, generateAeadKey());
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

function setup() {
  dir = mkdtempSync(path.join(tmpdir(), 'isvc10-node-'));
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
  const receipts = new SQLiteCompletionReceiptRepository(adapter);
  setRunRepository(runs);
  setReservationRepository(reservations);
  setMessageRepository(messages);
  setClassificationJobRepository(new SQLiteClassificationJobRepository(adapter));
  setCompletionReceiptRepository(receipts);

  const cipher = new StubPersonaCipher();
  cipher.open('general');

  let clock = NOW;
  const now = () => clock;
  const setNow = (t: number) => {
    clock = t;
  };

  // Capturing D2D transport — records every service.query the pacer emits.
  const sent: { to: string; type: string; body: Record<string, unknown> }[] = [];
  const sendD2D = async (to: string, type: string, body: Record<string, unknown>) => {
    sent.push({ to, type, body });
  };

  const node = wireRunPlaneNode({
    db: adapter,
    sendD2D,
    resolveVerificationKey: async (did) => (did === PROVIDER_DID ? providerPub : null),
    personaCipher: cipher,
    isPersonaOpen: (p) => cipher.isOpen(p),
    nowMsFn: now,
  });
  return { node, runs, messages, receipts, sent, now, setNow };
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
    service_uri: SERVICE_URI,
    provider_did: PROVIDER_DID,
    persona: 'general',
    idempotency_key: `idem-${randomBytes(4).toString('hex')}`,
    interval_ms: 0,
    expires_at: NOW + 3_600_000,
    queue_cap: 5,
    classify_timeout_ms: 15_000,
    ...over,
  };
}

/** A fake provider: build a runtime-issuer-SIGNED `service.response` body for a
 *  correlated query, exactly as a real provider would put on the wire. */
function providerResponse(
  runId: string,
  correlationId: string,
  over: { payloadHex?: string; cardDigest?: string } = {},
): Record<string, unknown> {
  // The unsealed plaintext payload: canonical envelope of PRE-SERIALIZED card +
  // params strings (E76-05). The signed digests are SHA-256 of those exact bytes.
  const cardStr = JSON.stringify({ version: 1, blocks: [{ kind: 'title', text: 'Route 42' }] });
  const paramsStr = JSON.stringify({ stop: 'main-st' });
  const payloadHex = over.payloadHex ?? bytesToHex(enc.encode(JSON.stringify({ card: cardStr, params: paramsStr })));
  const msg = {
    provider_did: PROVIDER_DID,
    service_uri: SERVICE_URI,
    run_id: runId,
    message_id: `pmsg-${randomBytes(4).toString('hex')}`,
    sequence: 1,
    dedup_key: `pdk-${randomBytes(4).toString('hex')}`,
    kind: 'informational' as const,
    action_type: '',
    params_digest: bytesToHex(sha256(enc.encode(paramsStr))),
    card_digest: over.cardDigest ?? bytesToHex(sha256(enc.encode(cardStr))),
    issued_at: Math.floor(NOW / 1000),
    expires_at: NOW + 120_000,
    schema_version: 'run.v1',
    runtime_issuer_did: PROVIDER_DID,
    runtime_key_id: 'key-1',
  };
  const signature = bytesToHex(sign(providerPriv, enc.encode(buildRunMessageProjection(msg))));
  return {
    capability: 'interactive_run',
    query_id: correlationId,
    status: 'ok',
    ttl_seconds: 120,
    result: { ...msg, signature, payload: payloadHex },
  };
}

/** A fake provider's signed pull `exhausted` marker for the reserved cursor. */
function providerExhausted(
  runId: string,
  correlationId: string,
  cursor: number,
): Record<string, unknown> {
  const marker = {
    provider_did: PROVIDER_DID,
    service_uri: SERVICE_URI,
    run_id: runId,
    cursor,
    issued_at: Math.floor(NOW / 1000),
    schema_version: 'run.v1',
    runtime_issuer_did: PROVIDER_DID,
    runtime_key_id: 'key-1',
  };
  const signature = bytesToHex(sign(providerPriv, enc.encode(buildRunExhaustedProjection(marker))));
  return {
    capability: 'interactive_run',
    query_id: correlationId,
    status: 'ok',
    ttl_seconds: 120,
    result: { ...marker, signature },
  };
}

/** A fake provider's runtime-issuer-SIGNED action-result completion. The result
 *  card rides the wire as `result_card` (hex), parallel to a message's `payload`. */
function providerCompletion(
  runId: string,
  delegationId: string,
  messageId: string,
  over: { cardStr?: string; cardDigest?: string; omitCard?: boolean } = {},
): Record<string, unknown> {
  const cardStr =
    over.cardStr ?? JSON.stringify({ version: 1, blocks: [{ kind: 'title', text: 'Booked' }] });
  const result = {
    provider_did: PROVIDER_DID,
    service_uri: SERVICE_URI,
    run_id: runId,
    message_id: messageId,
    delegation_id: delegationId,
    decision_revision: 1,
    status: 'completed' as const,
    // The SIGNED digest — real card by default; an attacker-mismatched one on demand.
    result_card_digest: over.cardDigest ?? bytesToHex(sha256(enc.encode(cardStr))),
    issued_at: Math.floor(NOW / 1000),
    schema_version: 'run.v1',
    runtime_issuer_did: PROVIDER_DID,
    runtime_key_id: 'key-1',
  };
  const signature = bytesToHex(sign(providerPriv, enc.encode(buildRunResultProjection(result))));
  return {
    capability: 'interactive_run',
    query_id: `deleg-${delegationId}`,
    status: 'ok',
    ttl_seconds: 120,
    result: {
      ...result,
      signature,
      ...(over.omitCard ? {} : { result_card: bytesToHex(enc.encode(cardStr)) }),
    },
  };
}

/** Seed a `dispatched` action message the completion advances. */
function seedDispatched(
  messages: SQLiteMessageRepository,
  runId: string,
  messageId: string,
  delegationId: string,
): void {
  messages.create({
    message_id: messageId,
    run_id: runId,
    reservation_id: null,
    dedup_key: `dk-${messageId}`,
    sequence: 1,
    kind: 'action',
    action_type: 'book',
    risk_class: 'MODERATE',
    state: 'dispatched',
    decision: 'approve',
    decision_revision: 1,
    delegation_id: delegationId,
    expires_at: NOW + 3_600_000,
    payload_ref: null,
    content_digest: 'a'.repeat(64),
    tier_candidate: null,
    final_tier: null,
    tier_source: null,
    reconciliation_evidence: '[]',
    created_at: NOW,
    updated_at: NOW,
  });
}

describe('wireRunPlaneNode — boot-level pull loop end-to-end (ISVC-10)', () => {
  it('start → pacer emits signed query → signed provider response → verify → ingest → classify', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());

    // 1) The pacer emits a signed `service.query` (captured by the transport).
    await t.node.plane.engine.pacerTick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].to).toBe(PROVIDER_DID);
    const body0 = t.sent[0].body;
    expect(body0.capability).toBe('interactive_run');
    const correlationId = body0.query_id as string;
    expect(correlationId).toBeTruthy();

    // 2) The provider returns a runtime-issuer-signed RunMessage; the D2D receive
    // hook verifies it at the trust boundary and ingests it.
    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerResponse(run.run_id, correlationId),
    );
    expect(handled).toBe(true);
    const stored = t.messages.listByRun(run.run_id);
    expect(stored).toHaveLength(1);
    expect(stored[0].state).toBe('classification_pending');

    // 3) Brain never reports → classify-timeout finalizes at the ceiling.
    t.setNow(NOW + 30_000);
    expect(t.node.plane.classify.sweepTimeouts()).toBeGreaterThanOrEqual(1);
    expect(t.messages.listByRun(run.run_id)[0].state).toBe('classified');
    expect(t.runs.getById(run.run_id)?.produced_count).toBe(1);
  });

  it('rejects a FORGED provider response (wrong signing key) — nothing is ingested', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    await t.node.plane.engine.pacerTick();
    const correlationId = t.sent[0].body.query_id as string;

    // Re-sign the response with an attacker key (resolver still returns the
    // legit provider key) → the trust boundary rejects it.
    const resp = providerResponse(run.run_id, correlationId);
    const result = resp.result as Record<string, unknown>;
    const wrong = randomBytes(32);
    result.signature = bytesToHex(
      sign(
        wrong,
        enc.encode(
          buildRunMessageProjection({
            provider_did: PROVIDER_DID,
            service_uri: SERVICE_URI,
            run_id: run.run_id,
            message_id: result.message_id as string,
            sequence: 1,
            dedup_key: result.dedup_key as string,
            kind: 'informational',
            action_type: '',
            params_digest: 'p'.repeat(64),
            card_digest: 'c'.repeat(64),
            issued_at: result.issued_at as number,
            expires_at: result.expires_at as number,
            schema_version: 'run.v1',
            runtime_issuer_did: PROVIDER_DID,
            runtime_key_id: 'key-1',
          }),
        ),
      ),
    );

    // Handled (it IS a run response), but REJECTED — no message enters the run.
    const handled = await t.node.handleServiceResponse(PROVIDER_DID, resp);
    expect(handled).toBe(true);
    expect(t.messages.listByRun(run.run_id)).toHaveLength(0);
  });

  it('returns false for a non-run service.response (lets the requester path handle it)', async () => {
    const t = setup();
    const handled = await t.node.handleServiceResponse(PROVIDER_DID, {
      capability: 'weather',
      query_id: 'watchq-abc',
      status: 'ok',
      ttl_seconds: 60,
      result: {},
    });
    expect(handled).toBe(false);
  });

  it('signed EXHAUSTED marker → stop_on_exhaustion run terminates on exhaustion (E76-07)', async () => {
    const t = setup();
    // pullRun defaults stop_on_exhaustion=true; first reservation cursor is 0.
    const run = t.node.plane.runService.create(pullRun());
    await t.node.plane.engine.pacerTick();
    const correlationId = t.sent[0].body.query_id as string;

    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerExhausted(run.run_id, correlationId, 0),
    );
    expect(handled).toBe(true);
    // No message admitted, and the exhaustion barrier terminated the run.
    expect(t.messages.listByRun(run.run_id)).toHaveLength(0);
    expect(t.runs.getById(run.run_id)?.drain_cause).toBe('exhaustion');
  });

  it('rejects a response whose payload does not hash to the signed card_digest (E76-05)', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    await t.node.plane.engine.pacerTick();
    const correlationId = t.sent[0].body.query_id as string;

    // The signature is VALID (over card_digest='c'*64), but the payload's real card
    // hashes to something else → the plaintext-integrity gate rejects it.
    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerResponse(run.run_id, correlationId, { cardDigest: 'c'.repeat(64) }),
    );
    expect(handled).toBe(true);
    expect(t.messages.listByRun(run.run_id)).toHaveLength(0);
  });

  it('rejects a response whose payload is not a valid card+params envelope (E76-05)', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    await t.node.plane.engine.pacerTick();
    const correlationId = t.sent[0].body.query_id as string;

    // A payload that is not the `{card,params}` envelope → digest mismatch/malformed.
    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerResponse(run.run_id, correlationId, {
        payloadHex: bytesToHex(enc.encode('NOT-AN-ENVELOPE')),
      }),
    );
    expect(handled).toBe(true);
    expect(t.messages.listByRun(run.run_id)).toHaveLength(0);
  });

  it('rejects a FORGED exhausted marker (wrong cursor) — no barrier set (E76-07)', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    await t.node.plane.engine.pacerTick();
    const correlationId = t.sent[0].body.query_id as string;

    // Reserved cursor is 0; an exhausted marker for cursor 9 is out-of-window.
    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerExhausted(run.run_id, correlationId, 9),
    );
    expect(handled).toBe(true);
    expect(t.runs.getById(run.run_id)?.drain_cause ?? null).toBeNull();
  });

  it('signed completion → Core VERIFIES + envelope-stores the result card under its OWN ref (81B-04)', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    const delegationId = 'del-ok';
    const messageId = 'msg-ok';
    seedDispatched(t.messages, run.run_id, messageId, delegationId);

    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerCompletion(run.run_id, delegationId, messageId),
    );
    expect(handled).toBe(true);

    // Core envelope-encrypted the verified card under a payload keyed by the
    // delegation id — never a provider-supplied ref string.
    const contentId = t.node.plane.payloads.contentId(`result-${delegationId}`);
    expect(contentId).toMatch(/^[0-9a-f]{64}$/);
    expect(t.node.plane.payloads.blobState(`result-${delegationId}`)).toBe('published');

    // The receipt records CORE's content id (not the raw wire value); the message advanced.
    const receipt = t.receipts.getByDelegationId(delegationId);
    expect(receipt?.result_card_ref).toBe(contentId);
    expect(t.messages.getById(messageId)?.state).toBe('completed');
  });

  it('completion whose result card mismatches the signed digest → card DROPPED, outcome still advances (81B-04)', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    const delegationId = 'del-bad';
    const messageId = 'msg-bad';
    seedDispatched(t.messages, run.run_id, messageId, delegationId);

    // Signature is valid over card_digest='c'*64, but the real card hashes elsewhere.
    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerCompletion(run.run_id, delegationId, messageId, { cardDigest: 'c'.repeat(64) }),
    );
    expect(handled).toBe(true);

    // No card blob stored under a signed-but-unrelated digest; ref is null.
    expect(t.node.plane.payloads.contentId(`result-${delegationId}`)).toBeNull();
    const receipt = t.receipts.getByDelegationId(delegationId);
    expect(receipt?.result_card_ref ?? null).toBeNull();
    // The independently-signed outcome still advanced (a bad card must not block it).
    expect(t.messages.getById(messageId)?.state).toBe('completed');
  });

  it('completion with NO result card → advances with a null ref (81B-04)', async () => {
    const t = setup();
    const run = t.node.plane.runService.create(pullRun());
    const delegationId = 'del-none';
    const messageId = 'msg-none';
    seedDispatched(t.messages, run.run_id, messageId, delegationId);

    const handled = await t.node.handleServiceResponse(
      PROVIDER_DID,
      providerCompletion(run.run_id, delegationId, messageId, { omitCard: true }),
    );
    expect(handled).toBe(true);
    expect(t.node.plane.payloads.contentId(`result-${delegationId}`)).toBeNull();
    expect(t.receipts.getByDelegationId(delegationId)?.result_card_ref ?? null).toBeNull();
    expect(t.messages.getById(messageId)?.state).toBe('completed');
  });
});
