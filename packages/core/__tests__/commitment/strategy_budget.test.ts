/**
 * COMMITMENT_KERNEL §11 — the budget store's arithmetic (the engine-level
 * tests are in commerce/term/term_strategy_budget.test.ts).
 *
 *   B-10  charges across new negotiations come from one owner budget: eight
 *         answers narrow 2^20 values to no fewer than 2^12;
 *   B-11  the store does not care how a proposal turned out: every charge counts;
 *   B-12  a charge for several versions takes that many;
 *   B-13  only the month refills the owner's budget.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { StrategyStore } from '../../src/commitment/strategy_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const MONTH = 30 * 24 * 60 * 60 * 1000;
const RULES = { perNegotiation: 12, perOwnerMonthly: 8 };

describe('verdict budgets bound what a strategy learns', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;
  let store: StrategyStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-budget-'));
    db = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    store = new StrategyStore(db, RULES);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const probe = (negotiationId: string, count = 1, nowMs = 1_000) =>
    store.charge({ kind: 'k', negotiationId, count, nowMs, thresholdVersion: 1 });

  it('B-10: a binary search across new negotiations learns one bit per verdict, no more', () => {
    const hardLimit = 731_337; // what Brain would like to find, in [0, 2^20)
    let low = 0;
    let high = 1 << 20;
    let answers = 0;
    for (let n = 0; n < 200; n += 1) {
      // A fresh negotiation each time: it must not reset the owner's budget.
      if (!probe(`neg-${String(n)}`).ok) continue;
      answers += 1;
      const mid = Math.floor((low + high) / 2);
      if (mid <= hardLimit) low = mid;
      else high = mid;
    }
    expect(answers).toBe(RULES.perOwnerMonthly);
    // Eight answers narrow 2^20 values to 2^12 at best: the limit stays hidden.
    expect(high - low).toBeGreaterThanOrEqual(1 << 12);
  });

  it('B-11: proposals that succeed are charged like those that fail', () => {
    for (let i = 0; i < RULES.perOwnerMonthly; i += 1)
      expect(probe(`deal-${String(i)}`)).toEqual({ ok: true });
    expect(probe('deal-next')).toEqual({ ok: false, spent: 'owner' });
  });

  it('B-12: each version of an offer is a verdict', () => {
    expect(probe('n1', 5)).toEqual({ ok: true });
    expect(probe('n2', 4)).toEqual({ ok: false, spent: 'owner' });
    expect(probe('n2', 3)).toEqual({ ok: true });
  });

  it('B-13: only the month refills the owner’s budget', () => {
    for (let i = 0; i < RULES.perOwnerMonthly; i += 1) probe(`n-${String(i)}`);
    expect(probe('n-new', 1, 1_000 + MONTH - 1)).toEqual({ ok: false, spent: 'owner' });
    expect(probe('n-new', 1, 1_000 + MONTH + 1)).toEqual({ ok: true });
  });
});
