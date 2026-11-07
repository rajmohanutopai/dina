/**
 * Run once per time zone by `zones` in goal_planner.test.ts, in a jest process
 * started with TZ set: dates in chat and in model prompts on the owner's clock.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { IDENTITY_MIGRATIONS, PlanStore, applyMigrations, planDayKey } from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { buildDayPlan } from '../../../src/plan/day_planner';
import { draftGoalPlan } from '../../../src/plan/goal_planner';
import { createPlanTools } from '../../../src/plan/plan_tools';

const NOW = new Date(2026, 10, 3, 21, 30).getTime();

it('runs in the zone it was started for', () => {
  // By offset: one zone can go by two names (Asia/Kolkata, Asia/Calcutta).
  const offset = (timeZone?: string): string =>
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).format(
      new Date(2027, 0, 15),
    );
  expect(offset()).toBe(offset(process.env.EXPECT_ZONE));
});

it('the drafter and the day planner are told the owner date', async () => {
  let drafted = '';
  await draftGoalPlan(
    { title: 'House', notes: '', targetAt: null, budgetCents: null, currency: 'USD' },
    NOW,
    async ({ user }) => {
      drafted = user;
      return '{}';
    },
  );
  expect(JSON.parse(drafted).today).toBe('2026-11-03');

  let planned = '';
  await buildDayPlan(
    {
      day: '2026-11-03',
      dayStart: new Date(2026, 10, 3).getTime(),
      dayEnd: new Date(2026, 10, 4).getTime(),
      now: NOW,
      goals: [],
      capacityMin: 60,
      tasks: [
        {
          id: 'a',
          title: 'A',
          summary: '',
          persona: 'general',
          project: '',
          dueAt: null,
          effortMin: null,
          carried: 0,
          createdAt: 1,
          goalId: '',
        },
      ],
    },
    async ({ user }) => {
      planned = user;
      return '{}';
    },
  );
  expect(JSON.parse(planned).now).toBe('Tue 2026-11-03 21:30');
});

it('a date said in chat comes back as the same date', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-zone-chat-'));
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  const store = new PlanStore(db);
  const tools = new Map(
    createPlanTools({ store: () => store, now: () => NOW }).map((t) => [t.name, t]),
  );
  await tools.get('set_goal')?.execute({ title: 'House', target_date: '2027-10-01' });
  const goal = store.listGoals()[0];
  expect(planDayKey(goal.targetAt as number)).toBe('2027-10-01');
  const task = store.addOwnerTask({ title: 'Builder quote', goalId: goal.id }, NOW);
  await tools.get('update_goal_task')?.execute({
    goal: 'House',
    task: 'Builder quote',
    waiting_on: 'Mike',
    waiting_until: '2026-11-10',
  });
  expect(planDayKey(store.getTask(task.id)?.waitingUntil as number)).toBe('2026-11-10');
  const shown = (await tools.get('show_goal')?.execute({ goal: 'House' })) as {
    target_date: string;
    waiting: { promised: string }[];
  };
  expect(shown.target_date).toBe('2027-10-01');
  expect(shown.waiting[0].promised).toBe('2026-11-10');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
