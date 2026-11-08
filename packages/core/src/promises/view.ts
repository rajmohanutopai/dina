/**
 * Promises and waits (docs/PROMISES_AND_WAITS.md): what the owner is owed and
 * what they owe, joined from every place Dina already tracks them. Read-only;
 * each source keeps its own state and its own screen.
 */

import { getCommerceRuntime, type CommerceRuntime } from '../commerce/runtime';
import { tenderSubject } from '../commerce/tender';
import { describePromise } from '../commitment/evidence';
import { getContact } from '../contacts/directory';
import { windowClosesAt } from '../coordination/group_plan';
import {
  getGroupPlanRepository,
  type GroupPlanRepository,
} from '../coordination/group_plan_repository';
import { planDayStart } from '../plan/day';
import { getPlanStore, OWNER_ORIGIN, type PlanStore, type PlanTask } from '../plan/store';

export type PromiseDirection = 'owed_to_me' | 'owed_by_me';
export type PromiseSource = 'plan' | 'talk' | 'group_plan' | 'tender' | 'order' | 'agreement';

export interface PromiseItem {
  /** `<source>:<source id>[:<part>]`, stable across reads. */
  id: string;
  direction: PromiseDirection;
  source: PromiseSource;
  /** A name, never empty. */
  who: string;
  whoDid: string | null;
  /** One line. */
  what: string;
  dueAt: number | null;
  /** Due before the start of today. */
  late: boolean;
  /** The source's own id: a task, plan, tender, order or agreement. */
  ref: string;
}

export interface PromisesAndWaits {
  items: PromiseItem[];
  /** Sources that could not be read just now; the rest still list. */
  missing: PromiseSource[];
}

export interface PromisesDeps {
  plan: () => PlanStore | null;
  groupPlans: () => GroupPlanRepository | null;
  commerce: () => CommerceRuntime | null;
  /** A contact's name, or null when unknown. */
  nameFor: (did: string) => string | null;
}

const UNKNOWN = 'Someone';

const TALK_PREFIX = 'talk:';

/** The `sourceRef` a tracked Talk promise carries. */
export function talkSourceRef(contactDid: string, messageId: string): string {
  return `${TALK_PREFIX}${contactDid}:${messageId}`;
}

/** The contact DID inside a Talk promise's `sourceRef`, or null. */
export function talkContactDid(sourceRef: string): string | null {
  if (!sourceRef.startsWith(TALK_PREFIX)) return null;
  const rest = sourceRef.slice(TALK_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0) return null;
  return rest.slice(0, cut);
}

function defaultDeps(): PromisesDeps {
  return {
    plan: getPlanStore,
    groupPlans: getGroupPlanRepository,
    commerce: getCommerceRuntime,
    nameFor: (did) => {
      const name = getContact(did)?.displayName?.trim() ?? '';
      return name === '' ? null : name;
    },
  };
}

function names(dids: string[], nameFor: PromisesDeps['nameFor']): string {
  const known = dids.map((d) => nameFor(d) ?? UNKNOWN);
  if (known.length <= 2) return known.join(' and ');
  return `${known.slice(0, 2).join(', ')} and ${known.length - 2} more`;
}

function planItems(store: PlanStore, deps: PromisesDeps): PromiseItem[] {
  const archived = new Set(
    store
      .listGoals()
      .filter((g) => !g.active)
      .map((g) => g.id),
  );
  const out: PromiseItem[] = [];
  for (const t of store.listTasks({ statuses: ['open'] })) {
    if (t.goalId !== '' && archived.has(t.goalId)) continue;
    const did = t.origin === OWNER_ORIGIN ? talkContactDid(t.sourceRef) : null;
    const fromTalk = t.source === 'talk' && did !== null;
    if (t.waitingOn !== '') {
      out.push(item(t, 'owed_to_me', fromTalk ? 'talk' : 'plan', t.waitingOn, did, t.waitingUntil));
    } else if (fromTalk) {
      out.push(item(t, 'owed_by_me', 'talk', deps.nameFor(did) ?? UNKNOWN, did, t.dueAt));
    }
  }
  return out;
}

function item(
  t: PlanTask,
  direction: PromiseDirection,
  source: PromiseSource,
  who: string,
  whoDid: string | null,
  dueAt: number | null,
): PromiseItem {
  return {
    id: `${source}:${t.id}`,
    direction,
    source,
    who: who.trim() === '' ? UNKNOWN : who.trim(),
    whoDid,
    what: t.title,
    dueAt,
    late: false,
    ref: t.id,
  };
}

function groupPlanItems(repo: GroupPlanRepository, deps: PromisesDeps): PromiseItem[] {
  const out: PromiseItem[] = [];
  for (const plan of repo.listOpen()) {
    const waiting = plan.guests.filter((g) => g.outcome === 'waiting').map((g) => g.contactDid);
    if (waiting.length === 0) continue;
    out.push({
      id: `group_plan:${plan.planId}`,
      direction: 'owed_to_me',
      source: 'group_plan',
      who: names(waiting, deps.nameFor),
      whoDid: waiting.length === 1 ? waiting[0] : null,
      what: `An answer about ${plan.intent}`,
      dueAt: windowClosesAt(plan),
      late: false,
      ref: plan.planId,
    });
  }
  return out;
}

function tenderItems(runtime: CommerceRuntime, deps: PromisesDeps, now: number): PromiseItem[] {
  const out: PromiseItem[] = [];
  for (const tender of runtime.tenders.listTenders()) {
    if (tender.expiresAt <= now) continue;
    const waiting = runtime.tenders
      .listMembers(tender.tenderId)
      .filter((m) => m.quoteId === '')
      .map((m) => m.supplierDid);
    if (waiting.length === 0) continue;
    out.push({
      id: `tender:${tender.tenderId}`,
      direction: 'owed_to_me',
      source: 'tender',
      who: names(waiting, deps.nameFor),
      whoDid: waiting.length === 1 ? waiting[0] : null,
      what: `A quote for ${tenderSubject(tender.linesJson) ?? 'your items'}`,
      dueAt: tender.expiresAt,
      late: false,
      ref: tender.tenderId,
    });
  }
  return out;
}

function orderItems(runtime: CommerceRuntime, deps: PromisesDeps): PromiseItem[] {
  return runtime.buyerOrders.listUnsettled().map(({ supplierDid, record }) => ({
    id: `order:${record.purchaseOrderId}`,
    direction: 'owed_to_me' as const,
    source: 'order' as const,
    who: deps.nameFor(supplierDid) ?? UNKNOWN,
    whoDid: supplierDid,
    what: 'An answer to your order',
    dueAt: null,
    late: false,
    ref: record.purchaseOrderId,
  }));
}

function agreementItems(runtime: CommerceRuntime, deps: PromisesDeps): PromiseItem[] {
  const out: PromiseItem[] = [];
  for (const a of runtime.terms.agreements()) {
    if (a.state !== 'accepted') continue;
    // The host sells the space; the vendor buys it.
    const mine = a.role === 'host' ? 'seller' : 'buyer';
    a.promises.forEach((p, i) => {
      out.push({
        id: `agreement:${a.proposalDigest}:${i}`,
        direction: p.by === mine ? 'owed_by_me' : 'owed_to_me',
        source: 'agreement',
        who: deps.nameFor(a.counterpartyDid) ?? UNKNOWN,
        whoDid: a.counterpartyDid,
        what: describePromise(p),
        dueAt: null,
        late: false,
        ref: a.proposalDigest,
      });
    });
  }
  return out;
}

/** Late first, then by date, then undated; ties by who. */
function compare(a: PromiseItem, b: PromiseItem): number {
  if (a.late !== b.late) return a.late ? -1 : 1;
  const da = a.dueAt ?? Infinity;
  const db = b.dueAt ?? Infinity;
  if (da !== db) return da - db;
  return a.who.localeCompare(b.who) || a.id.localeCompare(b.id);
}

/**
 * Every promise and wait Dina knows of. A source that is not running here
 * (no commerce on this node) adds nothing; one that fails to read is named in
 * `missing`.
 */
export function listPromisesAndWaits(
  now: number,
  over: Partial<PromisesDeps> = {},
): PromisesAndWaits {
  const deps = { ...defaultDeps(), ...over };
  const items: PromiseItem[] = [];
  const missing: PromiseSource[] = [];
  const read = (sources: PromiseSource[], fn: () => PromiseItem[]): void => {
    try {
      items.push(...fn());
    } catch {
      missing.push(...sources);
    }
  };
  const store = deps.plan();
  if (store !== null) read(['plan', 'talk'], () => planItems(store, deps));
  const repo = deps.groupPlans();
  if (repo !== null) read(['group_plan'], () => groupPlanItems(repo, deps));
  const runtime = deps.commerce();
  if (runtime !== null) {
    read(['tender'], () => tenderItems(runtime, deps, now));
    read(['order'], () => orderItems(runtime, deps));
    read(['agreement'], () => agreementItems(runtime, deps));
  }
  const dayStart = planDayStart(now);
  for (const it of items) it.late = it.dueAt !== null && it.dueAt < dayStart;
  items.sort(compare);
  return { items, missing };
}
