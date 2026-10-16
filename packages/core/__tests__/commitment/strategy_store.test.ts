/**
 * COMMITMENT_KERNEL §11 — the strategy slot's durable state.
 *
 *   S-10  the pack's fixed style fills the slot until the owner turns Brain
 *         on; values in Brain's brief are on by default and switch off per kind;
 *   S-11  verdict budgets survive a restart and a new negotiation; a spent
 *         budget is reported; a changed threshold refills the owner's.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { StrategyStore } from '../../src/commitment/strategy_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

describe('the strategy store', () => {
  let dir: string;
  let file: string;
  let pass: string;
  let db: NodeSQLiteAdapter;
  const open = (fresh: boolean) => {
    const a = new NodeSQLiteAdapter({
      path: file,
      passphraseHex: pass,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    if (fresh) applyMigrations(a, IDENTITY_MIGRATIONS);
    return a;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-strategy-'));
    file = path.join(dir, 'identity.sqlite');
    pass = randomBytes(32).toString('hex');
    db = open(true);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('S-10: the fixed style until Brain is turned on; values on by default', () => {
    const store = new StrategyStore(db);
    expect(store.settings('shelf_space.vendor')).toEqual({ strategy: 'fixed', valuesOn: true });
    store.setSettings('shelf_space.vendor', { strategy: 'brain', valuesOn: false }, 1);
    expect(store.settings('shelf_space.vendor')).toEqual({ strategy: 'brain', valuesOn: false });
    expect(store.settings('shelf_space.host')).toEqual({ strategy: 'fixed', valuesOn: true });
  });

  it('S-11: budgets survive a restart and a new negotiation', () => {
    const rules = { perNegotiation: 2, perOwnerMonthly: 3 };
    const charge = (s: StrategyStore, negotiationId: string, version = 1) =>
      s.charge({ kind: 'k', negotiationId, count: 1, nowMs: 1_000, thresholdVersion: version });
    let store = new StrategyStore(db, rules);
    expect(charge(store, 'n1')).toEqual({ ok: true });
    expect(charge(store, 'n1')).toEqual({ ok: true });
    expect(charge(store, 'n1')).toEqual({ ok: false, spent: 'negotiation' });
    const left = (negotiationId: string) =>
      store.canSpend({ kind: 'k', negotiationId, nowMs: 1_000, thresholdVersion: 1 });
    // Checking charges nothing, and says which budget ran out.
    expect(left('n1')).toEqual({ ok: false, spent: 'negotiation' });
    expect(left('n2')).toEqual({ ok: true });
    db.close();
    db = open(false);
    store = new StrategyStore(db, rules);
    expect(charge(store, 'n2')).toEqual({ ok: true });
    expect(charge(store, 'n3')).toEqual({ ok: false, spent: 'owner' });
    expect(left('n4')).toEqual({ ok: false, spent: 'owner' });
    // The owner changed the threshold: a fresh budget for it.
    expect(charge(store, 'n3', 2)).toEqual({ ok: true });
  });
});
