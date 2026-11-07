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
import { setDND, shouldDeliverNotification } from '@dina/brain/notifications';
import {
  dayCandidates,
  dayPlanMade,
  decideFeed,
  ensureRoutineTasks,
  finishDay,
  getPlanStore,
  latePhase,
  notifyPlanChanged,
  moneySummary,
  putOffTask,
  routineProgress,
  routineRuleError,
  routineRuleLabel,
  routineTurnsAhead,
  type LatePhase,
  type MoneySummary,
  type PlanCost,
  type PlanCostKind,
  type PlanPhase,
  planDayEnd,
  planDayKey,
  planDayStart,
  planOnDay,
  shiftCalendarDays,
  type PlanDay,
  type PlanFeed,
  type PlanGoal,
  type PlanRoutine,
  type PlanStore,
  type PlanTask,
  type RoutineInput,
} from '@dina/core';
import { kvGet, kvSet } from '@dina/core/kv';

import { peekAgenticRouter } from '../ai/agentic_swap';
import {
  PLAN_CHECKIN_ID_PREFIX,
  cancelNotification,
  scheduleNotification,
} from '../notifications/local';

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
  /** Quiet hours, `HH:MM`, local: no check-in lands inside them. */
  quietStart: string;
  quietEnd: string;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = Object.freeze({
  planTime: '08:00',
  middayTime: '13:00',
  eveningTime: '18:00',
  weeklyDay: 0,
  capacityHours: 6,
  checkins: true,
  quietStart: '22:00',
  quietEnd: '07:00',
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
    quietStart: time(s.quietStart, DEFAULT_PLAN_SETTINGS.quietStart),
    quietEnd: time(s.quietEnd, DEFAULT_PLAN_SETTINGS.quietEnd),
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
  setDND({ quietHoursStart: merged.quietStart, quietHoursEnd: merged.quietEnd });
  await rescheduleCheckins();
  return merged;
}

/** Put the owner's saved quiet hours in force. Quiet hours live in memory, so boot needs this. */
export async function applySavedQuietHours(): Promise<void> {
  const s = await loadPlanSettings();
  setDND({ quietHoursStart: s.quietStart, quietHoursEnd: s.quietEnd });
}

/** The check-in times that fall inside quiet hours, so they will not be sent. */
export function checkinsInQuietHours(settings: PlanSettings, now: number = Date.now()): string[] {
  const times: [string, string][] = [
    ['Morning plan', settings.planTime],
    ['Midday check', settings.middayTime],
    ['Evening review', settings.eveningTime],
  ];
  return times
    .filter(([, hhmm]) => !shouldDeliverNotification(2, new Date(atTime(now, hhmm))))
    .map(([label]) => label);
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

/** The local day `days` after the one holding `ms`, at `HH:MM`. */
function atTimeOn(ms: number, days: number, hhmm: string): number {
  const d = new Date(ms);
  return atTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12).getTime(), hhmm);
}

export { dayCandidates, type DayCandidate } from '@dina/core';

/**
 * A form's fields after the saved values change under it (a date moved, a
 * screen reloaded): a field the owner hasn't touched takes the new value, and
 * one being edited keeps what they've typed.
 */
export function mergeFormFields<T extends Record<string, string>>(
  current: T,
  saved: T,
  next: T,
): T {
  const out = { ...next };
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (current[k] !== saved[k]) out[k] = current[k];
  }
  return out;
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
  ensureRoutineTasks(store, now);
  const settings = await loadPlanSettings();
  const day = planDayKey(now);
  const plan = dayPlanMade(store, day);
  const tasks = store.listTasks({ statuses: ['held'] });
  const planned = planOnDay(store, now);
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
  ensureRoutineTasks(store, now);
  const settings = await loadPlanSettings();
  if (now < atTime(now, settings.planTime)) return false;
  if (dayPlanMade(store, planDayKey(now)) !== null) return false;
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

let planning: Promise<DayPlan> | null = null;

/**
 * Build and save today's plan. One at a time: a timer, a tap and chat can all
 * ask at once, and each would pay for a model call and overwrite the others.
 */
export function planToday(
  now: number = Date.now(),
  ask: PlannerAsk | null = routerAsk(),
): Promise<DayPlan> {
  if (planning !== null) return planning;
  planning = makeDayPlan(now, ask).finally(() => {
    planning = null;
  });
  return planning;
}

async function makeDayPlan(now: number, ask: PlannerAsk | null): Promise<DayPlan> {
  const store = requireStore();
  ensureRoutineTasks(store, now);
  const settings = await loadPlanSettings();
  const candidates = dayCandidates(store, now);
  const routineRule = (t: PlanTask): { rule: string; pressing: boolean } | null => {
    const r = t.routineId === '' ? null : store.getRoutine(t.routineId);
    return r === null ? null : { rule: routineRuleLabel(r), pressing: t.dueAt !== null };
  };
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
        ...(routineRule(t) !== null ? { routine: routineRule(t) ?? undefined } : {}),
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
  // What's already done today stays on the plan, so the count stays true.
  const day = planDayKey(now);
  const earlier = store.getDay(day);
  const done = planOnDay(store, now)
    .filter((p) => p.task.status === 'done')
    .map((p) => ({
      taskId: p.task.id,
      reason: p.reason,
      ...(p.task.goalId !== '' ? { goalId: p.task.goalId } : {}),
    }));
  // The owner can tick a task while the model thinks: it's on the plan once.
  const doneIds = new Set(done.map((e) => e.taskId));
  const entries = [...done, ...plan.entries.filter((e) => !doneIds.has(e.taskId))];
  // An empty day isn't a plan: auto-planning and the check-ins stay on.
  if (entries.length > 0 || earlier !== null) store.putDay(day, entries, plan.note, now);
  await rescheduleCheckins(now);
  return plan;
}

export async function setTaskDone(
  id: string,
  done: boolean,
  now: number = Date.now(),
): Promise<void> {
  const store = requireStore();
  const task = store.getTask(id);
  // A screen left open overnight can still offer yesterday's turn.
  if (task !== null && task.routineId !== '' && task.routineDay !== planDayKey(now)) {
    throw new Error('That turn has passed. Today’s is on your plan if one is due.');
  }
  store.updateTask(id, { status: done ? 'done' : 'open' }, now);
  await rescheduleCheckins(now);
}

export async function dropTask(id: string, now: number = Date.now()): Promise<void> {
  requireStore().updateTask(id, { status: 'dropped' }, now);
  await rescheduleCheckins(now);
}

/** Move an unfinished task to tomorrow; a routine's turn is skipped instead. */
export async function carryTask(id: string, now: number = Date.now()): Promise<void> {
  putOffTask(requireStore(), id, now);
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
  const end = finishDay(requireStore(), now);
  await rescheduleCheckins(now);
  return end === null ? 0 : end.carried.length + end.skipped.length;
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
  const goal = requireStore().addGoal(t.slice(0, 200), notes.trim().slice(0, 500), now);
  notifyPlanChanged();
  return goal;
}

export async function setGoalActive(
  id: string,
  active: boolean,
  now: number = Date.now(),
): Promise<void> {
  requireStore().updateGoal(id, { active }, now);
  await rescheduleCheckins(now);
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
  routines: RoutineView[];
}

export interface RoutineView {
  routine: PlanRoutine;
  /** "3 times a week". */
  rule: string;
  /** "2 of 3 this week". */
  progress: string;
  /** Today's turn, when there is one. */
  today: PlanTask | null;
}

/** Routines with how they stand, for one goal or ('' ) those on no goal. */
export function loadRoutines(goalId: string, now: number = Date.now()): RoutineView[] {
  const store = getPlanStore();
  if (store === null) return [];
  ensureRoutineTasks(store, now);
  const day = planDayKey(now);
  return store
    .listRoutines(true)
    .filter((r) => r.goalId === goalId)
    .map((routine) => ({
      routine,
      rule: routineRuleLabel(routine),
      progress: routineProgress(store, routine, now).line,
      today:
        store
          .listRoutineTasks(routine.id)
          .find((t) => t.routineDay === day && t.status !== 'dropped') ?? null,
    }));
}

export async function addRoutine(
  input: RoutineInput,
  now: number = Date.now(),
): Promise<PlanRoutine> {
  const title = input.title.trim();
  if (title === '') throw new Error('Write what repeats first.');
  const error = routineRuleError(input);
  if (error !== null) throw new Error(error);
  const store = requireStore();
  const routine = store.addRoutine({ ...input, title: title.slice(0, 200) }, now);
  ensureRoutineTasks(store, now);
  await rescheduleCheckins(now);
  return routine;
}

export async function stopRoutine(id: string, now: number = Date.now()): Promise<void> {
  requireStore().stopRoutine(id, now);
  await rescheduleCheckins(now);
}

export function loadGoal(id: string, now: number = Date.now()): GoalView | null {
  const store = requireStore();
  const goal = store.getGoal(id);
  if (goal === null) return null;
  const routines = loadRoutines(id, now);
  const phases = store.listPhases(id);
  const tasks = store
    .listTasks({ goalId: id, statuses: ['open', 'done'] })
    .filter((t) => t.routineId === '');
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
    routines,
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
  patch: { title?: string; notes?: string; targetAt?: number | null; budgetCents?: number | null },
  now: number = Date.now(),
): void {
  const title = patch.title?.trim();
  if (title === '') throw new Error('Write the goal first.');
  requireStore().updateGoal(
    id,
    {
      ...patch,
      ...(title !== undefined ? { title: title.slice(0, 200) } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes.trim().slice(0, 500) } : {}),
    },
    now,
  );
  // The weekly note names the goal and counts from its dates.
  notifyPlanChanged();
}

export function addGoalPhase(
  goalId: string,
  title: string,
  targetAt: number | null,
  now: number = Date.now(),
): PlanPhase {
  const t = title.trim();
  if (t === '') throw new Error('Write the phase first.');
  const phase = requireStore().addPhase(goalId, t.slice(0, 120), '', targetAt, now);
  notifyPlanChanged();
  return phase;
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

// Changing a live plan (§27).

export async function updatePhaseDetails(
  phaseId: string,
  patch: { title?: string; targetAt?: number | null },
  now: number = Date.now(),
): Promise<void> {
  const title = patch.title?.trim();
  if (title === '') throw new Error('Write the phase first.');
  requireStore().updatePhase(
    phaseId,
    {
      ...(title !== undefined ? { title: title.slice(0, 120) } : {}),
      ...(patch.targetAt !== undefined ? { targetAt: patch.targetAt } : {}),
    },
    now,
  );
  await rescheduleCheckins(now);
}

export async function moveGoalPhase(
  phaseId: string,
  direction: 'up' | 'down',
  now: number = Date.now(),
): Promise<void> {
  requireStore().movePhase(phaseId, direction, now);
  await rescheduleCheckins(now);
}

export async function deleteGoalPhase(phaseId: string, now: number = Date.now()): Promise<void> {
  requireStore().deletePhase(phaseId, now);
  await rescheduleCheckins(now);
}

export async function reopenGoalPhase(phaseId: string, now: number = Date.now()): Promise<void> {
  requireStore().reopenPhase(phaseId, now);
  await rescheduleCheckins(now);
}

export async function renameTask(
  taskId: string,
  title: string,
  now: number = Date.now(),
): Promise<void> {
  const t = title.trim();
  if (t === '') throw new Error('Write the task first.');
  requireStore().updateTask(taskId, { title: t.slice(0, 200) }, now);
  await rescheduleCheckins(now);
}

export async function moveTaskToPhase(
  taskId: string,
  phaseId: string,
  now: number = Date.now(),
): Promise<void> {
  requireStore().updateTask(taskId, { phaseId }, now);
  await rescheduleCheckins(now);
}

/** Set which tasks must finish before this one. Refuses a circle. */
export async function setTaskOrder(
  taskId: string,
  blockedBy: string[],
  now: number = Date.now(),
): Promise<void> {
  if (!requireStore().setTaskBlockedBy(taskId, blockedBy, now)) {
    throw new Error('Those tasks would end up waiting on each other. Pick a different one.');
  }
  await rescheduleCheckins(now);
}

export function removeGoalCost(id: string): void {
  requireStore().deleteCost(id);
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
      // A routine's turns would crowd out the project's own finished work.
      done: tasks.filter((t) => t.status === 'done' && t.routineId === '').map((t) => t.title),
      open: tasks.filter((t) => t.status === 'open' && t.phaseId === phase.id).map((t) => t.title),
    },
    now,
    ask,
  );
  // The owner can finish or delete the phase while the model answers.
  const still = store.getPhase(phaseId);
  if (still === null || still.status === 'done') return 0;
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
      waitingUntil: name === '' ? null : planDayEnd(shiftCalendarDays(now, Math.max(0, days))) - 1,
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
  quoteId = '',
): PlanCost {
  const cents = parseAmount(amountText);
  if (cents === null) throw new Error('Write the amount as a number, for example 18,400.');
  const store = requireStore();
  const quote = quoteId === '' ? null : store.getCost(quoteId);
  const l = label.trim() || (quote?.label ?? '');
  if (l === '') throw new Error('Say what the money is for.');
  return store.addCost(
    {
      goalId,
      label: l.slice(0, 120),
      kind,
      amountCents: cents,
      taskId: taskId || quote?.taskId || '',
      phaseId: quote?.phaseId ?? '',
      ...(kind === 'paid' && quoteId !== '' ? { quoteId } : {}),
    },
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

/** A goal with no finished task for this long gets a line in the weekly note. */
export const QUIET_GOAL_DAYS = 7;
/**
 * Morning check-ins sent while the app stays closed, as days after the next
 * one (§25). They thin out, then stop, until the owner opens the app.
 */
export const MORNING_FADE_DAYS = [0, 1, 2, 4, 7, 12];
/** Weekly notes sent while the app stays closed. */
export const WEEKLY_AHEAD = 2;

/** The id of the `turn`th check-in of a kind scheduled ahead. */
export function checkinId(kind: CheckinKind, turn = 0): string {
  return turn === 0
    ? `${PLAN_CHECKIN_ID_PREFIX}${kind}`
    : `${PLAN_CHECKIN_ID_PREFIX}${kind}-${turn}`;
}

function allCheckinIds(): string[] {
  return [
    ...MORNING_FADE_DAYS.map((_, i) => checkinId('morning', i)),
    checkinId('midday'),
    checkinId('evening'),
    ...Array.from({ length: WEEKLY_AHEAD }, (_, i) => checkinId('weekly', i)),
  ];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What will be open on the day holding `at`, as far as is known now. */
function openOn(store: PlanStore, at: number): { count: number; due: number } {
  const tasks = dayCandidates(store, at).map((c) => c.task);
  const dayEnd = planDayEnd(at);
  const ahead = routineTurnsAhead(store, at);
  return {
    count: tasks.length + ahead.count,
    due: tasks.filter((t) => t.dueAt !== null && t.dueAt < dayEnd).length + ahead.pressing,
  };
}

function weeklyNote(store: PlanStore, at: number): { body: string } | null {
  const quiet = quietGoals(store, at);
  const late = store
    .listGoals(true)
    .map((goal) => ({ goal, late: latePhase(store.listPhases(goal.id), at) }))
    .filter((x): x is { goal: PlanGoal; late: LatePhase } => x.late !== null)
    .sort((a, b) => b.late.days - a.late.days);
  if (late.length > 0) {
    const first = late[0];
    const lateIds = new Set(late.map((x) => x.goal.id));
    const more = late.length - 1 + quiet.filter((q) => !lateIds.has(q.goal.id)).length;
    return {
      body:
        `${first.late.phase.title} (${first.goal.title}) is ${plural(first.late.days, 'day', 'days')} late` +
        (more > 0 ? `, and ${plural(more, 'other goal needs', 'other goals need')} a look.` : '.'),
    };
  }
  if (quiet.length > 0) {
    const first = quiet[0];
    return {
      body:
        `No time on "${first.goal.title}" for ${first.days} days` +
        (quiet.length > 1
          ? `, and ${plural(quiet.length - 1, 'other goal', 'other goals')}.`
          : '.'),
    };
  }
  return null;
}

/**
 * The check-ins worth sending from now on, with the text they'd carry. The
 * phone runs nothing in the background, so each is written now. A later
 * morning's text counts what's known today, and every open of the app
 * rewrites them. One with nothing to say is left out.
 */
export function computeCheckins(store: PlanStore, settings: PlanSettings, now: number): Checkin[] {
  if (!settings.checkins) return [];
  const out: Checkin[] = [];
  const today = planDayKey(now);
  const plan = dayPlanMade(store, today);

  // Mornings: the next plan time, then thinning out while the app stays closed.
  const base = atTime(now, settings.planTime) > now ? 0 : 1;
  MORNING_FADE_DAYS.forEach((offset, turn) => {
    const at = atTimeOn(now, base + offset, settings.planTime);
    if (planDayKey(at) === today && plan !== null) return;
    const { count, due } = openOn(store, at);
    if (count === 0) return;
    const last = turn === MORNING_FADE_DAYS.length - 1;
    out.push({
      id: checkinId('morning', turn),
      kind: 'morning',
      at,
      title: 'Plan your day',
      body:
        `${plural(count, 'open task', 'open tasks')}` +
        (due > 0 ? `, ${due} due by the end of the day.` : '.') +
        (last ? ' Dina will stop asking until you open the app.' : ''),
      deepLink: 'dina://plan',
    });
  });

  const middayAt = atTime(now, settings.middayTime);
  if (plan === null) {
    const { count } = openOn(store, middayAt);
    if (middayAt > now && count > 0) {
      out.push({
        id: checkinId('midday'),
        kind: 'midday',
        at: middayAt,
        title: 'No plan yet today',
        body: `${plural(count, 'open task', 'open tasks')}. Open Dina to plan the rest of the day.`,
        deepLink: 'dina://plan',
      });
    }
  } else {
    const tasks = planOnDay(store, now).map((p) => p.task);
    const done = tasks.filter((t) => t.status === 'done').length;
    const left = tasks.filter((t) => t.status === 'open');
    if (middayAt > now && left.length > 0 && plan.reviewedAt === null) {
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

  // Weekly: the next weekly days at the evening time.
  const daysAhead = (settings.weeklyDay - new Date(now).getDay() + 7) % 7;
  const first = atTimeOn(now, daysAhead, settings.eveningTime) > now ? daysAhead : daysAhead + 7;
  for (let turn = 0; turn < WEEKLY_AHEAD; turn += 1) {
    const at = atTimeOn(now, first + turn * 7, settings.eveningTime);
    const note = weeklyNote(store, at);
    if (note === null) continue;
    out.push({
      id: checkinId('weekly', turn),
      kind: 'weekly',
      at,
      title: 'Your goals this week',
      body: note.body,
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
let rescheduleQueue: Promise<unknown> = Promise.resolve();

/**
 * Replace the scheduled check-ins with the ones worth sending now, one run at a
 * time: two runs side by side could bring back a check-in the later one cancelled.
 */
export function rescheduleCheckins(now: number = Date.now()): Promise<number> {
  const run = rescheduleQueue.catch(() => undefined).then(() => rescheduleCheckinsNow(now));
  rescheduleQueue = run;
  return run;
}

async function rescheduleCheckinsNow(now: number): Promise<number> {
  const store = getPlanStore();
  if (store === null) return 0;
  ensureRoutineTasks(store, now);
  const settings = await loadPlanSettings();
  const wanted = computeCheckins(store, settings, now).filter((c) =>
    shouldDeliverNotification(2, new Date(c.at)),
  );
  const keep = new Set(wanted.map((c) => c.id));
  for (const id of allCheckinIds()) {
    if (!keep.has(id)) {
      try {
        await cancelNotification(id);
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

/** Today's plan as chat asks for it (`plan_day`). */
export async function planTodayForChat(): Promise<{ count: number; note: string }> {
  const plan = await planToday();
  return { count: plan.entries.length, note: plan.note };
}
