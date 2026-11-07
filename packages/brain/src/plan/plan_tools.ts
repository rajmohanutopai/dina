/**
 * Chat tools for the daily plan (docs/DAILY_PLAN.md §10). Registered only on
 * the owner's own chat turns, never for an agent's ask, and only where the
 * plan store lives in this process (the phone).
 *
 *   add_task  — "I need to renew the car insurance by Friday"
 *   show_plan — "what's left today?"
 *   set_goal  — "this quarter I want to ship the Jiffy integration"
 *
 * Goal plans (§19):
 *   draft_goal_plan  — the chat model drafts phases and tasks; the owner
 *                      accepts them on the goal's page
 *   update_goal_task — "Mike sent the quote, $18,400"
 *   show_goal        — "how is the house going?"
 */

import {
  cleanGoalDraft,
  formatGoalMoney,
  getPlanStore,
  isTaskReady,
  latePhase,
  moneySummary,
  planDayKey,
  type PlanGoal,
  type PlanStore,
  type PlanTask,
} from '@dina/core';

import type { AgentTool } from '../reasoning/tool_registry';

export interface PlanToolOptions {
  store?: () => PlanStore | null;
  now?: () => number;
}

function parseDue(v: unknown): number | null | 'bad' {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : 'bad';
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function createAddTaskTool(opts: PlanToolOptions = {}): AgentTool {
  const store = opts.store ?? getPlanStore;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'add_task',
    description:
      'Add a to-do to the user\'s daily plan. Use it when the user says they need to, have to or want to do something ("I need to renew the car insurance by Friday", "add \'call the plumber\' to my list"). A task has no set time; for something that must alert at a set time use schedule_reminder instead. Resolve a due date into ISO-8601 before calling. Afterwards tell the user in one short line that it\'s on their list.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The task, short, as the user would write it on a list.',
        },
        due_at: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Optional deadline, ISO-8601 with offset or epoch ms.',
        },
        effort_min: { type: 'number', description: 'Optional rough effort in minutes.' },
        project: { type: 'string', description: 'Optional project or area it belongs to.' },
        persona: {
          type: 'string',
          description: 'Optional persona: "work" for job tasks; otherwise leave empty.',
        },
        goal: {
          type: 'string',
          description:
            "Optional: the user's goal this task serves, by title or id. The task joins that goal's current phase.",
        },
      },
      required: ['title'],
    },
    async execute(args) {
      const s = store();
      if (s === null) return { error: 'the daily plan is not available here' };
      const title = text(args.title, 200);
      if (title === '') return { error: 'title is required' };
      const due = parseDue(args.due_at);
      if (due === 'bad') return { error: 'due_at is not a date' };
      const effort =
        typeof args.effort_min === 'number' && args.effort_min > 0 && args.effort_min <= 24 * 60
          ? Math.round(args.effort_min)
          : null;
      const persona = /^[a-z][a-z0-9_-]{0,63}$/.test(text(args.persona, 64))
        ? text(args.persona, 64)
        : 'general';
      const goalRef = text(args.goal, 200);
      const goal = goalRef === '' ? null : findGoal(s, goalRef);
      if (goalRef !== '' && goal === null) {
        return { error: 'no single active goal matches; leave goal empty or ask the user' };
      }
      const phase =
        goal === null ? undefined : s.listPhases(goal.id).find((p) => p.status === 'active');
      const task = s.addOwnerTask(
        {
          title,
          dueAt: due,
          effortMin: effort,
          project: text(args.project, 200),
          persona,
          source: 'chat',
          goalId: goal?.id ?? '',
          phaseId: phase?.id ?? '',
        },
        now(),
      );
      return { added: true, id: task.id, title: task.title, due_at: task.dueAt };
    },
  };
}

export function createShowPlanTool(opts: PlanToolOptions = {}): AgentTool {
  const store = opts.store ?? getPlanStore;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'show_plan',
    description:
      'Read the user\'s plan for today and their other open to-dos. Use it for "what\'s on my plan", "what\'s left today", "what should I do next". Answer briefly from the result; don\'t list everything unless asked.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const s = store();
      if (s === null) return { error: 'the daily plan is not available here' };
      const day = planDayKey(now());
      const plan = s.getDay(day);
      const open = s.listTasks({ statuses: ['open', 'done'] });
      const byId = new Map(open.map((t) => [t.id, t]));
      const planned = (plan?.entries ?? []).flatMap((e) => {
        const t = byId.get(e.taskId);
        return t === undefined
          ? []
          : [{ title: t.title, done: t.status === 'done', reason: e.reason }];
      });
      const plannedIds = new Set((plan?.entries ?? []).map((e) => e.taskId));
      const others = open
        .filter((t) => t.status === 'open' && !plannedIds.has(t.id))
        .slice(0, 20)
        .map((t) => ({ title: t.title, due_at: t.dueAt, area: t.persona }));
      return {
        day,
        planned_yet: plan !== null,
        plan: planned,
        other_open: others,
        goals: s.listGoals(true).map((g) => g.title),
      };
    },
  };
}

export function createSetGoalTool(opts: PlanToolOptions = {}): AgentTool {
  const store = opts.store ?? getPlanStore;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'set_goal',
    description:
      'Add a goal the daily plan should serve, when the user states one ("this quarter I want to ship the Jiffy integration", "I want to run three times a week"). Not for single tasks: use add_task for those. The user also adds, archives and changes goals on the Goals page, so earlier messages may be out of date: call this (or show_goal) rather than saying from memory that a goal exists. Afterwards tell the user in one short line that the plan will make room for it.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The goal in a few words, as the user put it.' },
        notes: { type: 'string', description: 'Optional detail: how often, why.' },
        target_date: {
          type: 'string',
          description: 'Optional date the goal should be reached by, ISO-8601.',
        },
        budget: {
          type: 'number',
          description: 'Optional budget in whole currency units (450000 for $450,000).',
        },
        currency: {
          type: 'string',
          description: 'Optional ISO currency code; USD when not given.',
        },
      },
      required: ['title'],
    },
    async execute(args) {
      const s = store();
      if (s === null) return { error: 'the daily plan is not available here' };
      const title = text(args.title, 200);
      if (title === '') return { error: 'title is required' };
      const target = parseDue(args.target_date);
      if (target === 'bad') return { error: 'target_date is not a date' };
      const budget = money(args.budget);
      const currency = /^[A-Z]{3}$/.test(text(args.currency, 3).toUpperCase())
        ? text(args.currency, 3).toUpperCase()
        : 'USD';
      const existing = s.listGoals(true).find((g) => g.title.toLowerCase() === title.toLowerCase());
      if (existing !== undefined) return { added: false, already: true, id: existing.id };
      const goal = s.addGoal(title, text(args.notes, 500), now(), {
        targetAt: target,
        budgetCents: budget,
        currency,
      });
      return {
        added: true,
        id: goal.id,
        title: goal.title,
        next: 'For a goal with several stages, offer to draft a plan with draft_goal_plan.',
      };
    },
  };
}

/** Whole currency units → cents; null when absent or not a positive number. */
function money(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1e12 ? Math.round(n * 100) : null;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** The active goal named by id or by its words; null when none or unclear. */
export function findGoal(s: PlanStore, ref: unknown): PlanGoal | null {
  const r = text(ref, 200);
  if (r === '') return null;
  const goals = s.listGoals(true);
  const byId = goals.find((g) => g.id === r);
  if (byId !== undefined) return byId;
  const exact = goals.find((g) => g.title.toLowerCase() === r.toLowerCase());
  if (exact !== undefined) return exact;
  const want = words(r);
  const scored = goals
    .map((g) => ({ g, n: words(g.title).filter((w) => want.includes(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].n === scored[1].n) return null;
  return scored[0].g;
}

/** The open task in a goal that best matches the words; null when none or unclear. */
export function findGoalTask(s: PlanStore, goalId: string, ref: unknown): PlanTask | null {
  const want = words(text(ref, 200));
  if (want.length === 0) return null;
  const scored = s
    .listTasks({ goalId, statuses: ['open'] })
    .map((t) => ({
      t,
      n: words(`${t.title} ${t.waitingOn}`).filter((w) => want.includes(w)).length,
    }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].n === scored[1].n) return null;
  return scored[0].t;
}

export function createDraftGoalPlanTool(opts: PlanToolOptions = {}): AgentTool {
  const store = opts.store ?? getPlanStore;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'draft_goal_plan',
    description:
      "Draft a plan for one of the user's goals that has stages (building a house, a move, a launch): phases in order, each with a target date, and tasks for the first two phases only. Use it when the user asks for a plan for a goal, or agrees when you offer one. Create the goal first with set_goal if it doesn't exist. The draft is saved for the user to accept on the goal's page in Today → Goals; tell them that in one line, and list the phase titles.",
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal, by its title or id.' },
        phases: {
          type: 'array',
          description: 'Phases in order, at most 12.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              notes: { type: 'string', description: 'One line.' },
              target_date: {
                type: 'string',
                description: 'ISO-8601 date the phase should end by.',
              },
              tasks: {
                type: 'array',
                description: 'Only for the first two phases; at most 8.',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    effort_min: { type: 'number' },
                    after: {
                      type: 'array',
                      items: { type: 'number' },
                      description:
                        '0-based indices of earlier tasks in this phase that must be done first.',
                    },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['goal', 'phases'],
    },
    async execute(args) {
      const s = store();
      if (s === null) return { error: 'the daily plan is not available here' };
      const goal = findGoal(s, args.goal);
      if (goal === null)
        return { error: 'no single active goal matches; create it with set_goal first' };
      if (s.listPhases(goal.id).length > 0) {
        return {
          error: 'this goal already has a plan; changes go through its page in Today → Goals',
        };
      }
      const phases = Array.isArray(args.phases)
        ? args.phases.map((p: unknown) =>
            typeof p === 'object' && p !== null
              ? {
                  ...(p as Record<string, unknown>),
                  target: (p as Record<string, unknown>).target_date,
                }
              : p,
          )
        : [];
      const draft = cleanGoalDraft({ phases }, now(), goal.targetAt, 'chat');
      if (draft === null) return { error: 'the plan needs at least one phase with a title' };
      s.setGoalDraft(goal.id, draft, now());
      return {
        saved: true,
        goal: goal.title,
        phases: draft.phases.map((p) => p.title),
        where:
          "The draft waits on the goal's page (Today → Goals). Nothing starts until the user accepts it.",
      };
    },
  };
}

export function createUpdateGoalTaskTool(opts: PlanToolOptions = {}): AgentTool {
  const store = opts.store ?? getPlanStore;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'update_goal_task',
    description:
      'Record progress on a goal with a plan: a task done, someone the user is now waiting on (and until when), a wait that ended, or a quote or payment ("Mike will send the plumbing quote by Tuesday", "Mike sent the quote, $18,400", "paid the architect $12,000"). Dina only records money; she never pays. Reply in one short line saying what changed.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal, by its title or id.' },
        task: {
          type: 'string',
          description:
            'Words from the task, or the person being waited on. With waiting_on, a task the plan does not list yet is added, so then write it as a short task title ("Builder quote from Mike").',
        },
        done: { type: 'boolean', description: 'True when the task is finished.' },
        waiting_on: {
          type: 'string',
          description: 'Who the user is now waiting on for this task; empty string ends the wait.',
        },
        waiting_until: { type: 'string', description: 'When they promised it, ISO-8601.' },
        cost: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Whole currency units (18400 for $18,400).' },
            kind: { type: 'string', enum: ['quote', 'paid'] },
            label: { type: 'string', description: 'A few words: "Plumbing quote from Mike".' },
          },
          required: ['amount', 'kind'],
        },
      },
      required: ['goal'],
    },
    async execute(args) {
      const s = store();
      if (s === null) return { error: 'the daily plan is not available here' };
      const goal = findGoal(s, args.goal);
      if (goal === null) return { error: 'no single active goal matches' };
      const t = now();
      let task = args.task !== undefined ? findGoalTask(s, goal.id, args.task) : null;
      const changed: string[] = [];
      const cost =
        typeof args.cost === 'object' && args.cost !== null
          ? (args.cost as Record<string, unknown>)
          : null;
      const who = args.waiting_on !== undefined ? text(args.waiting_on, 100) : '';
      // A wait on something the plan doesn't list yet ("Mike will send the
      // builder quote by the 10th") becomes a task in the current phase.
      let added = false;
      if (task === null && who !== '' && text(args.task, 200) !== '') {
        const phase = s.listPhases(goal.id).find((p) => p.status === 'active');
        task = s.addOwnerTask(
          {
            title: text(args.task, 200),
            goalId: goal.id,
            phaseId: phase?.id ?? '',
            source: 'chat',
          },
          t,
        );
        added = true;
      }
      const needsTask = args.done === true || args.waiting_on !== undefined;
      if (needsTask && task === null) {
        return {
          error: 'no single open task in that goal matches; ask the user which one',
          open_tasks: s
            .listTasks({ goalId: goal.id, statuses: ['open'] })
            .slice(0, 20)
            .map((x) => x.title),
        };
      }
      if (task !== null && args.waiting_on !== undefined) {
        const until = parseDue(args.waiting_until);
        if (until === 'bad') return { error: 'waiting_until is not a date' };
        s.updateTask(task.id, { waitingOn: who, waitingUntil: who === '' ? null : until }, t);
        changed.push(who === '' ? 'wait ended' : `waiting on ${who}`);
      }
      if (cost !== null) {
        const cents = money(cost.amount);
        const kind = cost.kind === 'paid' ? 'paid' : cost.kind === 'quote' ? 'quote' : null;
        if (cents === null || kind === null)
          return { error: 'cost needs a positive amount and kind quote or paid' };
        s.addCost(
          {
            goalId: goal.id,
            taskId: task?.id ?? '',
            phaseId: task?.phaseId ?? '',
            label: text(cost.label, 120) || (task?.title ?? ''),
            kind,
            amountCents: cents,
          },
          t,
        );
        // A quote or payment that arrived ends the wait for it.
        if (task !== null && task.waitingOn !== '' && args.waiting_on === undefined) {
          s.updateTask(task.id, { waitingOn: '' }, t);
          changed.push('wait ended');
        }
        changed.push(
          `${kind === 'paid' ? 'paid' : 'quote'} ${formatGoalMoney(cents, goal.currency)}`,
        );
      }
      if (task !== null && args.done === true) {
        s.updateTask(task.id, { status: 'done', waitingOn: '' }, t);
        changed.push('done');
      }
      if (changed.length === 0) return { error: 'nothing to record' };
      return {
        goal: goal.title,
        task: task?.title,
        ...(added ? { added_task: true } : {}),
        changed,
      };
    },
  };
}

export function createShowGoalTool(opts: PlanToolOptions = {}): AgentTool {
  const store = opts.store ?? getPlanStore;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'show_goal',
    description:
      'Read where one of the user\'s goals stands: its phases, what is next, who they are waiting on, money, and any phase running late. Use it for "how is the house going?", "what am I waiting on?", "how much have I spent?". Answer briefly from the result. Goals change on the Goals page too, so call this rather than answering from earlier messages.',
    parameters: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'The goal, by its title or id.' } },
      required: ['goal'],
    },
    async execute(args) {
      const s = store();
      if (s === null) return { error: 'the daily plan is not available here' };
      const goal = findGoal(s, args.goal);
      if (goal === null)
        return {
          error: 'no single active goal matches',
          goals: s.listGoals(true).map((g) => g.title),
        };
      const t = now();
      const phases = s.listPhases(goal.id);
      const tasks = s.listTasks({ goalId: goal.id });
      const byId = new Map(tasks.map((x) => [x.id, x]));
      const phaseById = new Map(phases.map((p) => [p.id, p]));
      const late = latePhase(phases, t);
      const m = moneySummary(goal.budgetCents, s.listCosts(goal.id));
      const fmt = (c: number | null): string | undefined =>
        c === null ? undefined : formatGoalMoney(c, goal.currency);
      const date = (ms: number | null): string | undefined =>
        ms === null ? undefined : new Date(ms).toISOString().slice(0, 10);
      return {
        goal: goal.title,
        target_date: date(goal.targetAt),
        draft_waiting: goal.draft !== null ? goal.draft.phases.map((p) => p.title) : undefined,
        phases: phases.map((p) => ({
          title: p.title,
          status: p.status,
          target_date: date(p.targetAt),
          done: tasks.filter((x) => x.phaseId === p.id && x.status === 'done').length,
          open: tasks.filter((x) => x.phaseId === p.id && x.status === 'open').length,
        })),
        next: tasks
          .filter((x) => isTaskReady(x, byId, phaseById))
          .slice(0, 5)
          .map((x) => x.title),
        waiting: tasks
          .filter((x) => x.status === 'open' && x.waitingOn !== '')
          .map((x) => ({ task: x.title, on: x.waitingOn, promised: date(x.waitingUntil) })),
        late: late !== null ? { phase: late.phase.title, days: late.days } : undefined,
        money: {
          budget: fmt(m.budgetCents),
          paid: fmt(m.paidCents),
          open_quotes: fmt(m.openQuoteCents),
          left_if_quotes_paid: fmt(m.leftCents),
        },
      };
    },
  };
}

/** The plan tools, when the plan store lives in this process; else none. */
export function createPlanTools(opts: PlanToolOptions = {}): AgentTool[] {
  const store = opts.store ?? getPlanStore;
  if (store() === null) return [];
  return [
    createAddTaskTool(opts),
    createShowPlanTool(opts),
    createSetGoalTool(opts),
    createDraftGoalPlanTool(opts),
    createUpdateGoalTaskTool(opts),
    createShowGoalTool(opts),
  ];
}
