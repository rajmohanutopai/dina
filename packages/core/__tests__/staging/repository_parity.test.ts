/**
 * PLG-30 #3 — SQLite / InMemory staging repository parity for the
 * locked-secondary copy fields.
 *
 * `resolveMulti` builds each locked-secondary staging copy carrying
 * `classified_item` (the vault payload) + `approval_id` (its approval task) and
 * persists it via `ingest()`. The SQLite `ingest()` used to DROP both columns,
 * so after a restart the copy could neither be found by its approval nor written
 * to the vault. The InMemory store already clones both — this test pins the
 * SQLite store to that same round-trip so the divergence can't regress.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLiteStagingRepository, InMemoryStagingRepository } from '../../src/staging/repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { StagingItem } from '../../src/staging/service';

function makeItem(): StagingItem {
  return {
    id: 'stg-parity-1',
    source: 'chat',
    source_id: 'msg-1:health',
    producer_id: 'did:plc:brain',
    status: 'pending_unlock',
    persona: 'health',
    retry_count: 0,
    lease_until: 0,
    expires_at: 0,
    created_at: 1000,
    data: { body: '' },
    source_hash: 'h'.repeat(64),
    data_scope: 'user',
    classified_item: { id: 'v1', type: 'note', summary: 'Allergist is Dr Rao' },
    approval_id: 'approval-staging-xyz',
  };
}

describe('staging repository parity (PLG-30 #3)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stgpar-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('classified_item + approval_id round-trip through BOTH stores on ingest', () => {
    const sqlite = new SQLiteStagingRepository(adapter);
    const mem = new InMemoryStagingRepository();
    const item = makeItem();

    expect(sqlite.ingest(item)).toBe(true);
    expect(mem.ingest({ ...item })).toBe(true);

    const fromSqlite = sqlite.get(item.id);
    const fromMem = mem.get(item.id);
    expect(fromSqlite).not.toBeNull();
    expect(fromMem).not.toBeNull();
    // The two fields ingest() used to drop on the SQLite path.
    expect(fromSqlite!.classified_item).toEqual(item.classified_item);
    expect(fromSqlite!.approval_id).toBe(item.approval_id);
    // Parity: the SQLite round-trip now matches the InMemory clone.
    expect(fromSqlite!.classified_item).toEqual(fromMem!.classified_item);
    expect(fromSqlite!.approval_id).toBe(fromMem!.approval_id);
  });
});

/**
 * PLG-31 #4 — claim() is a compare-and-swap: the UPDATE is guarded on
 * `status='received'` and the return SELECT filters on the just-stamped lease,
 * so a row can be claimed exactly once. Single-process better-sqlite3 can't
 * race two workers, but these pin the observable CAS contract so it can't
 * regress into the old unguarded SELECT-then-UPDATE.
 */
describe('staging claim is a compare-and-swap (PLG-31 #4)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stgcas-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function received(id: string, createdAt: number): StagingItem {
    return {
      id,
      source: 'chat',
      source_id: id,
      producer_id: 'did:plc:brain',
      status: 'received',
      persona: 'general',
      retry_count: 0,
      lease_until: 0,
      expires_at: 9_999_999_999,
      created_at: createdAt,
      data: { body: id },
      source_hash: 'h'.repeat(64),
      data_scope: 'user',
    };
  }

  it.each([
    ['SQLite', () => new SQLiteStagingRepository(adapter)],
    ['InMemory', () => new InMemoryStagingRepository()],
  ])('%s: a second claim never re-returns an already-leased row', (_label, make) => {
    const repo = make();
    expect(repo.ingest(received('a', 100))).toBe(true);
    expect(repo.ingest(received('b', 200))).toBe(true);

    const first = repo.claim(1, 300, 1000, 'user');
    expect(first.map((i) => i.id)).toEqual(['a']);
    expect(first[0].status).toBe('classifying');

    // 'a' is now 'classifying' → the next claim can only take 'b'.
    const second = repo.claim(5, 300, 1000, 'user');
    expect(second.map((i) => i.id)).toEqual(['b']);

    // Nothing left to claim.
    expect(repo.claim(5, 300, 1000, 'user')).toEqual([]);
  });

  it('SQLite: claim never returns a pre-existing classifying row it did not transition', () => {
    const repo = new SQLiteStagingRepository(adapter);
    // A row another worker already leased (status='classifying').
    adapter.run(
      `INSERT INTO staging_inbox (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, data_scope)
       VALUES (?, ?, ?, ?, 'classifying', 'general', 0, 5000, 9999999999, 50, ?, ?, 'user')`,
      ['leased', 'chat', 'leased', 'did:plc:other', JSON.stringify({ body: 'x' }), 'h'.repeat(64)],
    );
    expect(repo.ingest(received('fresh', 100))).toBe(true);

    const claimed = repo.claim(5, 300, 1000, 'user');
    // Only the fresh 'received' row is returned; the foreign lease is untouched.
    expect(claimed.map((i) => i.id)).toEqual(['fresh']);
    expect(repo.get('leased')?.status).toBe('classifying');
    expect(repo.get('leased')?.lease_until).toBe(5000);
  });
});

/**
 * PLG-31 #6 — a corrupt SQLite row is QUARANTINED (projected to null), not
 * normalized to a benign empty item. The old projection swallowed bad JSON to a
 * default and blind-cast every scalar, so a corrupt row surfaced as a
 * valid-looking item that drainForPersona would mark `stored` with nothing
 * written — silent data loss.
 */
describe('staging repository quarantines corrupt rows (PLG-31 #6)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stgquar-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function insertRaw(
    id: string,
    status: string,
    data: string,
    classifiedItem: string | null = null,
  ): void {
    adapter.run(
      `INSERT INTO staging_inbox (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, data_scope, classified_item)
       VALUES (?, 'chat', ?, 'did:plc:brain', ?, 'general', 0, 0, 9999999999, 100, ?, ?, 'user', ?)`,
      [id, id, status, data, 'h'.repeat(64), classifiedItem],
    );
  }

  it('quarantines a row with unparseable data JSON: get→null, listAll skips it', () => {
    const repo = new SQLiteStagingRepository(adapter);
    insertRaw('good', 'received', JSON.stringify({ body: 'ok' }));
    insertRaw('bad-json', 'received', '{not valid json');

    expect(repo.get('bad-json')).toBeNull();
    expect(repo.get('good')).not.toBeNull();
    expect(repo.listAll().map((i) => i.id)).toEqual(['good']);
    expect(repo.size()).toBe(2); // still on disk — quarantined at read, not deleted
  });

  it('quarantines a corrupt row out of claim() instead of returning a garbage item', () => {
    const repo = new SQLiteStagingRepository(adapter);
    // A 'received' row whose data is a JSON array (not an object) is corrupt.
    insertRaw('bad-array', 'received', JSON.stringify(['not', 'an', 'object']));

    // claim SELECTs it as a candidate + flips it, but the projection drops it —
    // so the drain never sees a valid-looking empty item to silently "store".
    expect(repo.claim(5, 300, 1000, 'user')).toEqual([]);
  });

  it('quarantines a row with an out-of-enum status', () => {
    const repo = new SQLiteStagingRepository(adapter);
    insertRaw('weird-status', 'teleported', JSON.stringify({ body: 'x' }));
    expect(repo.get('weird-status')).toBeNull();
    expect(repo.listByStatus('teleported')).toEqual([]);
  });

  it('quarantines a row with unparseable classified_item JSON', () => {
    const repo = new SQLiteStagingRepository(adapter);
    insertRaw('bad-ci', 'pending_unlock', JSON.stringify({ body: 'x' }), '{broken');
    expect(repo.get('bad-ci')).toBeNull();
  });
});

/**
 * PLG-32 #10 / #11 / #27 — the completeness gaps PLG-31's quarantine left:
 * a corrupt row still holds its dedup KEY (#10), scalar columns weren't
 * validated (#11), and the in-memory clone was shallow (#27).
 */
describe('staging repository PLG-32 hardening', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stgp32-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('#10: deleteByDedup evicts an unreadable row so a valid re-ingest can reclaim the key', () => {
    const repo = new SQLiteStagingRepository(adapter);
    // A corrupt row occupying the UNIQUE(producer, source, source_id, scope) key.
    adapter.run(
      `INSERT INTO staging_inbox (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, data_scope)
       VALUES ('corrupt-1', 'chat', 'msg-1', 'did:plc:brain', 'received', 'general', 0, 0, 9999999999, 100, '{bad json', ?, 'user')`,
      ['h'.repeat(64)],
    );
    // findByDedup quarantines it → null (the key looks "free" but IGNORE would no-op).
    expect(repo.findByDedup('did:plc:brain', 'chat', 'msg-1', 'user')).toBeNull();
    // deleteByDedup evicts it; a fresh valid row can now take the key.
    repo.deleteByDedup('did:plc:brain', 'chat', 'msg-1', 'user');
    const fresh: StagingItem = {
      id: 'fresh-1',
      source: 'chat',
      source_id: 'msg-1',
      producer_id: 'did:plc:brain',
      status: 'received',
      persona: 'general',
      retry_count: 0,
      lease_until: 0,
      expires_at: 9999999999,
      created_at: 200,
      data: { body: 'ok' },
      source_hash: 'h'.repeat(64),
      data_scope: 'user',
    };
    expect(repo.ingest(fresh)).toBe(true);
    expect(repo.findByDedup('did:plc:brain', 'chat', 'msg-1', 'user')?.id).toBe('fresh-1');
  });

  it.each([
    ['unknown data_scope', "'not_a_scope'", '100', '0', '0'],
    ['non-numeric (NaN) expires_at', "'user'", "'abc'", '0', '0'],
    ['negative retry_count', "'user'", '9999999999', '0', '-3'],
    ['negative created_at', "'user'", '9999999999', '-5', '0'],
  ])('#11: quarantines a row with %s', (_label, scopeSql, expiresSql, createdSql, retrySql) => {
    const repo = new SQLiteStagingRepository(adapter);
    adapter.run(
      `INSERT INTO staging_inbox (id, source, source_id, producer_id, status, persona, retry_count, lease_until, expires_at, created_at, data, source_hash, data_scope)
       VALUES ('scalar-bad', 'chat', 'scalar-bad', 'did:plc:brain', 'received', 'general', ${retrySql}, 0, ${expiresSql}, ${createdSql}, ?, ?, ${scopeSql})`,
      [JSON.stringify({ body: 'x' }), 'h'.repeat(64)],
    );
    expect(repo.get('scalar-bad')).toBeNull();
    expect(repo.listAll()).toEqual([]);
  });

  it('#27: the in-memory clone is DEEP — mutating a returned nested value cannot leak into the store', () => {
    const repo = new InMemoryStagingRepository();
    const item: StagingItem = {
      id: 'deep-1',
      source: 'chat',
      source_id: 'deep-1',
      producer_id: 'did:plc:brain',
      status: 'received',
      persona: 'general',
      retry_count: 0,
      lease_until: 0,
      expires_at: 9999999999,
      created_at: 100,
      data: { nested: { list: [1, 2, 3] } },
      source_hash: 'h'.repeat(64),
      data_scope: 'user',
    };
    expect(repo.ingest(item)).toBe(true);
    // Mutate the ORIGINAL object's nested value after ingest…
    (item.data.nested as { list: number[] }).list.push(999);
    // …and the stored copy is unaffected (a shallow clone would have leaked it).
    const stored = repo.get('deep-1');
    expect((stored?.data.nested as { list: number[] }).list).toEqual([1, 2, 3]);
    // Likewise, mutating a RETURNED copy doesn't corrupt the store.
    (stored?.data.nested as { list: number[] }).list.push(777);
    expect((repo.get('deep-1')?.data.nested as { list: number[] }).list).toEqual([1, 2, 3]);
  });
});
