/**
 * What can go on a day, and how a day ends (docs/DAILY_PLAN.md §17, §25).
 * Shared by the phone's screens and the chat tools, so both follow one rule.
 */

import { planDayKey, planDayKeyAfter, planDayStart } from './day';
import { isTaskReady, needsChase } from './goal_rules';

import type { PlanDay, PlanPhase, PlanStore, PlanTask } from './store';

export interface DayCandidate {
  task: PlanTask;
  /** Set when the task is a late wait to chase. */
  chase?: { on: string; until: number };
}

/**
 * Open tasks that can go on the day holding `now`: ready ones, and late
 * waits. Tasks of an archived goal stay out until it's restored, and so do a
 * routine's turn from another day and a task put off to a later day.
 */
export function dayCandidates(store: PlanStore, now: number): DayCandidate[] {
  const all = store.listTasks({ statuses: ['open', 'done', 'dropped'] });
  const byId = new Map(all.map((t) => [t.id, t]));
  const goals = store.listGoals();
  const archived = new Set(goals.filter((g) => !g.active).map((g) => g.id));
  const phases = new Map<string, PlanPhase>();
  for (const g of goals) for (const p of store.listPhases(g.id)) phases.set(p.id, p);
  const day = planDayKey(now);
  const dayStart = planDayStart(now);
  return all.flatMap((task): DayCandidate[] => {
    if (task.status !== 'open' || archived.has(task.goalId)) return [];
    if (task.routineId !== '' && task.routineDay !== day) return [];
    if (task.plannedFor > day) return [];
    // A late wait stops the waiting, not the plan's order: it still needs its
    // phase active and what it comes after finished.
    if (needsChase(task, dayStart) && isTaskReady({ ...task, waitingOn: '' }, byId, phases)) {
      return [{ task, chase: { on: task.waitingOn, until: task.waitingUntil ?? now } }];
    }
    return isTaskReady(task, byId, phases) ? [{ task }] : [];
  });
}

/** A day's plan counts as made only with something on it. */
export function dayPlanMade(store: PlanStore, day: string): PlanDay | null {
  const plan = store.getDay(day);
  return plan !== null && plan.entries.length > 0 ? plan : null;
}

export interface PlannedTask {
  task: PlanTask;
  reason: string;
}

/**
 * Today's plan as it stands now. Finished tasks stay, for the count. An open
 * task stays only while it can still go on the day: the plan was made earlier,
 * and since then its goal may be archived, or it may be waiting on someone,
 * put off, or moved to a later phase. Every reader of the plan goes through
 * this, so screens, chat and check-ins agree.
 */
export function planOnDay(store: PlanStore, now: number): PlannedTask[] {
  const plan = store.getDay(planDayKey(now));
  if (plan === null) return [];
  const eligible = new Set(dayCandidates(store, now).map((c) => c.task.id));
  const archived = new Set(
    store
      .listGoals()
      .filter((g) => !g.active)
      .map((g) => g.id),
  );
  return plan.entries.flatMap((e): PlannedTask[] => {
    const task = store.getTask(e.taskId);
    if (task === null) return [];
    const keep = task.status === 'done' ? !archived.has(task.goalId) : eligible.has(task.id);
    return keep ? [{ task, reason: e.reason }] : [];
  });
}

/**
 * Put a task off to tomorrow; the planner sees how often. Doing it twice in a
 * day counts once. A routine's turn
 * can't move, since its next turn comes by itself, so it is skipped instead.
 * Returns what happened, or null when the task can't be put off.
 */
export function putOffTask(
  store: PlanStore,
  id: string,
  now: number,
): 'carried' | 'skipped' | null {
  const task = store.getTask(id);
  if (task === null || task.status !== 'open') return null;
  if (task.routineId !== '') {
    store.updateTask(id, { status: 'dropped' }, now);
    return 'skipped';
  }
  const tomorrow = planDayKeyAfter(now, 1);
  if (task.plannedFor < tomorrow) {
    store.updateTask(id, { plannedFor: tomorrow, carried: task.carried + 1 }, now);
  }
  return 'carried';
}

export interface DayEnd {
  carried: string[];
  skipped: string[];
  done: number;
}

/** End the day: every planned task still open is put off, and the day is reviewed. */
export function finishDay(store: PlanStore, now: number): DayEnd | null {
  const day = planDayKey(now);
  if (dayPlanMade(store, day) === null) return null;
  const out: DayEnd = { carried: [], skipped: [], done: 0 };
  for (const { task: t } of planOnDay(store, now)) {
    if (t.status === 'done') out.done += 1;
    if (t.status !== 'open') continue;
    const r = putOffTask(store, t.id, now);
    if (r === 'carried') out.carried.push(t.title);
    if (r === 'skipped') out.skipped.push(t.title);
  }
  store.markReviewed(day, now);
  return out;
}
