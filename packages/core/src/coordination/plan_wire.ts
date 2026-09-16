/**
 * The plan on the wire (docs/GROUP_COORDINATION_ARCHITECTURE.md §9) —
 * snake_case, and only what a surface renders. One projection, shared by the
 * owner routes that answer it and the clients that read it, so the phone, the
 * web and Brain's tool all see the same bytes.
 *
 * Spoke task ids are exposed so a card can key each guest row to its ordinary
 * `service_query` lifecycle message; preflight request ids are not — nothing
 * renders them. Requirements are the de-identified derivation (§6 point 4):
 * kinds and counts, never a household or a line of text.
 */

import {
  deriveRequirements,
  windowClosesAt,
  type Disclosure,
  type GroupPlan,
  type GroupPlanState,
  type Requirement,
  type SpokeOutcome,
} from './group_plan';

import type { FoldState, MeetingSlot, SpokeReply } from './group_fold';

export interface GroupPlanGuestWire {
  contact_did: string;
  required: boolean;
  outcome: SpokeOutcome;
  reply: SpokeReply | null;
  disclosures: Disclosure[];
  spokes: ({ round: number; stage: 'queried'; task_id: string } | { round: number; stage: 'grant_requested' })[];
}

export interface GroupPlanFoldWire {
  state: FoldState;
  agreed: MeetingSlot[];
  missing_required: string[];
  emptied_by: string[];
  optional_fit: Record<string, MeetingSlot[]>;
  counters: Record<string, MeetingSlot[]>;
  needs_more_info: string[];
}

export interface GroupPlanWire {
  plan_id: string;
  intent: string;
  state: GroupPlanState;
  window_seconds: number;
  round: number;
  round_opened_at: number | null;
  window_closes_at: number | null;
  created_at: number;
  updated_at: number;
  candidates: MeetingSlot[];
  chosen: MeetingSlot | null;
  fold: GroupPlanFoldWire | null;
  guests: GroupPlanGuestWire[];
  requirements: Requirement[];
}

export function projectPlan(plan: GroupPlan): GroupPlanWire {
  return {
    plan_id: plan.planId,
    intent: plan.intent,
    state: plan.state,
    window_seconds: plan.windowSeconds,
    round: plan.round,
    round_opened_at: plan.roundOpenedAt,
    window_closes_at: windowClosesAt(plan),
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    candidates: plan.candidates,
    chosen: plan.chosen,
    fold:
      plan.fold === null
        ? null
        : {
            state: plan.fold.state,
            agreed: plan.fold.agreed,
            missing_required: plan.fold.missingRequired,
            emptied_by: plan.fold.emptiedBy,
            optional_fit: plan.fold.optionalFit,
            counters: plan.fold.counters,
            needs_more_info: plan.fold.needsMoreInfo,
          },
    guests: plan.guests.map((g) => ({
      contact_did: g.contactDid,
      required: g.required,
      outcome: g.outcome,
      reply: g.reply,
      disclosures: g.disclosures,
      spokes: g.spokes.map((s) =>
        s.stage === 'queried'
          ? { round: s.round, stage: s.stage, task_id: s.taskId }
          : { round: s.round, stage: s.stage },
      ),
    })),
    requirements: deriveRequirements(plan),
  };
}

const STATES: ReadonlySet<string> = new Set<GroupPlanState>(['proposing', 'folded', 'confirming', 'settled', 'abandoned']);

/**
 * A wire plan as a client reads it back — the shape a route answers, checked
 * at the field level a surface leans on. Null when the bytes are not a plan.
 */
export function readGroupPlanWire(value: unknown): GroupPlanWire | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (
    typeof p.plan_id !== 'string' ||
    p.plan_id === '' ||
    typeof p.intent !== 'string' ||
    typeof p.state !== 'string' ||
    !STATES.has(p.state) ||
    typeof p.round !== 'number' ||
    !Array.isArray(p.guests) ||
    !Array.isArray(p.candidates) ||
    !Array.isArray(p.requirements)
  ) {
    return null;
  }
  return p as unknown as GroupPlanWire;
}

/**
 * A plan's HANDLE (§11): enough for a caller to name a plan and nothing
 * about who is in it — no guests, no replies, no disclosures. This is what
 * Brain may list, so a turn with no memory of an earlier turn can still find
 * the plan the owner means and read its de-identified hand-off by id.
 */
export interface GroupPlanHandleWire {
  plan_id: string;
  intent: string;
  state: GroupPlanState;
  round: number;
  chosen: MeetingSlot | null;
  updated_at: number;
}

export function projectHandle(plan: GroupPlan): GroupPlanHandleWire {
  return {
    plan_id: plan.planId,
    intent: plan.intent,
    state: plan.state,
    round: plan.round,
    chosen: plan.chosen,
    updated_at: plan.updatedAt,
  };
}

export function readGroupPlanHandles(value: unknown): GroupPlanHandleWire[] {
  if (!Array.isArray(value)) return [];
  const out: GroupPlanHandleWire[] = [];
  for (const v of value) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    const h = v as Record<string, unknown>;
    if (typeof h.plan_id !== 'string' || h.plan_id === '' || typeof h.intent !== 'string') continue;
    if (typeof h.state !== 'string' || !STATES.has(h.state) || typeof h.round !== 'number') continue;
    out.push(h as unknown as GroupPlanHandleWire);
  }
  return out;
}
