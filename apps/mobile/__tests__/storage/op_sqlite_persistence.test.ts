/**
 * Persistence is actually exercised in tests.
 *
 * Before the op-sqlite Jest mock, `OpSQLiteAdapter` couldn't open in Jest
 * (native module won't load), so the unlock path swallowed the failure and
 * everything ran on the in-memory fallback — "persistence healthy" was
 * never really tested. This drives the SAME adapter against real SQLite
 * (via the mock) to prove open + DDL + CRUD + transaction semantics work.
 */
import { open } from '@op-engineering/op-sqlite';

import { OpSQLiteAdapter } from '../../src/storage/op_sqlite_adapter';

type OpenFn = Parameters<OpSQLiteAdapter['open']>[3];
const openFn = open as unknown as OpenFn;

describe('OpSQLiteAdapter — real SQLite via the op-sqlite mock', () => {
  it('opens, runs DDL/CRUD, and reads the row back', () => {
    const adapter = new OpSQLiteAdapter();
    expect(adapter.isOpen).toBe(false);

    // Empty location -> in-memory DB; empty dekHex -> mock skips PRAGMA key.
    adapter.open('test.sqlite', '', '', openFn);
    expect(adapter.isOpen).toBe(true);

    adapter.execute('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
    adapter.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['did', 'did:plc:abc']);

    const rows = adapter.query<{ k: string; v: string }>('SELECT k, v FROM kv WHERE k = ?', [
      'did',
    ]);
    expect(rows).toEqual([{ k: 'did', v: 'did:plc:abc' }]);

    adapter.close();
    expect(adapter.isOpen).toBe(false);
  });

  it('rolls back a failed transaction (genuine SQLite semantics)', () => {
    const adapter = new OpSQLiteAdapter();
    adapter.open('tx.sqlite', '', '', openFn);
    adapter.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    adapter.run('INSERT INTO t (id) VALUES (1)');

    expect(() =>
      adapter.transaction(() => {
        adapter.run('INSERT INTO t (id) VALUES (2)');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // The in-flight row was rolled back; only the pre-transaction row remains.
    const rows = adapter.query<{ id: number }>('SELECT id FROM t ORDER BY id');
    expect(rows).toEqual([{ id: 1 }]);
    adapter.close();
  });
});
