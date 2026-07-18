/**
 * ISVC-2 — envelope-encrypted payload store + per-payload-leaf-key crypto-shred
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §13/§20). Runs against a REAL SQLite
 * engine so the v21 migration + BLOB storage are proven.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../../src/crypto/aead';
import { PersonaLockedError } from '../../src/errors';
import {
  InMemoryErasureKeyStore,
  SQLiteErasureKeyStore,
  probeErasureMode,
  setErasureKeyStore,
  type ErasureKeyStore,
} from '../../src/run/erasure_store';
import { PayloadStore, type PersonaCipher } from '../../src/run/payload_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A test persona cipher: an open persona has a 32-byte key; a locked one
 *  returns null from wrap/unwrap (matching the persona-DEK contract). */
class StubPersonaCipher implements PersonaCipher {
  private readonly keys = new Map<string, Uint8Array>();
  open(persona: string, key: Uint8Array = generateAeadKey()): void {
    this.keys.set(persona, key);
  }
  lock(persona: string): void {
    this.keys.delete(persona);
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

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected non-null');
  return v;
}

let dir: string;
let db: DatabaseAdapter;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'isvc2-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  db = adapter;
});

afterEach(() => {
  setErasureKeyStore(null);
  adapter?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeStore(
  erasure: ErasureKeyStore,
  cipher: StubPersonaCipher,
): { store: PayloadStore; cipher: StubPersonaCipher } {
  const store = new PayloadStore({ db, erasureStore: erasure, personaCipher: cipher });
  return { store, cipher };
}

describe('PayloadStore envelope', () => {
  it('round-trips a payload for an open persona', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);

    const pt = enc.encode('sensitive message envelope');
    const ref = store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: pt });
    expect(ref.content_id).toMatch(/^[0-9a-f]{64}$/);
    expect(store.blobState('p1')).toBe('published');

    const got = need(store.getPayload('p1', 'general'));
    expect(dec.decode(got)).toBe('sensitive message envelope');
  });

  it('stores NO Tier-0 plaintext — the raw blob is ciphertext', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);
    store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: enc.encode('PLAINTEXT-MARKER') });
    const rows = db.query<{ blob: Uint8Array }>('SELECT blob FROM run_payload_blobs WHERE payload_id = ?', ['p1']);
    const blobText = dec.decode(need(rows[0]).blob);
    expect(blobText).not.toContain('PLAINTEXT-MARKER');
  });

  it('throws PersonaLockedError when putting into a locked persona', () => {
    const cipher = new StubPersonaCipher(); // 'general' never opened → locked
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);
    expect(() =>
      store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: enc.encode('x') }),
    ).toThrow(PersonaLockedError);
  });

  it('returns null (sealed) when the persona is locked at read time', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);
    store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: enc.encode('x') });
    // Confirm it decrypts while open, then lock and confirm it seals.
    expect(store.getPayload('p1', 'general')).not.toBeNull();
    cipher.lock('general'); // DEK out of RAM
    expect(store.getPayload('p1', 'general')).toBeNull(); // sealed — confidentiality wrap unrecoverable
  });
});

describe('crypto-shred (§13/§20)', () => {
  it('destroys the leaf key ⇒ payload undecryptable, while the blob row REMAINS', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const erasure = new InMemoryErasureKeyStore('backup_resistant');
    const { store } = makeStore(erasure, cipher);
    store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: enc.encode('secret') });

    store.shredPayload('p1');

    // Crypto-shred ≠ row delete: the blob row is still 'published' present…
    expect(store.blobState('p1')).toBe('published');
    // …but it is undecryptable even with the persona open (the leaf key is gone).
    expect(store.getPayload('p1', 'general')).toBeNull();
    expect(erasure.has('p1')).toBe(false);
  });

  it('per-payload isolation: shredding one leaves every other payload decryptable', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);
    store.putPayload({ payloadId: 'a', runId: 'r1', persona: 'general', plaintext: enc.encode('A') });
    store.putPayload({ payloadId: 'b', runId: 'r1', persona: 'general', plaintext: enc.encode('B') });

    store.shredPayload('a');

    expect(store.getPayload('a', 'general')).toBeNull();
    expect(dec.decode(need(store.getPayload('b', 'general')))).toBe('B');
  });

  it('logical_deletion caveat: a restored backup of the leaf key RECOVERS the payload', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    // Tier-0-backed erasure store = logical_deletion (backup-restorable).
    const erasure = new SQLiteErasureKeyStore(db);
    const { store } = makeStore(erasure, cipher);
    store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: enc.encode('recoverable') });

    // What a backup would have captured before the shred.
    const backedUpKey = need(erasure.get('p1'));
    store.shredPayload('p1');
    expect(store.getPayload('p1', 'general')).toBeNull();

    // Simulate restoring that leaf-key row from a backup — proves this mode is
    // NOT backup-resistant (a conforming backend would keep the key off backups).
    erasure.put('p1', backedUpKey);
    expect(dec.decode(need(store.getPayload('p1', 'general')))).toBe('recoverable');
  });
});

describe('erasure_mode probe', () => {
  it('reports the wired backend mode; falls back to logical_deletion', () => {
    expect(probeErasureMode()).toBe('logical_deletion'); // nothing wired
    setErasureKeyStore(new SQLiteErasureKeyStore(db));
    expect(probeErasureMode()).toBe('logical_deletion');
    setErasureKeyStore(new InMemoryErasureKeyStore('backup_resistant'));
    expect(probeErasureMode()).toBe('backup_resistant');
  });
});

describe('GC vs publish (§13)', () => {
  it('never GCs a live published blob; GCs after shred', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);
    store.putPayload({ payloadId: 'p1', runId: 'r1', persona: 'general', plaintext: enc.encode('x') });

    // live payload (key present) → GC refuses
    expect(store.gcPayload('p1')).toBe(false);
    expect(store.blobState('p1')).toBe('published');

    // shredded → GC reclaims
    store.shredPayload('p1');
    expect(store.gcPayload('p1')).toBe(true);
    expect(store.blobState('p1')).toBeNull(); // row physically gone
  });

  it('never GCs a prepared (mid-publish) pin; GCs an abandoned pin', () => {
    const cipher = new StubPersonaCipher();
    cipher.open('general');
    const { store } = makeStore(new InMemoryErasureKeyStore(), cipher);
    // Insert a raw 'prepared' pin (a crash between pin and publish).
    db.run(
      `INSERT INTO run_payload_blobs (payload_id, run_id, persona, content_id, blob, wrapped_key, state, created_at, updated_at)
       VALUES ('pin', 'r1', 'general', 'cid', ?, ?, 'prepared', 1, 1)`,
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
    );
    expect(store.gcPayload('pin')).toBe(false); // mid-publish — never GC

    // the prepared-lease sweep abandons it, then GC reclaims
    expect(store.abandonPrepared('pin')).toBe(true);
    expect(store.gcPayload('pin')).toBe(true);
    expect(store.blobState('pin')).toBeNull();
  });
});
