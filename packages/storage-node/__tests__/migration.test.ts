/**
 * Migration runner tests (task 3.15).
 *
 * Exercises the real `runMigrations` against `NodeSQLiteAdapter`:
 *   - schema_version table creation
 *   - ordered transactional application
 *   - idempotent re-run (second call = no-op)
 *   - partial failure leaves DB in a consistent state
 *   - validation of migration shape
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '../src/adapter';
import {
  MigrationError,
  getSchemaVersion,
  runMigrations,
  type Migration,
} from '../src/migration';

const KEY = '0'.repeat(64);

const tmpDirs: string[] = [];
function tempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-sqlite-migration-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

function openAdapter(): NodeSQLiteAdapter {
  return new NodeSQLiteAdapter({ path: tempPath(), passphraseHex: KEY });
}

describe('runMigrations — happy path', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => { a = openAdapter(); });
  afterEach(() => { a.close(); });

  it('creates schema_version table on first run', () => {
    runMigrations(a, []);
    expect(getSchemaVersion(a)).toBe(0);
    const rows = a.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    );
    expect(rows).toHaveLength(1);
  });

  it('applies a single migration and records the version', () => {
    const nowMs = 1_700_000_000_000;
    const final = runMigrations(
      a,
      [{
        id: 1,
        description: 'init',
        up: ['CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)'],
      }],
      () => nowMs,
    );
    expect(final).toBe(1);
    expect(getSchemaVersion(a)).toBe(1);

    const rows = a.query<{ version: number; applied_at: number }>(
      'SELECT version, applied_at FROM schema_version',
    );
    expect(rows).toEqual([{ version: 1, applied_at: nowMs }]);

    // Table created.
    expect(() => a.execute('INSERT INTO items (name) VALUES (?)', ['a'])).not.toThrow();
  });

  it('applies multiple migrations in id order', () => {
    const migrations: Migration[] = [
      { id: 1, description: 'users', up: ['CREATE TABLE users (id INTEGER PRIMARY KEY)'] },
      { id: 2, description: 'posts', up: ['CREATE TABLE posts (id INTEGER PRIMARY KEY, user INTEGER)'] },
      { id: 3, description: 'comments', up: ['CREATE TABLE comments (id INTEGER PRIMARY KEY, post INTEGER)'] },
    ];
    expect(runMigrations(a, migrations)).toBe(3);
    expect(getSchemaVersion(a)).toBe(3);
    expect(a.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','posts','comments')")).toHaveLength(3);
  });

  it('input order does not matter — sorts by id', () => {
    const unsorted: Migration[] = [
      { id: 3, description: 'third', up: ['CREATE TABLE t3 (v INTEGER)'] },
      { id: 1, description: 'first', up: ['CREATE TABLE t1 (v INTEGER)'] },
      { id: 2, description: 'second', up: ['CREATE TABLE t2 (v INTEGER)'] },
    ];
    runMigrations(a, unsorted);

    const rows = a.query<{ version: number }>('SELECT version FROM schema_version ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it('multi-statement up applies all statements in one transaction', () => {
    runMigrations(a, [{
      id: 1,
      description: 'two tables',
      up: [
        'CREATE TABLE a (id INTEGER)',
        'CREATE TABLE b (id INTEGER)',
      ],
    }]);
    expect(a.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b')")).toHaveLength(2);
  });
});

describe('runMigrations — idempotency', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => { a = openAdapter(); });
  afterEach(() => { a.close(); });

  it('second call with the same list is a no-op', () => {
    const migrations: Migration[] = [
      { id: 1, description: 'init', up: ['CREATE TABLE t (id INTEGER)'] },
    ];
    runMigrations(a, migrations);
    const firstAppliedAt = a.query<{ applied_at: number }>(
      'SELECT applied_at FROM schema_version WHERE version = 1',
    )[0]!.applied_at;

    // Re-run — should not re-apply, applied_at preserved.
    runMigrations(a, migrations);
    const secondAppliedAt = a.query<{ applied_at: number }>(
      'SELECT applied_at FROM schema_version WHERE version = 1',
    )[0]!.applied_at;
    expect(secondAppliedAt).toBe(firstAppliedAt);
  });

  it('adding new migrations only applies the new ones', () => {
    runMigrations(a, [{ id: 1, description: 'init', up: ['CREATE TABLE t1 (v INTEGER)'] }]);
    expect(getSchemaVersion(a)).toBe(1);

    runMigrations(a, [
      { id: 1, description: 'init', up: ['CREATE TABLE t1 (v INTEGER)'] },
      { id: 2, description: 'added', up: ['CREATE TABLE t2 (v INTEGER)'] },
    ]);
    expect(getSchemaVersion(a)).toBe(2);
    // t1 wasn't re-created (its existence would error on "already exists"
    // unless the IF NOT EXISTS clause is used). The fact that the second
    // run didn't throw proves migration 1 was skipped.
  });

  it('survives across close/reopen — version persists to disk', () => {
    const dbPath = tempPath();
    const migrations: Migration[] = [
      { id: 1, description: 'init', up: ['CREATE TABLE t (v INTEGER)'] },
      { id: 2, description: 'column', up: ['ALTER TABLE t ADD COLUMN tag TEXT'] },
    ];
    const a1 = new NodeSQLiteAdapter({ path: dbPath, passphraseHex: KEY });
    runMigrations(a1, migrations);
    a1.close();

    const a2 = new NodeSQLiteAdapter({ path: dbPath, passphraseHex: KEY });
    try {
      expect(getSchemaVersion(a2)).toBe(2);
      // Re-run from clean adapter — still no-op.
      expect(runMigrations(a2, migrations)).toBe(2);
    } finally {
      a2.close();
    }
  });
});

describe('runMigrations — failure semantics', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => { a = openAdapter(); });
  afterEach(() => { a.close(); });

  it('failed migration rolls back its transaction', () => {
    const migrations: Migration[] = [{
      id: 1,
      description: 'bad',
      up: [
        'CREATE TABLE half (id INTEGER)',
        'NOT VALID SQL STATEMENT', // will error
      ],
    }];
    expect(() => runMigrations(a, migrations)).toThrow(/migration_failed/);

    // schema_version should not mark migration 1 as applied.
    expect(getSchemaVersion(a)).toBe(0);
    // The `half` table created in the same transaction must have rolled back.
    expect(
      a.query("SELECT name FROM sqlite_master WHERE type='table' AND name='half'"),
    ).toHaveLength(0);
  });

  it('stops at first failing migration, earlier ones stay applied', () => {
    const migrations: Migration[] = [
      { id: 1, description: 'ok', up: ['CREATE TABLE ok (v INTEGER)'] },
      { id: 2, description: 'bad', up: ['NOT VALID SQL'] },
      { id: 3, description: 'never runs', up: ['CREATE TABLE later (v INTEGER)'] },
    ];
    expect(() => runMigrations(a, migrations)).toThrow(/migration_failed/);
    expect(getSchemaVersion(a)).toBe(1);
    expect(a.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ok'")).toHaveLength(1);
    expect(a.query("SELECT name FROM sqlite_master WHERE type='table' AND name='later'")).toHaveLength(0);
  });
});

describe('runMigrations — input validation', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => { a = openAdapter(); });
  afterEach(() => { a.close(); });

  it('rejects non-array migrations', () => {
    expect(() =>
      runMigrations(a, 'hi' as unknown as Migration[]),
    ).toThrow(/invalid_input/);
  });

  it.each([
    ['zero id', [{ id: 0, description: 'x', up: ['CREATE TABLE x (v INTEGER)'] }]],
    ['negative id', [{ id: -1, description: 'x', up: ['CREATE TABLE x (v INTEGER)'] }]],
    ['float id', [{ id: 1.5, description: 'x', up: ['CREATE TABLE x (v INTEGER)'] }]],
  ] as const)('rejects %s', (_label, bad) => {
    expect(() => runMigrations(a, bad as unknown as Migration[])).toThrow(/invalid_migration/);
  });

  it('rejects duplicate ids', () => {
    const dup: Migration[] = [
      { id: 1, description: 'a', up: ['CREATE TABLE a (v INTEGER)'] },
      { id: 1, description: 'b', up: ['CREATE TABLE b (v INTEGER)'] },
    ];
    expect(() => runMigrations(a, dup)).toThrow(/duplicate_id/);
  });

  it('rejects empty up', () => {
    expect(() =>
      runMigrations(a, [{ id: 1, description: 'x', up: [] }]),
    ).toThrow(/invalid_migration/);
  });

  it('rejects non-string statement in up', () => {
    expect(() =>
      runMigrations(a, [{ id: 1, description: 'x', up: [null as unknown as string] }]),
    ).toThrow(/invalid_migration/);
  });

  it('rejects empty-string statement in up', () => {
    expect(() =>
      runMigrations(a, [{ id: 1, description: 'x', up: ['   '] }]),
    ).toThrow(/invalid_migration/);
  });

  it('MigrationError carries code', () => {
    try {
      runMigrations(a, [{ id: 0, description: 'x', up: ['CREATE TABLE x (v INTEGER)'] }]);
      fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MigrationError);
      expect((e as MigrationError).code).toBe('invalid_migration');
    }
  });
});

describe('getSchemaVersion', () => {
  let a: NodeSQLiteAdapter;
  beforeEach(() => { a = openAdapter(); });
  afterEach(() => { a.close(); });

  it('returns 0 on a fresh DB (creates table as a side effect)', () => {
    expect(getSchemaVersion(a)).toBe(0);
  });

  it('reads back the highest applied version', () => {
    runMigrations(a, [
      { id: 1, description: 'a', up: ['CREATE TABLE a (v INTEGER)'] },
      { id: 2, description: 'b', up: ['CREATE TABLE b (v INTEGER)'] },
    ]);
    expect(getSchemaVersion(a)).toBe(2);
  });
});
