/**
 * Guided-demo orchestration state machine — unit tests
 * (start / pending / resume / end + crash recovery).
 */

import { resetKVStore } from '../../src/kv/store';
import { getActiveDemo } from '../../src/scope/active_demo';
import { clearScopedCleanups } from '../../src/scope/cleanup';
import { wireIdentityScopeCleanups } from '../../src/scope/cleanup_wiring';
import {
  currentDataScope,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
} from '../../src/scope/data_scope';
import {
  startGuidedDemo,
  startEmpty,
  pendingGuidedDemo,
  resumeGuidedDemo,
  markGuidedDemoStep,
  endGuidedDemo,
} from '../../src/scope/guided_demo';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

/** Fake adapter honouring `… WHERE data_scope = ?` count + delete. */
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

describe('guided-demo orchestration', () => {
  let id: ReturnType<typeof fakeDb>;
  beforeEach(() => {
    resetKVStore();
    resetDataScope();
    clearScopedCleanups();
    setGuidedDemoIdFactory(() => 'run1');
    id = fakeDb();
    wireIdentityScopeCleanups(() => id.db);
  });
  afterEach(() => {
    clearScopedCleanups();
    resetGuidedDemoIdFactory();
  });

  it('start switches scope, persists the recovery record with an EMPTY step', async () => {
    const scope = await startGuidedDemo(1000);
    expect(scope).toBe('guided_demo:run1');
    expect(currentDataScope()).toBe('guided_demo:run1');
    // step starts empty — the marker records the last COMPLETED step, so a
    // crash right after start must resume from the beginning, NOT skip step 1.
    expect(await getActiveDemo()).toEqual({
      activeDemoScope: 'guided_demo:run1',
      startedAt: 1000,
      step: '',
    });
  });

  it('markGuidedDemoStep advances the recorded step', async () => {
    await startGuidedDemo(1);
    await markGuidedDemoStep('chair_ask');
    expect((await getActiveDemo())?.step).toBe('chair_ask');
  });

  it('end tears down the demo data, clears recovery, returns to user', async () => {
    await startGuidedDemo(1);
    id.seed('reminders', 'guided_demo:run1', 2);
    id.seed('reminders', 'user', 3);

    const torn = await endGuidedDemo();
    expect(torn).toBe('guided_demo:run1');
    expect(currentDataScope()).toBe('user');
    expect(await getActiveDemo()).toBeNull();
    expect(id.count('reminders', 'guided_demo:run1')).toBe(0);
    expect(id.count('reminders', 'user')).toBe(3); // user untouched
  });

  it('end is a no-op when there is no active demo', async () => {
    expect(await endGuidedDemo()).toBeNull();
    expect(currentDataScope()).toBe('user');
  });

  it('startEmpty keeps the runtime on user', () => {
    startEmpty();
    expect(currentDataScope()).toBe('user');
  });

  it('crash-recovery: pending → resume → end', async () => {
    // Start a demo, write some data.
    await startGuidedDemo(1);
    id.seed('people', 'guided_demo:run1', 1);

    // Simulate a restart: runtime scope is lost (back to user default), but the
    // KV recovery record survives.
    resetDataScope();
    expect(currentDataScope()).toBe('user');

    // Boot sees the pending demo.
    const pending = await pendingGuidedDemo();
    expect(pending?.activeDemoScope).toBe('guided_demo:run1');

    // User picks "Continue" → resume back into the scope.
    expect(await resumeGuidedDemo()).toBe('guided_demo:run1');
    expect(currentDataScope()).toBe('guided_demo:run1');

    // ...or "Delete and start empty" → end cleans it up.
    await endGuidedDemo();
    expect(currentDataScope()).toBe('user');
    expect(await getActiveDemo()).toBeNull();
    expect(id.count('people', 'guided_demo:run1')).toBe(0);
  });

  it('end resolves the scope from the persisted record even if runtime is on user', async () => {
    await startGuidedDemo(1);
    id.seed('people', 'guided_demo:run1', 2);
    resetDataScope(); // runtime on 'user', but record still says guided_demo:run1
    const torn = await endGuidedDemo();
    expect(torn).toBe('guided_demo:run1');
    expect(id.count('people', 'guided_demo:run1')).toBe(0);
  });
});
