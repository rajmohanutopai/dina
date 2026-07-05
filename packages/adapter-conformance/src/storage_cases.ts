/**
 * Storage adapter conformance cases — the behavioral contract of
 * `DatabaseAdapter` (`@dina/core/storage`), asserted identically against
 * better-sqlite3 (node, CI) and op-sqlite (device).
 *
 * Each case receives a FRESH, already-open adapter and creates its own table,
 * so cases are isolated and order-independent. All adapter calls are
 * synchronous (the contract is sync on both backends).
 *
 * Targets the highest silent-divergence risks catalogued across the two
 * impls: `run()` rows-affected (`info.changes` vs `result.rowsAffected ?? 0` —
 * the original CAS-corruption bug), blob type coercion (Buffer vs
 * ArrayBuffer/Uint8Array), `query()` aggregate aliasing + shape fallback,
 * transaction rollback, FTS5 availability, NULL/number coercion, and that a
 * constraint violation actually throws.
 *
 * Out of scope here (logged as findings, not asserted as a green contract):
 * cross-impl SQLCipher cipher-param decryption (inherently a device-side
 * write-on-node/read-on-op-sqlite test), `foreign_keys` default, journal_mode
 * configurability — these have no unified contract yet and would redden node.
 */

import { assert, assertEqual, assertBytesEqual, assertThrowsSync, errorText } from './assert';
import type { ConformanceCase } from './case';
import type { ConformanceDatabaseAdapter } from './types';

/** First row of a result set, asserting the set is non-empty. */
function first(rows: Array<Record<string, unknown>>, label: string): Record<string, unknown> {
  const row = rows[0];
  assert(row !== undefined, `${label}: expected at least one row, got none`);
  return row;
}

/** Read a single scalar column from the first row of a query. */
function scalar(adapter: ConformanceDatabaseAdapter, sql: string, params?: unknown[]): unknown {
  const row = first(adapter.query(sql, params), `scalar(${sql})`);
  const key0 = Object.keys(row)[0];
  assert(key0 !== undefined, `scalar(${sql}): row had no columns`);
  return row[key0];
}

function rowCount(adapter: ConformanceDatabaseAdapter, table: string): number {
  return Number(scalar(adapter, `SELECT COUNT(*) FROM ${table}`));
}

export const STORAGE_CASES: ReadonlyArray<ConformanceCase<ConformanceDatabaseAdapter>> = [
  // ── run(): rows affected — the original op-sqlite bug ────────────────────
  {
    name: 'run-insert-returns-1',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      assertEqual(db.run('INSERT INTO t (v) VALUES (?)', ['a']), 1, 'INSERT affects 1 row');
    },
  },
  {
    name: 'run-multi-delete-returns-n',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      for (const v of ['a', 'b', 'c']) db.run('INSERT INTO t (v) VALUES (?)', [v]);
      assertEqual(db.run('DELETE FROM t'), 3, 'DELETE of 3 rows reports 3');
    },
  },
  {
    name: 'run-update-zero-rows-returns-0',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.run('INSERT INTO t (v) VALUES (?)', ['a']);
      // No row matches → 0 affected. A constant-1 return (the bug) breaks CAS.
      assertEqual(db.run('UPDATE t SET v = ? WHERE v = ?', ['x', 'nomatch']), 0, 'no-match UPDATE → 0');
    },
  },
  {
    name: 'run-update-matching-returns-n',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, g INTEGER)');
      for (let i = 0; i < 4; i++) db.run('INSERT INTO t (v, g) VALUES (?, 1)', [`r${i}`]);
      db.run('INSERT INTO t (v, g) VALUES (?, 2)', ['other']);
      assertEqual(db.run('UPDATE t SET v = ? WHERE g = 1', ['z']), 4, 'matching UPDATE → 4');
    },
  },
  {
    name: 'run-cas-guard-zero-when-stale',
    run(db) {
      // The exact CAS pattern that broke: an optimistic update guarded by a
      // version column must report 0 when the guard fails, 1 when it matches.
      db.execute('CREATE TABLE kv (k TEXT PRIMARY KEY, val TEXT, ver INTEGER)');
      db.run('INSERT INTO kv (k, val, ver) VALUES (?, ?, ?)', ['x', 'v1', 1]);
      assertEqual(db.run('UPDATE kv SET val=?, ver=ver+1 WHERE k=? AND ver=?', ['v2', 'x', 9]), 0, 'stale CAS → 0');
      assertEqual(db.run('UPDATE kv SET val=?, ver=ver+1 WHERE k=? AND ver=?', ['v2', 'x', 1]), 1, 'fresh CAS → 1');
    },
  },

  // ── query(): row shape, empties, aggregate aliasing ──────────────────────
  {
    name: 'query-returns-rows-keyed-by-column',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
      db.run('INSERT INTO t (name, n) VALUES (?, ?)', ['alice', 7]);
      const rows = db.query('SELECT name, n FROM t');
      assertEqual(rows.length, 1, 'one row');
      const row = first(rows, 'select name,n');
      assertEqual(row.name, 'alice', 'name column');
      assertEqual(row.n, 7, 'n column');
    },
  },
  {
    name: 'query-empty-result-is-empty-array',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const rows = db.query('SELECT * FROM t');
      assert(Array.isArray(rows), 'result is an array');
      assertEqual(rows.length, 0, 'empty table → []');
    },
  },
  {
    name: 'query-aggregate-aliased-keys-by-alias',
    run(db) {
      // op-sqlite historically keyed `SELECT MAX(v)` by the raw expression, so
      // an un-aliased aggregate read back `undefined`. Aliasing is the portable
      // fix; assert the alias resolves on both.
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
      for (const v of [3, 9, 5]) db.run('INSERT INTO t (v) VALUES (?)', [v]);
      const rows = db.query('SELECT MAX(v) AS m FROM t');
      assertEqual(rows.length, 1, 'one aggregate row');
      assertEqual(first(rows, 'aggregate').m, 9, 'aliased MAX resolves');
    },
  },

  // ── execute(): DDL + single-statement DML ────────────────────────────────
  {
    name: 'execute-ddl-then-dml',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.execute("INSERT INTO t (v) VALUES ('seed')");
      assertEqual(rowCount(db, 't'), 1, 'execute applied the DML');
    },
  },

  // ── transaction(): commit / rollback / re-throw ──────────────────────────
  {
    name: 'transaction-commits-on-success',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.transaction(() => {
        db.run('INSERT INTO t (v) VALUES (?)', ['a']);
        db.run('INSERT INTO t (v) VALUES (?)', ['b']);
      });
      assertEqual(rowCount(db, 't'), 2, 'both inserts committed');
    },
  },
  {
    name: 'transaction-rolls-back-and-rethrows',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.run('INSERT INTO t (v) VALUES (?)', ['keep']);
      const sentinel = new Error('rollback-sentinel');
      const caught = assertThrowsSync(() => {
        db.transaction(() => {
          db.run('INSERT INTO t (v) VALUES (?)', ['gone']);
          throw sentinel;
        });
      }, 'transaction re-throws');
      assert(caught === sentinel, 'the original error is re-thrown unchanged');
      assertEqual(rowCount(db, 't'), 1, 'rollback left only the pre-tx row');
    },
  },

  // ── close() / isOpen ─────────────────────────────────────────────────────
  {
    name: 'isOpen-true-while-open',
    run(db) {
      assertEqual(db.isOpen, true, 'a freshly opened adapter is open');
    },
  },
  {
    name: 'close-is-idempotent',
    run(db) {
      db.close();
      assertEqual(db.isOpen, false, 'isOpen false after close');
      // Second close must not throw.
      db.close();
      assertEqual(db.isOpen, false, 'still closed after a second close');
    },
  },
  {
    name: 'post-close-query-throws',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      db.close();
      // Don't assert message prose (it differs across impls) — just that a
      // post-close operation fails loudly rather than returning stale data.
      assertThrowsSync(() => db.query('SELECT 1'), 'query after close throws');
    },
  },

  // ── blobs: the silent corruption class (Buffer vs ArrayBuffer/Uint8Array) ─
  {
    name: 'blob-uint8array-round-trips-as-uint8array',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)');
      const payload = new Uint8Array([0, 1, 2, 250, 255, 128, 7]);
      db.run('INSERT INTO t (data) VALUES (?)', [payload]);
      const got = first(db.query('SELECT data FROM t'), 'blob').data;
      // assertBytesEqual also asserts it IS a Uint8Array (an ArrayBuffer read
      // back would fail the row contract — the op-sqlite divergence).
      assertBytesEqual(got, payload, 'blob bytes round-trip');
    },
  },
  {
    name: 'blob-empty-round-trips',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)');
      db.run('INSERT INTO t (data) VALUES (?)', [new Uint8Array(0)]);
      const got = first(db.query('SELECT data FROM t'), 'empty blob').data;
      assertBytesEqual(got, new Uint8Array(0), 'empty blob round-trips');
    },
  },
  {
    name: 'blob-large-1mb-round-trips',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)');
      const big = new Uint8Array(1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
      db.run('INSERT INTO t (data) VALUES (?)', [big]);
      const got = first(db.query('SELECT data FROM t'), 'large blob').data;
      assertBytesEqual(got, big, '1MB blob round-trips intact');
    },
  },

  // ── NULL / number coercion ───────────────────────────────────────────────
  {
    name: 'null-reads-back-as-null',
    run(db) {
      db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.run('INSERT INTO t (v) VALUES (?)', [null]);
      assertEqual(first(db.query('SELECT v FROM t'), 'null').v, null, 'NULL → null');
    },
  },
  {
    name: 'integer-and-text-coercion',
    run(db) {
      db.execute('CREATE TABLE t (i INTEGER, s TEXT, r REAL)');
      db.run('INSERT INTO t (i, s, r) VALUES (?, ?, ?)', [42, 'hi', 1.5]);
      const row = first(db.query('SELECT i, s, r FROM t'), 'coerce');
      assertEqual(typeof row.i, 'number', 'INTEGER → number');
      assertEqual(row.i, 42, 'integer value');
      assertEqual(typeof row.s, 'string', 'TEXT → string');
      assertEqual(row.s, 'hi', 'text value');
      assertEqual(row.r, 1.5, 'REAL value');
    },
  },

  // ── constraint enforcement actually throws ───────────────────────────────
  {
    name: 'unique-violation-throws-and-leaves-one-row',
    run(db) {
      db.execute('CREATE TABLE t (k TEXT UNIQUE)');
      db.run('INSERT INTO t (k) VALUES (?)', ['dup']);
      const err = assertThrowsSync(
        () => db.run('INSERT INTO t (k) VALUES (?)', ['dup']),
        'duplicate UNIQUE throws',
      );
      // Tolerant shape check: a constraint signal, not exact prose.
      const text = errorText(err);
      assert(
        text.includes('unique') || text.includes('constraint'),
        `expected a constraint error, got: ${text}`,
      );
      assertEqual(rowCount(db, 't'), 1, 'the failed insert added nothing');
    },
  },

  // ── FTS5: presence + ranked search (op-sqlite must be built with FTS5) ────
  {
    name: 'fts5-create-insert-match-ranked',
    run(db) {
      db.execute("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61 remove_diacritics 1')");
      db.run("INSERT INTO docs (body) VALUES ('the quick brown fox')", []);
      db.run("INSERT INTO docs (body) VALUES ('a slow brown bear and a quick quick hare')", []);
      const rows = db.query("SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank", ['quick']);
      assertEqual(rows.length, 2, 'both docs match "quick"');
      // BM25 ranks the doc with more/denser hits first.
      const top = first(rows, 'fts5 ranked').body;
      assert(
        String(top).includes('quick quick'),
        `expected the denser match first, got: ${String(top)}`,
      );
    },
  },
  {
    name: 'fts5-diacritic-folding',
    run(db) {
      db.execute("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61 remove_diacritics 1')");
      db.run("INSERT INTO docs (body) VALUES ('café société')", []);
      const rows = db.query('SELECT body FROM docs WHERE docs MATCH ?', ['cafe']);
      assertEqual(rows.length, 1, 'diacritic-folded search matches');
    },
  },
];
