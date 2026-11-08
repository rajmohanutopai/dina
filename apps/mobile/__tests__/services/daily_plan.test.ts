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
  setPlanChangedListener,
  setPlanStore,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  __getScheduled,
  __resetNotificationsMock,
  __setIosStatus,
  IosAuthorizationStatus,
} from '../../__mocks__/expo-notifications';
import {
  getAlertAccess,
  rescheduleAllReminders,
  scheduleNotification,
} from '../../src/notifications/local';
import {
  acceptGoalDraft,
  addGoal,
  addGoalPhase,
  addGoalTask,
  addRoutine,
  addTask,
  addToToday,
  discardGoalDraft,
  deleteGoalPhase,
  dropTask,
  loadRoutines,
  mergeFormFields,
  MORNING_FADE_DAYS,
  moveGoalPhase,
  moveTaskToPhase,
  renameTask,
  reopenGoalPhase,
  setGoalActive,
  setTaskOrder,
  stopRoutine,
  updateGoalDetails,
  updatePhaseDetails,
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
  checkinsInQuietHours,
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

beforeEach(async () => {
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
  await savePlanSettings(DEFAULT_PLAN_SETTINGS);
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
    const byKind = new Map(list.filter((c) => c.id === checkinId(c.kind)).map((c) => [c.kind, c]));
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
    const mornings = MORNING_FADE_DAYS.map((_, i) => checkinId('morning', i));
    expect(scheduledIds()).toEqual(
      [checkinId('evening'), checkinId('midday'), ...mornings].sort(),
    );

    // Done: nothing is left to say.
    const [t] = store.listTasks({ statuses: ['open'] });
    await setTaskDone(t.id, true, MORNING);
    expect(scheduledIds()).toEqual([]);

    // A quiet-hours window over the evening time keeps that check-in off;
    // the 08:00 morning plan is outside it.
    await addTask('Another', MORNING);
    await planToday(MORNING, null);
    setDND({ quietHoursStart: '17:00', quietHoursEnd: '07:00' });
    await rescheduleCheckins(MORNING);
    expect(scheduledIds()).toEqual([checkinId('midday'), ...mornings].sort());
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
    expect(weekly?.body).toMatch(/^Roof \(Build the house\) is \d+ days late\.$/);
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

describe('things that repeat (§24)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('a turn lands on Today, lapses when missed, and never piles up', async () => {
    await addRoutine(
      { title: 'Stretch', kind: 'days', weekdays: [0, 1, 2, 3, 4, 5, 6], effortMin: 10 },
      MORNING,
    );
    let view = await loadToday(MORNING);
    expect(view.others.map((t) => t.title)).toEqual(['Stretch']);
    expect(view.others[0].routineDay).toBe('2026-11-03');
    // Asking again makes no second turn.
    await loadToday(MORNING + 1000);
    expect(store.listTasks({ statuses: ['open'] })).toHaveLength(1);

    view = await loadToday(MORNING + 3 * DAY);
    expect(view.others.map((t) => t.routineDay)).toEqual(['2026-11-06']);
    expect(store.listTasks({ statuses: ['open'] })).toHaveLength(1);
  });

  it('three times a week spreads out and stops at three', async () => {
    const r = await addRoutine({ title: 'Run', kind: 'per_week', timesPerWeek: 3 }, MORNING - DAY);
    const monday = MORNING - DAY; // Monday 2 November
    const days: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const at = monday + i * DAY;
      const open = (await loadToday(at)).others.filter((t) => t.routineId === r.id);
      if (open.length > 0) {
        days.push(open[0].routineDay);
        await setTaskDone(open[0].id, true, at);
      }
    }
    expect(days).toEqual(['2026-11-02', '2026-11-04', '2026-11-06']);
    expect(loadRoutines('', monday + 6 * DAY)[0].progress).toBe('3 of 3 this week');
  });

  it('a missed week presses at the end: the turns still fit', async () => {
    const r = await addRoutine({ title: 'Run', kind: 'per_week', timesPerWeek: 3 }, MORNING);
    const friday = MORNING + 3 * DAY;
    const [turn] = (await loadToday(friday)).others.filter((t) => t.routineId === r.id);
    expect(turn.dueAt).not.toBeNull(); // 3 still to do, 3 days left
  });

  it('a skipped turn counts as nothing, the review skips it, and Stop ends it', async () => {
    const r = await addRoutine({ title: 'Stretch', kind: 'days', weekdays: [2] }, MORNING);
    await planToday(MORNING, null);
    const [turn] = store.listTasks({ statuses: ['open'] });
    const evening = atTime(MORNING, '18:30');
    expect(await finishReview(evening)).toBe(1);
    expect(store.getTask(turn.id)).toMatchObject({ status: 'dropped', carried: 0 });
    expect(loadRoutines('', evening)[0].today).toBeNull();
    await stopRoutine(r.id, evening);
    expect(loadRoutines('', evening)).toEqual([]);
    expect((await loadToday(MORNING + 7 * DAY)).others).toEqual([]);
  });

  it('turns ahead count in the morning check-in; the plan names them', async () => {
    await addRoutine({ title: 'Stretch', kind: 'days', weekdays: [3] }, MORNING); // Wednesdays
    const morning = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).find(
      (c) => c.kind === 'morning',
    );
    expect(morning?.at).toBe(atTime(MORNING + DAY, '08:00'));
    expect(morning?.body).toBe('1 open task, 1 due by the end of the day.');
    const wednesday = MORNING + DAY;
    const plan = await planToday(wednesday, null);
    expect(plan.entries[0].reason).toBe("Today's turn: wed");
  });

  it('a goal archived takes its routines and tasks off the day', async () => {
    const goal = store.addGoal('Get fit', '', MORNING);
    await addRoutine({ title: 'Run', goalId: goal.id, kind: 'days', weekdays: [2, 3] }, MORNING);
    const phase = addGoalPhase(goal.id, 'Base', null, MORNING);
    await addGoalTask(goal.id, phase.id, 'Buy shoes', MORNING);
    expect((await loadToday(MORNING)).others.map((t) => t.title).sort()).toEqual([
      'Buy shoes',
      'Run',
    ]);
    expect(loadGoal(goal.id, MORNING)?.routines[0].progress).toBe('0 of 2 this week');
    expect(loadGoal(goal.id, MORNING)?.loose).toEqual([]);
    await setGoalActive(goal.id, false, MORNING);
    expect((await loadToday(MORNING)).others).toEqual([]);
    expect((await loadToday(MORNING + DAY)).others).toEqual([]);
    await setGoalActive(goal.id, true, MORNING + DAY);
    expect((await loadToday(MORNING + DAY)).others.map((t) => t.title).sort()).toEqual([
      'Buy shoes',
      'Run',
    ]);
  });

  it('refuses a rule it cannot follow', async () => {
    await expect(addRoutine({ title: 'x', kind: 'days', weekdays: [] }, MORNING)).rejects.toThrow(
      /day of the week/,
    );
    await expect(addRoutine({ title: 'x', kind: 'per_week' }, MORNING)).rejects.toThrow(/1 to 7/);
    await expect(
      addRoutine({ title: 'x', kind: 'monthly', dayOfMonth: 40 }, MORNING),
    ).rejects.toThrow(/1 to 31/);
    await expect(addRoutine({ title: ' ', kind: 'per_week', timesPerWeek: 2 }, MORNING)).rejects.toThrow(
      /repeats/,
    );
  });
});

describe('check-ins while the app stays closed (§25)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('mornings thin out over two weeks, and the last says it stops', async () => {
    await addTask('Renew car insurance', MORNING);
    const mornings = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).filter(
      (c) => c.kind === 'morning',
    );
    const gaps = mornings.map((c) => Math.round((c.at - MORNING) / DAY));
    expect(gaps).toEqual([1, 2, 3, 5, 8, 13]);
    expect(new Set(mornings.map((c) => c.id)).size).toBe(6);
    expect(mornings[0].body).toBe('1 open task.');
    expect(mornings[5].body).toBe('1 open task. Dina will stop asking until you open the app.');
    for (const c of mornings) expect(new Date(c.at).getHours()).toBe(8);
  });

  it('opening the app rewrites them; nothing fires for a task since done', async () => {
    const t = await addTask('Renew car insurance', MORNING);
    await rescheduleCheckins(MORNING);
    expect(scheduledIds().length).toBeGreaterThan(1);
    await setTaskDone(t.id, true, MORNING + DAY);
    expect(scheduledIds()).toEqual([]);
  });

  it('with no plan today, midday says so once; a later open has nothing to add', async () => {
    await addTask('Renew car insurance', MORNING);
    const midday = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).find(
      (c) => c.kind === 'midday',
    );
    expect(midday?.title).toBe('No plan yet today');
    expect(midday?.body).toBe('1 open task. Open Dina to plan the rest of the day.');
    const afternoon = atTime(MORNING, '15:00');
    expect(
      computeCheckins(store, DEFAULT_PLAN_SETTINGS, afternoon).some((c) => c.kind === 'midday'),
    ).toBe(false);
  });

  it('a day already planned before its plan time gets no "Plan your day"', async () => {
    await addTask('Renew car insurance', MORNING);
    const early = atTime(MORNING, '06:00');
    await planToday(early, null);
    const list = computeCheckins(store, DEFAULT_PLAN_SETTINGS, early);
    expect(list.filter((c) => c.kind === 'morning').every((c) => c.at > atTime(MORNING, '23:00'))).toBe(
      true,
    );
  });

  it('two weekly notes go ahead, and a date past its phase shows in both', async () => {
    const goal = store.addGoal('House', '', MORNING);
    addGoalPhase(goal.id, 'Roof', MORNING + 2 * DAY, MORNING);
    const weekly = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).filter(
      (c) => c.kind === 'weekly',
    );
    expect(weekly.map((c) => c.id)).toEqual([checkinId('weekly'), checkinId('weekly', 1)]);
    expect(weekly[1].at - weekly[0].at).toBe(7 * DAY);
    expect(weekly[1].body).toMatch(/^Roof \(House\) is \d+ days late/);
  });

  it('turning check-ins off cancels every one ahead', async () => {
    await addTask('Renew car insurance', MORNING);
    await rescheduleCheckins(MORNING);
    await savePlanSettings({ checkins: false });
    expect(scheduledIds()).toEqual([]);
  });
});

describe('changing a live plan (§27)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function plan(): Promise<{
    id: string;
    p1: string;
    p2: string;
    a: string;
    b: string;
  }> {
    const id = store.addGoal('House', '', MORNING).id;
    const p1 = addGoalPhase(id, 'Foundation', MORNING + 10 * DAY, MORNING).id;
    const p2 = addGoalPhase(id, 'Framing', MORNING + 40 * DAY, MORNING).id;
    const a = (await addGoalTask(id, p1, 'Pour concrete', MORNING)).id;
    const b = (await addGoalTask(id, p1, 'Inspect footings', MORNING)).id;
    return { id, p1, p2, a, b };
  }

  it('renames a phase, moves its date, and reorders', async () => {
    const { id, p1, p2 } = await plan();
    await updatePhaseDetails(p1, { title: ' Footings ', targetAt: MORNING + 20 * DAY }, MORNING);
    expect(store.getPhase(p1)).toMatchObject({ title: 'Footings', targetAt: MORNING + 20 * DAY });
    await expect(updatePhaseDetails(p1, { title: ' ' }, MORNING)).rejects.toThrow(/phase/);
    await moveGoalPhase(p2, 'up', MORNING);
    expect(store.listPhases(id).map((p) => p.id)).toEqual([p2, p1]);
    await moveGoalPhase(p2, 'up', MORNING); // already first
    expect(store.listPhases(id).map((p) => p.id)).toEqual([p2, p1]);
  });

  it('deleting the active phase starts the next and keeps its tasks and money', async () => {
    const { id, p1, p2, a } = await plan();
    recordGoalCost(id, 'Concrete', '900', 'quote', a, MORNING);
    const before = store.listCosts(id)[0];
    store.updateTask(a, {}, MORNING);
    await deleteGoalPhase(p1, MORNING);
    expect(store.getPhase(p2)?.status).toBe('active');
    expect(store.getTask(a)).toMatchObject({ phaseId: '', status: 'open', goalId: id });
    expect(store.listCosts(id)[0].id).toBe(before.id);
    expect(loadGoal(id, MORNING)?.loose.map((t) => t.id)).toContain(a);
    expect(dayCandidates(store, MORNING).map((c) => c.task.id)).toContain(a);
  });

  it('finishing a phase moves open tasks on; undoing it reopens the phase', async () => {
    const { p1, p2, a, b } = await plan();
    await setTaskDone(a, true, MORNING);
    await finishGoalPhase(p1, MORNING);
    expect(store.getTask(b)?.phaseId).toBe(p2);
    expect(store.getTask(a)?.phaseId).toBe(p1); // finished work stays put
    await reopenGoalPhase(p1, MORNING);
    expect(store.getPhase(p1)?.status).toBe('active');
    expect(store.getPhase(p1)?.doneAt).toBeNull();
  });

  it('the last phase finished leaves open tasks on the goal, still on the day', async () => {
    const id = store.addGoal('Small job', '', MORNING).id;
    const p = addGoalPhase(id, 'Only', null, MORNING);
    const t = await addGoalTask(id, p.id, 'Left over', MORNING);
    await finishGoalPhase(p.id, MORNING);
    expect(store.getTask(t.id)?.phaseId).toBe('');
    expect(dayCandidates(store, MORNING).map((c) => c.task.id)).toEqual([t.id]);
  });

  it('renames, moves and drops a task, and sets its order without a circle', async () => {
    const { p2, a, b } = await plan();
    await renameTask(a, 'Pour the slab', MORNING);
    expect(store.getTask(a)?.title).toBe('Pour the slab');
    await expect(renameTask(a, ' ', MORNING)).rejects.toThrow(/task/);

    await setTaskOrder(b, [a], MORNING);
    expect(dayCandidates(store, MORNING).map((c) => c.task.id)).toEqual([a]);
    await expect(setTaskOrder(a, [b], MORNING)).rejects.toThrow(/each other/);
    await expect(setTaskOrder(a, [a], MORNING)).rejects.toThrow(/each other/);
    await setTaskOrder(b, [], MORNING);
    expect(dayCandidates(store, MORNING).map((c) => c.task.id)).toEqual([a, b]);

    await moveTaskToPhase(b, p2, MORNING);
    expect(dayCandidates(store, MORNING).map((c) => c.task.id)).toEqual([a]);
    await dropTask(a, MORNING);
    expect(dayCandidates(store, MORNING)).toEqual([]);
  });
});

describe('how a check-in reaches the owner (§25)', () => {
  afterEach(() => __setIosStatus(undefined));

  it('provisional counts as quiet, so Today asks for alerts', async () => {
    __setIosStatus(IosAuthorizationStatus.PROVISIONAL);
    expect(await getAlertAccess()).toBe('quiet');
    __setIosStatus(IosAuthorizationStatus.AUTHORIZED);
    expect(await getAlertAccess()).toBe('alerts');
  });
});

describe('the review round on the phone', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('Tomorrow takes a task off Today, the check-ins and a re-plan, and it returns', async () => {
    const a = await addTask('Call the plumber', MORNING);
    const b = await addTask('Book the dentist', MORNING);
    await planToday(MORNING, null);
    await carryTask(a.id, MORNING);
    const view = await loadToday(MORNING);
    expect(view.planned.map((p) => p.task.id)).toEqual([b.id]);
    expect(view.others).toEqual([]);
    const midday = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).find((c) => c.kind === 'midday');
    expect(midday?.body).toBe('Next: Book the dentist');
    await planToday(MORNING, null);
    expect((await loadToday(MORNING)).planned.map((p) => p.task.id)).toEqual([b.id]);
    expect((await loadToday(MORNING + DAY)).others.map((t) => t.id)).toContain(a.id);
  });

  it('a goal archived mid-day takes its planned tasks off Today and the check-ins', async () => {
    const goal = store.addGoal('House', '', MORNING);
    const phase = addGoalPhase(goal.id, 'Roof', null, MORNING);
    await addGoalTask(goal.id, phase.id, 'Order tiles', MORNING);
    await planToday(MORNING, null);
    expect((await loadToday(MORNING)).planned).toHaveLength(1);
    await setGoalActive(goal.id, false, MORNING);
    expect((await loadToday(MORNING)).planned).toEqual([]);
    expect(computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).some((c) => c.kind === 'midday')).toBe(false);
  });

  it('a re-plan keeps what is done; one after the review reviews again', async () => {
    const a = await addTask('Reply to Sancho', MORNING);
    const b = await addTask('Book the dentist', MORNING);
    await planToday(MORNING, null);
    await setTaskDone(a.id, true, MORNING);
    await planToday(MORNING, null);
    expect((await loadToday(MORNING)).planned.map((p) => [p.task.id, p.task.status])).toEqual([
      [a.id, 'done'],
      [b.id, 'open'],
    ]);
    const evening = atTime(MORNING, '18:30');
    await finishReview(evening);
    // Finished for the day: no midday check, even earlier the same day.
    expect(store.getDay(planDayKey(MORNING))?.reviewedAt).toBe(evening);
    const c = await addTask('Water plants', evening);
    await planToday(evening, null);
    expect(store.getDay(planDayKey(MORNING))?.reviewedAt).toBeNull();
    expect((await loadToday(evening)).planned.map((p) => p.task.id)).toEqual([a.id, c.id]);
    expect((await loadToday(evening)).reviewDue).toBe(true);
  });

  it('after the day is ended, midday says nothing', async () => {
    await addTask('Reply to Sancho', MORNING);
    await planToday(MORNING, null);
    await finishReview(MORNING);
    const list = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING);
    expect(list.some((c) => c.kind === 'midday' || c.kind === 'evening')).toBe(false);
  });

  it('planning nothing is no plan: auto-plan and check-ins stay on', async () => {
    await planToday(MORNING, null);
    expect(store.getDay(planDayKey(MORNING))).toBeNull();
    await addTask('Reply to Sancho', MORNING);
    expect(await shouldAutoPlan(MORNING)).toBe(true);
    expect((await loadToday(MORNING)).plan).toBeNull();
  });

  it('a skippable turn ahead is not called due', async () => {
    await addRoutine({ title: 'Run', kind: 'per_week', timesPerWeek: 2 }, MORNING);
    const [t] = store.listTasks({ statuses: ['open'] });
    await setTaskDone(t.id, true, MORNING);
    const list = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING);
    const later = list.filter((c) => c.kind === 'morning' && c.body.startsWith('1 open task'));
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((c) => !c.body.includes('due') || new Date(c.at).getDay() === 0)).toBe(true);
  });

  it('the weekly note counts each goal once', async () => {
    const house = store.addGoal('House', '', MORNING - 30 * DAY);
    addGoalPhase(house.id, 'Roof', MORNING - DAY, MORNING - 30 * DAY);
    const weekly = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).find((c) => c.kind === 'weekly');
    expect(weekly?.body).toMatch(/^Roof \(House\) is \d+ days late\.$/);
    store.addGoal('Fit', '', MORNING - 30 * DAY);
    const again = computeCheckins(store, DEFAULT_PLAN_SETTINGS, MORNING).find((c) => c.kind === 'weekly');
    expect(again?.body).toMatch(/late, and 1 other goal needs a look\.$/);
  });

  it('quiet hours can be set, and a check-in inside them is named', async () => {
    const saved = await savePlanSettings({ planTime: '06:30' });
    expect(checkinsInQuietHours(saved, MORNING)).toEqual(['Morning plan']);
    const moved = await savePlanSettings({ quietStart: '23:00', quietEnd: '06:00' });
    expect(checkinsInQuietHours(moved, MORNING)).toEqual([]);
    await addTask('x', MORNING);
    await rescheduleCheckins(MORNING);
    expect(scheduledIds()).toContain(checkinId('morning', 1));
  });

  it('a payment on the page goes toward the quote picked', () => {
    const id = store.addGoal('House', '', MORNING, { budgetCents: 100_000_00 }).id;
    const q = recordGoalCost(id, 'Roof quote', '18,400', 'quote', '', MORNING);
    recordGoalCost(id, '', '2,000', 'paid', '', MORNING, q.id);
    expect(loadGoal(id, MORNING)?.money).toMatchObject({
      paidCents: 2_000_00,
      openQuoteCents: 16_400_00,
    });
    expect(loadGoal(id, MORNING)?.costs[1].label).toBe('Roof quote');
  });

  it('a goal can be renamed and given notes, but not left blank', () => {
    const id = store.addGoal('Hosue', '', MORNING).id;
    updateGoalDetails(id, { title: ' House ', notes: ' Move in by autumn ' }, MORNING);
    expect(store.getGoal(id)).toMatchObject({ title: 'House', notes: 'Move in by autumn' });
    expect(() => updateGoalDetails(id, { title: ' ' }, MORNING)).toThrow(/goal/);
  });

  it('a form keeps what is being typed and takes what moved under it', () => {
    const saved = { target: '2027-10-01', notes: '' };
    const moved = { target: '2027-10-13', notes: '' };
    // Date moved, nobody touched it: the form follows, so Save can't undo the move.
    expect(mergeFormFields(saved, saved, moved)).toEqual(moved);
    // Notes being typed stay.
    expect(mergeFormFields({ ...saved, notes: 'typing' }, saved, moved)).toEqual({
      target: '2027-10-13',
      notes: 'typing',
    });
  });

  it('two plans asked for at once are one plan and one model call', async () => {
    await addTask('Reply to Sancho', MORNING);
    let calls = 0;
    const ask = async (): Promise<string> => {
      calls += 1;
      return '{"entries":[]}';
    };
    await Promise.all([planToday(MORNING, ask), planToday(MORNING, ask)]);
    expect(calls).toBe(1);
  });

  it("yesterday's turn can't be ticked from a screen left open overnight", async () => {
    const r = await addRoutine({ title: 'Stretch', kind: 'days', weekdays: [2, 3] }, MORNING);
    const [turn] = store.listRoutineTasks(r.id);
    const tomorrow = MORNING + DAY;
    await expect(setTaskDone(turn.id, true, tomorrow)).rejects.toThrow(/passed/);
    expect(store.getTask(turn.id)?.status).toBe('open');
    const [today] = loadRoutines('', tomorrow).map((v) => v.today);
    await setTaskDone(today?.id ?? '', true, tomorrow);
    expect(loadRoutines('', tomorrow)[0].progress).toBe('1 of 2 this week');
  });

  it('a task ticked while the model thinks is on the plan once', async () => {
    const a = await addTask('Reply to Sancho', MORNING);
    await planToday(MORNING, null);
    await planToday(MORNING, async () => {
      await setTaskDone(a.id, true, MORNING);
      return JSON.stringify({ entries: [{ task_id: a.id, reason: 'First' }] });
    });
    const planned = (await loadToday(MORNING)).planned;
    expect(planned.map((p) => p.task.id)).toEqual([a.id]);
    expect(planned[0].task.status).toBe('done');
  });

  it('a task added by hand while the model thinks stays on the plan (PLAN-5)', async () => {
    const a = await addTask('Reply to Sancho', MORNING);
    const b = await addTask('Book the dentist', MORNING);
    await planToday(MORNING, async () => {
      await addToToday(b.id, MORNING);
      return JSON.stringify({ entries: [{ task_id: a.id, reason: 'First' }] });
    });
    expect((await loadToday(MORNING)).planned.map((p) => p.task.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(store.getTask(b.id)?.plannedFor).toBe(planDayKey(MORNING));
    // A later re-plan keeps it too, and lists it once.
    await planToday(MORNING, async () =>
      JSON.stringify({
        entries: [
          { task_id: a.id, reason: 'First' },
          { task_id: b.id, reason: 'Second' },
        ],
      }),
    );
    const planned = (await loadToday(MORNING)).planned;
    expect(planned.filter((p) => p.task.id === b.id)).toHaveLength(1);
    expect(planned.find((p) => p.task.id === b.id)?.reason).toBe('Added by you');
  });

  it('a plan landing after the owner ended the day leaves the review standing (PLAN-7)', async () => {
    const a = await addTask('Reply to Sancho', MORNING);
    await planToday(MORNING, null);
    await planToday(MORNING, async () => {
      await finishReview(MORNING);
      return JSON.stringify({ entries: [{ task_id: a.id, reason: 'First' }] });
    });
    expect(store.getDay(planDayKey(MORNING))?.reviewedAt).toBe(MORNING);
    expect(store.getTask(a.id)?.plannedFor).toBe(planDayKeyAfter(MORNING, 1));
  });

  it('a draft landing after a phase, or a discard, is not saved (PLAN-6)', async () => {
    const answer = JSON.stringify({ phases: [{ title: 'Model', tasks: [{ title: 'x' }] }] });
    const g = addGoal('House', '', MORNING);
    const saved = await draftPlanForGoal(g.id, MORNING, async () => {
      addGoalPhase(g.id, 'By hand', null, MORNING);
      return answer;
    });
    expect(saved).toBe(false);
    expect(store.getGoal(g.id)?.draft).toBeNull();

    const g2 = addGoal('Move', '', MORNING);
    expect(await draftPlanForGoal(g2.id, MORNING, async () => answer)).toBe(true);
    const again = await draftPlanForGoal(g2.id, MORNING + 1, async () => {
      discardGoalDraft(g2.id, MORNING + 1);
      return answer;
    });
    expect(again).toBe(false);
    expect(store.getGoal(g2.id)?.draft).toBeNull();
  });

  it('check-ins scheduled side by side end as the last run says', async () => {
    const a = await addTask('Reply to Sancho', MORNING);
    await planToday(MORNING, null);
    const first = rescheduleCheckins(MORNING);
    store.updateTask(a.id, { status: 'done' }, MORNING);
    const second = rescheduleCheckins(MORNING);
    await Promise.all([first, second]);
    expect(scheduledIds()).toEqual([]);
  });

  it('a cold start leaves the check-ins to the plan, and re-issues everything else', async () => {
    await addTask('Reply to Sancho', MORNING);
    await rescheduleCheckins(MORNING);
    const future = Date.now() + 60 * 60 * 1000;
    await scheduleNotification({
      id: 'notif-reminder-1',
      title: 'Dentist',
      body: 'x',
      channel: 'solicited',
      triggerAt: future,
    });
    expect(await rescheduleAllReminders(Date.now())).toBe(1);
  });

  it('suggestions that arrive after the phase is finished are not added to it', async () => {
    const id = store.addGoal('House', '', MORNING).id;
    const p1 = addGoalPhase(id, 'Roof', null, MORNING);
    addGoalPhase(id, 'Paint', null, MORNING);
    const n = await suggestTasksForPhase(p1.id, MORNING, async () => {
      await finishGoalPhase(p1.id, MORNING);
      return JSON.stringify({ tasks: [{ title: 'Order tiles' }] });
    });
    expect(n).toBe(0);
    expect(store.listTasks({ goalId: id })).toEqual([]);
  });

  it('a new goal, new details and a new phase reach the check-ins', () => {
    let told = 0;
    setPlanChangedListener(() => {
      told += 1;
    });
    const goal = addGoal('House', '', MORNING);
    updateGoalDetails(goal.id, { title: 'Home' }, MORNING);
    addGoalPhase(goal.id, 'Roof', null, MORNING);
    setPlanChangedListener(null);
    expect(told).toBe(3);
  });

  it('Suggest tasks sees finished project work, not routine turns', async () => {
    const id = store.addGoal('Fit', '', MORNING).id;
    const phase = addGoalPhase(id, 'Base', null, MORNING);
    const t = await addGoalTask(id, phase.id, 'Buy shoes', MORNING);
    await setTaskDone(t.id, true, MORNING);
    await addRoutine({ goalId: id, title: 'Run', kind: 'days', weekdays: [2] }, MORNING);
    const [turn] = store.listTasks({ statuses: ['open'] });
    await setTaskDone(turn.id, true, MORNING);
    let seen = '';
    await suggestTasksForPhase(phase.id, MORNING, async ({ user }) => {
      seen = user;
      return '{"tasks":[]}';
    });
    expect(JSON.parse(seen).done).toEqual(['Buy shoes']);
  });
});
