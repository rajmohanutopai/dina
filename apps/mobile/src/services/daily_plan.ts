/**
 * The daily plan on the phone (docs/DAILY_PLAN.md §7–§9): build today's plan,
 * tick tasks, the evening review, agent permissions, settings, and the
 * check-ins scheduled as local notifications.
 *
 * The phone runs no code in the background, so each check-in is scheduled
 * ahead with the text known now, and rescheduled whenever the plan or a
 * task changes and on every foreground.
 */

import {
  buildDayPlan,
  draftGoalPlan,
  suggestPhaseTasks,
  type DayPlan,
  type PlannerAsk,
} from '@dina/brain';
import { shouldDeliverNotification } from '@dina/brain/notifications';
import {
  decideFeed,
  getPlanStore,
  isTaskReady,
  latePhase,
  moneySummary,
  needsChase,
  type LatePhase,
  type MoneySummary,
  type PlanCost,
  type PlanCostKind,
  type PlanPhase,
  planDayEnd,
  planDayKey,
  planDayKeyAfter,
  planDayStart,
  type PlanDay,
  type PlanFeed,
  type PlanGoal,
  type PlanStore,
  type PlanTask,
} from '@dina/core';
import { kvGet, kvSet } from '@dina/core/kv';

import { peekAgenticRouter } from '../ai/agentic_swap';
import { cancelNotification, scheduleNotification } from '../notifications/local';

const KV_NAMESPACE = 'plan';
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEY = 'settings';

export interface PlanSettings {
  /** `HH:MM`, local. */
  planTime: string;
  middayTime: string;
  eveningTime: string;
  /** 0 = Sunday … 6 = Saturday. */
  weeklyDay: number;
  /** Hours available for tasks on a day. */
  capacityHours: number;
  /** Check-ins on or off. */
  checkins: boolean;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = Object.freeze({
  planTime: '08:00',
  middayTime: '13:00',
  eveningTime: '18:00',
  weeklyDay: 0,
  capacityHours: 6,
  checkins: true,
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validSettings(raw: unknown): PlanSettings {
  const s: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const time = (v: unknown, d: string): string => (typeof v === 'string' && HHMM.test(v) ? v : d);
  const weekly =
    typeof s.weeklyDay === 'number' &&
    Number.isInteger(s.weeklyDay) &&
    s.weeklyDay >= 0 &&
    s.weeklyDay <= 6
      ? s.weeklyDay
      : DEFAULT_PLAN_SETTINGS.weeklyDay;
  const hours =
    typeof s.capacityHours === 'number' && s.capacityHours > 0 && s.capacityHours <= 16
      ? s.capacityHours
      : DEFAULT_PLAN_SETTINGS.capacityHours;
  return {
    planTime: time(s.planTime, DEFAULT_PLAN_SETTINGS.planTime),
    middayTime: time(s.middayTime, DEFAULT_PLAN_SETTINGS.middayTime),
    eveningTime: time(s.eveningTime, DEFAULT_PLAN_SETTINGS.eveningTime),
    weeklyDay: weekly,
    capacityHours: hours,
    checkins: s.checkins !== false,
  };
}

export async function loadPlanSettings(): Promise<PlanSettings> {
  try {
    const raw = await kvGet(SETTINGS_KEY, KV_NAMESPACE);
    return validSettings(raw === null ? {} : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PLAN_SETTINGS };
  }
}

export async function savePlanSettings(next: Partial<PlanSettings>): Promise<PlanSettings> {
  const merged = validSettings({ ...(await loadPlanSettings()), ...next });
  await kvSet(SETTINGS_KEY, JSON.stringify(merged), KV_NAMESPACE);
  await rescheduleCheckins();
  return merged;
}

function requireStore(): PlanStore {
  const store = getPlanStore();
  if (store === null) throw new Error('Your Dina is still starting. Try again in a moment.');
  return store;
}

/** `HH:MM` on the local day holding `dayMs`. */
export function atTime(dayMs: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}

// ---------------------------------------------------------------------------
// Which tasks can go on a day (DAILY_PLAN.md §17)
// ---------------------------------------------------------------------------

export interface DayCandidate {
  task: PlanTask;
  /** Set when the task is a late wait to chase. */
  chase?: { on: string; until: number };
}

/** Open tasks that can go on the day holding `now`: ready ones, and late waits. */
export function dayCandidates(store: PlanStore, now: number): DayCandidate[] {
  const all = store.listTasks({ statuses: ['open', 'done', 'dropped'] });
  const byId = new Map(all.map((t) => [t.id, t]));
  const phases = new Map<string, PlanPhase>();
  for (const g of store.listGoals()) for (const p of store.listPhases(g.id)) phases.set(p.id, p);
  const dayEnd = planDayEnd(now);
  return all.flatMap((task): DayCandidate[] => {
    if (task.status !== 'open') return [];
    if (needsChase(task, dayEnd)) {
      return [{ task, chase: { on: task.waitingOn, until: task.waitingUntil ?? now } }];
    }
    return isTaskReady(task, byId, phases) ? [{ task }] : [];
  });
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export interface TodayView {
  day: string;
  plan: PlanDay | null;
  /** Planned tasks in plan order, with their reasons. */
  planned: { task: PlanTask; reason: string }[];
  /** Open tasks that could go on today, not in today's plan. */
  others: PlanTask[];
  /** Task id → who to chase, for late waits. */
  chases: Record<string, string>;
  goals: PlanGoal[];
  /** Agents waiting for the owner's yes, with how many tasks each holds. */
  pendingFeeds: { feed: PlanFeed; held: number }[];
  /** Evening review: planned tasks still open after the evening time. */
  reviewDue: boolean;
}

export async function loadToday(now: number = Date.now()): Promise<TodayView> {
  const store = requireStore();
  const settings = await loadPlanSettings();
  const day = planDayKey(now);
  const plan = store.getDay(day);
  const tasks = store.listTasks({ statuses: ['open', 'done', 'held'] });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const planned = (plan?.entries ?? []).flatMap((e) => {
    const t = byId.get(e.taskId);
    return t === undefined || t.status === 'held' ? [] : [{ task: t, reason: e.reason }];
  });
  const plannedIds = new Set(planned.map((p) => p.task.id));
  const candidates = dayCandidates(store, now);
  const chases: Record<string, string> = {};
  for (const c of candidates) if (c.chase !== undefined) chases[c.task.id] = c.chase.on;
  const others = candidates
    .map((c) => c.task)
    .filter((t) => !plannedIds.has(t.id))
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
  const pendingFeeds = store
    .listFeeds()
    .filter((f) => f.state === 'pending')
    .map((feed) => ({
      feed,
      held: tasks.filter(
        (t) => t.status === 'held' && t.origin === feed.agentDid && t.persona === feed.persona,
      ).length,
    }))
    .filter((p) => p.held > 0);
  const reviewDue =
    plan !== null &&
    plan.reviewedAt === null &&
    now >= atTime(now, settings.eveningTime) &&
    planned.some((p) => p.task.status === 'open');
  return {
    day,
    plan,
    planned,
    others,
    chases,
    goals: store.listGoals(true),
    pendingFeeds,
    reviewDue,
  };
}

/** Whether the screen should build today's plan on its own when opened. */
export async function shouldAutoPlan(now: number = Date.now()): Promise<boolean> {
  const store = getPlanStore();
  if (store === null) return false;
  const settings = await loadPlanSettings();
  if (now < atTime(now, settings.planTime)) return false;
  if (store.getDay(planDayKey(now)) !== null) return false;
  return dayCandidates(store, now).length > 0;
}

/** The model, through the shared router (PII scrubbed on the way out). */
function routerAsk(): PlannerAsk | null {
  const router = peekAgenticRouter();
  if (router === null) return null;
  return async ({ systemPrompt, user, responseSchema, maxTokens }) => {
    const res = await router.chat({
      taskType: 'reason',
      persona: 'general',
      systemPrompt,
      messages: [{ role: 'user', content: user }],
      responseSchema,
      maxTokens: maxTokens ?? 2000,
    });
    return res.content;
  };
}

export async function planToday(
  now: number = Date.now(),
  ask: PlannerAsk | null = routerAsk(),
): Promise<DayPlan> {
  const store = requireStore();
  const settings = await loadPlanSettings();
  const candidates = dayCandidates(store, now);
  const plan = await buildDayPlan(
    {
      day: planDayKey(now),
      dayStart: planDayStart(now),
      dayEnd: planDayEnd(now),
      now,
      capacityMin: Math.round(settings.capacityHours * 60),
      goals: store.listGoals(true).map((g) => ({ id: g.id, title: g.title, notes: g.notes })),
      tasks: candidates.map(({ task: t, chase }) => ({
        ...(chase !== undefined ? { chase } : {}),
        id: t.id,
        title: t.title,
        summary: t.summary,
        persona: t.persona,
        project: t.project,
        dueAt: t.dueAt,
        effortMin: t.effortMin,
        carried: t.carried,
        createdAt: t.createdAt,
        goalId: t.goalId,
      })),
    },
    ask,
  );
  store.putDay(planDayKey(now), plan.entries, plan.note, now);
  await rescheduleCheckins(now);
  return plan;
}

export async function setTaskDone(
  id: string,
  done: boolean,
  now: number = Date.now(),
): Promise<void> {
  requireStore().updateTask(id, { status: done ? 'done' : 'open' }, now);
  await rescheduleCheckins(now);
}

export async function dropTask(id: string, now: number = Date.now()): Promise<void> {
  requireStore().updateTask(id, { status: 'dropped' }, now);
  await rescheduleCheckins(now);
}

/** Move an unfinished task to tomorrow; the planner sees how often. */
export async function carryTask(id: string, now: number = Date.now()): Promise<void> {
  const store = requireStore();
  const task = store.getTask(id);
  if (task === null) return;
  store.updateTask(id, { plannedFor: planDayKeyAfter(now, 1), carried: task.carried + 1 }, now);
  await rescheduleCheckins(now);
}

/** Add a task to today's plan by hand. */
export async function addToToday(id: string, now: number = Date.now()): Promise<void> {
  const store = requireStore();
  const day = planDayKey(now);
  const plan = store.getDay(day);
  const entries = plan?.entries ?? [];
  if (entries.some((e) => e.taskId === id)) return;
  store.putDay(day, [...entries, { taskId: id, reason: 'Added by you' }], plan?.note ?? '', now);
  await rescheduleCheckins(now);
}

export async function addTask(title: string, now: number = Date.now()): Promise<PlanTask> {
  const t = title.trim();
  if (t === '') throw new Error('Write the task first.');
  const task = requireStore().addOwnerTask({ title: t.slice(0, 200) }, now);
  await rescheduleCheckins(now);
  return task;
}

/** Finish the evening review: every planned task still open is carried. */
export async function finishReview(now: number = Date.now()): Promise<number> {
  const store = requireStore();
  const day = planDayKey(now);
  const plan = store.getDay(day);
  if (plan === null) return 0;
  let carried = 0;
  for (const e of plan.entries) {
    const t = store.getTask(e.taskId);
    if (t !== null && t.status === 'open' && t.plannedFor === day) {
      store.updateTask(t.id, { plannedFor: planDayKeyAfter(now, 1), carried: t.carried + 1 }, now);
      carried += 1;
    }
  }
  store.markReviewed(day, now);
  await rescheduleCheckins(now);
  return carried;
}

// ---------------------------------------------------------------------------
// Agents and goals
// ---------------------------------------------------------------------------

export async function decideAgentFeed(
  agentDid: string,
  persona: string,
  allow: boolean,
  now: number = Date.now(),
): Promise<void> {
  decideFeed(requireStore(), agentDid, persona, allow, now);
  await rescheduleCheckins(now);
}

export function listAgentFeeds(): PlanFeed[] {
  return getPlanStore()?.listFeeds() ?? [];
}

export function listGoals(): PlanGoal[] {
  return getPlanStore()?.listGoals() ?? [];
}

export function addGoal(title: string, notes = '', now: number = Date.now()): PlanGoal {
  const t = title.trim();
  if (t === '') throw new Error('Write the goal first.');
  return requireStore().addGoal(t.slice(0, 200), notes.trim().slice(0, 500), now);
}

export function setGoalActive(id: string, active: boolean, now: number = Date.now()): void {
  requireStore().updateGoal(id, { active }, now);
}

// ---------------------------------------------------------------------------
// Goal plans (DAILY_PLAN.md §15–§20)
// ---------------------------------------------------------------------------

export interface GoalView {
  goal: PlanGoal;
  phases: { phase: PlanPhase; tasks: PlanTask[] }[];
  /** Tasks tied to the goal but to no phase. */
  loose: PlanTask[];
  /** Task ids that can go on a day now. */
  ready: string[];
  late: LatePhase | null;
  money: MoneySummary;
  costs: PlanCost[];
}

export function loadGoal(id: string, now: number = Date.now()): GoalView | null {
  const store = requireStore();
  const goal = store.getGoal(id);
  if (goal === null) return null;
  const phases = store.listPhases(id);
  const tasks = store.listTasks({ goalId: id, statuses: ['open', 'done'] });
  const ready = new Set(
    dayCandidates(store, now)
      .filter((c) => c.chase === undefined)
      .map((c) => c.task.id),
  );
  const costs = store.listCosts(id);
  return {
    goal,
    phases: phases.map((phase) => ({ phase, tasks: tasks.filter((t) => t.phaseId === phase.id) })),
    loose: tasks.filter((t) => t.phaseId === '' || !phases.some((p) => p.id === t.phaseId)),
    ready: tasks.filter((t) => ready.has(t.id)).map((t) => t.id),
    late: latePhase(phases, now),
    money: moneySummary(goal.budgetCents, costs),
    costs,
  };
}

export interface GoalSummary {
  /** "Framing · phase 3 of 7", or empty. */
  line: string;
  lateDays: number;
  hasDraft: boolean;
}

export function goalSummary(goal: PlanGoal, now: number = Date.now()): GoalSummary {
  const store = getPlanStore();
  if (store === null) return { line: '', lateDays: 0, hasDraft: false };
  const phases = store.listPhases(goal.id);
  const active = phases.filter((p) => p.status === 'active');
  const late = latePhase(phases, now);
  const line =
    active.length > 0
      ? `${active.map((p) => p.title).join(', ')} · phase ${phases.indexOf(active[0]) + 1} of ${phases.length}`
      : phases.length > 0 && phases.every((p) => p.status === 'done')
        ? 'Every phase done'
        : '';
  return { line, lateDays: late?.days ?? 0, hasDraft: goal.draft !== null };
}

/** Ask the model for a draft; false with no model or no usable answer. */
export async function draftPlanForGoal(
  id: string,
  now: number = Date.now(),
  ask: PlannerAsk | null = routerAsk(),
): Promise<boolean> {
  const store = requireStore();
  const goal = store.getGoal(id);
  if (goal === null) return false;
  const draft = await draftGoalPlan(goal, now, ask);
  if (draft === null) return false;
  store.setGoalDraft(id, draft, now);
  return true;
}

export async function acceptGoalDraft(id: string, now: number = Date.now()): Promise<boolean> {
  const ok = requireStore().acceptGoalDraft(id, now) !== null;
  await rescheduleCheckins(now);
  return ok;
}

export function discardGoalDraft(id: string, now: number = Date.now()): void {
  requireStore().setGoalDraft(id, null, now);
}

export function updateGoalDetails(
  id: string,
  patch: { title?: string; targetAt?: number | null; budgetCents?: number | null },
  now: number = Date.now(),
): void {
  requireStore().updateGoal(id, patch, now);
}

export function addGoalPhase(
  goalId: string,
  title: string,
  targetAt: number | null,
  now: number = Date.now(),
): PlanPhase {
  const t = title.trim();
  if (t === '') throw new Error('Write the phase first.');
  return requireStore().addPhase(goalId, t.slice(0, 120), '', targetAt, now);
}

export async function finishGoalPhase(
  phaseId: string,
  now: number = Date.now(),
): Promise<PlanPhase | null> {
  const started = requireStore().finishPhase(phaseId, now);
  await rescheduleCheckins(now);
  return started;
}

export async function startGoalPhase(phaseId: string, now: number = Date.now()): Promise<void> {
  requireStore().startPhase(phaseId, now);
  await rescheduleCheckins(now);
}

export async function addGoalTask(
  goalId: string,
  phaseId: string,
  title: string,
  now: number = Date.now(),
): Promise<PlanTask> {
  const t = title.trim();
  if (t === '') throw new Error('Write the task first.');
  const task = requireStore().addOwnerTask({ title: t.slice(0, 200), goalId, phaseId }, now);
  await rescheduleCheckins(now);
  return task;
}

/** Ask the model for a phase's next tasks and add them. Returns how many. */
export async function suggestTasksForPhase(
  phaseId: string,
  now: number = Date.now(),
  ask: PlannerAsk | null = routerAsk(),
): Promise<number> {
  const store = requireStore();
  const phase = store.getPhase(phaseId);
  const goal = phase === null ? null : store.getGoal(phase.goalId);
  if (phase === null || goal === null) return 0;
  const tasks = store.listTasks({ goalId: goal.id });
  const suggested = await suggestPhaseTasks(
    {
      goal,
      phase,
      done: tasks.filter((t) => t.status === 'done').map((t) => t.title),
      open: tasks.filter((t) => t.status === 'open' && t.phaseId === phase.id).map((t) => t.title),
    },
    now,
    ask,
  );
  const ids: string[] = [];
  for (const s of suggested) {
    const blockedBy = s.after.flatMap((n) => (n < ids.length ? [ids[n]] : []));
    ids.push(
      store.addOwnerTask(
        {
          title: s.title,
          effortMin: s.effortMin,
          goalId: goal.id,
          phaseId,
          blockedBy,
          source: 'plan',
        },
        now,
      ).id,
    );
  }
  await rescheduleCheckins(now);
  return ids.length;
}

/** Wait on someone for a task, for `days` days; an empty name ends the wait. */
export async function setTaskWait(
  taskId: string,
  who: string,
  days: number,
  now: number = Date.now(),
): Promise<void> {
  const name = who.trim().slice(0, 100);
  requireStore().updateTask(
    taskId,
    {
      waitingOn: name,
      waitingUntil: name === '' ? null : planDayEnd(now + Math.max(0, days) * DAY_MS) - 1,
    },
    now,
  );
  await rescheduleCheckins(now);
}

/** Parse "18,400" or "$18,400.50" into cents; null when it isn't an amount. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 ? cents : null;
}

export function recordGoalCost(
  goalId: string,
  label: string,
  amountText: string,
  kind: PlanCostKind,
  taskId = '',
  now: number = Date.now(),
): PlanCost {
  const cents = parseAmount(amountText);
  if (cents === null) throw new Error('Write the amount as a number, for example 18,400.');
  const l = label.trim();
  if (l === '') throw new Error('Say what the money is for.');
  return requireStore().addCost(
    { goalId, label: l.slice(0, 120), kind, amountCents: cents, taskId },
    now,
  );
}

/** Move the late phase, every later open phase and the goal's date by the days it's late. */
export async function moveLateDates(goalId: string, now: number = Date.now()): Promise<number> {
  const store = requireStore();
  const late = latePhase(store.listPhases(goalId), now);
  if (late === null) return 0;
  store.shiftDates(
    goalId,
    late.moves.map((p) => p.id),
    late.days,
    true,
    now,
  );
  await rescheduleCheckins(now);
  return late.days;
}

// ---------------------------------------------------------------------------
// Check-ins (§8)
// ---------------------------------------------------------------------------

export type CheckinKind = 'morning' | 'midday' | 'evening' | 'weekly';

export interface Checkin {
  id: string;
  kind: CheckinKind;
  at: number;
  title: string;
  body: string;
  deepLink: string;
}

const CHECKIN_KINDS: CheckinKind[] = ['morning', 'midday', 'evening', 'weekly'];
/** A goal with no finished task for this long gets a line in the weekly note. */
export const QUIET_GOAL_DAYS = 7;

export function checkinId(kind: CheckinKind): string {
  return `notif-plan-${kind}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The check-ins worth sending from now on, with the text they'd carry. One
 * of each kind at most: the next one due. A check-in with nothing to say is
 * left out.
 */
export function computeCheckins(store: PlanStore, settings: PlanSettings, now: number): Checkin[] {
  if (!settings.checkins) return [];
  const out: Checkin[] = [];
  const today = planDayKey(now);

  // Morning: the next plan time, today's if still ahead, else tomorrow's.
  const morningToday = atTime(now, settings.planTime);
  const morningAt = morningToday > now ? morningToday : atTime(now + DAY_MS, settings.planTime);
  const morningDayEnd = planDayEnd(morningAt);
  const open = dayCandidates(store, morningAt).map((c) => c.task);
  const dueThatDay = open.filter((t) => t.dueAt !== null && t.dueAt < morningDayEnd).length;
  if (open.length > 0) {
    out.push({
      id: checkinId('morning'),
      kind: 'morning',
      at: morningAt,
      title: 'Plan your day',
      body:
        `${plural(open.length, 'open task', 'open tasks')}` +
        (dueThatDay > 0 ? `, ${dueThatDay} due by the end of the day.` : '.'),
      deepLink: 'dina://plan',
    });
  }

  const plan = store.getDay(today);
  if (plan !== null && plan.entries.length > 0) {
    const tasks = plan.entries
      .map((e) => store.getTask(e.taskId))
      .filter((t): t is PlanTask => t !== null && t.status !== 'held' && t.status !== 'dropped');
    const done = tasks.filter((t) => t.status === 'done').length;
    const left = tasks.filter((t) => t.status === 'open');
    const middayAt = atTime(now, settings.middayTime);
    if (middayAt > now && left.length > 0) {
      out.push({
        id: checkinId('midday'),
        kind: 'midday',
        at: middayAt,
        title: `${done} of ${tasks.length} done`,
        body: `Next: ${left[0].title}`,
        deepLink: 'dina://plan',
      });
    }
    const eveningAt = atTime(now, settings.eveningTime);
    if (eveningAt > now && left.length > 0 && plan.reviewedAt === null) {
      out.push({
        id: checkinId('evening'),
        kind: 'evening',
        at: eveningAt,
        title: 'Review your day',
        body: `${plural(left.length, 'task', 'tasks')} still open. Carry them to tomorrow or drop them.`,
        deepLink: 'dina://plan',
      });
    }
  }

  // Weekly: the next weekly day at the evening time.
  const daysAhead = (settings.weeklyDay - new Date(now).getDay() + 7) % 7;
  let weeklyAt = atTime(now + daysAhead * DAY_MS, settings.eveningTime);
  if (weeklyAt <= now) weeklyAt = atTime(now + 7 * DAY_MS, settings.eveningTime);
  const quiet = quietGoals(store, weeklyAt);
  const late = store
    .listGoals(true)
    .map((goal) => ({ goal, late: latePhase(store.listPhases(goal.id), weeklyAt) }))
    .filter((x): x is { goal: PlanGoal; late: LatePhase } => x.late !== null)
    .sort((a, b) => b.late.days - a.late.days);
  if (late.length > 0) {
    const first = late[0];
    const more = late.length - 1 + quiet.length;
    out.push({
      id: checkinId('weekly'),
      kind: 'weekly',
      at: weeklyAt,
      title: 'Your goals this week',
      body:
        `${first.late.phase.title} (${first.goal.title}) is ${plural(first.late.days, 'day', 'days')} late` +
        (more > 0 ? `, and ${plural(more, 'other goal needs', 'other goals need')} a look.` : '.'),
      deepLink: 'dina://goals',
    });
  } else if (quiet.length > 0) {
    const first = quiet[0];
    out.push({
      id: checkinId('weekly'),
      kind: 'weekly',
      at: weeklyAt,
      title: 'Your goals this week',
      body:
        `No time on "${first.goal.title}" for ${first.days} days` +
        (quiet.length > 1
          ? `, and ${plural(quiet.length - 1, 'other goal', 'other goals')}.`
          : '.'),
      deepLink: 'dina://goals',
    });
  }
  return out;
}

/** Active goals with no finished task in `QUIET_GOAL_DAYS`, quietest first. */
export function quietGoals(store: PlanStore, at: number): { goal: PlanGoal; days: number }[] {
  const done = store.listTasks({ statuses: ['done'] });
  return store
    .listGoals(true)
    .map((goal) => {
      const last = done
        .filter((t) => t.goalId === goal.id && t.doneAt !== null)
        .reduce((m, t) => Math.max(m, t.doneAt ?? 0), goal.createdAt);
      return { goal, days: Math.floor((at - last) / DAY_MS) };
    })
    .filter((q) => q.days >= QUIET_GOAL_DAYS)
    .sort((a, b) => b.days - a.days);
}

/**
 * Replace the scheduled check-ins with the ones worth sending now. Quiet
 * hours win: a check-in that would land inside them is not scheduled.
 */
export async function rescheduleCheckins(now: number = Date.now()): Promise<number> {
  const store = getPlanStore();
  if (store === null) return 0;
  const settings = await loadPlanSettings();
  const wanted = computeCheckins(store, settings, now).filter((c) =>
    shouldDeliverNotification(2, new Date(c.at)),
  );
  const keep = new Set(wanted.map((c) => c.id));
  for (const kind of CHECKIN_KINDS) {
    if (!keep.has(checkinId(kind))) {
      try {
        await cancelNotification(checkinId(kind));
      } catch {
        // Nothing scheduled under that id.
      }
    }
  }
  for (const c of wanted) {
    try {
      await scheduleNotification({
        id: c.id,
        title: c.title,
        body: c.body,
        channel: 'solicited',
        triggerAt: c.at,
        data: { deepLink: c.deepLink, kind: 'plan' },
      });
    } catch {
      // Notifications refused: the Today screen still works.
    }
  }
  return wanted.length;
}
