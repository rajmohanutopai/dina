/**
 * DAILY_PLAN.md §24, §27 — things that repeat and changes to a live plan, on a
 * real SQLCipher identity database, including the upgrade from v88.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  dayCandidates,
  dayPlanMade,
  finishDay,
  planOnDay,
  putOffTask,
} from '../../src/plan/day_rules';
import { latePhase, moneySummary } from '../../src/plan/goal_rules';
import { decideFeed, parseBatch, receiveBatch } from '../../src/plan/intake';
import {
  ensureRoutineTasks,
  routineProgress,
  routineRuleError,
  routineRuleLabel,
  routineTurnOn,
  routineTurnsAhead,
  weekStart,
} from '../../src/plan/routines';
import { PlanStore, type PlanRoutine } from '../../src/plan/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

// Monday 2 November 2026, local noon.
const MON = new Date(2026, 10, 2, 12).getTime();

function on(day: number): number {
  return new Date(2026, 10, 2 + day, 12).getTime();
}

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

function open(migrations = IDENTITY_MIGRATIONS): void {
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
  });
  applyMigrations(db, migrations);
  store = new PlanStore(db);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plan-routines-'));
  open();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function routine(over: Partial<PlanRoutine>): PlanRoutine {
  return {
    id: 'r',
    goalId: '',
    title: 'Run',
    persona: 'general',
    effortMin: null,
    kind: 'per_week',
    weekdays: [],
    timesPerWeek: 3,
    dayOfMonth: 0,
    active: true,
    createdAt: MON,
    updatedAt: MON,
    ...over,
  };
}

describe('routineTurnOn', () => {
  it('follows weekdays and the month, using the last day of a short month', () => {
    const wed = routine({ kind: 'days', weekdays: [3] });
    expect(routineTurnOn(wed, [], on(2))).toEqual({ due: true, pressing: true });
    expect(routineTurnOn(wed, [], on(1)).due).toBe(false);

    const m31 = routine({ kind: 'monthly', dayOfMonth: 31 });
    expect(routineTurnOn(m31, [], new Date(2026, 10, 30, 12).getTime()).due).toBe(true);
    expect(routineTurnOn(m31, [], new Date(2026, 10, 29, 12).getTime()).due).toBe(false);
    expect(routineTurnOn(m31, [], new Date(2026, 11, 31, 12).getTime()).due).toBe(true);
    expect(routineTurnOn(m31, [], new Date(2026, 11, 30, 12).getTime()).due).toBe(false);
  });

  it('per week: spaces turns, counts this week only, presses when days run short', () => {
    const r = routine({});
    expect(routineTurnOn(r, [], on(0))).toEqual({ due: true, pressing: false });
    expect(routineTurnOn(r, ['2026-11-02'], on(1)).due).toBe(false); // done yesterday
    expect(routineTurnOn(r, ['2026-11-02'], on(2)).due).toBe(true);
    // Last week's turns don't count toward this week.
    expect(routineTurnOn(r, ['2026-10-26', '2026-10-28', '2026-10-30'], on(0)).due).toBe(true);
    // Target met.
    expect(routineTurnOn(r, ['2026-11-02', '2026-11-03', '2026-11-04'], on(5)).due).toBe(false);
    // Three to do on Friday, Saturday and Sunday: each is pressing even after a run yesterday.
    expect(routineTurnOn(r, [], on(4))).toEqual({ due: true, pressing: true });
    expect(routineTurnOn(r, ['2026-11-06'], on(5))).toEqual({ due: true, pressing: true });
    // Done today: no second turn today.
    expect(routineTurnOn(r, ['2026-11-02'], on(0)).due).toBe(false);
  });

  it('once a week waits a week from the last turn, then presses on Sunday', () => {
    const r = routine({ timesPerWeek: 1 });
    expect(routineTurnOn(r, ['2026-11-01'], on(0)).due).toBe(false); // Sunday, yesterday
    expect(routineTurnOn(r, ['2026-11-01'], on(6))).toEqual({ due: true, pressing: true });
  });

  it('seven a week is every day, and a stopped routine has no turns', () => {
    const r = routine({ timesPerWeek: 7 });
    expect(routineTurnOn(r, ['2026-11-02'], on(1)).due).toBe(true);
    expect(routineTurnOn(routine({ active: false }), [], on(0)).due).toBe(false);
  });

  it('weeks run Monday to Sunday', () => {
    expect(weekStart(on(6))).toBe(new Date(2026, 10, 2).getTime());
    expect(weekStart(on(7))).toBe(new Date(2026, 10, 9).getTime());
  });
});

describe('ensureRoutineTasks', () => {
  it('makes one turn a day, lapses the old one, and keeps finished ones', () => {
    const r = store.addRoutine(
      { title: 'Stretch', kind: 'days', weekdays: [1, 2], effortMin: 15 },
      MON,
    );
    expect(ensureRoutineTasks(store, MON)).toBe(1);
    expect(ensureRoutineTasks(store, MON + 1000)).toBe(0);
    const [first] = store.listRoutineTasks(r.id);
    expect(first).toMatchObject({
      title: 'Stretch',
      routineDay: '2026-11-02',
      effortMin: 15,
      source: 'routine',
      status: 'open',
    });
    // The database itself refuses a second turn for a day.
    expect(() =>
      store.addOwnerTask({ title: 'x', routineId: r.id, routineDay: '2026-11-02' }, MON),
    ).toThrow();

    ensureRoutineTasks(store, on(1));
    const turns = store.listRoutineTasks(r.id);
    expect(turns.map((t) => [t.routineDay, t.status])).toEqual([
      ['2026-11-02', 'dropped'],
      ['2026-11-03', 'open'],
    ]);
    expect(routineProgress(store, r, on(1)).line).toBe('0 of 2 this week');
    store.updateTask(turns[1].id, { status: 'done' }, on(1));
    expect(routineProgress(store, r, on(1)).line).toBe('1 of 2 this week');
    ensureRoutineTasks(store, on(7));
    expect(store.getTask(turns[1].id)?.status).toBe('done');
  });

  it('a dropped turn stays dropped today', () => {
    const r = store.addRoutine({ title: 'Run', kind: 'per_week', timesPerWeek: 3 }, MON);
    ensureRoutineTasks(store, MON);
    const [t] = store.listRoutineTasks(r.id);
    store.updateTask(t.id, { status: 'dropped' }, MON);
    expect(ensureRoutineTasks(store, MON + 1000)).toBe(0);
    expect(ensureRoutineTasks(store, on(1))).toBe(1); // tomorrow it offers again
  });

  it('counts turns ahead without making them, and skips an archived goal', () => {
    const goal = store.addGoal('Fit', '', MON);
    store.addRoutine({ title: 'Run', goalId: goal.id, kind: 'days', weekdays: [3] }, MON);
    expect(routineTurnsAhead(store, on(2)).count).toBe(1);
    expect(store.listTasks()).toEqual([]);
    store.updateGoal(goal.id, { active: false }, MON);
    expect(routineTurnsAhead(store, on(2)).count).toBe(0);
    expect(ensureRoutineTasks(store, on(2))).toBe(0);
  });

  it('stopping drops the open turn and leaves finished ones', () => {
    const r = store.addRoutine({ title: 'Run', kind: 'days', weekdays: [1, 2] }, MON);
    ensureRoutineTasks(store, MON);
    const [t] = store.listRoutineTasks(r.id);
    store.updateTask(t.id, { status: 'done' }, MON);
    ensureRoutineTasks(store, on(1));
    store.stopRoutine(r.id, on(1));
    expect(store.listRoutineTasks(r.id).map((x) => x.status)).toEqual(['done', 'dropped']);
    expect(ensureRoutineTasks(store, on(7))).toBe(0);
  });
});

describe('putting off and ending a day', () => {
  it('a task moves to tomorrow; a turn is skipped', () => {
    const task = store.addOwnerTask({ title: 'Call Sam' }, MON);
    expect(putOffTask(store, task.id, MON)).toBe('carried');
    expect(store.getTask(task.id)).toMatchObject({ carried: 1, plannedFor: '2026-11-03' });
    const r = store.addRoutine({ title: 'Run', kind: 'days', weekdays: [1] }, MON);
    ensureRoutineTasks(store, MON);
    const [turn] = store.listRoutineTasks(r.id);
    expect(putOffTask(store, turn.id, MON)).toBe('skipped');
    expect(putOffTask(store, turn.id, MON)).toBeNull();
  });

  it('finishDay reports what moved, and null with no plan', () => {
    expect(finishDay(store, MON)).toBeNull();
    const a = store.addOwnerTask({ title: 'Done one' }, MON);
    const b = store.addOwnerTask({ title: 'Left one' }, MON);
    store.addRoutine({ title: 'Run', kind: 'days', weekdays: [1] }, MON);
    ensureRoutineTasks(store, MON);
    const ids = dayCandidates(store, MON).map((c) => c.task.id);
    store.putDay(
      '2026-11-02',
      ids.map((taskId) => ({ taskId, reason: '' })),
      '',
      MON,
    );
    store.updateTask(a.id, { status: 'done' }, MON);
    expect(finishDay(store, MON)).toEqual({ done: 1, carried: ['Left one'], skipped: ['Run'] });
    expect(store.getTask(b.id)?.plannedFor).toBe('2026-11-03');
    expect(store.getDay('2026-11-02')?.reviewedAt).toBe(MON);
  });
});

describe('labels and rule checks', () => {
  it('names each rule', () => {
    const label = (o: Partial<PlanRoutine>): string => routineRuleLabel(routine(o));
    expect(label({})).toBe('3 times a week');
    expect(label({ timesPerWeek: 1 })).toBe('Once a week');
    expect(label({ kind: 'days', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day');
    expect(label({ kind: 'days', weekdays: [5, 1, 2, 3, 4] })).toBe('Weekdays');
    expect(label({ kind: 'days', weekdays: [0, 1, 3] })).toBe('Mon, Wed, Sun');
    expect(label({ kind: 'monthly', dayOfMonth: 1 })).toBe('On the 1st of each month');
    expect(label({ kind: 'monthly', dayOfMonth: 22 })).toBe('On the 22nd of each month');
    expect(label({ kind: 'monthly', dayOfMonth: 11 })).toBe('On the 11th of each month');
  });

  it('refuses rules with nothing to follow', () => {
    expect(routineRuleError({ kind: 'days', weekdays: [] })).not.toBeNull();
    expect(routineRuleError({ kind: 'days', weekdays: [7] })).not.toBeNull();
    expect(routineRuleError({ kind: 'per_week', timesPerWeek: 8 })).not.toBeNull();
    expect(routineRuleError({ kind: 'monthly', dayOfMonth: 0 })).not.toBeNull();
    expect(routineRuleError({ kind: 'per_week', timesPerWeek: 7 })).toBeNull();
  });
});

describe('changes to a live plan', () => {
  it('moves phases even when positions are equal, and stops at the ends', () => {
    const g = store.addGoal('House', '', MON);
    const a = store.addPhase(g.id, 'A', '', null, MON);
    const b = store.addPhase(g.id, 'B', '', null, MON);
    const c = store.addPhase(g.id, 'C', '', null, MON);
    db.run('UPDATE plan_phases SET position = 0 WHERE goal_id = ?', [g.id]);
    const order = store.listPhases(g.id).map((p) => p.id);
    expect(store.movePhase(order[2], 'up', MON)).toBe(true);
    expect(store.listPhases(g.id).map((p) => p.id)).toEqual([order[0], order[2], order[1]]);
    expect(store.movePhase(order[0], 'up', MON)).toBe(false);
    expect(store.movePhase(order[1], 'down', MON)).toBe(false);
    expect(store.movePhase('nope', 'up', MON)).toBe(false);
    expect([a, b, c].length).toBe(3);
  });

  it('deleting keeps the tasks and money; an inactive delete starts nothing', () => {
    const g = store.addGoal('House', '', MON);
    const a = store.addPhase(g.id, 'A', '', null, MON);
    const b = store.addPhase(g.id, 'B', '', null, MON);
    const c = store.addPhase(g.id, 'C', '', null, MON);
    const t = store.addOwnerTask({ title: 'x', goalId: g.id, phaseId: b.id }, MON);
    const cost = store.addCost(
      { goalId: g.id, phaseId: b.id, label: 'y', kind: 'quote', amountCents: 100 },
      MON,
    );
    expect(store.deletePhase(b.id, MON)).toBe(true);
    expect(store.getTask(t.id)?.phaseId).toBe('');
    expect(store.listCosts(g.id).find((x) => x.id === cost.id)?.phaseId).toBe('');
    expect(store.getPhase(c.id)?.status).toBe('upcoming');
    expect(store.deletePhase(a.id, MON)).toBe(true);
    expect(store.getPhase(c.id)?.status).toBe('active');
    expect(store.deletePhase('nope', MON)).toBe(false);
  });

  it('the next phase after a finished middle one starts, not an earlier one', () => {
    const g = store.addGoal('House', '', MON);
    const a = store.addPhase(g.id, 'A', '', null, MON);
    const b = store.addPhase(g.id, 'B', '', null, MON);
    const c = store.addPhase(g.id, 'C', '', null, MON);
    store.movePhase(a.id, 'down', MON); // B, A, C; A still active
    const started = store.finishPhase(a.id, MON);
    expect(started?.id).toBe(c.id);
    expect(store.getPhase(b.id)?.status).toBe('upcoming');
  });

  it('refuses a circle or a task from another goal as an order', () => {
    const g = store.addGoal('House', '', MON);
    const other = store.addGoal('Boat', '', MON);
    const a = store.addOwnerTask({ title: 'a', goalId: g.id }, MON);
    const b = store.addOwnerTask({ title: 'b', goalId: g.id }, MON);
    const c = store.addOwnerTask({ title: 'c', goalId: g.id }, MON);
    const x = store.addOwnerTask({ title: 'x', goalId: other.id }, MON);
    const loose = store.addOwnerTask({ title: 'l' }, MON);
    expect(store.setTaskBlockedBy(b.id, [a.id], MON)).toBe(true);
    expect(store.setTaskBlockedBy(c.id, [b.id], MON)).toBe(true);
    expect(store.setTaskBlockedBy(a.id, [c.id], MON)).toBe(false);
    expect(store.setTaskBlockedBy(a.id, [x.id], MON)).toBe(false);
    expect(store.setTaskBlockedBy(loose.id, [a.id], MON)).toBe(false);
    expect(store.setTaskBlockedBy(a.id, [a.id], MON)).toBe(false);
    expect(store.getTask(a.id)?.blockedBy).toEqual([]);
  });

  it('removing a payment reopens what its quote still owes', () => {
    const g = store.addGoal('House', '', MON);
    const t = store.addOwnerTask({ title: 'Roof', goalId: g.id }, MON);
    const q = store.addCost(
      { goalId: g.id, taskId: t.id, label: 'q', kind: 'quote', amountCents: 100 },
      MON,
    );
    const p1 = store.addCost(
      { goalId: g.id, taskId: t.id, label: 'p', kind: 'paid', amountCents: 50 },
      MON,
    );
    const p2 = store.addCost(
      { goalId: g.id, taskId: t.id, label: 'p', kind: 'paid', amountCents: 50 },
      MON,
    );
    const settled = (): boolean | undefined =>
      store.listCosts(g.id).find((c) => c.id === q.id)?.settled;
    expect(settled()).toBe(true);
    expect(store.deleteCost(p1.id)).toBe(true);
    expect(settled()).toBe(false);
    store.deleteCost(p2.id);
    expect(settled()).toBe(false);
    expect(store.deleteCost('nope')).toBe(false);
  });
});

describe('migration v89', () => {
  it('upgrades a database already at v88 and keeps its tasks', () => {
    db.close();
    rmSync(path.join(dir, 'identity.sqlite'), { force: true });
    open(IDENTITY_MIGRATIONS.filter((m) => m.version <= 88));
    db.execute(
      `INSERT INTO plan_tasks (id, persona, title, origin, status, observed_at, created_at, updated_at)
       VALUES ('t1', 'general', 'Old task', 'owner', 'open', 1, 1, 1)`,
    );
    db.close();
    open();
    expect(store.getTask('t1')).toMatchObject({ title: 'Old task', routineId: '', routineDay: '' });
    // Rows from before the migration all share an empty routine id; the turn
    // index leaves them alone.
    store.addOwnerTask({ title: 'Another' }, MON);
    expect(store.listRoutines()).toEqual([]);
  });
});

describe('the review round: rules across personas, money, clocks and batches', () => {
  it('an item cannot reach a task under another persona through a repeat of its source_ref', () => {
    const agent = 'did:key:zAgent';
    receiveBatch(
      store,
      agent,
      'A',
      parseBatch(
        {
          batch_id: 'b1',
          persona: 'work',
          items: [{ title: 'Work item', source_ref: 'x', observed_at: MON - 2000 }],
        },
        MON,
      ),
      MON,
    );
    decideFeed(store, agent, 'work', true, MON);
    const before = store.listTasks({ origin: agent })[0];
    // A feed the owner never allowed, then one they blocked.
    const r = receiveBatch(
      store,
      agent,
      'A',
      parseBatch(
        {
          batch_id: 'b2',
          persona: 'general',
          items: [{ title: 'Changed', source_ref: 'x', observed_at: MON - 1000 }],
        },
        MON,
      ),
      MON,
    );
    expect(r).toMatchObject({ accepted: 0, held: 0 });
    expect(store.getTask(before.id)).toMatchObject({
      title: 'Work item',
      persona: 'work',
      status: 'open',
    });
  });

  it('a batch that fails part way leaves nothing, and sending it again delivers it all', () => {
    const agent = 'did:key:zAgent';
    const batch = parseBatch(
      {
        batch_id: 'b1',
        persona: 'work',
        items: [
          { title: 'One', source_ref: 'a' },
          { title: 'Two', source_ref: 'b' },
        ],
      },
      MON,
    );
    const real = store.upsertAgentItem.bind(store);
    let calls = 0;
    const spy = jest.spyOn(store, 'upsertAgentItem').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return real(...args);
    });
    expect(() => receiveBatch(store, agent, 'A', batch, MON)).toThrow('disk full');
    spy.mockRestore();
    expect(store.listTasks({ origin: agent })).toEqual([]);
    expect(receiveBatch(store, agent, 'A', batch, MON)).toMatchObject({
      held: 2,
      duplicate_batch: false,
    });
  });

  it('a deposit leaves the rest of a quote open; the balance settles it', () => {
    const g = store.addGoal('House', '', MON, { budgetCents: 100_000 });
    const q = store.addCost(
      { goalId: g.id, label: 'Roof', kind: 'quote', amountCents: 18_400 },
      MON,
    );
    const dep = store.addCost(
      { goalId: g.id, label: 'Deposit', kind: 'paid', amountCents: 2_000, quoteId: q.id },
      MON,
    );
    expect(moneySummary(100_000, store.listCosts(g.id))).toMatchObject({
      paidCents: 2_000,
      openQuoteCents: 16_400,
      leftCents: 81_600,
    });
    store.addCost(
      { goalId: g.id, label: 'Balance', kind: 'paid', amountCents: 16_400, quoteId: q.id },
      MON,
    );
    expect(moneySummary(100_000, store.listCosts(g.id))).toMatchObject({
      openQuoteCents: 0,
      leftCents: 81_600,
    });
    // Taking the deposit back reopens what it covered.
    store.deleteCost(dep.id);
    expect(moneySummary(100_000, store.listCosts(g.id))).toMatchObject({
      paidCents: 16_400,
      openQuoteCents: 2_000,
    });
    // A removed quote leaves its payments standing, tied to nothing.
    store.deleteCost(q.id);
    expect(store.listCosts(g.id).map((c) => c.quoteId)).toEqual(['']);
  });

  it('re-planning a reviewed day starts its review again, and a task stays on its goal', () => {
    const g = store.addGoal('House', '', MON);
    const other = store.addGoal('Fit', '', MON);
    const p = store.addPhase(g.id, 'Roof', '', null, MON);
    const t = store.addOwnerTask({ title: 'Tiles', goalId: g.id, phaseId: p.id }, MON);
    const loose = store.addOwnerTask({ title: 'Run' }, MON);
    store.putDay('2026-11-02', [{ taskId: t.id, reason: '' }], '', MON);
    store.markReviewed('2026-11-02', MON);
    store.putDay(
      '2026-11-02',
      [
        { taskId: t.id, reason: '', goalId: other.id },
        { taskId: loose.id, reason: '', goalId: other.id },
      ],
      '',
      MON,
    );
    expect(store.getDay('2026-11-02')?.reviewedAt).toBeNull();
    expect(store.getTask(t.id)?.goalId).toBe(g.id);
    expect(store.getTask(loose.id)?.goalId).toBe(other.id);
  });

  it('a task put off leaves today and comes back tomorrow, counted once', () => {
    const t = store.addOwnerTask({ title: 'Call Sam' }, MON);
    store.putDay('2026-11-02', [{ taskId: t.id, reason: 'x' }], '', MON);
    expect(planOnDay(store, MON).map((p) => p.task.id)).toEqual([t.id]);
    putOffTask(store, t.id, MON);
    putOffTask(store, t.id, MON);
    expect(store.getTask(t.id)?.carried).toBe(1);
    expect(planOnDay(store, MON)).toEqual([]);
    expect(dayCandidates(store, MON)).toEqual([]);
    expect(dayCandidates(store, on(1)).map((c) => c.task.id)).toEqual([t.id]);
    // Saving the day again doesn't pull it back.
    store.putDay('2026-11-02', [{ taskId: t.id, reason: 'x' }], '', MON);
    expect(store.getTask(t.id)?.plannedFor).toBe('2026-11-03');
  });

  it('a planned task leaves when its goal is archived, it waits, or its order changes', () => {
    const g = store.addGoal('House', '', MON);
    const p = store.addPhase(g.id, 'Roof', '', null, MON);
    const later = store.addPhase(g.id, 'Paint', '', null, MON);
    const a = store.addOwnerTask({ title: 'a', goalId: g.id, phaseId: p.id }, MON);
    const b = store.addOwnerTask({ title: 'b', goalId: g.id, phaseId: p.id }, MON);
    const c = store.addOwnerTask({ title: 'c', goalId: g.id, phaseId: p.id }, MON);
    const d = store.addOwnerTask({ title: 'd', goalId: g.id, phaseId: p.id }, MON);
    store.putDay(
      '2026-11-02',
      [a, b, c, d].map((t) => ({ taskId: t.id, reason: '' })),
      '',
      MON,
    );
    store.updateTask(a.id, { waitingOn: 'Mike', waitingUntil: on(3) }, MON);
    store.updateTask(b.id, { phaseId: later.id }, MON);
    store.setTaskBlockedBy(c.id, [d.id], MON);
    expect(planOnDay(store, MON).map((x) => x.task.id)).toEqual([d.id]);
    store.updateTask(d.id, { status: 'done' }, MON);
    expect(planOnDay(store, MON).map((x) => x.task.id)).toEqual([c.id, d.id]);
    store.updateGoal(g.id, { active: false }, MON);
    expect(planOnDay(store, MON)).toEqual([]);
    expect(finishDay(store, MON)).toEqual({ done: 0, carried: [], skipped: [] });
    expect(store.getTask(c.id)?.carried).toBe(0);
  });

  it('a wait comes back the day after its promised day', () => {
    const t = store.addOwnerTask({ title: 'Quote' }, MON);
    store.updateTask(
      t.id,
      { waitingOn: 'Mike', waitingUntil: new Date(2026, 10, 3, 23, 59).getTime() },
      MON,
    );
    expect(dayCandidates(store, new Date(2026, 10, 3, 9).getTime())).toEqual([]);
    expect(dayCandidates(store, new Date(2026, 10, 4, 0, 1).getTime())[0].chase?.on).toBe('Mike');
  });

  it("a task's first day on the list doesn't move when an agent sends it again", () => {
    const agent = 'did:key:zAgent';
    decideFeed(store, agent, 'work', true, MON);
    store.notePendingFeed(agent, 'work', 'A', MON);
    decideFeed(store, agent, 'work', true, MON);
    receiveBatch(
      store,
      agent,
      'A',
      parseBatch(
        {
          batch_id: 'b1',
          persona: 'work',
          items: [{ title: 'One', source_ref: 'a', observed_at: MON - 5000 }],
        },
        MON,
      ),
      MON,
    );
    receiveBatch(
      store,
      agent,
      'A',
      parseBatch(
        {
          batch_id: 'b2',
          persona: 'work',
          items: [{ title: 'One', source_ref: 'a', observed_at: MON + 1000 }],
        },
        MON + 9000,
      ),
      MON + 9000,
    );
    const [t] = store.listTasks({ origin: agent });
    expect(t.updatedAt).toBe(MON + 9000);
    expect(t.openedAt).toBe(MON);
  });

  it('a task allowed later opens when it is allowed', () => {
    const agent = 'did:key:zAgent';
    receiveBatch(
      store,
      agent,
      'A',
      parseBatch(
        { batch_id: 'b1', persona: 'work', items: [{ title: 'One', source_ref: 'a' }] },
        MON,
      ),
      MON,
    );
    decideFeed(store, agent, 'work', true, MON + 5000);
    expect(store.listTasks({ origin: agent })[0].openedAt).toBe(MON + 5000);
  });

  it('counts only pressing turns as due ahead', () => {
    store.addRoutine({ title: 'Run', kind: 'per_week', timesPerWeek: 2 }, MON);
    store.addRoutine({ title: 'Stretch', kind: 'days', weekdays: [1] }, MON);
    expect(routineTurnsAhead(store, MON)).toEqual({ count: 2, pressing: 1 });
  });
});

describe('migration v90', () => {
  it('keeps settled quotes settled and gives old tasks their created time', () => {
    db.close();
    rmSync(path.join(dir, 'identity.sqlite'), { force: true });
    open(IDENTITY_MIGRATIONS.filter((m) => m.version <= 89));
    db.execute(
      `INSERT INTO plan_tasks (id, persona, title, origin, status, observed_at, created_at, updated_at)
       VALUES ('t1', 'general', 'Old', 'owner', 'open', 1, 77, 88)`,
    );
    db.execute(
      `INSERT INTO plan_costs (id, goal_id, label, kind, amount_cents, settled, at, created_at)
       VALUES ('c1', 'g1', 'Old quote', 'quote', 500, 1, 1, 1)`,
    );
    db.close();
    open();
    expect(store.getTask('t1')?.openedAt).toBe(77);
    expect(moneySummary(null, store.listCosts('g1')).openQuoteCents).toBe(0);
  });

  it("ties an old payment to its task's settled quote, so removing it reopens the quote", () => {
    db.close();
    rmSync(path.join(dir, 'identity.sqlite'), { force: true });
    open(IDENTITY_MIGRATIONS.filter((m) => m.version <= 89));
    db.execute(
      `INSERT INTO plan_costs (id, goal_id, task_id, label, kind, amount_cents, settled, at, created_at)
       VALUES ('q1', 'g1', 't1', 'Quote', 'quote', 500, 1, 1, 1),
              ('p1', 'g1', 't1', 'Paid', 'paid', 500, 0, 2, 2),
              ('p2', 'g1', '', 'Paid loose', 'paid', 100, 0, 3, 3)`,
    );
    db.close();
    open();
    expect(store.getCost('p1')?.quoteId).toBe('q1');
    expect(store.getCost('p2')?.quoteId).toBe('');
    store.deleteCost('p1');
    expect(moneySummary(null, store.listCosts('g1')).openQuoteCents).toBe(500);
  });
});

describe('migration v91', () => {
  it("keeps the title of an agent's task already here, and leaves new ones to the agent", () => {
    db.close();
    rmSync(path.join(dir, 'identity.sqlite'), { force: true });
    open(IDENTITY_MIGRATIONS.filter((m) => m.version <= 90));
    db.execute(
      `INSERT INTO plan_feeds (agent_did, persona, agent_name, state, first_seen, decided_at)
       VALUES ('did:key:zA', 'work', 'A', 'allowed', 1, 1)`,
    );
    db.execute(
      `INSERT INTO plan_tasks (id, persona, title, source_ref, origin, status, observed_at, created_at, updated_at)
       VALUES ('t1', 'work', 'Renamed by the owner', 'm1', 'did:key:zA', 'open', 1, 1, 1)`,
    );
    db.close();
    open();
    const batch = (id: string, ref: string, at: number): void => {
      receiveBatch(
        store,
        'did:key:zA',
        'A',
        parseBatch(
          {
            batch_id: id,
            persona: 'work',
            items: [{ title: 'RE: quote', source_ref: ref, observed_at: at }],
          },
          MON,
        ),
        MON,
      );
    };
    batch('b1', 'm1', 100);
    expect(store.getTask('t1')).toMatchObject({ title: 'Renamed by the owner', observedAt: 100 });
    batch('b2', 'm2', 100);
    const fresh = store.listTasks({ origin: 'did:key:zA' }).find((t) => t.sourceRef === 'm2');
    expect(fresh?.titleByOwner).toBe(false);
  });
});

describe('an owner rename and a reopened task', () => {
  it("the owner's name for an agent's task outlasts the agent's next batch", () => {
    const agent = 'did:key:zAgent';
    store.notePendingFeed(agent, 'work', 'A', MON);
    decideFeed(store, agent, 'work', true, MON);
    const send = (id: string, at: number, due: string): void => {
      receiveBatch(
        store,
        agent,
        'A',
        parseBatch(
          {
            batch_id: id,
            persona: 'work',
            items: [{ title: 'RE: Fwd: quote', source_ref: 'm1', observed_at: at, due_at: due }],
          },
          MON + 9000,
        ),
        MON + 9000,
      );
    };
    send('b1', MON, '2027-01-01');
    const [t] = store.listTasks({ origin: agent });
    // Before any rename, the agent's wording follows the source.
    store.updateTask(t.id, { title: 'Chase the roof quote' }, MON + 1);
    send('b2', MON + 2, '2027-02-02');
    const after = store.getTask(t.id);
    expect(after?.title).toBe('Chase the roof quote');
    // Everything else the agent knows still lands.
    expect(after?.observedAt).toBe(MON + 2);
    expect(after?.dueAt).toBe(new Date(2027, 1, 2, 23, 59).getTime());
  });

  it('a task reopened in a finished phase moves on, and shows on the day', () => {
    const g = store.addGoal('House', '', MON);
    const a = store.addPhase(g.id, 'Roof', '', null, MON);
    const b = store.addPhase(g.id, 'Paint', '', null, MON);
    const t = store.addOwnerTask({ title: 'Tiles', goalId: g.id, phaseId: a.id }, MON);
    store.updateTask(t.id, { status: 'done' }, MON);
    store.finishPhase(a.id, MON);
    expect(store.getTask(t.id)?.phaseId).toBe(a.id);
    store.updateTask(t.id, { status: 'open' }, MON);
    expect(store.getTask(t.id)?.phaseId).toBe(b.id);
    expect(dayCandidates(store, MON).map((c) => c.task.id)).toEqual([t.id]);
    // With every phase finished it stays on the goal, under no phase.
    store.updateTask(t.id, { status: 'done' }, MON);
    store.finishPhase(b.id, MON);
    store.updateTask(t.id, { status: 'open' }, MON);
    expect(store.getTask(t.id)?.phaseId).toBe('');
    expect(dayCandidates(store, MON).map((c) => c.task.id)).toEqual([t.id]);
  });
});

describe('rules a review found around chases, lateness and empty days', () => {
  it('a late wait still needs its phase active and what it comes after finished', () => {
    const g = store.addGoal('House', '', MON);
    const now = store.addPhase(g.id, 'Roof', '', null, MON);
    const later = store.addPhase(g.id, 'Paint', '', null, MON);
    const first = store.addOwnerTask({ title: 'First', goalId: g.id, phaseId: now.id }, MON);
    const inLater = store.addOwnerTask({ title: 'Later', goalId: g.id, phaseId: later.id }, MON);
    const blocked = store.addOwnerTask(
      { title: 'Blocked', goalId: g.id, phaseId: now.id, blockedBy: [first.id] },
      MON,
    );
    const free = store.addOwnerTask({ title: 'Free', goalId: g.id, phaseId: now.id }, MON);
    for (const t of [inLater, blocked, free]) {
      store.updateTask(t.id, { waitingOn: 'Mike', waitingUntil: MON }, MON);
    }
    const chases = dayCandidates(store, on(3)).filter((c) => c.chase !== undefined);
    expect(chases.map((c) => c.task.id)).toEqual([free.id]);
  });

  it('a phase has all of its target day, and a move always clears it', () => {
    const g = store.addGoal('House', '', MON);
    const target = new Date(2026, 10, 10, 12).getTime();
    const p = store.addPhase(g.id, 'Roof', '', target, MON);
    expect(latePhase(store.listPhases(g.id), new Date(2026, 10, 10, 15).getTime())).toBeNull();
    const now = new Date(2026, 10, 12, 15).getTime();
    const late = latePhase(store.listPhases(g.id), now);
    expect(late?.days).toBe(2);
    store.shiftDates(g.id, [p.id], late?.days ?? 0, false, now);
    expect(latePhase(store.listPhases(g.id), now)).toBeNull();
  });

  it('an empty day is no plan, so there is nothing to finish', () => {
    store.putDay('2026-11-02', [], '', MON);
    expect(dayPlanMade(store, '2026-11-02')).toBeNull();
    expect(finishDay(store, MON)).toBeNull();
  });
});

describe('zones', () => {
  // Jest gives tests a copy of process.env, so a test can't change the zone
  // it runs in. Each zone gets its own jest process.
  it.each(['America/Los_Angeles', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'])(
    'dates and clock changes hold in %s',
    (zone) => {
      const root = path.join(__dirname, '..', '..');
      const r = spawnSync(
        process.execPath,
        [
          require.resolve('jest/bin/jest'),
          '--runInBand',
          '--testMatch',
          '**/plan/zones/*.zone.ts',
          '--coverage=false',
        ],
        { cwd: root, env: { ...process.env, TZ: zone, EXPECT_ZONE: zone }, encoding: 'utf8' },
      );
      expect(`${r.status}\n${r.stderr.slice(-2000)}`).toMatch(/^0\n/);
    },
    120_000,
  );
});
