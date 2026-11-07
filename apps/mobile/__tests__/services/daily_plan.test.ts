/**
 * The daily plan on the phone (docs/DAILY_PLAN.md §7–§8): planning without a
 * model, the evening review, an agent's tasks waiting for the owner, and the
 * check-ins the OS gets, with their text and times. Real plan store over
 * SQLCipher; the OS notification layer is the jest mock.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetDND, setDND } from '@dina/brain/notifications';
import {
  IDENTITY_MIGRATIONS,
  PlanStore,
  applyMigrations,
  parseBatch,
  planDayKey,
  planDayKeyAfter,
  receiveBatch,
  setPlanStore,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  __getScheduled,
  __resetNotificationsMock,
} from '../../__mocks__/expo-notifications';
import {
  acceptGoalDraft,
  addGoalPhase,
  addGoalTask,
  addTask,
  atTime,
  dayCandidates,
  draftPlanForGoal,
  finishGoalPhase,
  goalSummary,
  loadGoal,
  moveLateDates,
  parseAmount,
  recordGoalCost,
  setTaskWait,
  suggestTasksForPhase,
  carryTask,
  checkinId,
  computeCheckins,
  decideAgentFeed,
  DEFAULT_PLAN_SETTINGS,
  finishReview,
  loadToday,
  planToday,
  rescheduleCheckins,
  savePlanSettings,
  setTaskDone,
  shouldAutoPlan,
  validSettings,
} from '../../src/services/daily_plan';

// Tuesday 3 November 2026, local time.
const MORNING = new Date(2026, 10, 3, 9, 0).getTime();
const AGENT = 'did:key:z6MkOfficeClaude';

let dir: string;
let db: NodeSQLiteAdapter;
let store: PlanStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-plan-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new PlanStore(db);
  setPlanStore(store);
  __resetNotificationsMock();
  resetDND();
  setDND({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
});

afterEach(() => {
  setPlanStore(null);
  resetDND();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function scheduledIds(): string[] {
  return __getScheduled().map((r) => (r as { identifier: string }).identifier).sort();
}

describe('planning and review', () => {
  it('plans with the fixed order when no model is set, and auto-plans once', async () => {
    await addTask('Renew car insurance', MORNING - 1000);
    expect(await shouldAutoPlan(MORNING)).toBe(true);
    expect(await shouldAutoPlan(atTime(MORNING, '07:00'))).toBe(false); // before the plan time
    const plan = await planToday(MORNING, null);
    expect(plan.by).toBe('fixed');
    expect(await shouldAutoPlan(MORNING)).toBe(false);
    const view = await loadToday(MORNING);
    expect(view.planned.map((p) => p.task.title)).toEqual(['Renew car insurance']);
  });

  it('the evening review carries what is left and counts it', async () => {
    const a = await addTask('Reply to Priya', MORNING);
    const b = await addTask('Book the dentist', MORNING);
    await planToday(MORNING, null);
    await setTaskDone(a.id, true, MORNING + 1000);
    const evening = atTime(MORNING, '18:30');
    expect((await loadToday(evening)).reviewDue).toBe(true);
    expect(await finishReview(evening)).toBe(1);
    expect(store.getTask(b.id)).toMatchObject({ plannedFor: planDayKeyAfter(evening, 1), carried: 1 });
    expect((await loadToday(evening)).reviewDue).toBe(false);
  });

  it('carrying one task moves it to tomorrow', async () => {
    const a = await addTask('Call the plumber', MORNING);
    await carryTask(a.id, MORNING);
    expect(store.getTask(a.id)?.plannedFor).toBe(planDayKeyAfter(MORNING, 1));
  });
});

describe("an agent's tasks", () => {
  it('wait on Today until the owner allows them', async () => {
    receiveBatch(
      store,
      AGENT,
      'Office Claude',
      parseBatch({ batch_id: 'b1', persona: 'work', items: [{ title: 'Answer Priya', source_ref: 'm1' }] }, MORNING),
      MORNING,
    );
    let view = await loadToday(MORNING);
    expect(view.pendingFeeds).toEqual([
      expect.objectContaining({ held: 1, feed: expect.objectContaining({ agentName: 'Office Claude', persona: 'work' }) }),
    ]);
    expect(view.others).toHaveLength(0);
    await decideAgentFeed(AGENT, 'work', true, MORNING + 1);
    view = await loadToday(MORNING + 1);
    expect(view.pendingFeeds).toHaveLength(0);
    expect(view.others.map((t) => t.title)).toEqual(['Answer Priya']);
  });
});

describe('check-ins', () => {
  it('morning, midday and evening carry the counts known now', async () => {
    const a = await addTask('Reply to Priya', MORNING);
    await addTask('Book the dentist', MORNING);
    await planToday(MORNING, null);
    await setTaskDone(a.id, true, MORNING);
    const list = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING);
    const byKind = new Map(list.map((c) => [c.kind, c]));
    expect(byKind.get('midday')).toMatchObject({
      title: '1 of 2 done',
      body: 'Next: Book the dentist',
      at: atTime(MORNING, '13:00'),
      deepLink: 'dina://plan',
    });
    expect(byKind.get('evening')?.body).toBe('1 task still open. Carry them to tomorrow or drop them.');
    // 09:00 is past today's 08:00 plan time: the next morning is tomorrow's.
    expect(byKind.get('morning')?.at).toBe(atTime(MORNING + 24 * 3_600_000, '08:00'));
    expect(byKind.has('weekly')).toBe(false); // no goals
  });

  it('says nothing when there is nothing to say', async () => {
    expect(computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING)).toEqual([]);
    const a = await addTask('Only task', MORNING);
    await planToday(MORNING, null);
    await setTaskDone(a.id, true, MORNING);
    expect(computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).map((c) => c.kind)).toEqual([]);
  });

  it('the weekly note names a goal that got no time', async () => {
    store.addGoal('Run three times a week', '', MORNING - 10 * 24 * 3_600_000);
    await addTask('x', MORNING);
    const weekly = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).find((c) => c.kind === 'weekly');
    // Next Sunday at the evening time; 15 days since the goal was set by then.
    expect(new Date(weekly?.at ?? 0).getDay()).toBe(0);
    expect(weekly?.body).toMatch(/^No time on "Run three times a week" for 15 days\.$/);
    expect(weekly?.deepLink).toBe('dina://goals');
  });

  it('schedules them with the OS, drops stale ones, and keeps out of quiet hours', async () => {
    await addTask('Reply to Priya', MORNING);
    await planToday(MORNING, null);
    await rescheduleCheckins(MORNING);
    expect(scheduledIds()).toEqual(
      [checkinId('evening'), checkinId('midday'), checkinId('morning')].sort(),
    );

    // Done: the midday and evening check-ins go.
    const [t] = store.listTasks({ statuses: ['open'] });
    await setTaskDone(t.id, true, MORNING);
    expect(scheduledIds()).toEqual([]);

    // A quiet-hours window over the evening time keeps that check-in off;
    // the 08:00 morning plan is outside it.
    await addTask('Another', MORNING);
    await planToday(MORNING, null);
    setDND({ quietHoursStart: '17:00', quietHoursEnd: '07:00' });
    await rescheduleCheckins(MORNING);
    expect(scheduledIds()).toEqual([checkinId('midday'), checkinId('morning')].sort());
  });

  it('can be turned off', async () => {
    await addTask('Reply to Priya', MORNING);
    await savePlanSettings({ checkins: false });
    await rescheduleCheckins(MORNING);
    expect(scheduledIds()).toEqual([]);
  });
});

it('settings fall back to the defaults on bad values', () => {
  expect(validSettings({ planTime: '25:00', capacityHours: -1, weeklyDay: 9 })).toEqual(DEFAULT_PLAN_SETTINGS);
  expect(validSettings({ planTime: '07:30', checkins: false })).toMatchObject({ planTime: '07:30', checkins: false });
  expect(planDayKey(MORNING)).toBe('2026-11-03');
});

describe('goal plans (§15–§21)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function house(): string {
    return store.addGoal('Build the house', '', MORNING, {
      targetAt: MORNING + 330 * DAY,
      budgetCents: 450_000_00,
    }).id;
  }

  it('drafting needs a model; the drafted plan feeds Today one ready task at a time', async () => {
    const id = house();
    expect(await draftPlanForGoal(id, MORNING, null)).toBe(false);
    const ok = await draftPlanForGoal(id, MORNING, async () =>
      JSON.stringify({
        phases: [
          {
            title: 'Land and permits',
            target: new Date(MORNING + 40 * DAY).toISOString(),
            tasks: [{ title: 'Get survey quotes' }, { title: 'Book the surveyor', after: [0] }],
          },
          { title: 'Foundation', target: new Date(MORNING + 90 * DAY).toISOString() },
        ],
      }),
    );
    expect(ok).toBe(true);
    expect(goalSummary(store.getGoal(id)!, MORNING).hasDraft).toBe(true);
    // Nothing reaches Today before the owner accepts.
    expect(dayCandidates(store, MORNING)).toEqual([]);
    expect(await acceptGoalDraft(id, MORNING)).toBe(true);
    expect(dayCandidates(store, MORNING).map((c) => c.task.title)).toEqual(['Get survey quotes']);
    expect(goalSummary(store.getGoal(id)!, MORNING).line).toBe('Land and permits · phase 1 of 2');

    const plan = await planToday(MORNING, null);
    expect(plan.entries).toHaveLength(1);
    const view = await loadToday(MORNING);
    expect(view.planned[0].task.goalId).toBe(id);
  });

  it('a wait leaves Today and comes back as a chase when it is late', async () => {
    const id = house();
    addGoalPhase(id, 'Plumbing', null, MORNING);
    const phase = store.listPhases(id)[0];
    const task = await addGoalTask(id, phase.id, 'Plumbing quote', MORNING);
    await setTaskWait(task.id, 'Mike', 2, MORNING);
    expect(dayCandidates(store, MORNING)).toEqual([]);
    expect((await loadToday(MORNING)).others).toEqual([]);
    const later = MORNING + 3 * DAY;
    const [c] = dayCandidates(store, later);
    expect(c.chase?.on).toBe('Mike');
    expect((await loadToday(later)).chases[task.id]).toBe('Mike');
    const plan = await planToday(later, null);
    expect(plan.entries[0].reason).toMatch(/^Chase Mike: due /);
  });

  it('phase done hands over; Suggest tasks fills the new phase', async () => {
    const id = house();
    const p1 = addGoalPhase(id, 'Foundation', null, MORNING);
    const p2 = addGoalPhase(id, 'Framing', null, MORNING);
    expect([p1.status, p2.status]).toEqual(['active', 'upcoming']);
    const started = await finishGoalPhase(p1.id, MORNING);
    expect(started?.id).toBe(p2.id);
    expect(await suggestTasksForPhase(p2.id, MORNING, null)).toBe(0);
    const n = await suggestTasksForPhase(p2.id, MORNING, async () =>
      JSON.stringify({ tasks: [{ title: 'Order lumber' }, { title: 'Hire the crew', after: [0] }] }),
    );
    expect(n).toBe(2);
    const g = loadGoal(id, MORNING)!;
    expect(g.phases[1].tasks.map((t) => t.title)).toEqual(['Order lumber', 'Hire the crew']);
    expect(g.ready).toEqual([g.phases[1].tasks[0].id]);
  });

  it('the late phase, its move, the weekly note and the money line', async () => {
    const id = house();
    const p1 = addGoalPhase(id, 'Roof', MORNING + 10 * DAY, MORNING);
    addGoalPhase(id, 'Finishing', MORNING + 60 * DAY, MORNING);
    const now = MORNING + 22 * DAY;
    const g = loadGoal(id, now)!;
    expect(g.late?.phase.id).toBe(p1.id);
    expect(g.late?.days).toBe(12);
    const weekly = computeCheckins(store, DEFAULT_PLAN_SETTINGS, now).find((c) => c.kind === 'weekly');
    expect(weekly?.body).toMatch(/^Roof \(Build the house\) is \d+ days late/);
    expect(await moveLateDates(id, now)).toBe(12);
    expect(loadGoal(id, now)!.late).toBeNull();
    expect(store.getGoal(id)!.targetAt).toBe(MORNING + 342 * DAY);

    expect(parseAmount('$18,400')).toBe(18_400_00);
    expect(parseAmount('12.5')).toBe(1250);
    expect(parseAmount('ten')).toBeNull();
    expect(() => recordGoalCost(id, 'Roof', 'ten', 'quote', '', now)).toThrow(/amount/);
    recordGoalCost(id, 'Roofing quote', '18,400', 'quote', '', now);
    recordGoalCost(id, 'Architect', '12,000', 'paid', '', now);
    expect(loadGoal(id, now)!.money).toEqual({
      budgetCents: 450_000_00,
      paidCents: 12_000_00,
      openQuoteCents: 18_400_00,
      leftCents: 419_600_00,
    });
  });
});
