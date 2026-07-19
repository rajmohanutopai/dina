/**
 * Scope-cleanup wiring + teardown orchestration — unit tests.
 */

import { resetKVStore } from '../../src/kv/store';
import { getActiveDemo, setActiveDemo } from '../../src/scope/active_demo';
import {
  clearScopedCleanups,
  deleteDataScope,
  registerScopedCleanup,
  registeredCleanupTables,
} from '../../src/scope/cleanup';
import {
  wireIdentityScopeCleanups,
  wirePersonaScopeCleanups,
  tearDownDataScope,
} from '../../src/scope/cleanup_wiring';
import { currentDataScope, resetDataScope, setCurrentDataScope } from '../../src/scope/data_scope';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

/** Minimal fake adapter that honours `… WHERE data_scope = ?` count + delete. */
function fakeDb() {
  const tables = new Map<string, { data_scope: string }[]>();
  const tableOf = (sql: string): string => /FROM\s+(\w+)/i.exec(sql)?.[1] ?? '';
  const db = {
    query: (sql: string, params?: unknown[]): unknown[] => {
      const rows = tables.get(tableOf(sql)) ?? [];
      const scope = params?.[0] as string;
      return [{ c: rows.filter((r) => r.data_scope === scope).length }];
    },
    execute: (sql: string, params?: unknown[]): void => {
      const t = tableOf(sql);
      const scope = params?.[0] as string;
      tables.set(t, (tables.get(t) ?? []).filter((r) => r.data_scope !== scope));
    },
  } as unknown as DatabaseAdapter;
  return {
    db,
    seed(table: string, scope: string, n: number): void {
      const rows = tables.get(table) ?? [];
      for (let i = 0; i < n; i += 1) rows.push({ data_scope: scope });
      tables.set(table, rows);
    },
    count(table: string, scope: string): number {
      return (tables.get(table) ?? []).filter((r) => r.data_scope === scope).length;
    },
  };
}

describe('scope cleanup wiring', () => {
  beforeEach(() => {
    clearScopedCleanups();
    resetKVStore();
    resetDataScope();
  });
  afterEach(() => clearScopedCleanups());

  it('registers identity + persona tables in child→parent order', () => {
    wireIdentityScopeCleanups(() => null);
    wirePersonaScopeCleanups(() => []);
    expect(registeredCleanupTables()).toEqual([
      'vault_item_subjects',
      'chat_messages',
      'person_surfaces',
      'reminders',
      'vault_items',
      'staging_inbox',
      'people',
    ]);
  });

  it('deletes across identity + persona DBs, reports counts, leaves user intact', async () => {
    const id = fakeDb();
    const persona = fakeDb();
    id.seed('reminders', 'guided_demo:x', 2);
    id.seed('reminders', 'user', 5);
    id.seed('people', 'guided_demo:x', 1);
    persona.seed('vault_items', 'guided_demo:x', 3);
    persona.seed('vault_item_subjects', 'guided_demo:x', 4);

    wireIdentityScopeCleanups(() => id.db);
    wirePersonaScopeCleanups(() => [persona.db]);

    const res = await deleteDataScope('guided_demo:x');
    expect(res.deleted).toMatchObject({
      reminders: 2,
      people: 1,
      vault_items: 3,
      vault_item_subjects: 4,
    });
    expect(res.errors).toEqual([]);
    expect(id.count('reminders', 'user')).toBe(5); // user untouched
    expect(id.count('reminders', 'guided_demo:x')).toBe(0);
  });

  it('sums persona deletes across multiple open persona DBs', async () => {
    const a = fakeDb();
    const b = fakeDb();
    a.seed('vault_items', 'guided_demo:x', 2);
    b.seed('vault_items', 'guided_demo:x', 3);
    wireIdentityScopeCleanups(() => null);
    wirePersonaScopeCleanups(() => [a.db, b.db]);
    const res = await deleteDataScope('guided_demo:x');
    expect(res.deleted.vault_items).toBe(5);
  });

  it('tearDownDataScope clears active demo + resets scope to user', async () => {
    const id = fakeDb();
    wireIdentityScopeCleanups(() => id.db);
    wirePersonaScopeCleanups(() => []);
    await setActiveDemo({ activeDemoScope: 'guided_demo:x', startedAt: 1, step: '' });
    setCurrentDataScope('guided_demo:x');

    await tearDownDataScope('guided_demo:x');
    expect(await getActiveDemo()).toBeNull();
    expect(currentDataScope()).toBe('user');
  });

  it('tearDownDataScope refuses the user scope', async () => {
    await expect(tearDownDataScope('user')).rejects.toThrow(/refusing to delete the user scope/);
  });

  it('tearDownDataScope KEEPS the recovery record when a table cleanup fails', async () => {
    // A partially-failed delete must not abandon demo rows: keep the active-demo
    // record so the next boot can retry. Register a deleter that throws.
    registerScopedCleanup({
      table: 'vault_items',
      order: 50,
      deleteScope: () => {
        throw new Error('disk full');
      },
    });
    await setActiveDemo({ activeDemoScope: 'guided_demo:x', startedAt: 1, step: '' });
    setCurrentDataScope('guided_demo:x');

    const res = await tearDownDataScope('guided_demo:x');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.table).toBe('vault_items');
    // Recovery preserved (retry on next boot); runtime still returns to user so
    // the user isn't stranded (the un-deleted rows stay hidden by scope).
    expect(await getActiveDemo()).not.toBeNull();
    expect(currentDataScope()).toBe('user');
  });

  it('persona cleanup accepts an ASYNC provider (opens all personas on demand)', async () => {
    // #4: the deleter must cover personas that aren't open yet, so the provider
    // is allowed to be async (opening a closed persona derives its DEK).
    const a = fakeDb();
    const b = fakeDb();
    a.seed('vault_items', 'guided_demo:x', 2);
    b.seed('vault_items', 'guided_demo:x', 4);
    wireIdentityScopeCleanups(() => null);
    wirePersonaScopeCleanups(async () => Promise.resolve([a.db, b.db]));
    const res = await deleteDataScope('guided_demo:x');
    expect(res.deleted.vault_items).toBe(6);
    expect(res.errors).toEqual([]);
  });

  it('a persona that FAILS to open cleans the rest + records an error (recovery kept)', async () => {
    // R4: openAllPersonaAdapters reports `failed` personas; the deleter cleans
    // the openable ones, then throws so the failure is recorded — and
    // tearDownDataScope keeps the recovery record (rows in the unopened persona
    // may still survive).
    const ok = fakeDb();
    ok.seed('vault_items', 'guided_demo:x', 3);
    ok.seed('vault_item_subjects', 'guided_demo:x', 1);
    wireIdentityScopeCleanups(() => null);
    wirePersonaScopeCleanups(() => ({ adapters: [ok.db], failed: ['health'] }));
    await setActiveDemo({ activeDemoScope: 'guided_demo:x', startedAt: 1, step: '' });
    setCurrentDataScope('guided_demo:x');

    const res = await tearDownDataScope('guided_demo:x');
    // Openable persona was still cleaned…
    expect(ok.count('vault_items', 'guided_demo:x')).toBe(0);
    // …and the failed-to-open persona is reported as an error per persona table.
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.every((e) => /persona open failed/.test(e.error))).toBe(true);
    // Recovery record preserved for a next-boot retry.
    expect(await getActiveDemo()).not.toBeNull();
  });
});
