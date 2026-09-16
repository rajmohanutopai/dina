/**
 * The plan store (docs/GROUP_COORDINATION_ARCHITECTURE.md §7): owner-private,
 * in the identity store beside the contact metadata it is made of, deletable.
 *
 * One JSON row per plan. The aggregate is read whole and written whole — no
 * query needs a column beyond the state it is in — so the row is the record,
 * and the only thing the table knows about its contents is enough to list
 * what is open. Rehydration validates the shape: a row this build cannot read
 * as a plan is reported as no plan, never half-believed.
 */

import { isMeetingSlot, type FoldResult, type SpokeReply } from './group_fold';
import {
  DISCLOSURE_KINDS,
  MAX_GROUP_GUESTS,
  MAX_PLAN_CANDIDATES,
  MAX_WINDOW_SECONDS,
  type Disclosure,
  type GroupPlan,
  type GroupPlanState,
  type GuestRecord,
  type SpokeRecord,
} from './group_plan';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface GroupPlanRepository {
  /** Insert or replace. */
  put(plan: GroupPlan): void;
  get(planId: string): GroupPlan | null;
  /** Every plan not settled or abandoned, newest first. */
  listOpen(): GroupPlan[];
  /** Every plan the organizer has not stopped — open or settled — newest first, bounded. */
  listRecent(limit: number): GroupPlan[];
  /** Deleting a plan deletes what guests disclosed for it. */
  remove(planId: string): boolean;
}

let repo: GroupPlanRepository | null = null;
export function setGroupPlanRepository(r: GroupPlanRepository | null): void {
  repo = r;
}
export function getGroupPlanRepository(): GroupPlanRepository | null {
  return repo;
}

const STATES: ReadonlySet<string> = new Set<GroupPlanState>([
  'proposing',
  'folded',
  'confirming',
  'settled',
  'abandoned',
]);
const OUTCOMES: ReadonlySet<string> = new Set(['waiting', 'answered', 'unreachable']);
const REPLY_STATUSES: ReadonlySet<string> = new Set(['accepted', 'counter', 'needs_more_info']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isSlotList(v: unknown): boolean {
  return Array.isArray(v) && v.every(isMeetingSlot);
}
function isReply(v: unknown): v is SpokeReply {
  if (!isRecord(v) || typeof v.status !== 'string' || !REPLY_STATUSES.has(v.status)) return false;
  if (v.accepted_slots !== undefined && !isSlotList(v.accepted_slots)) return false;
  if (v.counter_slots !== undefined && !isSlotList(v.counter_slots)) return false;
  if (v.message !== undefined && typeof v.message !== 'string') return false;
  return true;
}
function isDisclosure(v: unknown): v is Disclosure {
  return (
    isRecord(v) &&
    typeof v.kind === 'string' &&
    (DISCLOSURE_KINDS as readonly string[]).includes(v.kind) &&
    typeof v.text === 'string' &&
    v.about === 'household'
  );
}
function isSpoke(v: unknown): v is SpokeRecord {
  if (!isRecord(v) || typeof v.round !== 'number' || !Number.isInteger(v.round)) return false;
  if (v.stage === 'grant_requested') return typeof v.requestId === 'string' && v.requestId !== '';
  if (v.stage === 'queried') {
    return typeof v.taskId === 'string' && v.taskId !== '' && typeof v.queryId === 'string' && v.queryId !== '';
  }
  return false;
}
function isGuest(v: unknown): v is GuestRecord {
  return (
    isRecord(v) &&
    typeof v.contactDid === 'string' &&
    v.contactDid !== '' &&
    typeof v.required === 'boolean' &&
    Array.isArray(v.spokes) &&
    v.spokes.every(isSpoke) &&
    (v.reply === null || isReply(v.reply)) &&
    typeof v.outcome === 'string' &&
    OUTCOMES.has(v.outcome) &&
    Array.isArray(v.disclosures) &&
    v.disclosures.every(isDisclosure)
  );
}
function isFold(v: unknown): v is FoldResult {
  return (
    isRecord(v) &&
    typeof v.state === 'string' &&
    isSlotList(v.agreed) &&
    Array.isArray(v.missingRequired) &&
    Array.isArray(v.emptiedBy) &&
    isRecord(v.optionalFit) &&
    isRecord(v.counters) &&
    Array.isArray(v.needsMoreInfo)
  );
}

/**
 * Read a stored row back as a plan, or null. Strict on purpose: the bounds
 * that admitted the plan are re-checked, so a hand-edited row cannot carry a
 * ninth guest past the ceiling the transitions enforce.
 */
export function rehydrateGroupPlan(json: string): GroupPlan | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const p = parsed;
  if (
    typeof p.planId !== 'string' ||
    p.planId === '' ||
    typeof p.intent !== 'string' ||
    typeof p.createdAt !== 'number' ||
    typeof p.updatedAt !== 'number' ||
    typeof p.windowSeconds !== 'number' ||
    !Number.isInteger(p.windowSeconds) ||
    p.windowSeconds < 1 ||
    p.windowSeconds > MAX_WINDOW_SECONDS ||
    typeof p.round !== 'number' ||
    !Number.isInteger(p.round) ||
    !(p.roundOpenedAt === null || typeof p.roundOpenedAt === 'number') ||
    !Array.isArray(p.guests) ||
    p.guests.length === 0 ||
    p.guests.length > MAX_GROUP_GUESTS ||
    !p.guests.every(isGuest) ||
    !Array.isArray(p.candidates) ||
    p.candidates.length > MAX_PLAN_CANDIDATES ||
    !isSlotList(p.candidates) ||
    !(p.fold === null || isFold(p.fold)) ||
    !(p.chosen === null || isMeetingSlot(p.chosen)) ||
    typeof p.state !== 'string' ||
    !STATES.has(p.state)
  ) {
    return null;
  }
  return p as unknown as GroupPlan;
}

function rowToPlan(row: DBRow): GroupPlan | null {
  return rehydrateGroupPlan(String(row.plan_json ?? ''));
}

export class SQLiteGroupPlanRepository implements GroupPlanRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(plan: GroupPlan): void {
    if (plan.planId === '') throw new Error('group_plans.repository: planId is required');
    this.db.execute(
      `INSERT INTO group_plans (plan_id, state, created_at, updated_at, plan_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at,
         plan_json = excluded.plan_json`,
      [plan.planId, plan.state, plan.createdAt, plan.updatedAt, JSON.stringify(plan)],
    );
  }

  get(planId: string): GroupPlan | null {
    const rows = this.db.query('SELECT plan_json FROM group_plans WHERE plan_id = ?', [planId]);
    return rows.length === 0 ? null : rowToPlan(rows[0]);
  }

  listOpen(): GroupPlan[] {
    const rows = this.db.query(
      `SELECT plan_json FROM group_plans
        WHERE state NOT IN ('settled', 'abandoned')
        ORDER BY updated_at DESC`,
    );
    return rows.map(rowToPlan).filter((p): p is GroupPlan => p !== null);
  }

  listRecent(limit: number): GroupPlan[] {
    const rows = this.db.query(
      `SELECT plan_json FROM group_plans
        WHERE state != 'abandoned'
        ORDER BY updated_at DESC
        LIMIT ?`,
      [Math.max(1, Math.floor(limit))],
    );
    return rows.map(rowToPlan).filter((p): p is GroupPlan => p !== null);
  }

  remove(planId: string): boolean {
    const before = this.db.query('SELECT 1 FROM group_plans WHERE plan_id = ?', [planId]);
    if (before.length === 0) return false;
    this.db.execute('DELETE FROM group_plans WHERE plan_id = ?', [planId]);
    return true;
  }
}

/** Test double, and the phone's fallback before persistence is ready. */
export class InMemoryGroupPlanRepository implements GroupPlanRepository {
  private readonly rows = new Map<string, string>();

  put(plan: GroupPlan): void {
    if (plan.planId === '') throw new Error('group_plans.repository: planId is required');
    this.rows.set(plan.planId, JSON.stringify(plan));
  }
  get(planId: string): GroupPlan | null {
    const json = this.rows.get(planId);
    return json === undefined ? null : rehydrateGroupPlan(json);
  }
  listOpen(): GroupPlan[] {
    return [...this.rows.values()]
      .map(rehydrateGroupPlan)
      .filter((p): p is GroupPlan => p !== null && p.state !== 'settled' && p.state !== 'abandoned')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  listRecent(limit: number): GroupPlan[] {
    return [...this.rows.values()]
      .map(rehydrateGroupPlan)
      .filter((p): p is GroupPlan => p !== null && p.state !== 'abandoned')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.floor(limit)));
  }
  remove(planId: string): boolean {
    return this.rows.delete(planId);
  }
}
