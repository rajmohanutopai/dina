/**
 * The plan store (GROUP_COORDINATION §7) — through the REAL SQLite adapter and
 * the identity migrations, so migration v45 is what answers, and through the
 * in-memory twin, so the two agree.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  abandon,
  createGroupPlan,
  foldPlan,
  openRound,
  recordReply,
  type GroupPlan,
} from '../../src/coordination/group_plan';
import {
  InMemoryGroupPlanRepository,
  SQLiteGroupPlanRepository,
  rehydrateGroupPlan,
  type GroupPlanRepository,
} from '../../src/coordination/group_plan_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = 1_800_000_000_000;

function plan(planId: string, nowMs = T0): GroupPlan {
  const result = createGroupPlan({
    planId,
    intent: "Emma's birthday",
    guests: [
      { contactDid: 'did:plc:garcia', required: true },
      { contactDid: 'did:plc:miller', required: false },
    ],
    candidates: [{ start: 'Sat 26', note: 'afternoon' }, { start: 'Sat 19' }],
    nowMs,
  });
  if (!result.ok) throw new Error(result.refusal);
  return result.plan;
}

let dir: string;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'group-plans-'));
  adapter = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: randomBytes(32).toString('hex') });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
});

afterEach(() => {
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.each<[string, () => GroupPlanRepository]>([
  ['SQLite (migration v45)', () => new SQLiteGroupPlanRepository(adapter)],
  ['in-memory', () => new InMemoryGroupPlanRepository()],
])('%s', (_name, make) => {
  it('round-trips a plan through every transition, byte for byte', () => {
    const repo = make();
    const p = plan('plan_a');
    repo.put(p);
    expect(repo.get('plan_a')).toEqual(p);

    const opened = openRound(p, T0 + 1);
    if (!opened.ok) throw new Error(opened.refusal);
    const replied = recordReply(
      opened.plan,
      {
        contactDid: 'did:plc:garcia',
        reply: { status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] },
        disclosures: [{ kind: 'dietary', text: 'gluten-free', about: 'household' }],
      },
      T0 + 2,
    );
    if (!replied.ok) throw new Error(replied.refusal);
    const foldedResult = foldPlan(replied.plan, T0 + 3);
    if (!foldedResult.ok) throw new Error(foldedResult.refusal);
    repo.put(foldedResult.plan);
    const back = repo.get('plan_a');
    expect(back).toEqual(foldedResult.plan);
    expect(back?.state).toBe('folded');
    expect(back?.guests[0].disclosures).toEqual([{ kind: 'dietary', text: 'gluten-free', about: 'household' }]);
  });

  it('lists only open plans, newest first; settled and abandoned drop out', () => {
    const repo = make();
    repo.put(plan('older', T0));
    repo.put(plan('newer', T0 + 10));
    const gone = abandon(plan('gone', T0 + 20), T0 + 21);
    if (!gone.ok) throw new Error(gone.refusal);
    repo.put(gone.plan);
    expect(repo.listOpen().map((p) => p.planId)).toEqual(['newer', 'older']);
  });

  it('listRecent keeps settled plans (a booking follows them) and drops stopped ones, newest first, bounded', () => {
    const repo = make();
    repo.put(plan('older', T0));
    const settled = { ...plan('settled', T0 + 5), state: 'settled' as const };
    repo.put(settled);
    repo.put(plan('newer', T0 + 10));
    const gone = abandon(plan('gone', T0 + 20), T0 + 21);
    if (!gone.ok) throw new Error(gone.refusal);
    repo.put(gone.plan);
    expect(repo.listRecent(10).map((p) => p.planId)).toEqual(['newer', 'settled', 'older']);
    expect(repo.listRecent(2).map((p) => p.planId)).toEqual(['newer', 'settled']);
    expect(repo.listOpen().map((p) => p.planId)).toEqual(['newer', 'older']);
  });

  it('remove deletes the plan and everything guests disclosed for it', () => {
    const repo = make();
    repo.put(plan('plan_b'));
    expect(repo.remove('plan_b')).toBe(true);
    expect(repo.get('plan_b')).toBeNull();
    expect(repo.remove('plan_b')).toBe(false);
  });

  it('refuses an empty plan id', () => {
    const repo = make();
    expect(() => repo.put({ ...plan('x'), planId: '' })).toThrow(/planId/);
  });
});

describe('rehydration is strict', () => {
  it('a row this build cannot read as a plan is no plan — never half-believed', () => {
    expect(rehydrateGroupPlan('not json')).toBeNull();
    expect(rehydrateGroupPlan('[]')).toBeNull();
    expect(rehydrateGroupPlan(JSON.stringify({ ...plan('p'), state: 'dreaming' }))).toBeNull();
    expect(rehydrateGroupPlan(JSON.stringify({ ...plan('p'), guests: [] }))).toBeNull();
    expect(rehydrateGroupPlan(JSON.stringify({ ...plan('p'), candidates: [{ start: 7 }] }))).toBeNull();
    const badDisclosure = plan('p');
    badDisclosure.guests[0].disclosures = [{ kind: 'dietary', text: 'x', about: 'Lily' as never }];
    expect(rehydrateGroupPlan(JSON.stringify(badDisclosure))).toBeNull();
  });

  it('re-checks the bounds — a hand-edited row cannot carry a ninth guest past the ceiling', () => {
    const p = plan('p');
    const guests = Array.from({ length: 9 }, (_, i) => ({ ...p.guests[0], contactDid: `did:plc:g${i}` }));
    expect(rehydrateGroupPlan(JSON.stringify({ ...p, guests }))).toBeNull();
    const candidates = Array.from({ length: 13 }, (_, i) => ({ start: `Sat ${i}` }));
    expect(rehydrateGroupPlan(JSON.stringify({ ...p, candidates }))).toBeNull();
  });

  it('a stored row survives the SQLite adapter and rehydrates identically', () => {
    const repo = new SQLiteGroupPlanRepository(adapter);
    const p = plan('plan_c');
    repo.put(p);
    const raw = adapter.query('SELECT plan_json, state FROM group_plans WHERE plan_id = ?', ['plan_c']);
    expect(raw).toHaveLength(1);
    expect(raw[0].state).toBe('proposing');
    expect(rehydrateGroupPlan(String(raw[0].plan_json))).toEqual(p);
  });
});
