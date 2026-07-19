/**
 * Data-scope cleanup — unit tests (registry-driven deleteDataScope).
 */

import {
  deleteDataScope,
  registerScopedCleanup,
  clearScopedCleanups,
  registeredCleanupTables,
  type ScopedCleanup,
} from '../../src/scope/cleanup';

import type { DataScope } from '../../src/scope/data_scope';

/** An in-memory scoped table for testing cleanup behavior. */
function fakeTable(table: string, order?: number) {
  const rows = new Map<DataScope, number>();
  const calls: DataScope[] = [];
  const cleanup: ScopedCleanup = {
    table,
    order,
    deleteScope: (scope) => {
      calls.push(scope);
      const n = rows.get(scope) ?? 0;
      rows.delete(scope);
      return n;
    },
  };
  return { cleanup, rows, calls, seed: (scope: DataScope, n: number) => rows.set(scope, n) };
}

describe('deleteDataScope', () => {
  beforeEach(() => clearScopedCleanups());
  afterEach(() => clearScopedCleanups());

  it('refuses to delete the user scope', async () => {
    await expect(deleteDataScope('user')).rejects.toThrow(/refusing to delete the user scope/);
  });

  it('rejects an invalid scope', async () => {
    await expect(deleteDataScope('garbage' as DataScope)).rejects.toThrow(/invalid scope/);
  });

  it('runs every registered cleanup and reports per-table counts', async () => {
    const a = fakeTable('vault_items');
    const b = fakeTable('reminders');
    a.seed('guided_demo:x', 3);
    b.seed('guided_demo:x', 2);
    registerScopedCleanup(a.cleanup);
    registerScopedCleanup(b.cleanup);

    const res = await deleteDataScope('guided_demo:x');
    expect(res.scope).toBe('guided_demo:x');
    expect(res.deleted).toEqual({ vault_items: 3, reminders: 2 });
    expect(res.errors).toEqual([]);
  });

  it('runs cleanups in ascending `order` (child before parent)', async () => {
    const order: string[] = [];
    registerScopedCleanup({
      table: 'parent',
      order: 50,
      deleteScope: () => {
        order.push('parent');
        return 0;
      },
    });
    registerScopedCleanup({
      table: 'child',
      order: 10,
      deleteScope: () => {
        order.push('child');
        return 0;
      },
    });
    expect(registeredCleanupTables()).toEqual(['child', 'parent']);
    await deleteDataScope('guided_demo:x');
    expect(order).toEqual(['child', 'parent']);
  });

  it('isolates a failing table and continues', async () => {
    const ok = fakeTable('ok');
    ok.seed('guided_demo:x', 1);
    registerScopedCleanup({
      table: 'boom',
      order: 1,
      deleteScope: () => {
        throw new Error('disk full');
      },
    });
    registerScopedCleanup(ok.cleanup);

    const res = await deleteDataScope('guided_demo:x');
    expect(res.errors).toEqual([{ table: 'boom', error: 'disk full' }]);
    expect(res.deleted).toEqual({ ok: 1 });
  });

  it('is idempotent — a second run deletes zero', async () => {
    const a = fakeTable('vault_items');
    a.seed('guided_demo:x', 5);
    registerScopedCleanup(a.cleanup);

    expect((await deleteDataScope('guided_demo:x')).deleted).toEqual({ vault_items: 5 });
    expect((await deleteDataScope('guided_demo:x')).deleted).toEqual({ vault_items: 0 });
  });

  it('only deletes the requested scope, leaving other scopes intact', async () => {
    const a = fakeTable('vault_items');
    a.seed('guided_demo:x', 4);
    a.seed('user', 9);
    registerScopedCleanup(a.cleanup);

    await deleteDataScope('guided_demo:x');
    expect(a.rows.get('user')).toBe(9);
    expect(a.rows.get('guided_demo:x')).toBeUndefined();
  });

  it('dedupes registration by table (last wins)', async () => {
    registerScopedCleanup({ table: 't', deleteScope: () => 1 });
    registerScopedCleanup({ table: 't', deleteScope: () => 2 });
    expect(registeredCleanupTables()).toEqual(['t']);
    expect((await deleteDataScope('guided_demo:x')).deleted).toEqual({ t: 2 });
  });
});
