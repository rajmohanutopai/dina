/**
 * DAILY_PLAN.md §15–§19 — the goal drafter, the phase-task suggester, chases
 * in the day planner, and the goal chat tools over a real plan store,
 * walking the house from the design doc.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { IDENTITY_MIGRATIONS, PlanStore, applyMigrations } from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { fixedOrderPlan, type PlannerTask } from '../../src/plan/day_planner';
import { draftGoalPlan, suggestPhaseTasks } from '../../src/plan/goal_planner';
import { createPlanTools } from '../../src/plan/plan_tools';

import type { AgentTool } from '../../src/reasoning/tool_registry';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T08:00:00Z');
const GOAL = {
  title: 'Build the house',
  notes: '',
  targetAt: NOW + 330 * DAY,
  budgetCents: 450_000_00,
  currency: 'USD',
};

describe('draftGoalPlan', () => {
  it('returns null with no model, a failing model, or junk', async () => {
    expect(await draftGoalPlan(GOAL, NOW, null)).toBeNull();
    expect(await draftGoalPlan(GOAL, NOW, async () => Promise.reject(new Error('404')))).toBeNull();
    expect(await draftGoalPlan(GOAL, NOW, async () => 'not json')).toBeNull();
  });

  it('checks the model answer and passes the goal as data', async () => {
    let seen = '';
    const draft = await draftGoalPlan(GOAL, NOW, async ({ user }) => {
      seen = user;
      return (
        '```json\n' +
        JSON.stringify({
          phases: [
            {
              title: 'Land and permits',
              target: '2027-01-15',
              tasks: [{ title: 'Get survey quotes', effort_min: 60 }],
            },
            { title: 'Foundation', target: '2030-01-01' },
          ],
        }) +
        '\n```'
      );
    });
    expect(JSON.parse(seen).goal).toMatchObject({ title: 'Build the house', budget: '450000 USD' });
    expect(draft?.by).toBe('model');
    expect(draft?.phases.map((p) => p.title)).toEqual(['Land and permits', 'Foundation']);
    // Past the goal's date: clamped to it.
    expect(draft?.phases[1].targetAt).toBe(GOAL.targetAt);
  });
});

describe('draftGoalPlan with an answer shaped the way models write it', () => {
  it('reads prose around fenced JSON and the field names OpenRouter lets through', async () => {
    let asked: number | undefined;
    const draft = await draftGoalPlan(GOAL, NOW, async ({ maxTokens }) => {
      asked = maxTokens;
      return [
        "Here's a plan for you:",
        '```json',
        JSON.stringify({
          goal: 'Build the house',
          phases: [
            {
              title: 'Set up and register',
              note: 'Pick the race.',
              target_date: '2027-01-15',
              tasks: [{ text: 'Register for the race', effort_minutes: 20 }],
            },
          ],
        }),
        '```',
        'Good luck!',
      ].join('\n');
    });
    // Room for a whole plan: a cut-off answer can't be read.
    expect(asked).toBeGreaterThanOrEqual(4000);
    expect(draft?.phases[0]).toMatchObject({
      title: 'Set up and register',
      notes: 'Pick the race.',
      targetAt: Date.parse('2027-01-15'),
      tasks: [{ title: 'Register for the race', effortMin: 20, after: [] }],
    });
  });

  it('a cut-off answer gives null, not half a plan', async () => {
    expect(
      await draftGoalPlan(GOAL, NOW, async () => '```json\n{"phases":[{"title":"Set up"'),
    ).toBeNull();
  });
});

describe('suggestPhaseTasks', () => {
  it('drops tasks already listed and re-points "after"', async () => {
    const tasks = await suggestPhaseTasks(
      {
        goal: GOAL,
        phase: { title: 'Framing', notes: '', targetAt: null },
        done: ['Order lumber'],
        open: [],
      },
      NOW,
      async () =>
        JSON.stringify({
          tasks: [
            { title: 'Order lumber' },
            { title: 'Hire the framing crew' },
            { title: 'Walk the frame', after: [1] },
          ],
        }),
    );
    expect(tasks).toEqual([
      { title: 'Hire the framing crew', effortMin: null, after: [] },
      { title: 'Walk the frame', effortMin: null, after: [0] },
    ]);
  });
});

describe('chases in the day plan', () => {
  it('a late wait goes in with the due-today tasks and says who to chase', () => {
    const base: PlannerTask = {
      id: 'a',
      title: 'Plumbing quote',
      summary: '',
      persona: 'general',
      project: '',
      dueAt: null,
      effortMin: 10,
      carried: 0,
      createdAt: NOW - DAY,
      goalId: '',
    };
    const plan = fixedOrderPlan({
      day: '2026-11-03',
      dayStart: NOW - 8 * 60 * 60 * 1000,
      dayEnd: NOW + 16 * 60 * 60 * 1000,
      now: NOW,
      capacityMin: 0,
      goals: [],
      tasks: [{ ...base, chase: { on: 'Mike', until: Date.parse('2026-11-03T12:00:00Z') } }],
    });
    expect(plan.entries).toEqual([{ taskId: 'a', reason: 'Chase Mike: due Tue' }]);
  });
});

describe('goal chat tools — the house', () => {
  let dir: string;
  let db: NodeSQLiteAdapter;
  let store: PlanStore;
  let tools: Map<string, AgentTool>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'goaltools-'));
    db = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: 'cd'.repeat(32),
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    store = new PlanStore(db);
    tools = new Map(
      createPlanTools({ store: () => store, now: () => NOW }).map((t) => [t.name, t]),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    tools.get(name)!.execute(args) as Promise<unknown>;

  it('goal → draft → accept → wait → quote → payment → status', async () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining(['set_goal', 'draft_goal_plan', 'update_goal_task', 'show_goal']),
    );
    await run('set_goal', {
      title: 'Build the house',
      target_date: '2027-10-01',
      budget: 450000,
    });
    const goal = store.listGoals(true)[0];
    expect(goal).toMatchObject({ budgetCents: 450_000_00, currency: 'USD' });

    const drafted = (await run('draft_goal_plan', {
      goal: 'house',
      phases: [
        {
          title: 'Plumbing and electrical',
          target_date: '2027-05-01',
          tasks: [
            { title: 'Get the plumbing quote from Mike' },
            { title: 'Book the electrician', after: [0] },
          ],
        },
        { title: 'Finishing', target_date: '2027-09-01' },
      ],
    })) as Record<string, unknown>;
    expect(drafted).toMatchObject({
      saved: true,
      phases: ['Plumbing and electrical', 'Finishing'],
    });
    // Nothing starts until the owner accepts.
    expect(store.listPhases(goal.id)).toEqual([]);
    store.acceptGoalDraft(goal.id, NOW);
    // A second draft for a live plan is refused.
    expect(await run('draft_goal_plan', { goal: 'house', phases: [{ title: 'x' }] })).toMatchObject(
      {
        error: expect.stringContaining('already has a plan'),
      },
    );

    await run('update_goal_task', {
      goal: 'house',
      task: 'plumbing quote',
      waiting_on: 'Mike',
      waiting_until: '2026-11-10',
    });
    const quoteTask = store.listTasks({ goalId: goal.id })[0];
    expect(store.getTask(quoteTask.id)).toMatchObject({ waitingOn: 'Mike' });

    const got = (await run('update_goal_task', {
      goal: 'house',
      task: 'Mike',
      cost: { amount: 18400, kind: 'quote', label: 'Plumbing quote from Mike' },
    })) as Record<string, unknown>;
    expect(got.changed).toEqual(['wait ended', 'quote $18,400']);
    expect(store.getTask(quoteTask.id)!.waitingOn).toBe('');

    await run('update_goal_task', { goal: 'house', task: 'plumbing quote', done: true });
    const shown = (await run('show_goal', { goal: 'Build the house' })) as Record<string, unknown>;
    expect(shown).toMatchObject({
      goal: 'Build the house',
      next: ['Book the electrician'],
      waiting: [],
      money: {
        budget: '$450,000',
        paid: '$0',
        open_quotes: '$18,400',
        left_if_quotes_paid: '$431,600',
      },
    });
  });

  it('refuses an unclear task instead of guessing', async () => {
    await run('set_goal', { title: 'Build the house' });
    const goal = store.listGoals(true)[0];
    store.setGoalDraft(
      goal.id,
      {
        by: 'chat',
        phases: [
          {
            title: 'P',
            notes: '',
            targetAt: null,
            tasks: [
              { title: 'Call the roofer', effortMin: null, after: [] },
              { title: 'Call the plumber', effortMin: null, after: [] },
            ],
          },
        ],
      },
      NOW,
    );
    store.acceptGoalDraft(goal.id, NOW);
    expect(
      await run('update_goal_task', { goal: 'house', task: 'call', done: true }),
    ).toMatchObject({
      error: expect.stringContaining('no single open task'),
      open_tasks: ['Call the roofer', 'Call the plumber'],
    });
  });

  it('a wait on something new adds it to the current phase; add_task can join a goal', async () => {
    await run('set_goal', { title: 'Build the house' });
    const goal = store.listGoals(true)[0];
    store.setGoalDraft(
      goal.id,
      { by: 'chat', phases: [{ title: 'Land', notes: '', targetAt: null, tasks: [] }] },
      NOW,
    );
    const [phase] = store.acceptGoalDraft(goal.id, NOW)!;
    const got = (await run('update_goal_task', {
      goal: 'house',
      task: 'Builder quote from Mike',
      waiting_on: 'Mike',
      waiting_until: '2026-11-10',
    })) as Record<string, unknown>;
    expect(got).toMatchObject({ added_task: true, changed: ['waiting on Mike'] });
    expect(store.listTasks({ goalId: goal.id })[0]).toMatchObject({
      title: 'Builder quote from Mike',
      phaseId: phase.id,
      waitingOn: 'Mike',
    });
    await run('add_task', { title: 'Visit two plots', goal: 'house' });
    expect(store.listTasks({ goalId: goal.id }).map((t) => t.title)).toContain('Visit two plots');
    expect(await run('add_task', { title: 'x', goal: 'boat' })).toMatchObject({
      error: expect.stringContaining('no single active goal'),
    });
  });
});
