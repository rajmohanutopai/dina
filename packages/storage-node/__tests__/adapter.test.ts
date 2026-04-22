/**
 * NodeSQLiteAdapter tests — open/CRUD/transaction/close behaviour
 * against a real better-sqlite3-multiple-ciphers native module.
 *
 * Tasks covered:
 *   - 3.7 open(path, passphrase) — PRAGMA key, cipher_page_size, WAL
 *   - 3.8 execute/query/run/transaction/close/isOpen surface
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DatabaseAdapter } from '@dina/core';

import { NodeSQLiteAdapter, NodeSQLiteAdapterError } from '../src/adapter';

/** 32-byte test key — all zeros by default, or supply a hex override. */
const KEY_A = '0'.repeat(64);
const KEY_B = 'a'.repeat(64);

const tmpDirs: string[] = [];
function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sqlite-adapter-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow cleanup errors */ }
  }
});

describe('NodeSQLiteAdapter — option validation', () => {
  it.each([
    ['empty path', { path: '', passphraseHex: KEY_A }, /invalid_path/],
    ['non-hex key', { path: tempPath(), passphraseHex: 'not hex' }, /invalid_key/],
    ['short key', { path: tempPath(), passphraseHex: 'ab' }, /invalid_key/],
    ['non-pow2 page size', { path: tempPath(), passphraseHex: KEY_A, cipherPageSize: 3000 }, /invalid_page_size/],
    ['page size below 512', { path: tempPath(), passphraseHex: KEY_A, cipherPageSize: 256 }, /invalid_page_size/],
    ['bad journal mode', { path: tempPath(), passphraseHex: KEY_A, journalMode: 'TRUNCATE' as 'WAL' }, /invalid_journal_mode/],
    ['bad synchronous', { path: tempPath(), passphraseHex: KEY_A, synchronous: 'YOLO' as 'FULL' }, /invalid_synchronous/],
  ] as const)('rejects %s', (_label, opts, re) => {
    expect(() => new NodeSQLiteAdapter(opts)).toThrow(re);
  });
});

describe('NodeSQLiteAdapter — open + close', () => {
  it('opens, reports isOpen=true, closes cleanly', () => {
    const a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    expect(a.isOpen).toBe(true);
    a.close();
    expect(a.isOpen).toBe(false);
  });

  it('close() is idempotent', () => {
    const a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    a.close();
    expect(() => a.close()).not.toThrow();
    expect(a.isOpen).toBe(false);
  });

  it('satisfies DatabaseAdapter at compile time', () => {
    const a: DatabaseAdapter = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    a.close();
  });
});

describe('NodeSQLiteAdapter — encryption round-trip', () => {
  it('reopen with correct key succeeds', () => {
    const p = tempPath();
    const a = new NodeSQLiteAdapter({ path: p, passphraseHex: KEY_A });
    a.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    a.run('INSERT INTO t (v) VALUES (?)', ['hello']);
    a.close();

    const b = new NodeSQLiteAdapter({ path: p, passphraseHex: KEY_A });
    const rows = b.query<{ v: string }>('SELECT v FROM t');
    expect(rows).toEqual([{ v: 'hello' }]);
    b.close();
  });

  it('reopen with WRONG key raises wrong_key', () => {
    const p = tempPath();
    const a = new NodeSQLiteAdapter({ path: p, passphraseHex: KEY_A });
    a.execute('CREATE TABLE t (id INTEGER)');
    a.close();

    expect(() => new NodeSQLiteAdapter({ path: p, passphraseHex: KEY_B })).toThrow(
      /wrong_key/,
    );
  });
});

describe('NodeSQLiteAdapter — pragma application', () => {
  it('WAL journal mode is active on file-backed DB', () => {
    const a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    try {
      const rows = a.query<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(rows[0]!.journal_mode).toBe('wal');
    } finally {
      a.close();
    }
  });

  it('cipher_page_size override is accepted + round-trips', () => {
    // BSMC/wxSQLite3 doesn't expose a programmatic read-back for
    // `cipher_page_size` (the PRAGMA returns an empty result, and the
    // file header's `page_size` reports SQLite's logical size, not the
    // cipher page grouping). We can still assert the constructor
    // accepts a non-default size without error and that data written
    // under that size round-trips through a close/reopen cycle —
    // which is the observable contract callers depend on.
    const p = tempPath();
    const a = new NodeSQLiteAdapter({ path: p, passphraseHex: KEY_A, cipherPageSize: 8192 });
    a.execute('CREATE TABLE t (v TEXT)');
    a.run('INSERT INTO t VALUES (?)', ['row']);
    a.close();

    const b = new NodeSQLiteAdapter({ path: p, passphraseHex: KEY_A, cipherPageSize: 8192 });
    try {
      expect(b.query('SELECT v FROM t')).toEqual([{ v: 'row' }]);
    } finally {
      b.close();
    }
  });

  it('journalMode=DELETE switches the active journal', () => {
    const a = new NodeSQLiteAdapter({
      path: tempPath(),
      passphraseHex: KEY_A,
      journalMode: 'DELETE',
    });
    try {
      const rows = a.query<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(rows[0]!.journal_mode).toBe('delete');
    } finally {
      a.close();
    }
  });

  it('synchronous=FULL applies', () => {
    const a = new NodeSQLiteAdapter({
      path: tempPath(),
      passphraseHex: KEY_A,
      synchronous: 'FULL',
    });
    try {
      // synchronous: OFF=0 NORMAL=1 FULL=2 EXTRA=3
      const rows = a.query<{ synchronous: number }>('PRAGMA synchronous');
      expect(rows[0]!.synchronous).toBe(2);
    } finally {
      a.close();
    }
  });

  it('synchronous=NORMAL applies', () => {
    const a = new NodeSQLiteAdapter({
      path: tempPath(),
      passphraseHex: KEY_A,
      synchronous: 'NORMAL',
    });
    try {
      const rows = a.query<{ synchronous: number }>('PRAGMA synchronous');
      expect(rows[0]!.synchronous).toBe(1);
    } finally {
      a.close();
    }
  });
});

describe('NodeSQLiteAdapter — CRUD', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => {
    a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    a.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, tag TEXT)');
  });
  afterEach(() => { a.close(); });

  it('execute() runs DDL without params', () => {
    a.execute('CREATE TABLE extra (id INTEGER)');
    expect(a.query('SELECT name FROM sqlite_master WHERE type=? AND name=?', ['table', 'extra'])).toHaveLength(1);
  });

  it('execute() with params binds parameters', () => {
    a.execute('INSERT INTO items (name, tag) VALUES (?, ?)', ['apple', 'fruit']);
    expect(a.query<{ name: string }>('SELECT name FROM items')).toEqual([{ name: 'apple' }]);
  });

  it('query() returns rows', () => {
    a.execute('INSERT INTO items (name, tag) VALUES (?, ?)', ['apple', 'fruit']);
    a.execute('INSERT INTO items (name, tag) VALUES (?, ?)', ['table', 'furniture']);
    const rows = a.query<{ name: string; tag: string }>(
      'SELECT name, tag FROM items WHERE tag = ? ORDER BY name',
      ['fruit'],
    );
    expect(rows).toEqual([{ name: 'apple', tag: 'fruit' }]);
  });

  it('run() returns affected row count', () => {
    a.run('INSERT INTO items (name) VALUES (?)', ['a']);
    a.run('INSERT INTO items (name) VALUES (?)', ['b']);
    a.run('INSERT INTO items (name) VALUES (?)', ['c']);
    const n = a.run('DELETE FROM items WHERE name IN (?, ?)', ['a', 'c']);
    expect(n).toBe(2);
  });

  it('operations after close() throw', () => {
    a.close();
    // close() is idempotent so the afterEach cleanup still runs fine
    // against an already-closed adapter.
    expect(() => a.execute('SELECT 1')).toThrow(/closed/);
    expect(() => a.query('SELECT 1')).toThrow(/closed/);
    expect(() => a.run('SELECT 1')).toThrow(/closed/);
    expect(() => a.transaction(() => {})).toThrow(/closed/);
  });
});

describe('NodeSQLiteAdapter — transactions', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => {
    a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    a.execute('CREATE TABLE t (v INTEGER)');
  });
  afterEach(() => { a.close(); });

  it('commits on normal return', () => {
    a.transaction(() => {
      a.run('INSERT INTO t VALUES (?)', [1]);
      a.run('INSERT INTO t VALUES (?)', [2]);
    });
    expect(a.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('rolls back on throw', () => {
    expect(() =>
      a.transaction(() => {
        a.run('INSERT INTO t VALUES (?)', [1]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(a.query('SELECT v FROM t')).toEqual([]);
  });

  it('propagates the thrown error unchanged', () => {
    class Custom extends Error { constructor() { super('custom'); this.name = 'Custom'; } }
    let caught: unknown;
    try {
      a.transaction(() => { throw new Custom(); });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Custom);
  });
});

describe('NodeSQLiteAdapter — explicit transaction forms (task 3.9)', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => {
    a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    a.execute('CREATE TABLE t (v INTEGER)');
  });
  afterEach(() => { a.close(); });

  it('begin + commit persists writes', () => {
    expect(a.inExplicitTransaction).toBe(false);
    a.beginTransaction();
    expect(a.inExplicitTransaction).toBe(true);
    a.run('INSERT INTO t VALUES (?)', [1]);
    a.run('INSERT INTO t VALUES (?)', [2]);
    a.commitTransaction();
    expect(a.inExplicitTransaction).toBe(false);
    expect(a.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('begin + rollback discards writes', () => {
    a.beginTransaction();
    a.run('INSERT INTO t VALUES (?)', [1]);
    a.rollbackTransaction();
    expect(a.inExplicitTransaction).toBe(false);
    expect(a.query('SELECT v FROM t')).toEqual([]);
  });

  it('nested beginTransaction throws', () => {
    a.beginTransaction();
    try {
      expect(() => a.beginTransaction()).toThrow(/nested_transaction/);
    } finally {
      a.rollbackTransaction();
    }
  });

  it('commit without begin throws', () => {
    expect(() => a.commitTransaction()).toThrow(/no_active_transaction/);
  });

  it('rollback without begin throws', () => {
    expect(() => a.rollbackTransaction()).toThrow(/no_active_transaction/);
  });

  it('close with outstanding transaction rolls back + clears state', () => {
    const dbPath = tempPath();
    const b = new NodeSQLiteAdapter({ path: dbPath, passphraseHex: KEY_A });
    b.execute('CREATE TABLE t (v INTEGER)');
    b.beginTransaction();
    b.run('INSERT INTO t VALUES (?)', [99]);
    b.close();
    expect(b.isOpen).toBe(false);
    expect(b.inExplicitTransaction).toBe(false);

    // Reopen — the insert was rolled back, table is empty.
    const c = new NodeSQLiteAdapter({ path: dbPath, passphraseHex: KEY_A });
    try {
      expect(c.query('SELECT v FROM t')).toEqual([]);
    } finally {
      c.close();
    }
  });

  it('explicit transaction is independent per-adapter', () => {
    const b = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    b.execute('CREATE TABLE t (v INTEGER)');
    try {
      a.beginTransaction();
      expect(a.inExplicitTransaction).toBe(true);
      expect(b.inExplicitTransaction).toBe(false);
      a.rollbackTransaction();
    } finally {
      b.close();
    }
  });

  it('throws closed error when called on a closed adapter', () => {
    const b = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY_A });
    b.close();
    expect(() => b.beginTransaction()).toThrow(/closed/);
    expect(() => b.commitTransaction()).toThrow(/closed/);
    expect(() => b.rollbackTransaction()).toThrow(/closed/);
  });
});
