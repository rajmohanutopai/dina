/**
 * Task 3.3 — verify `better-sqlite3-multiple-ciphers` exposes the two
 * features our `DatabaseAdapter` implementation depends on:
 *
 *   1. **FTS5** with the `unicode61 remove_diacritics 1` tokenizer
 *      (matches Go Core + mobile storage).
 *   2. **Journal mode `WAL`** (crash-safety config per task 3.14).
 *
 * This test hits the real native module — no adapter layer, no mocking.
 * If it passes, the library decision in task 3.1 is validated end-to-end
 * for the two capabilities Phase 3a depends on most heavily.
 *
 * The test uses an **in-memory database** (`:memory:`) so no filesystem
 * state leaks between runs; WAL mode is verified by attempting to enable
 * it against a file-backed DB (WAL requires a real file) then reading
 * `PRAGMA journal_mode` back.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

describe('BSMC feature verification — FTS5', () => {
  it('creates an FTS5 virtual table with unicode61 remove_diacritics 1', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE VIRTUAL TABLE docs USING fts5(
          body,
          tokenize = "unicode61 remove_diacritics 1"
        );
      `);
      db.prepare('INSERT INTO docs(body) VALUES (?)').run('Café résumé');
      db.prepare('INSERT INTO docs(body) VALUES (?)').run('plain english text');

      // Query with a non-diacritic form — should hit the diacritic row
      // because the tokenizer strips diacritics on ingestion + query.
      const rows = db
        .prepare('SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank')
        .all('cafe');
      expect(rows).toHaveLength(1);
      expect((rows[0] as { body: string }).body).toBe('Café résumé');
    } finally {
      db.close();
    }
  });

  it('FTS5 MATCH operator returns the BM25-ranked row ordering', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE docs USING fts5(body);');
      const ins = db.prepare('INSERT INTO docs(body) VALUES (?)');
      ins.run('alpha beta gamma');
      ins.run('alpha alpha beta');
      ins.run('gamma only');

      const rows = db
        .prepare('SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank')
        .all('alpha');
      expect(rows).toHaveLength(2);
      // BM25 gives higher rank (lower score) to the doc with more `alpha`
      // occurrences, so "alpha alpha beta" ranks first.
      expect((rows[0] as { body: string }).body).toBe('alpha alpha beta');
    } finally {
      db.close();
    }
  });
});

describe('BSMC feature verification — WAL journal mode', () => {
  it('accepts PRAGMA journal_mode=WAL on a file-backed DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsmc-wal-'));
    const dbPath = path.join(dir, 'wal-check.sqlite');
    const db = new Database(dbPath);
    try {
      // `PRAGMA journal_mode = WAL` returns the mode that ended up active.
      // sqlite-mc keeps the WAL pragma result shaped as { journal_mode: 'wal' }.
      const result = db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>;
      expect(result).toHaveLength(1);
      expect(result[0]!.journal_mode).toBe('wal');

      // Sanity: a second read without argument reports 'wal' back.
      const readback = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      expect(readback[0]!.journal_mode).toBe('wal');

      // Crash-safety companion setting (task 3.14).
      db.pragma('synchronous = NORMAL');
      const sync = db.pragma('synchronous') as Array<{ synchronous: number }>;
      // synchronous = NORMAL = 1.
      expect(sync[0]!.synchronous).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in-memory DBs fall back to memory journal (WAL not supported)', () => {
    const db = new Database(':memory:');
    try {
      // Attempting WAL on :memory: silently falls back to 'memory' — this is
      // SQLite behaviour, documented here so nobody misreads a later failure
      // as a BSMC bug. Our real adapter only uses WAL on file-backed DBs.
      const result = db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>;
      expect(result[0]!.journal_mode).toBe('memory');
    } finally {
      db.close();
    }
  });
});

