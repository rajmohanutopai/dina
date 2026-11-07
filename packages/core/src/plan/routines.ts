/**
 * Things that repeat (docs/DAILY_PLAN.md §24): "every weekday", "three times
 * a week", "on the 1st". Plain rules, no model. A routine's turn becomes an
 * ordinary task on its day, so the plan, check-ins and chat treat it like any
 * other task. A turn not done by the end of its day lapses: turns never pile
 * up.
 */

import { planDayEnd, planDayKey, planDayStart } from './day';

import type { PlanRoutine, PlanStore, PlanTask } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local day `days` after the one holding `ms`, safe across clock changes. */
function dayAfter(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** How many whole local days lie between two day starts. */
function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((planDayStart(toMs) - planDayStart(fromMs)) / DAY_MS);
}

/** Monday of the week holding `ms`. Weeks run Monday to Sunday. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  return dayAfter(ms, -((d.getDay() + 6) % 7));
}

function parseDayKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export interface RoutineTurn {
  /** A turn falls on this day. */
  due: boolean;
  /** The day can't be skipped without missing the routine's target. */
  pressing: boolean;
}

const NO_TURN: RoutineTurn = { due: false, pressing: false };

/**
 * Whether a routine has a turn on the day holding `at`. `doneDays` holds the
 * day keys of its finished turns.
 *
 * `per_week` spreads its turns out: it waits about 7 ÷ n days after a finished
 * turn, unless the days left in the week only just fit what's still to do.
 */
export function routineTurnOn(
  routine: PlanRoutine,
  doneDays: readonly string[],
  at: number,
): RoutineTurn {
  if (!routine.active) return NO_TURN;
  const date = new Date(at);
  if (routine.kind === 'days') {
    return routine.weekdays.includes(date.getDay()) ? { due: true, pressing: true } : NO_TURN;
  }
  if (routine.kind === 'monthly') {
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return date.getDate() === Math.min(routine.dayOfMonth, last)
      ? { due: true, pressing: true }
      : NO_TURN;
  }
  const times = routine.timesPerWeek;
  if (times <= 0) return NO_TURN;
  const start = weekStart(at);
  const end = dayAfter(start, 7);
  const today = planDayKey(at);
  const done = doneDays.map(parseDayKey);
  const doneThisWeek = done.filter((d) => d >= start && d < end).length;
  const left = times - doneThisWeek;
  if (left <= 0) return NO_TURN;
  if (doneDays.includes(today)) return NO_TURN;
  const daysLeft = daysBetween(at, end);
  if (left >= daysLeft) return { due: true, pressing: true };
  const before = done.filter((d) => d < planDayStart(at));
  if (before.length > 0) {
    const since = daysBetween(Math.max(...before), at);
    if (since < Math.floor(7 / times)) return NO_TURN;
  }
  return { due: true, pressing: false };
}

function doneDaysOf(turns: readonly PlanTask[]): string[] {
  return turns.filter((t) => t.status === 'done').map((t) => t.routineDay);
}

function routineGoalActive(store: PlanStore, routine: PlanRoutine): boolean {
  if (routine.goalId === '') return true;
  return store.getGoal(routine.goalId)?.active === true;
}

/**
 * Bring the routines up to date for the day holding `now`: lapse old turns
 * and make today's. Safe to call often. Returns how many turns it made.
 */
export function ensureRoutineTasks(store: PlanStore, now: number): number {
  const today = planDayKey(now);
  const routines = store.listRoutines();
  let made = 0;
  for (const routine of routines) {
    const turns = store.listRoutineTasks(routine.id);
    for (const t of turns) {
      if (t.status === 'open' && t.routineDay < today) {
        store.updateTask(t.id, { status: 'dropped' }, now);
      }
    }
    if (!routine.active || !routineGoalActive(store, routine)) continue;
    if (turns.some((t) => t.routineDay === today)) continue;
    const turn = routineTurnOn(routine, doneDaysOf(turns), now);
    if (!turn.due) continue;
    store.addOwnerTask(
      {
        title: routine.title,
        persona: routine.persona,
        effortMin: routine.effortMin,
        goalId: routine.goalId,
        source: 'routine',
        routineId: routine.id,
        routineDay: today,
        dueAt: turn.pressing ? planDayEnd(now) - 1 : null,
      },
      now,
    );
    made += 1;
  }
  return made;
}

/** Turns expected on the day holding `at` that aren't tasks yet, and how many of them can't be skipped. */
export function routineTurnsAhead(
  store: PlanStore,
  at: number,
): { count: number; pressing: number } {
  const day = planDayKey(at);
  const out = { count: 0, pressing: 0 };
  for (const routine of store.listRoutines(true)) {
    if (!routineGoalActive(store, routine)) continue;
    const turns = store.listRoutineTasks(routine.id);
    if (turns.some((t) => t.routineDay === day)) continue;
    const turn = routineTurnOn(routine, doneDaysOf(turns), at);
    if (turn.due) out.count += 1;
    if (turn.pressing) out.pressing += 1;
  }
  return out;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "Every day", "Mon, Wed, Fri", "3 times a week", "On the 1st of each month". */
export function routineRuleLabel(routine: PlanRoutine): string {
  if (routine.kind === 'monthly') return `On the ${ordinal(routine.dayOfMonth)} of each month`;
  if (routine.kind === 'per_week') {
    return routine.timesPerWeek === 1 ? 'Once a week' : `${routine.timesPerWeek} times a week`;
  }
  const days = [...routine.weekdays].sort((a, b) => a - b);
  if (days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  // Monday first, as the week runs.
  return [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)]
    .map((d) => WEEKDAY_NAMES[d])
    .join(', ');
}

export interface RoutineProgress {
  done: number;
  /** Turns wanted in the period. */
  target: number;
  period: 'week' | 'month';
  /** "2 of 3 this week". */
  line: string;
}

/** How a routine stands this week, or this month for a monthly one. */
export function routineProgress(
  store: PlanStore,
  routine: PlanRoutine,
  now: number,
): RoutineProgress {
  const done = doneDaysOf(store.listRoutineTasks(routine.id)).map(parseDayKey);
  if (routine.kind === 'monthly') {
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const n = done.filter((x) => x >= start && x < end).length;
    return {
      done: n,
      target: 1,
      period: 'month',
      line: n > 0 ? 'Done this month' : 'Not done this month',
    };
  }
  const start = weekStart(now);
  const end = dayAfter(start, 7);
  const n = done.filter((x) => x >= start && x < end).length;
  const target = routine.kind === 'per_week' ? routine.timesPerWeek : routine.weekdays.length;
  return { done: n, target, period: 'week', line: `${n} of ${target} this week` };
}

/**
 * Check a routine's rule. Returns an error in plain words, or null when it's
 * usable: at least one weekday, 1–7 times a week, or a day of the month.
 */
export function routineRuleError(input: {
  kind: PlanRoutine['kind'];
  weekdays?: number[];
  timesPerWeek?: number;
  dayOfMonth?: number;
}): string | null {
  if (input.kind === 'days') {
    const days = input.weekdays ?? [];
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return 'Pick at least one day of the week.';
    }
    return null;
  }
  if (input.kind === 'per_week') {
    const n = input.timesPerWeek ?? 0;
    return Number.isInteger(n) && n >= 1 && n <= 7 ? null : 'Pick 1 to 7 times a week.';
  }
  const m = input.dayOfMonth ?? 0;
  return Number.isInteger(m) && m >= 1 && m <= 31 ? null : 'Pick a day of the month, 1 to 31.';
}
