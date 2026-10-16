/**
 * Drawing out the value model with an agent (COMMITMENT_KERNEL §7, §15 step 5).
 *
 * Brain helps the owner say what they value: from one turn of the owner's it
 * proposes up to four changes — a value for a choice, a flag or a promise (a
 * business's own costs are negative values), a never-rule, a capacity — and
 * Core shows them to the owner as one card. Nothing changes until the owner
 * says yes. Brain never decides it.
 *
 * What Brain may never see or propose: the walk-away point, the comfort zone,
 * per-part limits, totals and asking terms (the owner's Core form). A
 * never-rule with a figure ("no rent above ₹2,200") is a hard limit in words,
 * so Brain neither sees one nor proposes one. Brain sees never-rules as the
 * parts they constrain, never the owner's wording. With values off for a kind,
 * Brain sees no values or capacities for it. Brain changes only entries in
 * that view, and files an entry only under a persona it may read now.
 *
 * The card carries the exact entries and what each replaces. A yes applies
 * them all if each still stands as proposed; once one has landed the batch only goes forward, and a crash after the
 * yes is finished at the next boot (`reconcileModelChanges`).
 */

import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { WorkflowConflictError } from '../workflow/repository';
import {
  getWorkflowService,
  type ApprovalDecisionHandler,
  type WorkflowHooks,
  type WorkflowService,
} from '../workflow/service';

import {
  decode,
  encode,
  getValueModelStore,
  type ValueEntry,
  type ValueModelStore,
} from './model_store';

import type { NumberPartSpec } from './parts';
import type { NeverCondition } from './value_model';

export const MODEL_CHANGE_CARD = 'commitment_model_change';

/** The mark on a card's task row once a run began writing its changes. */
const STARTED = 'model_change_started';

/** How long the owner has to answer before the card lapses. */
const CARD_LIFETIME_SEC = 7 * 24 * 60 * 60;

/** At most this many changes on one card, from one turn of the owner's. */
export const MAX_CHANGES_PER_CARD = 4;

export type ModelChange =
  /**
   * `minted`: a new entry whose id Core chose. Without it, the id must name an
   * entry in Brain's view, so a refusal never says whether a hidden one exists.
   */
  | { action: 'put'; entry: ValueEntry; minted?: boolean }
  | { action: 'remove'; kind: string; id: string };

export interface ModelChangeItem {
  action: 'put' | 'remove';
  entry_id: string;
  /** The entry to keep (encoded, bigints exact); absent for a removal. */
  entry_json?: string;
  /** The entry as it stood when proposed (encoded); null when there was none. */
  replaces_json: string | null;
}

export interface ModelChangePayload {
  type: typeof MODEL_CHANGE_CARD;
  kind: string;
  changes: ModelChangeItem[];
}

const VALUE_TYPES: ReadonlySet<string> = new Set(['choice', 'flag', 'promise']);

const hasFigure = (all: readonly NeverCondition[]): boolean =>
  all.some((c) => 'below' in c || 'above' in c);

// ---------------------------------------------------------------------------
// What Brain sees
// ---------------------------------------------------------------------------

/**
 * The entries Brain may see and name: those it may read now, less never-rules
 * with a figure, and less values and capacities when the owner switched values
 * off for the kind. The one list both Brain's view and its proposals use.
 */
export function brainVisibleEntries(
  store: Pick<ValueModelStore, 'entriesForBrain'>,
  kind: string,
  valuesOn: boolean,
): ValueEntry[] {
  return store.entriesForBrain(kind).filter((e) => {
    if (e.body.type === 'never') return !hasFigure(e.body.all);
    if (!valuesOn && (VALUE_TYPES.has(e.body.type) || e.body.type === 'capacity')) return false;
    return true;
  });
}

/**
 * One entry as Brain reads it: numbers as strings; a never-rule as the parts it
 * constrains only, never the owner's wording.
 */
export function brainEntryView(entry: ValueEntry): Record<string, unknown> {
  const head = { id: entry.id, ...(entry.persona !== undefined ? { persona: entry.persona } : {}) };
  if (entry.body.type === 'never')
    return {
      ...head,
      body: { type: 'never', parts: [...new Set(entry.body.all.map((c) => c.part))].sort() },
    };
  return JSON.parse(
    JSON.stringify({ ...head, body: entry.body }, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString(10) : v,
    ),
  ) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plain words for the owner's card
// ---------------------------------------------------------------------------

const rupees = (v: bigint): string => (v < 0n ? `−₹${(-v).toString(10)}` : `₹${v.toString(10)}`);

/** A number part's value in its own unit: money from minor units, a ratio from basis points. */
function amount(part: string, v: bigint, numbers: readonly NumberPartSpec[]): string {
  const spec = numbers.find((n) => n.name === part);
  const twoPlaces = (x: bigint): string => {
    const neg = x < 0n;
    const a = neg ? -x : x;
    const cents = a % 100n;
    const whole = (a / 100n).toString(10);
    return `${neg ? '−' : ''}${cents === 0n ? whole : `${whole}.${cents.toString(10).padStart(2, '0')}`}`;
  };
  if (spec?.kind === 'money') return `₹${twoPlaces(v)}`;
  if (spec?.kind === 'ratio_bps') return `${twoPlaces(v)}%`;
  return v.toString(10);
}

function condition(c: NeverCondition, numbers: readonly NumberPartSpec[]): string {
  if ('present' in c) return `${c.part} is part of the deal`;
  if ('flag' in c) return c.flag ? `${c.part} is agreed` : `${c.part} is not agreed`;
  if ('choice' in c) return `${c.part} is ${c.choice}`;
  if ('below' in c) return `${c.part} is below ${amount(c.part, c.below, numbers)}`;
  return `${c.part} is above ${amount(c.part, c.above, numbers)}`;
}

/** The entry in plain words, for the owner. Never anything from the Core form. */
export function describeEntry(entry: ValueEntry, numbers: readonly NumberPartSpec[] = []): string {
  const b = entry.body;
  let words: string;
  switch (b.type) {
    case 'choice':
      // The seller's share of a delivery saving is a choice, not a price.
      words =
        b.part === 'saving_share'
          ? `pass on ${b.option === 'third' ? 'a third' : b.option === 'most' ? 'most' : 'half'} of what a cheaper delivery day saves you`
          : `${b.option} for ${b.part} is worth ${rupees(b.rupees)} a month to you`;
      break;
    case 'flag':
      words = `${b.part} is worth ${rupees(b.set)} a month to you if agreed, ${rupees(b.unset)} if not`;
      break;
    case 'promise': {
      const dims = Object.entries(b.value.dimensions)
        .map(([d, v]) => `${d} ${String(v)}`)
        .join(', ');
      words = `${b.part} (${dims}) is worth ${rupees(b.value.rupees)} a month to you`;
      break;
    }
    case 'never':
      words = `never agree when ${b.all.map((c) => condition(c, numbers)).join(' and ')} (“${b.label}”)`;
      break;
    case 'capacity':
      words = `you can promise at most ${b.amount.toString(10)} ${b.dimension} of ${b.part} in all`;
      break;
  }
  return entry.persona === undefined ? words : `${words}; kept in ${entry.persona}`;
}

// ---------------------------------------------------------------------------
// Brain's proposal
// ---------------------------------------------------------------------------

export type ProposeError =
  | 'numeric_never_rule'
  | 'persona_not_readable'
  | 'persona_closed'
  | 'no_such_entry'
  | 'too_many'
  | 'values_off'
  | 'turn_already_used'
  | 'owner_turn_not_proven';

export type ProposeResult = { ok: true; taskId: string } | { ok: false; error: ProposeError };

/**
 * What Brain may propose, beyond the entry being well formed for its kind
 * (the caller parses it with the owner's own rules). Null when allowed.
 */
export function brainEntryProblem(
  store: Pick<ValueModelStore, 'brainMayRead'>,
  entry: ValueEntry,
  valuesOn: boolean,
): 'numeric_never_rule' | 'persona_not_readable' | 'values_off' | null {
  if (entry.body.type === 'never' && hasFigure(entry.body.all)) return 'numeric_never_rule';
  if (!valuesOn && (VALUE_TYPES.has(entry.body.type) || entry.body.type === 'capacity'))
    return 'values_off';
  if (entry.persona !== undefined && !store.brainMayRead(entry.persona))
    return 'persona_not_readable';
  return null;
}

function changeWords(
  change: ModelChange,
  existing: ValueEntry | null,
  numbers: readonly NumberPartSpec[],
): string {
  if (change.action === 'remove')
    return `stop using: ${existing === null ? change.id : describeEntry(existing, numbers)}`;
  const now = describeEntry(change.entry, numbers);
  return existing === null
    ? `add: ${now}`
    : `change “${describeEntry(existing, numbers)}” to: ${now}`;
}

/** The key that spends one turn of the owner's on one card, across restarts. */
export function turnKey(releaseSession: string, turnId: string): string {
  return `commitment-model-change:${releaseSession}:${turnId}`;
}

/**
 * Raise one owner's card for the changes Brain proposes from one turn of the
 * owner's (all one kind of deal). Nothing in the model changes here. The
 * turn's proof is checked last (`proveTurn`), after the changes pass, so a
 * refused proposal does not spend the owner's turn; a turn already spent on a
 * card, before or after a restart, is refused.
 */
export function proposeModelChanges(args: {
  store: ValueModelStore;
  workflow: WorkflowService;
  kind: string;
  numbers: readonly NumberPartSpec[];
  valuesOn: boolean;
  changes: readonly ModelChange[];
  turn: { releaseSession: string; turnId: string };
  proveTurn: () => boolean;
  nowMs: number;
}): ProposeResult {
  const { store, workflow, kind, changes } = args;
  if (changes.length === 0 || changes.length > MAX_CHANGES_PER_CARD)
    return { ok: false, error: 'too_many' };
  const ids = changes.map((c) => (c.action === 'put' ? c.entry.id : c.id));
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'too_many' };
  const key = turnKey(args.turn.releaseSession, args.turn.turnId);
  if (workflow.store().getByIdempotencyKey(key) !== null)
    return { ok: false, error: 'turn_already_used' };
  const visible = new Set(brainVisibleEntries(store, kind, args.valuesOn).map((e) => e.id));
  const items: ModelChangeItem[] = [];
  const lines: string[] = [];
  for (const change of changes) {
    if ((change.action === 'put' ? change.entry.kind : change.kind) !== kind)
      return { ok: false, error: 'too_many' };
    const id = change.action === 'put' ? change.entry.id : change.id;
    if (change.action === 'put') {
      const problem = brainEntryProblem(store, change.entry, args.valuesOn);
      if (problem !== null) return { ok: false, error: problem };
    }
    // Brain changes only what it can see: an id it names must be in its view.
    // A hidden entry and a missing one get the same answer, so a refusal never
    // tells Brain what it was not shown.
    const minted = change.action === 'put' && change.minted === true;
    if (!minted && !visible.has(id)) return { ok: false, error: 'no_such_entry' };
    const existing = store.entryNow(kind, id);
    if (existing === 'closed')
      return { ok: false, error: minted ? 'persona_closed' : 'no_such_entry' };
    // A minted id names a new entry; the one reserved id (the seller's share,
    // one setting) may also replace the setting Brain can see.
    const replacesSetting = id === 'saving_share' && visible.has(id);
    if (minted && existing !== null && !replacesSetting)
      return { ok: false, error: 'no_such_entry' };
    items.push({
      action: change.action,
      entry_id: id,
      ...(change.action === 'put' ? { entry_json: encode(change.entry) } : {}),
      replaces_json: existing === null ? null : encode(existing),
    });
    lines.push(changeWords(change, existing, args.numbers));
  }
  if (!args.proveTurn()) return { ok: false, error: 'owner_turn_not_proven' };
  const payload: ModelChangePayload = { type: MODEL_CHANGE_CARD, kind, changes: items };
  const description =
    lines.length === 1
      ? `Dina suggests a change to what she knows about your deals — ${lines[0] ?? ''}. Apply it?`
      : `Dina suggests ${String(lines.length)} changes to what she knows about your deals:\n${lines
          .map((l, i) => `${String(i + 1)}. ${l}`)
          .join('\n')}\nApply them all?`;
  const taskId = `cmc-${args.turn.turnId}-${String(args.nowMs)}`.slice(0, 120);
  try {
    workflow.create({
      id: taskId,
      kind: WorkflowTaskKind.Approval,
      description,
      payload: JSON.stringify(payload),
      idempotencyKey: key,
      correlationId: MODEL_CHANGE_CARD,
      origin: 'system',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(args.nowMs / 1000) + CARD_LIFETIME_SEC,
    });
  } catch (error) {
    if (error instanceof WorkflowConflictError) return { ok: false, error: 'turn_already_used' };
    throw error;
  }
  return { ok: true, taskId };
}

// ---------------------------------------------------------------------------
// The owner's answer
// ---------------------------------------------------------------------------

export function parseModelChangePayload(json: string): ModelChangePayload | null {
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  if (p === null || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  if (r.type !== MODEL_CHANGE_CARD || typeof r.kind !== 'string' || !Array.isArray(r.changes))
    return null;
  if (r.changes.length === 0 || r.changes.length > MAX_CHANGES_PER_CARD) return null;
  for (const c of r.changes as unknown[]) {
    if (c === null || typeof c !== 'object') return null;
    const i = c as Record<string, unknown>;
    if (typeof i.entry_id !== 'string') return null;
    if (i.action !== 'put' && i.action !== 'remove') return null;
    if (i.action === 'put' && typeof i.entry_json !== 'string') return null;
    if (i.replaces_json !== null && typeof i.replaces_json !== 'string') return null;
  }
  return r as unknown as ModelChangePayload;
}

export type ApplyResult =
  | { ok: true; version: number }
  /** Nothing was written: the card ends here. */
  | { ok: false; reason: 'out_of_date' | 'persona_closed' | 'unreadable' }
  /**
   * Some of the batch may stand: the card stays running, and each boot goes
   * forward until every change is in. The owner approved them all.
   */
  | { ok: false; reason: 'incomplete' };

/** The entry as it should stand once an item is applied (encoded); null for a removal. */
const target = (item: ModelChangeItem): string | null =>
  item.action === 'remove' ? null : (item.entry_json ?? null);

/** The entry as it stands now (encoded), or 'closed'. */
function standing(store: ValueModelStore, kind: string, id: string): string | null | 'closed' {
  const now = store.entryNow(kind, id);
  return now === 'closed' ? 'closed' : now === null ? null : encode(now);
}

/**
 * Apply the changes the owner approved, all of them. Until a run has begun
 * writing — the card's row records it before the first write — a stale entry
 * or a closed persona ends the card with nothing written. Once begun, the
 * batch only goes forward: every item still as
 * proposed, or already as approved, is written again — a store write is safe
 * to repeat, and repeating it finishes one a crash cut short (a stale copy,
 * an index row) — and anything that stops it leaves the card for the next
 * run. An item the owner changed since stands as they left it.
 */
export function applyModelChanges(
  store: ValueModelStore,
  payload: ModelChangePayload,
  nowMs: number,
  /**
   * Whether a run already began writing this card, as recorded on its task
   * row; and how to record it, once, before the first write. Without these
   * (a test), the batch counts as not started and nothing is recorded.
   */
  progress: { started: boolean; markStarted: () => boolean } = {
    started: false,
    markStarted: () => true,
  },
): ApplyResult {
  const steps: {
    item: ModelChangeItem;
    entry: ValueEntry | null;
    state: 'pending' | 'landed' | 'moved' | 'closed';
  }[] = [];
  for (const item of payload.changes) {
    let entry: ValueEntry | null = null;
    if (item.action === 'put') {
      try {
        entry = decode<ValueEntry>(item.entry_json as string);
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
      if (entry.kind !== payload.kind || entry.id !== item.entry_id)
        return { ok: false, reason: 'unreadable' };
    }
    const now = standing(store, payload.kind, item.entry_id);
    const closedTarget = entry?.persona !== undefined && !store.personaWritable(entry.persona);
    const state =
      now === 'closed' || closedTarget
        ? 'closed'
        : now === target(item)
          ? 'landed'
          : now === item.replaces_json
            ? 'pending'
            : 'moved';
    steps.push({ item, entry, state });
  }
  // Started is what the card's row says, never a guess from what stands: an
  // entry that landed may sit in a persona closed now.
  if (!progress.started) {
    if (steps.some((x) => x.state === 'closed')) return { ok: false, reason: 'persona_closed' };
    if (steps.some((x) => x.state === 'moved' || x.state === 'landed'))
      return { ok: false, reason: 'out_of_date' };
    if (!progress.markStarted()) return { ok: false, reason: 'incomplete' };
  }
  let version = store.form(payload.kind).version;
  for (const step of steps) {
    if (step.state === 'moved') continue;
    if (step.state === 'closed') return { ok: false, reason: 'incomplete' };
    try {
      const wrote =
        step.entry === null
          ? store.removeEntry({ kind: payload.kind, id: step.item.entry_id }, nowMs)
          : store.putEntry(step.entry, nowMs);
      if (!wrote.ok) return { ok: false, reason: 'incomplete' };
      version = wrote.version;
    } catch {
      return { ok: false, reason: 'incomplete' };
    }
  }
  return { ok: true, version };
}

/**
 * Apply one approved card and settle its task. The task is claimed first
 * (queued → running at the owner's yes; already running only at boot, when
 * nothing else runs), so no two runs apply one card, and a card already ended
 * is never applied. Any failure is the task's, never a throw.
 */
function settle(
  workflow: WorkflowService,
  store: ValueModelStore | null,
  task: WorkflowTask,
  nowMs: number,
  from: 'queued' | 'running',
): void {
  const payload = parseModelChangePayload(task.payload);
  if (payload === null) return;
  if (from === 'queued') {
    let claimed = false;
    try {
      claimed = workflow
        .store()
        .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    } catch {
      claimed = false;
    }
    if (!claimed) return;
  }
  // Whether a run already began writing: the card's own row, which outlives a crash.
  const started = workflow.store().getById(task.id)?.internal_stash === STARTED;
  const progress = {
    started,
    markStarted: (): boolean => {
      try {
        return workflow.store().setInternalStash(task.id, STARTED, nowMs);
      } catch {
        return false;
      }
    },
  };
  let result: ApplyResult;
  try {
    result =
      store === null
        ? { ok: false, reason: 'unreadable' }
        : applyModelChanges(store, payload, nowMs, progress);
  } catch {
    result = { ok: false, reason: 'incomplete' };
  }
  // Part of the batch may stand: the card stays running for the boot to finish.
  if (!result.ok && result.reason === 'incomplete') return;
  try {
    if (result.ok)
      workflow.complete(task.id, JSON.stringify({ version: result.version }), 'applied');
    else workflow.fail(task.id, result.reason);
  } catch {
    /* the boot finds the card running and settles it */
  }
}

export function makeModelChangeDecisionHandler(deps: {
  store: () => Promise<ValueModelStore | null>;
  workflow: () => WorkflowService | null;
  nowMs: () => number;
}): ApprovalDecisionHandler {
  return ({ task, decision }: { task: WorkflowTask; decision: string }) => {
    if (decision !== 'approved' || parseModelChangePayload(task.payload) === null) return;
    const workflow = deps.workflow();
    if (workflow === null) return;
    void deps
      .store()
      .catch(() => null)
      .then((store) => settle(workflow, store, task, deps.nowMs(), 'queued'));
  };
}

/**
 * At boot, finish every card the owner approved whose changes were not
 * settled: still queued (a crash before the run claimed it), or running (a
 * crash mid-run, or a batch a failed write left). Nothing else runs at boot,
 * and applying again goes forward from what stands.
 */
export function reconcileModelChanges(
  workflow: WorkflowService,
  store: ValueModelStore,
  nowMs: number,
): number {
  let n = 0;
  for (const task of workflow.store().getByCorrelationId(MODEL_CHANGE_CARD)) {
    if (task.status === WorkflowTaskState.Queued) settle(workflow, store, task, nowMs, 'queued');
    else if (task.status === WorkflowTaskState.Running)
      settle(workflow, store, task, nowMs, 'running');
    else continue;
    n += 1;
  }
  return n;
}

let installed: ValueModelStore | null = null;

/** The value model's contribution to the workflow service, composed at every host. */
export function modelChangeWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: makeModelChangeDecisionHandler({
      store: async () => installed ?? (await getValueModelStore()),
      workflow: getWorkflowService,
      nowMs: over.nowMs ?? Date.now,
    }),
  };
}

/** Boot: finish approved changes a crash left unapplied. */
export async function reconcileModelChangesAtBoot(nowMs: number = Date.now()): Promise<number> {
  const workflow = getWorkflowService();
  const store = installed ?? (await getValueModelStore());
  return workflow === null || store === null ? 0 : reconcileModelChanges(workflow, store, nowMs);
}

/** Tests: the store the hook applies changes to (null: the node's own). */
export function installModelChangeStore(store: ValueModelStore | null): void {
  installed = store;
}
