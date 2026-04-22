/**
 * Task 3.10 — FTS5 virtual table + `unicode61 remove_diacritics 1`
 * tokenizer tests, driven through the `NodeSQLiteAdapter` (not the
 * bare BSMC API).
 *
 * This matches the tokenizer config used by Go Core + mobile storage
 * so the semantic-search layer behaves identically across runtimes.
 * Task 3.3 proved BSMC supports it at the native level; this test
 * proves the ADAPTER exposes it correctly through `execute`/`query`/
 * `run`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '../src/adapter';

const KEY = '0'.repeat(64);

const tmpDirs: string[] = [];
function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sqlite-fts5-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('adapter → FTS5', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => {
    a = new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY });
    a.execute(`
      CREATE VIRTUAL TABLE docs USING fts5(
        body,
        tokenize = "unicode61 remove_diacritics 1"
      );
    `);
  });
  afterEach(() => { a.close(); });

  it('unicode61 remove_diacritics 1 strips diacritics on ingest and query', () => {
    a.run('INSERT INTO docs(body) VALUES (?)', ['Café résumé']);
    a.run('INSERT INTO docs(body) VALUES (?)', ['plain english text']);

    // Non-diacritic query matches the diacritic row because the
    // tokenizer strips diacritics on both sides.
    const hits = a.query<{ body: string }>(
      'SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank',
      ['cafe'],
    );
    expect(hits).toEqual([{ body: 'Café résumé' }]);
  });

  it('BM25 rank orders by term frequency across rows', () => {
    a.run('INSERT INTO docs(body) VALUES (?)', ['alpha beta gamma']);
    a.run('INSERT INTO docs(body) VALUES (?)', ['alpha alpha beta']);
    a.run('INSERT INTO docs(body) VALUES (?)', ['gamma only']);

    const hits = a.query<{ body: string }>(
      'SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank',
      ['alpha'],
    );
    expect(hits).toEqual([
      { body: 'alpha alpha beta' },
      { body: 'alpha beta gamma' },
    ]);
  });

  it('phrase queries work across a multi-word column', () => {
    a.run('INSERT INTO docs(body) VALUES (?)', ['hello world from dina']);
    a.run('INSERT INTO docs(body) VALUES (?)', ['world hello reversed']);

    const exact = a.query<{ body: string }>(
      'SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank',
      ['"hello world"'],
    );
    expect(exact).toHaveLength(1);
    expect(exact[0]!.body).toBe('hello world from dina');
  });

  it('unicode61 is case-insensitive by default', () => {
    a.run('INSERT INTO docs(body) VALUES (?)', ['MixedCASE Text']);
    const hits = a.query<{ body: string }>(
      'SELECT body FROM docs WHERE docs MATCH ?',
      ['mixedcase'],
    );
    expect(hits).toHaveLength(1);
  });

  it('delete + re-insert maintains index integrity', () => {
    a.run('INSERT INTO docs(body) VALUES (?)', ['first doc']);
    a.run('INSERT INTO docs(body) VALUES (?)', ['second doc']);
    const deleted = a.run('DELETE FROM docs WHERE body = ?', ['first doc']);
    expect(deleted).toBe(1);

    const hits = a.query<{ body: string }>(
      'SELECT body FROM docs WHERE docs MATCH ?',
      ['doc'],
    );
    expect(hits).toEqual([{ body: 'second doc' }]);
  });
});
