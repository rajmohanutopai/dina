/**
 * Task 3.19 — concurrent-access smoke.
 *
 * Proves multi-connection behaviour doesn't corrupt data or deadlock.
 * Node is single-threaded, so "concurrent" here means two live
 * `NodeSQLiteAdapter` instances open on the same file — SQLite
 * coordinates file-level locking; WAL gives single-writer /
 * multi-reader semantics.
 *
 * **What we check**:
 *   1. Two adapters can open the same file simultaneously.
 *   2. After conn A commits, conn B sees the write (WAL commit
 *      visibility).
 *   3. While conn A holds an explicit write transaction, conn B's
 *      reads return the pre-transaction snapshot (WAL snapshot
 *      isolation).
 *   4. BEGIN IMMEDIATE on conn B blocks/rejects while conn A already
 *      holds a write lock — first-writer-wins, no data corruption.
 *   5. Multiple readers see each other's writes after commit, no
 *      cross-talk during read.
 *   6. An adapter close on one conn doesn't affect the other.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);

const tmpDirs: string[] = [];
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sqlite-conc-'));
  tmpDirs.push(dir);
  return path.join(dir, 'shared.sqlite');
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

/** Open an adapter with the persona-grade pragmas (WAL + NORMAL). */
function openShared(filePath: string): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter({
    path: filePath,
    passphraseHex: KEY,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
}

describe('concurrent access — basic co-existence', () => {
  it('two adapters can open the same file simultaneously', () => {
    const p = tempFile();
    const a = openShared(p);
    try {
      a.execute('CREATE TABLE t (v INTEGER)');
    } finally {
      // Keep A open; opening B next.
    }
    const b = openShared(p);
    try {
      expect(a.isOpen).toBe(true);
      expect(b.isOpen).toBe(true);
      // Both can query.
      expect(a.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
      expect(b.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
    } finally {
      a.close();
      b.close();
    }
  });

  it('closing one adapter does not affect the other', () => {
    const p = tempFile();
    const a = openShared(p);
    a.execute('CREATE TABLE t (v INTEGER)');
    const b = openShared(p);
    try {
      a.close();
      expect(a.isOpen).toBe(false);
      expect(b.isOpen).toBe(true);
      b.run('INSERT INTO t VALUES (?)', [42]);
      expect(b.query<{ v: number }>('SELECT v FROM t')).toEqual([{ v: 42 }]);
    } finally {
      b.close();
    }
  });
});

describe('concurrent access — commit visibility (WAL)', () => {
  it('writes on conn A are visible to conn B after commit', () => {
    const p = tempFile();
    const a = openShared(p);
    const b = openShared(p);
    try {
      a.execute('CREATE TABLE t (v INTEGER)');
      a.run('INSERT INTO t VALUES (?)', [1]);
      // B opened BEFORE the write — after A's commit (autocommit), B
      // must see the new row because every SELECT opens a fresh
      // snapshot in WAL mode.
      expect(b.query<{ v: number }>('SELECT v FROM t')).toEqual([{ v: 1 }]);

      a.run('INSERT INTO t VALUES (?)', [2]);
      expect(b.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }, { v: 2 }]);
    } finally {
      a.close();
      b.close();
    }
  });

  it('many sequential writes on A are consistently visible to B', () => {
    const p = tempFile();
    const a = openShared(p);
    const b = openShared(p);
    try {
      a.execute('CREATE TABLE t (v INTEGER)');
      // 100 interleaved: write on A, read on B, verify count.
      for (let i = 1; i <= 100; i += 1) {
        a.run('INSERT INTO t VALUES (?)', [i]);
        const rows = b.query<{ n: number }>('SELECT count(*) AS n FROM t');
        expect(rows[0]!.n).toBe(i);
      }
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('concurrent access — snapshot isolation during open tx', () => {
  it('B reads pre-tx snapshot while A holds an uncommitted write', () => {
    const p = tempFile();
    const a = openShared(p);
    const b = openShared(p);
    try {
      a.execute('CREATE TABLE t (v INTEGER)');
      a.run('INSERT INTO t VALUES (?)', [1]);

      // Open A's transaction, write inside, don't commit yet.
      a.beginTransaction();
      a.run('INSERT INTO t VALUES (?)', [2]);

      // B's read should see only {1} — snapshot isolation under WAL.
      expect(b.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }]);

      // After A commits, B sees both.
      a.commitTransaction();
      expect(b.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }, { v: 2 }]);
    } finally {
      a.close();
      b.close();
    }
  });

  it('A rollback discards uncommitted writes — B sees only the snapshot baseline', () => {
    const p = tempFile();
    const a = openShared(p);
    const b = openShared(p);
    try {
      a.execute('CREATE TABLE t (v INTEGER)');
      a.run('INSERT INTO t VALUES (?)', [1]);

      a.beginTransaction();
      a.run('INSERT INTO t VALUES (?)', [2]);
      a.run('INSERT INTO t VALUES (?)', [3]);
      a.rollbackTransaction();

      expect(b.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }]);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('concurrent access — write-lock contention', () => {
  it('second BEGIN IMMEDIATE on conn B is rejected while A holds a write lock', () => {
    const p = tempFile();
    const a = openShared(p);
    const b = openShared(p);
    try {
      // BSMC defaults to a 5-second busy timeout, which would make this
      // test take that long before surfacing SQLITE_BUSY. Pin B's wait
      // to 100ms so we fail-fast — the behaviour we want to prove is
      // "second writer is rejected", not "first writer holds for 5s".
      b.execute('PRAGMA busy_timeout = 100');

      a.execute('CREATE TABLE t (v INTEGER)');
      // BEGIN (without IMMEDIATE) defers write-lock acquisition until
      // the first actual write. Using explicit BEGIN then a write
      // forces the lock.
      a.beginTransaction();
      a.run('INSERT INTO t VALUES (?)', [1]);

      // B's attempt to START a write should fail within 100ms with
      // SQLITE_BUSY. Using raw `execute('BEGIN IMMEDIATE')` so we can
      // observe the rejection without tripping our explicit-tx state
      // machine (which tracks callback/explicit independently).
      expect(() => b.execute('BEGIN IMMEDIATE')).toThrow(/SQLITE_BUSY|database is locked/i);

      // A can still commit cleanly.
      a.commitTransaction();

      // Once A releases, B can take the write lock.
      b.execute('BEGIN IMMEDIATE');
      b.run('INSERT INTO t VALUES (?)', [2]);
      b.execute('COMMIT');

      // Both rows persisted.
      expect(a.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }, { v: 2 }]);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('concurrent access — multiple readers', () => {
  it('three readers see each other\'s base state consistently after one writer commits', () => {
    const p = tempFile();
    const writer = openShared(p);
    writer.execute('CREATE TABLE t (v INTEGER)');
    const r1 = openShared(p);
    const r2 = openShared(p);
    const r3 = openShared(p);
    try {
      for (let i = 1; i <= 10; i += 1) writer.run('INSERT INTO t VALUES (?)', [i]);

      // All three readers see the same committed state.
      const expectRows = Array.from({ length: 10 }, (_, i) => ({ v: i + 1 }));
      expect(r1.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual(expectRows);
      expect(r2.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual(expectRows);
      expect(r3.query<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual(expectRows);
    } finally {
      writer.close();
      r1.close();
      r2.close();
      r3.close();
    }
  });
});
