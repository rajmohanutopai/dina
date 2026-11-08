/**
 * The daily plan's store (docs/DAILY_PLAN.md §5): tasks, goals, each day's
 * plan, the agent feeds and the batch ids that guard the inbox route.
 *
 * The database is the only copy; nothing is cached in memory, so the phone
 * and its routes always read the same rows.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { onDeviceRevoked } from '../devices/registry';

import { shiftCalendarDays } from './day';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type PlanTaskStatus = 'held' | 'open' | 'done' | 'dropped';
export type PlanFeedState = 'pending' | 'allowed' | 'blocked';

/** `origin` of a task the owner added in the app or in chat. */
export const OWNER_ORIGIN = 'owner';

export interface PlanTask {
  id: string;
  persona: string;
  title: string;
  summary: string;
  source: string;
  sourceRef: string;
  link: string;
  dueAt: number | null;
  effortMin: number | null;
  project: string;
  goalId: string;
  origin: string;
  status: PlanTaskStatus;
  plannedFor: string;
  carried: number;
  observedAt: number;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  /** The goal phase it belongs to, or ''. */
  phaseId: string;
  /** Task ids that must be done or dropped first. */
  blockedBy: string[];
  /** Who the owner is waiting on, as they wrote it, or ''. */
  waitingOn: string;
  waitingUntil: number | null;
  /** The routine this is one turn of, or ''. */
  routineId: string;
  /** The day (`YYYY-MM-DD`) of that turn, or ''. */
  routineDay: string;
  /** When it first reached the owner's list: added, or an agent's task allowed. */
  openedAt: number;
  /** The owner renamed it, so an agent's later copy keeps their wording. */
  titleByOwner: boolean;
}

export type PlanRoutineKind = 'days' | 'per_week' | 'monthly';

/** Something that repeats (DAILY_PLAN.md §24): each turn becomes a task on its day. */
export interface PlanRoutine {
  id: string;
  /** The goal it serves, or ''. */
  goalId: string;
  title: string;
  persona: string;
  effortMin: number | null;
  kind: PlanRoutineKind;
  /** `days`: weekdays, 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** `per_week`: how many times a week, 1–7. */
  timesPerWeek: number;
  /** `monthly`: day of the month, 1–31; shorter months use their last day. */
  dayOfMonth: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineInput {
  goalId?: string;
  title: string;
  persona?: string;
  effortMin?: number | null;
  kind: PlanRoutineKind;
  weekdays?: number[];
  timesPerWeek?: number;
  dayOfMonth?: number;
}

export interface PlanGoal {
  id: string;
  title: string;
  notes: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  targetAt: number | null;
  budgetCents: number | null;
  currency: string;
  /** A drafted plan waiting for the owner (§19), or null. */
  draft: GoalDraft | null;
  draftAt: number | null;
}

export type PlanPhaseStatus = 'upcoming' | 'active' | 'done';

export interface PlanPhase {
  id: string;
  goalId: string;
  title: string;
  notes: string;
  position: number;
  targetAt: number | null;
  status: PlanPhaseStatus;
  startedAt: number | null;
  doneAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type PlanCostKind = 'quote' | 'paid';

export interface PlanCost {
  id: string;
  goalId: string;
  phaseId: string;
  taskId: string;
  label: string;
  kind: PlanCostKind;
  amountCents: number;
  /** A payment: the quote it pays toward, or ''. */
  quoteId: string;
  /** A quote: paid in full. */
  settled: boolean;
  at: number;
  createdAt: number;
}

/** A task in a drafted plan. `after` holds indices of earlier tasks in the same phase. */
export interface GoalDraftTask {
  title: string;
  effortMin: number | null;
  after: number[];
}

export interface GoalDraftPhase {
  title: string;
  notes: string;
  targetAt: number | null;
  tasks: GoalDraftTask[];
}

export interface GoalDraft {
  phases: GoalDraftPhase[];
  /** Who drafted it: the planner on the goal's page, or the chat model. */
  by: 'model' | 'chat';
}

export interface PlanDayEntry {
  taskId: string;
  reason: string;
  goalId?: string;
}

export interface PlanDay {
  day: string;
  entries: PlanDayEntry[];
  note: string;
  plannedAt: number;
  reviewedAt: number | null;
}

export interface PlanFeed {
  agentDid: string;
  persona: string;
  agentName: string;
  state: PlanFeedState;
  firstSeen: number;
  decidedAt: number | null;
}

/** One item as an agent sends it, after validation. */
export interface AgentItem {
  source: string;
  sourceRef: string;
  title: string;
  summary: string;
  link: string;
  dueAt: number | null;
  effortMin: number | null;
  project: string;
  closed: boolean;
  observedAt: number;
}

export interface OwnerTaskInput {
  title: string;
  summary?: string;
  persona?: string;
  link?: string;
  dueAt?: number | null;
  effortMin?: number | null;
  project?: string;
  goalId?: string;
  source?: string;
  plannedFor?: string;
  phaseId?: string;
  blockedBy?: string[];
  routineId?: string;
  routineDay?: string;
}

export interface TaskPatch {
  title?: string;
  summary?: string;
  dueAt?: number | null;
  effortMin?: number | null;
  project?: string;
  goalId?: string;
  status?: Exclude<PlanTaskStatus, 'held'>;
  plannedFor?: string;
  carried?: number;
  phaseId?: string;
  blockedBy?: string[];
  waitingOn?: string;
  waitingUntil?: number | null;
}

export type UpsertResult = 'inserted' | 'updated' | 'stale';

const TASK_COLUMNS =
  'id, persona, title, summary, source, source_ref, link, due_at, effort_min, project, goal_id, ' +
  'origin, status, planned_for, carried, observed_at, created_at, updated_at, done_at, ' +
  'phase_id, blocked_by, waiting_on, waiting_until, routine_id, routine_day, opened_at, title_by_owner';

export function newPlanId(prefix: string): string {
  return `${prefix}-${bytesToHex(randomBytes(8))}`;
}

function num(v: unknown): number | null {
  return v === null || v === undefined || v === '' ? null : Number(v);
}

function idList(json: unknown): string[] {
  if (typeof json !== 'string' || json === '') return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Read a stored draft; null when absent or unreadable. */
export function parseGoalDraft(json: unknown): GoalDraft | null {
  if (typeof json !== 'string' || json === '') return null;
  try {
    const v = JSON.parse(json) as Partial<GoalDraft>;
    if (!Array.isArray(v.phases)) return null;
    return { phases: v.phases, by: v.by === 'chat' ? 'chat' : 'model' };
  } catch {
    return null;
  }
}

function taskFromRow(r: DBRow): PlanTask {
  return {
    id: String(r.id),
    persona: String(r.persona),
    title: String(r.title),
    summary: String(r.summary ?? ''),
    source: String(r.source ?? ''),
    sourceRef: String(r.source_ref ?? ''),
    link: String(r.link ?? ''),
    dueAt: num(r.due_at),
    effortMin: num(r.effort_min),
    project: String(r.project ?? ''),
    goalId: String(r.goal_id ?? ''),
    origin: String(r.origin),
    status: String(r.status) as PlanTaskStatus,
    plannedFor: String(r.planned_for ?? ''),
    carried: Number(r.carried ?? 0),
    observedAt: Number(r.observed_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    doneAt: num(r.done_at),
    phaseId: String(r.phase_id ?? ''),
    blockedBy: idList(r.blocked_by),
    waitingOn: String(r.waiting_on ?? ''),
    waitingUntil: num(r.waiting_until),
    routineId: String(r.routine_id ?? ''),
    routineDay: String(r.routine_day ?? ''),
    openedAt: Number(r.opened_at ?? 0) || Number(r.created_at),
    titleByOwner: Number(r.title_by_owner ?? 0) === 1,
  };
}

function numberList(json: unknown): number[] {
  if (typeof json !== 'string' || json === '') return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

function routineFromRow(r: DBRow): PlanRoutine {
  return {
    id: String(r.id),
    goalId: String(r.goal_id ?? ''),
    title: String(r.title),
    persona: String(r.persona ?? 'general'),
    effortMin: num(r.effort_min),
    kind: String(r.kind) as PlanRoutineKind,
    weekdays: numberList(r.weekdays),
    timesPerWeek: Number(r.times_per_week ?? 0),
    dayOfMonth: Number(r.day_of_month ?? 0),
    active: Number(r.active) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function goalFromRow(r: DBRow): PlanGoal {
  return {
    id: String(r.id),
    title: String(r.title),
    notes: String(r.notes ?? ''),
    active: Number(r.active) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    targetAt: num(r.target_at),
    budgetCents: num(r.budget_cents),
    currency: String(r.currency ?? 'USD') || 'USD',
    draft: parseGoalDraft(r.draft_json),
    draftAt: num(r.draft_at),
  };
}

function phaseFromRow(r: DBRow): PlanPhase {
  return {
    id: String(r.id),
    goalId: String(r.goal_id),
    title: String(r.title),
    notes: String(r.notes ?? ''),
    position: Number(r.position),
    targetAt: num(r.target_at),
    status: String(r.status) as PlanPhaseStatus,
    startedAt: num(r.started_at),
    doneAt: num(r.done_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function costFromRow(r: DBRow): PlanCost {
  return {
    id: String(r.id),
    goalId: String(r.goal_id),
    phaseId: String(r.phase_id ?? ''),
    taskId: String(r.task_id ?? ''),
    label: String(r.label ?? ''),
    kind: String(r.kind) as PlanCostKind,
    amountCents: Number(r.amount_cents),
    quoteId: String(r.quote_id ?? ''),
    settled: Number(r.settled) === 1,
    at: Number(r.at),
    createdAt: Number(r.created_at),
  };
}

function feedFromRow(r: DBRow): PlanFeed {
  return {
    agentDid: String(r.agent_did),
    persona: String(r.persona),
    agentName: String(r.agent_name ?? ''),
    state: String(r.state) as PlanFeedState,
    firstSeen: Number(r.first_seen),
    decidedAt: num(r.decided_at),
  };
}

function parseEntries(json: unknown): PlanDayEntry[] {
  if (typeof json !== 'string' || json === '') return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e: unknown) => {
      if (typeof e !== 'object' || e === null) return [];
      const o = e as Record<string, unknown>;
      if (typeof o.taskId !== 'string') return [];
      return [
        {
          taskId: o.taskId,
          reason: typeof o.reason === 'string' ? o.reason : '',
          ...(typeof o.goalId === 'string' && o.goalId !== '' ? { goalId: o.goalId } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export interface TaskQuery {
  statuses?: PlanTaskStatus[];
  origin?: string;
  persona?: string;
  /** Only tasks updated at or after this time (ms). */
  updatedSince?: number;
  goalId?: string;
}

export class PlanStore {
  constructor(private readonly db: DatabaseAdapter) {}

  // ---------------- tasks ----------------

  getTask(id: string): PlanTask | null {
    const rows = this.db.query(`SELECT ${TASK_COLUMNS} FROM plan_tasks WHERE id = ?`, [id]);
    return rows.length > 0 ? taskFromRow(rows[0]) : null;
  }

  listTasks(q: TaskQuery = {}): PlanTask[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.statuses !== undefined && q.statuses.length > 0) {
      where.push(`status IN (${q.statuses.map(() => '?').join(', ')})`);
      params.push(...q.statuses);
    }
    if (q.origin !== undefined) {
      where.push('origin = ?');
      params.push(q.origin);
    }
    if (q.persona !== undefined) {
      where.push('persona = ?');
      params.push(q.persona);
    }
    if (q.updatedSince !== undefined) {
      where.push('updated_at >= ?');
      params.push(q.updatedSince);
    }
    if (q.goalId !== undefined) {
      where.push('goal_id = ?');
      params.push(q.goalId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .query(`SELECT ${TASK_COLUMNS} FROM plan_tasks ${clause} ORDER BY created_at ASC`, params)
      .map(taskFromRow);
  }

  addOwnerTask(input: OwnerTaskInput, now: number): PlanTask {
    const task: PlanTask = {
      id: newPlanId('task'),
      persona: input.persona ?? 'general',
      title: input.title,
      summary: input.summary ?? '',
      source: input.source ?? 'manual',
      sourceRef: '',
      link: input.link ?? '',
      dueAt: input.dueAt ?? null,
      effortMin: input.effortMin ?? null,
      project: input.project ?? '',
      goalId: input.goalId ?? '',
      origin: OWNER_ORIGIN,
      status: 'open',
      plannedFor: input.plannedFor ?? '',
      carried: 0,
      observedAt: now,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
      phaseId: input.phaseId ?? '',
      blockedBy: input.blockedBy ?? [],
      waitingOn: '',
      waitingUntil: null,
      routineId: input.routineId ?? '',
      routineDay: input.routineDay ?? '',
      openedAt: now,
      titleByOwner: false,
    };
    this.insert(task);
    return task;
  }

  /**
   * Take one agent item. A new `(origin, source_ref)` is inserted with
   * `status`; a known one is updated only when the item was seen later than
   * the stored copy, so a replayed old batch changes nothing. An agent never
   * reopens a task the owner finished or dropped, and its `closed` marks an
   * open task done. A held item it closes is deleted: the owner never saw it,
   * so no row stays for a block to miss or chat to reopen, and the same item
   * sent again later waits for the owner like a new one.
   */
  upsertAgentItem(
    origin: string,
    persona: string,
    item: AgentItem,
    status: 'held' | 'open',
    now: number,
  ): UpsertResult {
    const existing =
      item.sourceRef === ''
        ? null
        : (this.db
            .query(`SELECT ${TASK_COLUMNS} FROM plan_tasks WHERE origin = ? AND source_ref = ?`, [
              origin,
              item.sourceRef,
            ])
            .map(taskFromRow)[0] ?? null);
    // The owner's yes or no is per persona: an item can't reach a task held
    // under another persona by repeating its source_ref.
    if (existing !== null && existing.persona !== persona) return 'stale';
    if (existing === null) {
      if (item.closed) return 'stale';
      this.insert({
        id: newPlanId('task'),
        persona,
        title: item.title,
        summary: item.summary,
        source: item.source,
        sourceRef: item.sourceRef,
        link: item.link,
        dueAt: item.dueAt,
        effortMin: item.effortMin,
        project: item.project,
        goalId: '',
        origin,
        status,
        plannedFor: '',
        carried: 0,
        observedAt: item.observedAt,
        createdAt: now,
        updatedAt: now,
        doneAt: null,
        phaseId: '',
        blockedBy: [],
        waitingOn: '',
        waitingUntil: null,
        routineId: '',
        routineDay: '',
        openedAt: status === 'open' ? now : 0,
        titleByOwner: false,
      });
      return 'inserted';
    }
    if (item.observedAt <= existing.observedAt) return 'stale';
    if (item.closed && existing.status === 'held') {
      this.db.run('DELETE FROM plan_tasks WHERE id = ?', [existing.id]);
      return 'updated';
    }
    let nextStatus: PlanTaskStatus = existing.status;
    let doneAt = existing.doneAt;
    let waitingOn = existing.waitingOn;
    let waitingUntil = existing.waitingUntil;
    if (item.closed && existing.status === 'open') {
      nextStatus = 'done';
      doneAt = now;
      waitingOn = '';
      waitingUntil = null;
    }
    this.db.run(
      `UPDATE plan_tasks SET title = ?, summary = ?, source = ?, link = ?, due_at = ?, effort_min = ?,
         project = ?, status = ?, done_at = ?, waiting_on = ?, waiting_until = ?, observed_at = ?,
         updated_at = ? WHERE id = ?`,
      [
        existing.titleByOwner ? existing.title : item.title,
        item.summary,
        item.source,
        item.link,
        item.dueAt,
        item.effortMin,
        item.project,
        nextStatus,
        doneAt,
        waitingOn,
        waitingUntil,
        item.observedAt,
        now,
        existing.id,
      ],
    );
    return 'updated';
  }

  updateTask(id: string, patch: TaskPatch, now: number): PlanTask | null {
    const task = this.getTask(id);
    if (task === null || task.status === 'held') return null;
    const next: PlanTask = {
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.effortMin !== undefined ? { effortMin: patch.effortMin } : {}),
      ...(patch.project !== undefined ? { project: patch.project } : {}),
      ...(patch.goalId !== undefined ? { goalId: patch.goalId } : {}),
      ...(patch.plannedFor !== undefined ? { plannedFor: patch.plannedFor } : {}),
      ...(patch.carried !== undefined ? { carried: patch.carried } : {}),
      ...(patch.phaseId !== undefined ? { phaseId: patch.phaseId } : {}),
      ...(patch.blockedBy !== undefined ? { blockedBy: patch.blockedBy } : {}),
      ...(patch.waitingOn !== undefined ? { waitingOn: patch.waitingOn } : {}),
      ...(patch.waitingUntil !== undefined ? { waitingUntil: patch.waitingUntil } : {}),
      updatedAt: now,
    };
    if (next.waitingOn === '') next.waitingUntil = null;
    if (patch.status !== undefined && patch.status !== task.status) {
      next.status = patch.status;
      next.doneAt = patch.status === 'done' ? now : null;
      // Done ends the wait, so a task reopened later doesn't chase someone anew.
      if (patch.status === 'done') {
        next.waitingOn = '';
        next.waitingUntil = null;
      }
      // Reopened in a finished phase it would be hidden and off every day: it
      // moves on, as a task still open when the phase finished does.
      if (patch.status === 'open' && patch.phaseId === undefined && task.phaseId !== '') {
        const phase = this.getPhase(task.phaseId);
        if (phase !== null && phase.status === 'done') {
          next.phaseId = this.phaseAfter(phase)?.id ?? '';
        }
      }
    }
    if (patch.title !== undefined && patch.title !== task.title) next.titleByOwner = true;
    this.db.run(
      `UPDATE plan_tasks SET title = ?, summary = ?, due_at = ?, effort_min = ?, project = ?, goal_id = ?,
         status = ?, planned_for = ?, carried = ?, done_at = ?, updated_at = ?, phase_id = ?,
         blocked_by = ?, waiting_on = ?, waiting_until = ?, title_by_owner = ? WHERE id = ?`,
      [
        next.title,
        next.summary,
        next.dueAt,
        next.effortMin,
        next.project,
        next.goalId,
        next.status,
        next.plannedFor,
        next.carried,
        next.doneAt,
        now,
        next.phaseId,
        JSON.stringify(next.blockedBy),
        next.waitingOn,
        next.waitingUntil,
        next.titleByOwner ? 1 : 0,
        id,
      ],
    );
    return next;
  }

  /** Held tasks from one feed become open. Returns how many. */
  releaseHeld(origin: string, persona: string, now: number): number {
    return this.db.run(
      `UPDATE plan_tasks SET status = 'open', updated_at = ?, opened_at = ? WHERE origin = ? AND persona = ? AND status = 'held'`,
      [now, now, origin, persona],
    );
  }

  /** Held tasks from one feed are removed. Returns how many. */
  deleteHeld(origin: string, persona: string): number {
    return this.db.run(
      `DELETE FROM plan_tasks WHERE origin = ? AND persona = ? AND status = 'held'`,
      [origin, persona],
    );
  }

  private insert(t: PlanTask): void {
    this.db.execute(
      `INSERT INTO plan_tasks (${TASK_COLUMNS}) VALUES (${new Array(27).fill('?').join(', ')})`,
      [
        t.id,
        t.persona,
        t.title,
        t.summary,
        t.source,
        t.sourceRef,
        t.link,
        t.dueAt,
        t.effortMin,
        t.project,
        t.goalId,
        t.origin,
        t.status,
        t.plannedFor,
        t.carried,
        t.observedAt,
        t.createdAt,
        t.updatedAt,
        t.doneAt,
        t.phaseId,
        JSON.stringify(t.blockedBy),
        t.waitingOn,
        t.waitingUntil,
        t.routineId,
        t.routineDay,
        t.openedAt,
        t.titleByOwner ? 1 : 0,
      ],
    );
  }

  /**
   * Set what a task waits for. Refused (false) when a named task isn't an
   * open or finished task of the same goal, or when the tasks would end up
   * waiting on each other.
   */
  setTaskBlockedBy(id: string, blockedBy: string[], now: number): boolean {
    const task = this.getTask(id);
    if (task === null || task.goalId === '') return false;
    const wanted = [...new Set(blockedBy)];
    if (wanted.includes(id)) return false;
    const siblings = new Map(this.listTasks({ goalId: task.goalId }).map((t) => [t.id, t]));
    for (const b of wanted) if (!siblings.has(b)) return false;
    const seen = new Set<string>();
    const stack = [...wanted];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (at === id) return false;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(siblings.get(at)?.blockedBy ?? []));
    }
    return this.updateTask(id, { blockedBy: wanted }, now) !== null;
  }

  // ---------------- routines ----------------

  listRoutines(activeOnly = false): PlanRoutine[] {
    return this.db
      .query(
        `SELECT * FROM plan_routines ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at ASC`,
      )
      .map(routineFromRow);
  }

  getRoutine(id: string): PlanRoutine | null {
    const rows = this.db.query('SELECT * FROM plan_routines WHERE id = ?', [id]);
    return rows.length > 0 ? routineFromRow(rows[0]) : null;
  }

  addRoutine(input: RoutineInput, now: number): PlanRoutine {
    const routine: PlanRoutine = {
      id: newPlanId('routine'),
      goalId: input.goalId ?? '',
      title: input.title,
      persona: input.persona ?? 'general',
      effortMin: input.effortMin ?? null,
      kind: input.kind,
      weekdays: input.weekdays ?? [],
      timesPerWeek: input.timesPerWeek ?? 0,
      dayOfMonth: input.dayOfMonth ?? 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.db.execute(
      `INSERT INTO plan_routines (id, goal_id, title, persona, effort_min, kind, weekdays, times_per_week,
         day_of_month, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        routine.id,
        routine.goalId,
        routine.title,
        routine.persona,
        routine.effortMin,
        routine.kind,
        JSON.stringify(routine.weekdays),
        routine.timesPerWeek,
        routine.dayOfMonth,
        now,
        now,
      ],
    );
    return routine;
  }

  /** Stop a routine. Its open turn goes too; finished turns stay. */
  stopRoutine(id: string, now: number): boolean {
    let stopped = false;
    this.db.transaction(() => {
      stopped =
        this.db.run('UPDATE plan_routines SET active = 0, updated_at = ? WHERE id = ?', [now, id]) >
        0;
      this.db.run(
        `UPDATE plan_tasks SET status = 'dropped', updated_at = ? WHERE routine_id = ? AND status = 'open'`,
        [now, id],
      );
    });
    return stopped;
  }

  /** Every turn of a routine, oldest first. */
  listRoutineTasks(routineId: string): PlanTask[] {
    return this.db
      .query(
        `SELECT ${TASK_COLUMNS} FROM plan_tasks WHERE routine_id = ? ORDER BY routine_day ASC`,
        [routineId],
      )
      .map(taskFromRow);
  }

  /** Run several writes as one: all of them or none. */
  inTransaction(fn: () => void): void {
    this.db.transaction(fn);
  }

  // ---------------- batches ----------------

  /** True the first time this agent sends this batch id. */
  claimBatch(agentDid: string, batchId: string, now: number): boolean {
    const seen = this.db.query(
      'SELECT 1 AS hit FROM plan_batches WHERE agent_did = ? AND batch_id = ?',
      [agentDid, batchId],
    );
    if (seen.length > 0) return false;
    this.db.execute(
      'INSERT INTO plan_batches (agent_did, batch_id, received_at) VALUES (?, ?, ?)',
      [agentDid, batchId, now],
    );
    return true;
  }

  pruneBatches(before: number): number {
    return this.db.run('DELETE FROM plan_batches WHERE received_at < ?', [before]);
  }

  // ---------------- feeds ----------------

  getFeed(agentDid: string, persona: string): PlanFeed | null {
    const rows = this.db.query('SELECT * FROM plan_feeds WHERE agent_did = ? AND persona = ?', [
      agentDid,
      persona,
    ]);
    return rows.length > 0 ? feedFromRow(rows[0]) : null;
  }

  listFeeds(): PlanFeed[] {
    return this.db.query('SELECT * FROM plan_feeds ORDER BY first_seen ASC').map(feedFromRow);
  }

  /** Record a feed the owner has not decided on yet. Keeps an existing row. */
  notePendingFeed(agentDid: string, persona: string, agentName: string, now: number): PlanFeed {
    const existing = this.getFeed(agentDid, persona);
    if (existing !== null) return existing;
    this.db.execute(
      `INSERT INTO plan_feeds (agent_did, persona, agent_name, state, first_seen) VALUES (?, ?, ?, 'pending', ?)`,
      [agentDid, persona, agentName, now],
    );
    return { agentDid, persona, agentName, state: 'pending', firstSeen: now, decidedAt: null };
  }

  setFeedState(agentDid: string, persona: string, state: PlanFeedState, now: number): boolean {
    return (
      this.db.run(
        'UPDATE plan_feeds SET state = ?, decided_at = ? WHERE agent_did = ? AND persona = ?',
        [state, now, agentDid, persona],
      ) > 0
    );
  }

  /** Remove every feed an agent has, and its held tasks (the device was unpaired). */
  forgetAgent(agentDid: string): void {
    this.db.run(`DELETE FROM plan_tasks WHERE origin = ? AND status = 'held'`, [agentDid]);
    this.db.run('DELETE FROM plan_feeds WHERE agent_did = ?', [agentDid]);
  }

  // ---------------- goals ----------------

  listGoals(activeOnly = false): PlanGoal[] {
    return this.db
      .query(
        `SELECT * FROM plan_goals ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at ASC`,
      )
      .map(goalFromRow);
  }

  getGoal(id: string): PlanGoal | null {
    const rows = this.db.query('SELECT * FROM plan_goals WHERE id = ?', [id]);
    return rows.length > 0 ? goalFromRow(rows[0]) : null;
  }

  addGoal(
    title: string,
    notes: string,
    now: number,
    extra: { targetAt?: number | null; budgetCents?: number | null; currency?: string } = {},
  ): PlanGoal {
    const goal: PlanGoal = {
      id: newPlanId('goal'),
      title,
      notes,
      active: true,
      createdAt: now,
      updatedAt: now,
      targetAt: extra.targetAt ?? null,
      budgetCents: extra.budgetCents ?? null,
      currency: extra.currency ?? 'USD',
      draft: null,
      draftAt: null,
    };
    this.db.execute(
      `INSERT INTO plan_goals (id, title, notes, active, created_at, updated_at, target_at, budget_cents, currency)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [goal.id, title, notes, now, now, goal.targetAt, goal.budgetCents, goal.currency],
    );
    return goal;
  }

  updateGoal(
    id: string,
    patch: {
      title?: string;
      notes?: string;
      active?: boolean;
      targetAt?: number | null;
      budgetCents?: number | null;
      currency?: string;
    },
    now: number,
  ): PlanGoal | null {
    const goal = this.getGoal(id);
    if (goal === null) return null;
    const next: PlanGoal = {
      ...goal,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.targetAt !== undefined ? { targetAt: patch.targetAt } : {}),
      ...(patch.budgetCents !== undefined ? { budgetCents: patch.budgetCents } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      updatedAt: now,
    };
    this.db.run(
      `UPDATE plan_goals SET title = ?, notes = ?, active = ?, target_at = ?, budget_cents = ?, currency = ?,
         updated_at = ? WHERE id = ?`,
      [
        next.title,
        next.notes,
        next.active ? 1 : 0,
        next.targetAt,
        next.budgetCents,
        next.currency,
        now,
        id,
      ],
    );
    return next;
  }

  /**
   * Save or clear (null) a goal's drafted plan. A draft can't land on a goal
   * that already has phases: nothing could accept it. Returns false then.
   */
  setGoalDraft(id: string, draft: GoalDraft | null, now: number): boolean {
    if (draft !== null && this.listPhases(id).length > 0) return false;
    return (
      this.db.run(
        'UPDATE plan_goals SET draft_json = ?, draft_at = ?, updated_at = ? WHERE id = ?',
        [draft === null ? '' : JSON.stringify(draft), draft === null ? null : now, now, id],
      ) > 0
    );
  }

  /**
   * Turn a goal's draft into phases and tasks. The first phase starts.
   * Refused (null) when there is no draft or the goal already has phases.
   */
  acceptGoalDraft(goalId: string, now: number): PlanPhase[] | null {
    const goal = this.getGoal(goalId);
    if (goal === null || goal.draft === null) return null;
    if (this.listPhases(goalId).length > 0) return null;
    const draft = goal.draft;
    const phases: PlanPhase[] = [];
    this.db.transaction(() => {
      draft.phases.forEach((dp, i) => {
        const phase = this.insertPhase(
          goalId,
          dp.title,
          dp.notes,
          i,
          dp.targetAt,
          i === 0 ? 'active' : 'upcoming',
          now,
        );
        phases.push(phase);
        const ids: string[] = [];
        for (const dt of dp.tasks) {
          const blockedBy = dt.after.flatMap((n) => (n >= 0 && n < ids.length ? [ids[n]] : []));
          const task = this.addOwnerTask(
            {
              title: dt.title,
              effortMin: dt.effortMin,
              goalId,
              phaseId: phase.id,
              blockedBy,
              source: 'plan',
            },
            now,
          );
          ids.push(task.id);
        }
      });
      this.db.run(
        `UPDATE plan_goals SET draft_json = '', draft_at = NULL, updated_at = ? WHERE id = ?`,
        [now, goalId],
      );
    });
    return phases;
  }

  // ---------------- phases ----------------

  listPhases(goalId: string): PlanPhase[] {
    return this.db
      .query('SELECT * FROM plan_phases WHERE goal_id = ? ORDER BY position ASC, created_at ASC', [
        goalId,
      ])
      .map(phaseFromRow);
  }

  getPhase(id: string): PlanPhase | null {
    const rows = this.db.query('SELECT * FROM plan_phases WHERE id = ?', [id]);
    return rows.length > 0 ? phaseFromRow(rows[0]) : null;
  }

  /** Append a phase to a goal. It starts active when no other phase is open. */
  addPhase(
    goalId: string,
    title: string,
    notes: string,
    targetAt: number | null,
    now: number,
  ): PlanPhase {
    const phases = this.listPhases(goalId);
    const anyOpen = phases.some((p) => p.status !== 'done');
    const position = phases.reduce((m, p) => Math.max(m, p.position + 1), 0);
    // The goal now has a plan by hand: a draft waiting on it could never be accepted.
    this.setGoalDraft(goalId, null, now);
    return this.insertPhase(
      goalId,
      title,
      notes,
      position,
      targetAt,
      anyOpen ? 'upcoming' : 'active',
      now,
    );
  }

  updatePhase(
    id: string,
    patch: { title?: string; notes?: string; targetAt?: number | null },
    now: number,
  ): PlanPhase | null {
    const p = this.getPhase(id);
    if (p === null) return null;
    const next = {
      ...p,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.targetAt !== undefined ? { targetAt: patch.targetAt } : {}),
      updatedAt: now,
    };
    this.db.run(
      'UPDATE plan_phases SET title = ?, notes = ?, target_at = ?, updated_at = ? WHERE id = ?',
      [next.title, next.notes, next.targetAt, now, id],
    );
    return next;
  }

  /** Start an upcoming phase now (work that overlaps). */
  startPhase(id: string, now: number): boolean {
    return (
      this.db.run(
        `UPDATE plan_phases SET status = 'active', started_at = ?, updated_at = ? WHERE id = ? AND status = 'upcoming'`,
        [now, now, id],
      ) > 0
    );
  }

  /**
   * Mark a phase done; the next upcoming phase of the goal starts when no
   * other phase is still active. Tasks still open in it move to the next
   * phase not done, or off the phases when there is none, so none is lost.
   * Returns the phase that started, if any.
   */
  finishPhase(id: string, now: number): PlanPhase | null {
    const phase = this.getPhase(id);
    if (phase === null || phase.status === 'done') return null;
    let started: PlanPhase | null = null;
    this.db.transaction(() => {
      this.db.run(
        `UPDATE plan_phases SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, id],
      );
      const rest = this.listPhases(phase.goalId);
      const heir = this.phaseAfter(phase);
      this.db.run(
        `UPDATE plan_tasks SET phase_id = ?, updated_at = ? WHERE phase_id = ? AND status = 'open'`,
        [heir?.id ?? '', now, id],
      );
      started = this.startNextIfNoneActive(rest, phase.position, now);
    });
    return started;
  }

  /** Undo "Phase done". The phase is active again, alongside any other. */
  reopenPhase(id: string, now: number): boolean {
    return (
      this.db.run(
        `UPDATE plan_phases SET status = 'active', done_at = NULL, updated_at = ? WHERE id = ? AND status = 'done'`,
        [now, id],
      ) > 0
    );
  }

  /** Swap a phase with its neighbour. False at either end of the list. */
  movePhase(id: string, direction: 'up' | 'down', now: number): boolean {
    const phase = this.getPhase(id);
    if (phase === null) return false;
    const phases = this.listPhases(phase.goalId);
    const at = phases.findIndex((p) => p.id === id);
    const other = phases[direction === 'up' ? at - 1 : at + 1];
    if (other === undefined) return false;
    this.db.transaction(() => {
      // Renumber from the list's order, so equal positions can't stop a swap.
      const order = phases.map((p) => p.id);
      order[at] = other.id;
      order[phases.indexOf(other)] = id;
      order.forEach((pid, i) => {
        this.db.run('UPDATE plan_phases SET position = ?, updated_at = ? WHERE id = ?', [
          i,
          now,
          pid,
        ]);
      });
    });
    return true;
  }

  /**
   * Delete a phase. Its tasks and money stay on the goal, under no phase. The
   * next upcoming phase starts when this was the only active one.
   */
  deletePhase(id: string, now: number): boolean {
    const phase = this.getPhase(id);
    if (phase === null) return false;
    this.db.transaction(() => {
      this.db.run('DELETE FROM plan_phases WHERE id = ?', [id]);
      this.db.run(`UPDATE plan_tasks SET phase_id = '', updated_at = ? WHERE phase_id = ?`, [
        now,
        id,
      ]);
      this.db.run(`UPDATE plan_costs SET phase_id = '' WHERE phase_id = ?`, [id]);
      this.startNextIfNoneActive(this.listPhases(phase.goalId), phase.position, now);
    });
    return true;
  }

  /** The next phase of its goal not done, or else an earlier one not done. */
  private phaseAfter(phase: PlanPhase): PlanPhase | undefined {
    const rest = this.listPhases(phase.goalId).filter(
      (p) => p.id !== phase.id && p.status !== 'done',
    );
    return rest.find((p) => p.position > phase.position) ?? rest[0];
  }

  private startNextIfNoneActive(
    phases: PlanPhase[],
    fromPosition: number,
    now: number,
  ): PlanPhase | null {
    if (phases.some((p) => p.status === 'active')) return null;
    const next =
      phases.find((p) => p.status === 'upcoming' && p.position > fromPosition) ??
      phases.find((p) => p.status === 'upcoming');
    if (next === undefined) return null;
    this.startPhase(next.id, now);
    return { ...next, status: 'active', startedAt: now, updatedAt: now };
  }

  /** Move the target dates of these phases (and optionally the goal) by `days`. */
  shiftDates(
    goalId: string,
    phaseIds: string[],
    days: number,
    moveGoal: boolean,
    now: number,
  ): void {
    const whole = Math.round(days);
    this.db.transaction(() => {
      for (const id of phaseIds) {
        const phase = this.getPhase(id);
        if (phase === null || phase.goalId !== goalId || phase.targetAt === null) continue;
        this.db.run('UPDATE plan_phases SET target_at = ?, updated_at = ? WHERE id = ?', [
          shiftCalendarDays(phase.targetAt, whole),
          now,
          id,
        ]);
      }
      const goal = moveGoal ? this.getGoal(goalId) : null;
      if (goal !== null && goal.targetAt !== null) {
        this.db.run('UPDATE plan_goals SET target_at = ?, updated_at = ? WHERE id = ?', [
          shiftCalendarDays(goal.targetAt, whole),
          now,
          goalId,
        ]);
      }
    });
  }

  private insertPhase(
    goalId: string,
    title: string,
    notes: string,
    position: number,
    targetAt: number | null,
    status: PlanPhaseStatus,
    now: number,
  ): PlanPhase {
    const phase: PlanPhase = {
      id: newPlanId('phase'),
      goalId,
      title,
      notes,
      position,
      targetAt,
      status,
      startedAt: status === 'active' ? now : null,
      doneAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.execute(
      `INSERT INTO plan_phases (id, goal_id, title, notes, position, target_at, status, started_at, done_at,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [phase.id, goalId, title, notes, position, targetAt, status, phase.startedAt, now, now],
    );
    return phase;
  }

  // ---------------- money ----------------

  listCosts(goalId: string): PlanCost[] {
    return this.db
      .query('SELECT * FROM plan_costs WHERE goal_id = ? ORDER BY at ASC, created_at ASC', [goalId])
      .map(costFromRow);
  }

  /**
   * Record a quote or a payment. A payment goes toward the quote named. With
   * none named it goes toward its task's oldest open quote, and `quoteId: ''`
   * says it pays no quote at all. A quote is settled once what's been
   * paid toward it reaches its amount: a deposit leaves the rest open.
   */
  addCost(
    input: {
      goalId: string;
      phaseId?: string;
      taskId?: string;
      label: string;
      kind: PlanCostKind;
      amountCents: number;
      at?: number;
      quoteId?: string;
    },
    now: number,
  ): PlanCost {
    const taskId = input.taskId ?? '';
    let quoteId = input.kind === 'paid' ? (input.quoteId ?? '') : '';
    if (input.kind === 'paid' && input.quoteId === undefined && taskId !== '') {
      quoteId =
        this.listCosts(input.goalId).find(
          (c) => c.kind === 'quote' && !c.settled && c.taskId === taskId,
        )?.id ?? '';
    }
    const cost: PlanCost = {
      id: newPlanId('cost'),
      goalId: input.goalId,
      phaseId: input.phaseId ?? '',
      taskId,
      label: input.label,
      kind: input.kind,
      amountCents: Math.round(input.amountCents),
      quoteId,
      settled: false,
      at: input.at ?? now,
      createdAt: now,
    };
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO plan_costs (id, goal_id, phase_id, task_id, label, kind, amount_cents, settled, at, created_at, quote_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          cost.id,
          cost.goalId,
          cost.phaseId,
          cost.taskId,
          cost.label,
          cost.kind,
          cost.amountCents,
          cost.at,
          now,
          cost.quoteId,
        ],
      );
      if (quoteId !== '') this.resettleQuote(quoteId);
    });
    return cost;
  }

  /** Remove a quote or payment, and work out again what a payment paid toward. */
  deleteCost(id: string): boolean {
    const cost = this.getCost(id);
    if (cost === null) return false;
    this.db.transaction(() => {
      this.db.run('DELETE FROM plan_costs WHERE id = ?', [id]);
      if (cost.kind === 'quote') {
        this.db.run(`UPDATE plan_costs SET quote_id = '' WHERE quote_id = ?`, [id]);
      } else if (cost.quoteId !== '') {
        this.resettleQuote(cost.quoteId);
      }
    });
    return true;
  }

  private resettleQuote(quoteId: string): void {
    const quote = this.getCost(quoteId);
    if (quote === null) return;
    const paid = this.db
      .query(`SELECT amount_cents FROM plan_costs WHERE quote_id = ? AND kind = 'paid'`, [quoteId])
      .reduce((sum, r) => sum + Number(r.amount_cents), 0);
    this.db.run('UPDATE plan_costs SET settled = ? WHERE id = ?', [
      paid >= quote.amountCents ? 1 : 0,
      quoteId,
    ]);
  }

  getCost(id: string): PlanCost | null {
    const rows = this.db.query('SELECT * FROM plan_costs WHERE id = ?', [id]);
    return rows.length > 0 ? costFromRow(rows[0]) : null;
  }

  // ---------------- days ----------------

  getDay(day: string): PlanDay | null {
    const rows = this.db.query('SELECT * FROM plan_days WHERE day = ?', [day]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      day: String(r.day),
      entries: parseEntries(r.entries_json),
      note: String(r.note ?? ''),
      plannedAt: Number(r.planned_at),
      reviewedAt: num(r.reviewed_at),
    };
  }

  /** Save a day's plan, and mark each chosen task as planned for that day. */
  putDay(day: string, entries: PlanDayEntry[], note: string, now: number): PlanDay {
    this.db.transaction(() => {
      this.db.execute(
        `INSERT INTO plan_days (day, entries_json, note, planned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET entries_json = excluded.entries_json, note = excluded.note,
           planned_at = excluded.planned_at, reviewed_at = NULL`,
        [day, JSON.stringify(entries), note, now],
      );
      this.db.run(
        `UPDATE plan_tasks SET planned_for = '' WHERE planned_for = ? AND status = 'open'`,
        [day],
      );
      // The planner can tie a loose task to a goal. It can't move one off the
      // goal and phase it's on, or pull back a task put off to a later day.
      for (const e of entries) {
        this.db.run(
          `UPDATE plan_tasks SET planned_for = ?,
             goal_id = CASE WHEN goal_id = '' AND phase_id = '' THEN ? ELSE goal_id END,
             updated_at = ? WHERE id = ? AND status = 'open' AND planned_for <= ?`,
          [day, e.goalId ?? '', now, e.taskId, day],
        );
      }
    });
    return { day, entries, note, plannedAt: now, reviewedAt: null };
  }

  markReviewed(day: string, now: number): boolean {
    return this.db.run('UPDATE plan_days SET reviewed_at = ? WHERE day = ?', [now, day]) > 0;
  }
}

let store: PlanStore | null = null;
let planChanged: (() => void) | null = null;

/**
 * Who to tell when something outside the owner's screens changes the plan
 * (chat, an agent's batch), so the check-ins scheduled ahead stay true.
 */
export function setPlanChangedListener(fn: (() => void) | null): void {
  planChanged = fn;
}

export function notifyPlanChanged(): void {
  planChanged?.();
}

export function setPlanStore(s: PlanStore | null): void {
  store = s;
}

export function getPlanStore(): PlanStore | null {
  return store;
}

// Unpairing a device, of any role that can post to the inbox, ends its
// permission to add tasks and drops what it sent that the owner never allowed.
// Tasks the owner already took on stay. The boot reconcile runs this again, for
// a revoke that happened with no store open.
onDeviceRevoked((did) => {
  store?.forgetAgent(did);
});
