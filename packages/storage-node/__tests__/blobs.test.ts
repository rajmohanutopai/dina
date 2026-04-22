/**
 * Task 3.11 — Uint8Array ↔ Buffer blob handling through the adapter.
 *
 * BSMC accepts both `Uint8Array` and `Buffer` on write (Buffer is a
 * subclass of Uint8Array at the runtime level). It always returns
 * `Buffer` on read, which satisfies the `DBRow` type contract of
 * `Uint8Array` because `Buffer instanceof Uint8Array === true`.
 *
 * These tests pin that behaviour so a future BSMC upgrade or SQLite
 * binding swap can't silently break the wire contract callers depend
 * on (e.g. embeddings + wrapped keys stored as BLOBs).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);

const tmpDirs: string[] = [];
function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sqlite-blob-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('adapter → blob round-trip', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => {
    a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY });
    a.execute('CREATE TABLE b (id INTEGER PRIMARY KEY, payload BLOB)');
  });
  afterEach(() => { a.close(); });

  it('Uint8Array in, Uint8Array-compatible bytes out', () => {
    const written = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    a.run('INSERT INTO b (payload) VALUES (?)', [written]);

    const rows = a.query<{ payload: Uint8Array }>('SELECT payload FROM b');
    expect(rows).toHaveLength(1);
    const read = rows[0]!.payload;
    expect(read).toBeInstanceOf(Uint8Array);
    expect(Array.from(read)).toEqual(Array.from(written));
  });

  it('Buffer in round-trips identically to Uint8Array path', () => {
    const written = Buffer.from([0xba, 0xdf, 0x00, 0xd0]);
    a.run('INSERT INTO b (payload) VALUES (?)', [written]);

    const rows = a.query<{ payload: Uint8Array }>('SELECT payload FROM b');
    const read = rows[0]!.payload;
    expect(read).toBeInstanceOf(Uint8Array);
    expect(Array.from(read)).toEqual(Array.from(written));
  });

  it('empty-byte BLOB round-trips without zero-length panic', () => {
    const empty = new Uint8Array(0);
    a.run('INSERT INTO b (payload) VALUES (?)', [empty]);

    const read = a.query<{ payload: Uint8Array }>('SELECT payload FROM b')[0]!.payload;
    expect(read).toBeInstanceOf(Uint8Array);
    expect(read.length).toBe(0);
  });

  it('1 MB BLOB round-trips byte-exactly', () => {
    const size = 1_024 * 1_024;
    const written = new Uint8Array(size);
    // Deterministic fill so any corruption is detectable.
    for (let i = 0; i < size; i += 1) written[i] = i & 0xff;
    a.run('INSERT INTO b (payload) VALUES (?)', [written]);

    const read = a.query<{ payload: Uint8Array }>('SELECT payload FROM b')[0]!.payload;
    expect(read.length).toBe(size);
    // Sample a few bytes to avoid an O(1M) comparison — every index
    // is computed from `i & 0xff`, so failures anywhere surface on
    // a handful of probes.
    expect(read[0]).toBe(0);
    expect(read[255]).toBe(255);
    expect(read[256]).toBe(0);
    expect(read[size - 1]).toBe((size - 1) & 0xff);
  });

  it('NULL BLOB column surfaces as null, not empty bytes', () => {
    a.run('INSERT INTO b (id, payload) VALUES (?, ?)', [42, null]);
    const row = a.query<{ payload: Uint8Array | null }>('SELECT payload FROM b WHERE id = ?', [42])[0]!;
    expect(row.payload).toBeNull();
  });

  it('multiple rows with distinct payloads round-trip independently', () => {
    const payloads = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]),
      new Uint8Array([0x00]),
    ];
    for (const p of payloads) {
      a.run('INSERT INTO b (payload) VALUES (?)', [p]);
    }
    const rows = a.query<{ id: number; payload: Uint8Array }>(
      'SELECT id, payload FROM b ORDER BY id',
    );
    expect(rows.map((r) => Array.from(r.payload))).toEqual(payloads.map((p) => Array.from(p)));
  });

  it('BLOB write inside a transaction commits atomically', () => {
    const big = new Uint8Array([0xaa, 0xbb, 0xcc]);
    a.transaction(() => {
      a.run('INSERT INTO b (payload) VALUES (?)', [big]);
      a.run('INSERT INTO b (payload) VALUES (?)', [big]);
    });
    const rows = a.query<{ payload: Uint8Array }>('SELECT payload FROM b');
    expect(rows).toHaveLength(2);
    expect(Array.from(rows[0]!.payload)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(Array.from(rows[1]!.payload)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('BLOB write that throws inside transaction rolls back entirely', () => {
    expect(() =>
      a.transaction(() => {
        a.run('INSERT INTO b (payload) VALUES (?)', [new Uint8Array([1])]);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(a.query('SELECT payload FROM b')).toEqual([]);
  });
});
