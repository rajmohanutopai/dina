/**
 * DAILY_PLAN.md §15–§17 — goal plans over a real SQLCipher identity
 * database: a drafted plan becomes phases and tasks, only ready tasks can go
 * on a day, waits come back as chases, phases hand over, late phases move
 * the later dates only when asked, and the money line adds up. Also checks
 * that v88 upgrades a database already at v87.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  cleanGoalDraft,
  formatGoalMoney,
  isTaskReady,
  latePhase,
  moneySummary,
  needsChase,
} from '../../src/plan/goal_rules';
import { PlanStore, type PlanTask } from '../../src/plan/store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-03T07:00:00Z');

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
  dir = mkdtempSync(path.join(tmpdir(), 'goalplan-'));
  open();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HOUSE_DRAFT = {
  phases: [
    {
      title: 'Land and permits',
      notes: 'Survey, zoning, building permit',
      target: new Date(T0 + 60 * DAY).toISOString(),
      tasks: [
        { title: 'Get three quotes for the survey', effort_min: 60 },
        { title: 'Book the surveyor', after: [0] },
        { title: 'File the permit', after: [1, 5, -1] },
      ],
    },
    { title: 'Foundation', target_at: T0 + 120 * DAY, tasks: [] },
    { title: 'Framing', target_at: T0 + 30 * DAY },
    { title: '   ' },
  ],
};

function readyMaps(goalId: string): {
  tasks: PlanTask[];
  ready: (t: PlanTask) => boolean;
} {
  const tasks = store.listTasks({ goalId });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const phases = new Map(store.listPhases(goalId).map((p) => [p.id, p]));
  return { tasks, ready: (t) => isTaskReady(t, byId, phases) };
}

describe('cleanGoalDraft', () => {
  it('keeps order, clamps dates and maps "after" to kept tasks', () => {
    const d = cleanGoalDraft(HOUSE_DRAFT, T0, T0 + 100 * DAY, 'chat');
    expect(d).not.toBeNull();
    expect(d!.phases.map((p) => p.title)).toEqual(['Land and permits', 'Foundation', 'Framing']);
    // Clamped to the goal's target.
    expect(d!.phases[1].targetAt).toBe(T0 + 100 * DAY);
    // Earlier than the phase before it: dropped.
    expect(d!.phases[2].targetAt).toBeNull();
    expect(d!.phases[0].tasks.map((t) => t.after)).toEqual([[], [0], [1]]);
    expect(d!.phases[0].tasks[0].effortMin).toBe(60);
  });

  it('refuses junk', () => {
    expect(cleanGoalDraft(null, T0, null, 'model')).toBeNull();
    expect(cleanGoalDraft({ phases: [{ title: '' }] }, T0, null, 'model')).toBeNull();
    expect(cleanGoalDraft({ phases: 'x' }, T0, null, 'model')).toBeNull();
  });
});

describe('a goal plan', () => {
  function house(): string {
    const goal = store.addGoal('Build the house', '', T0, {
      targetAt: T0 + 330 * DAY,
      budgetCents: 450_000_00,
    });
    const draft = cleanGoalDraft(HOUSE_DRAFT, T0, goal.targetAt, 'chat')!;
    expect(store.setGoalDraft(goal.id, draft, T0)).toBe(true);
    expect(store.getGoal(goal.id)!.draft?.phases).toHaveLength(3);
    return goal.id;
  }

  it('accepting the draft makes phases and tasks; the first phase starts', () => {
    const id = house();
    const phases = store.acceptGoalDraft(id, T0)!;
    expect(phases.map((p) => p.status)).toEqual(['active', 'upcoming', 'upcoming']);
    expect(store.getGoal(id)!.draft).toBeNull();
    const tasks = store.listTasks({ goalId: id });
    expect(tasks).toHaveLength(3);
    expect(tasks[1].blockedBy).toEqual([tasks[0].id]);
    expect(tasks[2].blockedBy).toEqual([tasks[1].id]);
    // A second accept is refused: the goal already has phases.
    store.setGoalDraft(id, cleanGoalDraft(HOUSE_DRAFT, T0, null, 'chat'), T0);
    expect(store.acceptGoalDraft(id, T0)).toBeNull();
  });

  it('only ready tasks can go on a day', () => {
    const id = house();
    const [p1, p2] = store.acceptGoalDraft(id, T0)!;
    const late = store.addOwnerTask({ title: 'Pour the slab', goalId: id, phaseId: p2.id }, T0);
    let { tasks, ready } = readyMaps(id);
    expect(tasks.filter(ready).map((t) => t.title)).toEqual(['Get three quotes for the survey']);
    expect(ready(store.getTask(late.id)!)).toBe(false);

    store.updateTask(tasks[0].id, { status: 'done' }, T0 + DAY);
    ({ tasks, ready } = readyMaps(id));
    expect(tasks.filter(ready).map((t) => t.title)).toEqual(['Book the surveyor']);

    // Phase done → the next one starts and its task is ready.
    const started = store.finishPhase(p1.id, T0 + 2 * DAY);
    expect(started?.id).toBe(p2.id);
    ({ tasks, ready } = readyMaps(id));
    expect(ready(store.getTask(late.id)!)).toBe(true);
    // The unfinished task of a done phase moves on with the plan.
    expect(store.getTask(tasks[1].id)?.phaseId).toBe(p2.id);
    expect(ready(store.getTask(tasks[1].id)!)).toBe(true);
  });

  it('a wait takes a task off the day until it needs chasing', () => {
    const id = house();
    store.acceptGoalDraft(id, T0);
    const first = store.listTasks({ goalId: id })[0];
    store.updateTask(first.id, { waitingOn: 'Mike', waitingUntil: T0 + 3 * DAY }, T0);
    const t = store.getTask(first.id)!;
    const { ready } = readyMaps(id);
    expect(ready(t)).toBe(false);
    expect(needsChase(t, T0 + DAY)).toBe(false);
    expect(needsChase(t, T0 + 4 * DAY)).toBe(true);
    // Clearing the wait clears its date too.
    const cleared = store.updateTask(first.id, { waitingOn: '' }, T0)!;
    expect(cleared.waitingUntil).toBeNull();
    expect(readyMaps(id).ready(cleared)).toBe(true);
  });

  it('a late phase moves later dates only when asked', () => {
    const id = house();
    const [p1, p2, p3] = store.acceptGoalDraft(id, T0)!;
    expect(latePhase(store.listPhases(id), T0 + 10 * DAY)).toBeNull();
    // A phase has all of its target day; the next day it's one day late.
    expect(latePhase(store.listPhases(id), T0 + 60 * DAY + 1000)).toBeNull();
    expect(latePhase(store.listPhases(id), T0 + 61 * DAY)!.days).toBe(1);
    const now = T0 + 72 * DAY;
    const late = latePhase(store.listPhases(id), now)!;
    expect(late.phase.id).toBe(p1.id);
    expect(late.days).toBe(12);
    expect(late.moves.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id]);
    // Nothing moved yet.
    expect(store.getPhase(p2.id)!.targetAt).toBe(p2.targetAt);
    store.shiftDates(
      id,
      late.moves.map((p) => p.id),
      late.days,
      true,
      now,
    );
    expect(store.getPhase(p1.id)!.targetAt).toBe(p1.targetAt! + 12 * DAY);
    expect(store.getPhase(p2.id)!.targetAt).toBe(p2.targetAt! + 12 * DAY);
    expect(store.getPhase(p3.id)!.targetAt).toBeNull();
    expect(store.getGoal(id)!.targetAt).toBe(T0 + 342 * DAY);
  });

  it('the money line: a payment goes toward its task’s quote', () => {
    const id = house();
    store.acceptGoalDraft(id, T0);
    const task = store.listTasks({ goalId: id })[0];
    store.addCost(
      {
        goalId: id,
        taskId: task.id,
        label: 'Plumbing quote',
        kind: 'quote',
        amountCents: 18_400_00,
      },
      T0,
    );
    store.addCost(
      { goalId: id, label: 'Architect deposit', kind: 'paid', amountCents: 12_000_00 },
      T0,
    );
    let m = moneySummary(450_000_00, store.listCosts(id));
    expect(m).toEqual({
      budgetCents: 450_000_00,
      paidCents: 12_000_00,
      openQuoteCents: 18_400_00,
      leftCents: 419_600_00,
    });
    store.addCost(
      { goalId: id, taskId: task.id, label: 'Plumbing', kind: 'paid', amountCents: 18_000_00 },
      T0,
    );
    m = moneySummary(450_000_00, store.listCosts(id));
    // Paid less than quoted: the $400 still owed stays open.
    expect(m.openQuoteCents).toBe(400_00);
    expect(m.leftCents).toBe(419_600_00);
    expect(formatGoalMoney(18_400_00)).toBe('$18,400');
    expect(formatGoalMoney(1050)).toBe('$10.50');
  });
});

describe('migration v88', () => {
  it('upgrades a database already at v87 and keeps its tasks', () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(tmpdir(), 'goalplan-'));
    open(IDENTITY_MIGRATIONS.filter((m) => m.version <= 87));
    db.execute(
      `INSERT INTO plan_tasks (id, persona, title, origin, status, observed_at, created_at, updated_at)
       VALUES ('task-old', 'general', 'Book the dentist', 'owner', 'open', 1, 1, 1)`,
    );
    db.execute(
      `INSERT INTO plan_goals (id, title, created_at, updated_at) VALUES ('goal-old', 'Run', 1, 1)`,
    );
    db.close();
    open();
    const t = store.getTask('task-old')!;
    expect(t).toMatchObject({
      title: 'Book the dentist',
      phaseId: '',
      blockedBy: [],
      waitingOn: '',
    });
    expect(store.getGoal('goal-old')).toMatchObject({
      currency: 'USD',
      targetAt: null,
      draft: null,
    });
  });
});
