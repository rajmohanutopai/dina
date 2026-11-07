/**
 * Goal-plan rules (docs/DAILY_PLAN.md §17). Plain code, no model: which
 * tasks can go on a day, which waits need chasing, which phase is late,
 * and where the money stands.
 */

import type { GoalDraft, GoalDraftPhase, PlanCost, PlanPhase, PlanTask } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Limits on a drafted plan (§18). */
export const MAX_DRAFT_PHASES = 12;
export const MAX_DRAFT_TASKS_PER_PHASE = 8;

/**
 * True when the task can go on a day: open, waiting on no one, nothing it
 * waits for still open, and its phase (if any) active.
 */
export function isTaskReady(
  task: PlanTask,
  tasksById: ReadonlyMap<string, PlanTask>,
  phasesById: ReadonlyMap<string, PlanPhase>,
): boolean {
  if (task.status !== 'open' || task.waitingOn !== '') return false;
  for (const id of task.blockedBy) {
    const b = tasksById.get(id);
    if (b !== undefined && b.status !== 'done' && b.status !== 'dropped') return false;
  }
  if (task.phaseId !== '') {
    const phase = phasesById.get(task.phaseId);
    if (phase !== undefined && phase.status !== 'active') return false;
  }
  return true;
}

/** A waiting task whose date falls before `dayEnd` needs chasing. */
export function needsChase(task: PlanTask, dayEnd: number): boolean {
  return (
    task.status === 'open' &&
    task.waitingOn !== '' &&
    task.waitingUntil !== null &&
    task.waitingUntil < dayEnd
  );
}

/** Days a phase is past its target, rounded up (so moving it that many days
 * clears it), or 0. */
export function daysLate(phase: PlanPhase, now: number): number {
  if (phase.status === 'done' || phase.targetAt === null || phase.targetAt >= now) return 0;
  return Math.ceil((now - phase.targetAt) / DAY_MS);
}

export interface LatePhase {
  phase: PlanPhase;
  days: number;
  /** Phases whose dates move with it: this one and every later one not done. */
  moves: PlanPhase[];
}

/** The latest-running phase of a goal, or null when nothing is late. */
export function latePhase(phases: readonly PlanPhase[], now: number): LatePhase | null {
  const ordered = [...phases].sort((a, b) => a.position - b.position);
  let worst: { phase: PlanPhase; days: number } | null = null;
  for (const p of ordered) {
    const d = daysLate(p, now);
    if (d > 0 && (worst === null || d > worst.days)) worst = { phase: p, days: d };
  }
  if (worst === null) return null;
  const from = worst.phase.position;
  const moves = ordered.filter((p) => p.status !== 'done' && p.position >= from);
  return { phase: worst.phase, days: worst.days, moves };
}

export interface MoneySummary {
  budgetCents: number | null;
  paidCents: number;
  openQuoteCents: number;
  /** Budget − paid − open quotes; null with no budget. */
  leftCents: number | null;
}

export function moneySummary(budgetCents: number | null, costs: readonly PlanCost[]): MoneySummary {
  const paid = costs.filter((c) => c.kind === 'paid').reduce((s, c) => s + c.amountCents, 0);
  const quoted = costs
    .filter((c) => c.kind === 'quote' && !c.settled)
    .reduce((s, c) => s + c.amountCents, 0);
  return {
    budgetCents,
    paidCents: paid,
    openQuoteCents: quoted,
    leftCents: budgetCents === null ? null : budgetCents - paid - quoted,
  };
}

/** `$18,400` / `$18,400.50`, in the goal's currency. */
export function formatGoalMoney(cents: number, currency = 'USD'): string {
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

function clip(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Check a drafted plan from a model or the chat model. Keeps at most
 * `MAX_DRAFT_PHASES` phases and `MAX_DRAFT_TASKS_PER_PHASE` tasks each,
 * drops empty titles, keeps target dates between `now` and the goal's
 * target (when it has one) and in order, and keeps only `after` indices
 * that point at earlier tasks in the same phase. Null when nothing usable
 * is left.
 *
 * Accepts `{phases: [{title, notes, target|target_at|targetAt, tasks:
 * [{title, effort_min|effortMin, after}]}]}`, and the names a model tends to
 * use instead when the provider doesn't enforce the schema (OpenRouter):
 * `name`, `note`, `target_date`, `date`, `text`, `effort_minutes`.
 */
export function cleanGoalDraft(
  raw: unknown,
  now: number,
  goalTargetAt: number | null,
  by: GoalDraft['by'],
): GoalDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const list = (raw as Record<string, unknown>).phases;
  if (!Array.isArray(list)) return null;
  const phases: GoalDraftPhase[] = [];
  let lastTarget = now;
  for (const p of list) {
    if (phases.length >= MAX_DRAFT_PHASES) break;
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    const title = clip(o.title ?? o.name, 120);
    if (title === '') continue;
    let target = toMs(o.target_at ?? o.targetAt ?? o.target ?? o.target_date ?? o.date);
    if (target !== null) {
      if (target < lastTarget) target = null;
      else if (goalTargetAt !== null && target > goalTargetAt) target = goalTargetAt;
    }
    if (target !== null) lastTarget = target;
    const tasks: GoalDraftPhase['tasks'] = [];
    const rawTasks = Array.isArray(o.tasks) ? o.tasks : [];
    // Indices in the model's list → indices in the kept list.
    const keptIndex = new Map<number, number>();
    rawTasks.forEach((t: unknown, i: number) => {
      if (tasks.length >= MAX_DRAFT_TASKS_PER_PHASE) return;
      if (typeof t !== 'object' || t === null) return;
      const r = t as Record<string, unknown>;
      const tt = clip(r.title ?? r.text ?? r.name, 200);
      if (tt === '') return;
      const e = r.effort_min ?? r.effortMin ?? r.effort_minutes;
      const effortMin = typeof e === 'number' && e > 0 && e <= 24 * 60 ? Math.round(e) : null;
      const after = (Array.isArray(r.after) ? r.after : [])
        .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n < i)
        .flatMap((n) => {
          const k = keptIndex.get(n);
          return k === undefined ? [] : [k];
        });
      keptIndex.set(i, tasks.length);
      tasks.push({ title: tt, effortMin, after: [...new Set(after)] });
    });
    phases.push({ title, notes: clip(o.notes ?? o.note, 300), targetAt: target, tasks });
  }
  return phases.length > 0 ? { phases, by } : null;
}
