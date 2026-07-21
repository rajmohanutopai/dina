/**
 * ISVC-6 — locked-arrival held_by_lock: device-seal + spool + unlock publish +
 * barrier discard + response_lost (INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§13).
 * Runs against real SQLite (the payload store's v21 tables).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';
import { getPublicKey } from '../../src/crypto/ed25519';
import { InMemoryErasureKeyStore } from '../../src/run/erasure_store';
import {
  InMemoryRunSpool,
  LockedArrivalStore,
  NaclDeviceSealer,
  type SealedResponseRef,
} from '../../src/run/locked_arrival';
import { PayloadStore, type PersonaCipher } from '../../src/run/payload_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const enc = new TextEncoder();
const dec = new TextDecoder();

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

/** Persona cipher whose key can be toggled (open/locked). */
class StubPersonaCipher implements PersonaCipher {
  private readonly keys = new Map<string, Uint8Array>();
  open(persona: string): void {
    this.keys.set(persona, generateAeadKey());
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
let db: DatabaseAdapter;

function setup() {
  dir = mkdtempSync(path.join(tmpdir(), 'isvc6-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  db = adapter;

  const erasure = new InMemoryErasureKeyStore();
  const cipher = new StubPersonaCipher();
  cipher.open('general');
  const payloadStore = new PayloadStore({ db, erasureStore: erasure, personaCipher: cipher });

  const seed = randomBytes(32);
  const sealer = new NaclDeviceSealer(getPublicKey(seed), seed);
  const spool = new InMemoryRunSpool();
  const locked = new LockedArrivalStore({ spool, deviceSealer: sealer, payloadStore, erasureStore: erasure });
  return { erasure, cipher, payloadStore, spool, sealer, locked };
}

afterEach(() => {
  adapter?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('LockedArrivalStore (§7)', () => {
  it('stage → publish round-trips through the device seal into the persona store', () => {
    const { payloadStore, locked } = setup();
    const ref = locked.stage('p1', enc.encode('held while locked'));
    expect(ref.spool_id).toMatch(/^spool-/);
    expect(ref.content_digest).toMatch(/^[0-9a-f]{64}$/);

    // not yet in the persona store
    expect(payloadStore.blobState('p1')).toBeNull();

    const out = locked.publish('p1', 'r1', 'general', ref);
    expect(out.outcome).toBe('published');
    // now decryptable from the persona store (re-wrapped under the persona DEK)
    expect(dec.decode(need(payloadStore.getPayload('p1', 'general')))).toBe('held while locked');
  });

  it('re-publish after a crash-before-ack is an idempotent no-op (no duplicate insert)', () => {
    const { payloadStore, locked } = setup();
    const ref = locked.stage('p1', enc.encode('once'));
    expect(locked.publish('p1', 'r1', 'general', ref).outcome).toBe('published');
    // simulate the recovery pass re-running publish (crash landed after the
    // Tier-0 CAS, before the spool ack) — must not throw a PK conflict
    const again = locked.publish('p1', 'r1', 'general', ref);
    expect(again.outcome).toBe('published');
    expect(dec.decode(need(payloadStore.getPayload('p1', 'general')))).toBe('once');
  });

  it('publish acks (removes) the spool blob', () => {
    const { spool, locked } = setup();
    const ref = locked.stage('p1', enc.encode('x'));
    expect(spool.peek(ref.spool_id)).not.toBeNull();
    locked.publish('p1', 'r1', 'general', ref);
    expect(spool.peek(ref.spool_id)).toBeNull();
  });

  it('barrier discard crypto-shreds the leaf key + ack-deletes the spool blob WITHOUT decryption', () => {
    const { erasure, spool, payloadStore, locked } = setup();
    const ref = locked.stage('p1', enc.encode('secret'));
    // R5-01/B-01 — the staging leaf key is namespaced AND unique per staged
    // object; the ref pins its exact id (§7 crash-safety + duplicate-safety).
    const keyId = ref.staged_key_id ?? '';
    expect(keyId.startsWith('staged:p1:')).toBe(true);
    expect(erasure.has(keyId)).toBe(true);

    locked.discard('p1', ref);

    expect(erasure.has(keyId)).toBe(false); // crypto-shred
    expect(spool.peek(ref.spool_id)).toBeNull(); // spool blob gone
    expect(payloadStore.blobState('p1')).toBeNull(); // never published
  });

  it('a lost/corrupt staged blob surfaces response_lost (not a silent drop)', () => {
    const { locked } = setup();
    const ref = locked.stage('p1', enc.encode('x'));
    // simulate a detected digest mismatch (corruption) with an unavailable retry
    const corrupt: SealedResponseRef = { ...ref, content_digest: 'f'.repeat(64) };
    const out = locked.publish('p1', 'r1', 'general', corrupt);
    expect(out).toEqual({ outcome: 'response_lost', reason: 'digest_mismatch' });
  });

  it('a missing spool blob surfaces response_lost', () => {
    const { locked } = setup();
    const out = locked.publish('p1', 'r1', 'general', { spool_id: 'spool-nope', content_digest: 'a'.repeat(64) });
    expect(out).toEqual({ outcome: 'response_lost', reason: 'blob_missing' });
  });

  it('a TRUNCATED staged framing surfaces response_lost:corrupt, never an uncaught throw (F16)', () => {
    const { spool, locked } = setup();
    // A 2-byte blob can't even hold the 4-byte length header.
    const spoolId = spool.store(new Uint8Array([0, 0]));
    const out = locked.publish('p1', 'r1', 'general', { spool_id: spoolId, content_digest: 'a'.repeat(64) });
    expect(out).toEqual({ outcome: 'response_lost', reason: 'corrupt' });
  });

  it('a CORRUPT wrapped-key (blob digest still valid) surfaces response_lost:corrupt (F16)', () => {
    const { spool, locked } = setup();
    const ref = locked.stage('p1', enc.encode('secret'));
    const staged = spool.peek(ref.spool_id);
    if (staged === null) throw new Error('staged blob missing');
    // Flip a byte INSIDE wrappedSealedKp (offset ≥ 4). The `blob` tail is untouched
    // so the digest check passes — the corruption is only caught at decrypt time.
    const tampered = new Uint8Array(staged);
    tampered[4] ^= 0xff;
    const newId = spool.store(tampered);
    const out = locked.publish('p1', 'r1', 'general', { ...ref, spool_id: newId });
    expect(out).toEqual({ outcome: 'response_lost', reason: 'corrupt' });
  });

  it('a shredded leaf key before publish surfaces response_lost', () => {
    const { erasure, locked } = setup();
    const ref = locked.stage('p1', enc.encode('x'));
    erasure.destroy(ref.staged_key_id ?? ''); // shredded (e.g. a racing barrier)
    expect(locked.publish('p1', 'r1', 'general', ref)).toEqual({
      outcome: 'response_lost',
      reason: 'erasure_key_gone',
    });
  });

  it('a putPayload failure leaves the staging key intact + surfaces publish_failed; a retry succeeds (VERIF #3)', () => {
    const { erasure, spool, payloadStore, sealer, locked } = setup();
    const ref = locked.stage('p1', enc.encode('recovered on retry'));
    expect(erasure.has(ref.staged_key_id ?? '')).toBe(true);

    // A publish store whose persona-store write throws mid-flight (e.g. disk
    // error). R5-01: the staging leaf key lives under its OWN namespaced id
    // (`staged:p1`), so putPayload's bare-`p1` key write can never clobber it —
    // the spool blob stays decryptable for the retry with no restore dance.
    let attempts = 0;
    const throwingPayloads = {
      contentId: (id: string) => payloadStore.contentId(id),
      blobState: (id: string) => payloadStore.blobState(id),
      putPayload: () => {
        attempts++;
        throw new Error('simulated disk failure');
      },
    } as unknown as PayloadStore;
    const failStore = new LockedArrivalStore({
      spool,
      deviceSealer: sealer,
      payloadStore: throwingPayloads,
      erasureStore: erasure,
    });

    const out = failStore.publish('p1', 'r1', 'general', ref);
    expect(out).toEqual({ outcome: 'response_lost', reason: 'publish_failed' });
    expect(attempts).toBe(1);
    // The staging key is INTACT (retry-safe) and the spool blob NOT acked.
    expect(erasure.has(ref.staged_key_id ?? '')).toBe(true);
    expect(spool.peek(ref.spool_id)).not.toBeNull();

    // A retry against the real (healthy) payload store recovers the response.
    const retry = locked.publish('p1', 'r1', 'general', ref);
    expect(retry.outcome).toBe('published');
    expect(dec.decode(need(payloadStore.getPayload('p1', 'general')))).toBe('recovered on retry');
  });
});
