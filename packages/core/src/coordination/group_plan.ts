/**
 * THE GROUP PLAN (docs/GROUP_COORDINATION_ARCHITECTURE.md §7) — the
 * organizer's memory of a conversation that happened over N ordinary one-shot
 * calls, and the only place the whole picture exists.
 *
 * It is NOT a coordinator. No node waits on it; no message references it. A
 * guest's node holds nothing that depends on it, so a crash mid-plan leaves N
 * spoke cards in N Talk threads exactly as a crash mid-1:1 does, and the plan
 * is rebuilt from them. It is owner-private, deletable, and deleting it
 * deletes what guests disclosed for it.
 *
 * Everything here is PURE: a transition takes a plan and returns a new plan
 * or a typed refusal, and the store (`group_plan_repository.ts`) persists
 * whatever the transition returned. That is what lets the state machine be
 * tested without a database and the bounds be refused before anything is
 * sent.
 *
 *   proposing ──fold──▶ folded ──choose──▶ confirming ──settle──▶ settled
 *      ▲                  │                                │
 *      └───────widen──────┘◀───────────────────────────────┘ (a guest reneged)
 *   any non-terminal ──abandon──▶ abandoned
 *
 * ROUNDS ARE FAN-OUTS. A propose is one, a confirm is one, a widen is one;
 * three is the ceiling (§4), and a plan that has not settled in three is a
 * conversation for humans.
 */

import { MAX_SERVICE_TTL } from '../d2d/families';
import { oneLine } from '../util/one_line';

import {
  foldGroupPlan,
  isMeetingSlot,
  slotKey,
  type FoldResult,
  type MeetingSlot,
  type SpokeReply,
} from './group_fold';

/** Ceilings (§12). Refused, never truncated silently. */
export const MAX_GROUP_GUESTS = 8;
export const MAX_PLAN_CANDIDATES = 12;
export const MAX_PLAN_ROUNDS = 3;
/** One bounded line; the same ceiling the context projector uses for a text field. */
export const MAX_DISCLOSURE_CHARS = 120;
export const MAX_INTENT_CHARS = 400;
/** A slot's `start` / `end` — a date or a time in words, never a paragraph. */
export const MAX_SLOT_CHARS = 80;
/**
 * The shared reply window (§5, §16 rule 9), in seconds: every spoke of a
 * round closes at the same instant, so the organizer cannot tell a refusal
 * from an outage by WHEN a guest's row changed. Bounded by the D2D wire's own
 * TTL ceiling because each spoke is a `service.query` with that TTL.
 */
export const MAX_WINDOW_SECONDS: number = MAX_SERVICE_TTL;
export const DEFAULT_WINDOW_SECONDS: number = MAX_WINDOW_SECONDS;

export type GroupPlanState = 'proposing' | 'folded' | 'confirming' | 'settled' | 'abandoned';

export type SpokeOutcome = 'waiting' | 'answered' | 'unreachable';

/** What a guest's node chose to say beyond its availability (§6). Never a named person. */
export const DISCLOSURE_KINDS = ['dietary', 'accessibility', 'transport', 'note'] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number];

export interface Disclosure {
  kind: DisclosureKind;
  /** One bounded line. */
  text: string;
  /** The only granularity a disclosure carries on the wire. */
  about: 'household';
}

/**
 * One spoke of one round. A guest with a stored `service.offer` is queried at
 * once (`queried`); a guest without one is first asked for reach through the
 * 1:1 preflight (`service.grant_request`, CONTACT_SERVICES §5.2) and queried
 * the moment the offer lands (`grant_requested` → `queried`). Both stages
 * close with the round's window, so neither is visible as a timing signal.
 */
export type SpokeRecord =
  | { round: number; stage: 'grant_requested'; requestId: string }
  | { round: number; stage: 'queried'; taskId: string; queryId: string };

export interface GuestRecord {
  contactDid: string;
  required: boolean;
  spokes: SpokeRecord[];
  /** The reply to the CURRENT round; cleared when a new round is sent. */
  reply: SpokeReply | null;
  outcome: SpokeOutcome;
  /** Everything this guest's node chose to disclose, across rounds. */
  disclosures: Disclosure[];
}

/**
 * A vendor-bound requirement (§6 point 4, §10): a kind, a count, and the
 * NEEDS — the disclosure lines as the households wrote them, deduplicated —
 * so a bakery can be asked for "one gluten-free portion" and not merely "one
 * dietary requirement". Nothing that names who: no DID, no display name, and
 * `about` never travels. A need is one bounded line the guest's own gate
 * admitted and the organizer's tier agreed to hold.
 */
export interface Requirement {
  kind: DisclosureKind;
  count: number;
  needs: string[];
}

export interface GroupPlan {
  planId: string;
  intent: string;
  createdAt: number;
  updatedAt: number;
  /** The shared reply window for every round, seconds (§5). */
  windowSeconds: number;
  /** Fan-outs sent so far. */
  round: number;
  /** When the current round was opened (ms); null before the first. */
  roundOpenedAt: number | null;
  guests: GuestRecord[];
  /** The organizer's candidates for the CURRENT round, in preference order. */
  candidates: MeetingSlot[];
  fold: FoldResult | null;
  chosen: MeetingSlot | null;
  state: GroupPlanState;
}

export type GroupPlanRefusal =
  | 'empty_intent'
  | 'intent_too_long'
  | 'no_guests'
  | 'too_many_guests'
  | 'duplicate_guest'
  | 'no_required_guest'
  | 'malformed_guest'
  | 'no_candidates'
  | 'too_many_candidates'
  | 'malformed_slot'
  | 'duplicate_candidate'
  | 'rounds_exhausted'
  | 'wrong_state'
  | 'unknown_guest'
  | 'slot_not_agreed'
  | 'malformed_disclosure'
  | 'bad_window'
  | 'required_unanswered';

export interface PlanRefused {
  ok: false;
  refusal: GroupPlanRefusal;
  detail?: string;
}
export type PlanResult = { ok: true; plan: GroupPlan } | PlanRefused;

const refuse = (refusal: GroupPlanRefusal, detail?: string): PlanRefused =>
  detail === undefined ? { ok: false, refusal } : { ok: false, refusal, detail };

function validateCandidates(raw: readonly unknown[]): { ok: true; slots: MeetingSlot[] } | PlanRefused {
  if (raw.length === 0) return refuse('no_candidates');
  if (raw.length > MAX_PLAN_CANDIDATES) {
    return refuse('too_many_candidates', `${raw.length} candidates; the ceiling is ${MAX_PLAN_CANDIDATES}`);
  }
  const slots: MeetingSlot[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isMeetingSlot(value)) return refuse('malformed_slot');
    // The organizer's own candidates are REFUSED when over-long, never
    // clipped: a date string cut in the middle is a different date. (A
    // guest's inbound disclosure text is clipped instead — see
    // `normaliseDisclosure` — because a peer's over-long note must not cost
    // the organizer that peer's availability.)
    const start = oneLine(value.start, MAX_SLOT_CHARS + 1);
    const end = value.end === undefined ? undefined : oneLine(value.end, MAX_SLOT_CHARS + 1);
    const note = value.note === undefined ? undefined : oneLine(value.note, MAX_DISCLOSURE_CHARS + 1);
    if (start === '' || start.length > MAX_SLOT_CHARS) return refuse('malformed_slot', 'start');
    if (end !== undefined && end.length > MAX_SLOT_CHARS) return refuse('malformed_slot', 'end');
    if (note !== undefined && note.length > MAX_DISCLOSURE_CHARS) return refuse('malformed_slot', 'note');
    const slot: MeetingSlot = {
      start,
      ...(end !== undefined && end !== '' ? { end } : {}),
      ...(note !== undefined && note !== '' ? { note } : {}),
    };
    const key = slotKey(slot);
    if (seen.has(key)) return refuse('duplicate_candidate', slot.start);
    seen.add(key);
    slots.push(slot);
  }
  return { ok: true, slots };
}

/**
 * Open a plan. Nothing is sent here — the caller fans out the first round and
 * records each spoke; this only decides whether the plan is one the bounds
 * admit, and refuses by name when it is not.
 *
 * At least one guest must be REQUIRED (§17.2): a plan with only optional
 * guests would "converge" on whatever nobody objected to, which is a date
 * with nobody's yes behind it.
 */
export function createGroupPlan(args: {
  planId: string;
  intent: string;
  guests: readonly { contactDid: string; required: boolean }[];
  candidates: readonly unknown[];
  /** Defaults to the wire ceiling — the most room a human reviewer can have. */
  windowSeconds?: number;
  nowMs: number;
}): PlanResult {
  const windowSeconds = args.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) {
    return refuse('bad_window', `window_seconds must be 1..${MAX_WINDOW_SECONDS}`);
  }
  const intent = oneLine(args.intent, MAX_INTENT_CHARS);
  if (intent === '') return refuse('empty_intent');
  if (args.intent.trim().length > MAX_INTENT_CHARS) return refuse('intent_too_long');
  if (args.guests.length === 0) return refuse('no_guests');
  if (args.guests.length > MAX_GROUP_GUESTS) {
    return refuse('too_many_guests', `${args.guests.length} guests; the ceiling is ${MAX_GROUP_GUESTS}`);
  }
  const seen = new Set<string>();
  const guests: GuestRecord[] = [];
  for (const guest of args.guests) {
    if (typeof guest.contactDid !== 'string' || guest.contactDid.trim() === '' || typeof guest.required !== 'boolean') {
      return refuse('malformed_guest');
    }
    if (seen.has(guest.contactDid)) return refuse('duplicate_guest', guest.contactDid);
    seen.add(guest.contactDid);
    guests.push({
      contactDid: guest.contactDid,
      required: guest.required,
      spokes: [],
      reply: null,
      outcome: 'waiting',
      disclosures: [],
    });
  }
  if (!guests.some((g) => g.required)) return refuse('no_required_guest');
  const candidates = validateCandidates(args.candidates);
  if (!candidates.ok) return candidates;
  return {
    ok: true,
    plan: {
      planId: args.planId,
      intent,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
      windowSeconds,
      round: 0,
      roundOpenedAt: null,
      guests,
      candidates: candidates.slots,
      fold: null,
      chosen: null,
      state: 'proposing',
    },
  };
}

function touch(plan: GroupPlan, nowMs: number, patch: Partial<GroupPlan>): GroupPlan {
  return { ...plan, ...patch, updatedAt: nowMs };
}

function guestIndex(plan: GroupPlan, contactDid: string): number {
  return plan.guests.findIndex((g) => g.contactDid === contactDid);
}

/**
 * A round was sent: every guest's reply resets, the round counter advances.
 * Refused past the ceiling — the caller must ask this BEFORE fanning out, so
 * a fourth round is never on the wire.
 */
export function openRound(plan: GroupPlan, nowMs: number): PlanResult {
  if (plan.state !== 'proposing' && plan.state !== 'confirming') return refuse('wrong_state', plan.state);
  if (plan.round >= MAX_PLAN_ROUNDS) return refuse('rounds_exhausted');
  return {
    ok: true,
    plan: touch(plan, nowMs, {
      round: plan.round + 1,
      roundOpenedAt: nowMs,
      fold: null,
      guests: plan.guests.map((g) => ({ ...g, reply: null, outcome: 'waiting' })),
    }),
  };
}

/** A spoke as the sender knows it — the round is the plan's to stamp. */
export type SpokeInput =
  | { stage: 'grant_requested'; requestId: string }
  | { stage: 'queried'; taskId: string; queryId: string };

/** When the current round's window closes (ms), or null before the first round. */
export function windowClosesAt(plan: GroupPlan): number | null {
  return plan.roundOpenedAt === null ? null : plan.roundOpenedAt + plan.windowSeconds * 1000;
}

/** The spoke of the current round for one guest, or null. */
export function currentSpoke(guest: GuestRecord, round: number): SpokeRecord | null {
  for (let i = guest.spokes.length - 1; i >= 0; i--) {
    if (guest.spokes[i].round === round) return guest.spokes[i];
  }
  return null;
}

/**
 * The spoke that carried this round's question to one guest. A `queried`
 * spoke REPLACES a `grant_requested` one of the same round — the preflight and
 * the query it unlocked are one spoke, not two.
 */
export function recordSpoke(
  plan: GroupPlan,
  contactDid: string,
  spoke: SpokeInput,
  nowMs: number,
): PlanResult {
  const i = guestIndex(plan, contactDid);
  if (i < 0) return refuse('unknown_guest', contactDid);
  const record = { round: plan.round, ...spoke } as SpokeRecord;
  const guests = plan.guests.slice();
  const spokes = guests[i].spokes.slice();
  const last = spokes.length - 1;
  if (last >= 0 && spokes[last].round === plan.round && spokes[last].stage === 'grant_requested') {
    spokes[last] = record;
  } else {
    spokes.push(record);
  }
  guests[i] = { ...guests[i], spokes };
  return { ok: true, plan: touch(plan, nowMs, { guests }) };
}


/** A well-formed disclosure, bounded and one-lined; anything else is refused. */
export function normaliseDisclosure(value: unknown): Disclosure | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (typeof d.kind !== 'string' || !(DISCLOSURE_KINDS as readonly string[]).includes(d.kind)) return null;
  if (d.about !== 'household') return null;
  if (typeof d.text !== 'string') return null;
  const text = oneLine(d.text, MAX_DISCLOSURE_CHARS);
  if (text === '') return null;
  return { kind: d.kind as DisclosureKind, text, about: 'household' };
}

/** A guest answered this round. Disclosures are appended; a malformed one refuses the whole reply. */
export function recordReply(
  plan: GroupPlan,
  args: { contactDid: string; reply: SpokeReply; disclosures?: readonly unknown[] },
  nowMs: number,
): PlanResult {
  const i = guestIndex(plan, args.contactDid);
  if (i < 0) return refuse('unknown_guest', args.contactDid);
  const disclosures: Disclosure[] = [];
  for (const raw of args.disclosures ?? []) {
    const d = normaliseDisclosure(raw);
    if (d === null) return refuse('malformed_disclosure');
    disclosures.push(d);
  }
  const guests = plan.guests.slice();
  // A guest who says "gluten-free" at propose and again at confirm has said
  // one thing, and a vendor requirement counted twice would order two
  // portions. Deduplicated by kind and text across rounds.
  const merged = [...guests[i].disclosures];
  for (const d of disclosures) {
    if (!merged.some((m) => m.kind === d.kind && m.text === d.text)) merged.push(d);
  }
  guests[i] = { ...guests[i], reply: args.reply, outcome: 'answered', disclosures: merged };
  return { ok: true, plan: touch(plan, nowMs, { guests }) };
}

/** The shared window closed with no answer from this guest. Collapsed: no reason is recorded. */
export function markUnreachable(plan: GroupPlan, contactDid: string, nowMs: number): PlanResult {
  const i = guestIndex(plan, contactDid);
  if (i < 0) return refuse('unknown_guest', contactDid);
  if (plan.guests[i].outcome === 'answered') return { ok: true, plan };
  const guests = plan.guests.slice();
  guests[i] = { ...guests[i], outcome: 'unreachable' };
  return { ok: true, plan: touch(plan, nowMs, { guests }) };
}

/**
 * Fold the current round. The plan moves to `folded` only when every
 * required guest is accounted for — answered or unreachable — because a fold
 * over a guest who may still answer is provisional, and the organizer must
 * not be handed a decision on it.
 */
export function foldPlan(plan: GroupPlan, nowMs: number): PlanResult {
  // A folded plan folds again: an optional guest's late answer within the
  // window updates `optionalFit` without reopening a decision.
  if (plan.state !== 'proposing' && plan.state !== 'confirming' && plan.state !== 'folded') {
    return refuse('wrong_state', plan.state);
  }
  const fold = foldGroupPlan({
    candidates: plan.candidates,
    guests: plan.guests.map((g) => ({ contactDid: g.contactDid, required: g.required, reply: g.reply })),
  });
  const stillWaiting = plan.guests.some((g) => g.required && g.outcome === 'waiting');
  const settledConfirm =
    plan.state === 'confirming' && fold.state === 'converged' && plan.chosen !== null;
  return {
    ok: true,
    plan: touch(plan, nowMs, {
      fold,
      state: stillWaiting ? plan.state : settledConfirm ? 'settled' : plan.state === 'confirming' ? 'confirming' : 'folded',
    }),
  };
}

/**
 * The organizer picks a slot the fold agreed on and the confirm round is
 * opened with that one candidate. A slot outside `agreed` is refused: the
 * organizer's Dina cannot confirm a time nobody said yes to.
 */
export function choose(plan: GroupPlan, slot: MeetingSlot, nowMs: number): PlanResult {
  if (plan.state !== 'folded') return refuse('wrong_state', plan.state);
  // A folded plan whose fold is still `waiting` closed its window on a
  // required guest who never answered. What the others agreed on is
  // provisional — §4's fold is "the slots every REQUIRED guest accepted" —
  // so nothing can be chosen until that guest is dropped from required
  // (`makeOptional`) or the plan is widened or stopped (§13).
  if (plan.fold === null || plan.fold.state === 'waiting') {
    return refuse('required_unanswered', plan.fold?.missingRequired.join(',') ?? '');
  }
  const agreed = plan.fold.agreed;
  const match = agreed.find((s) => slotKey(s) === slotKey(slot));
  if (match === undefined) return refuse('slot_not_agreed', slot.start);
  const opened = openRound(touch(plan, nowMs, { state: 'confirming', chosen: match, candidates: [match] }), nowMs);
  return opened;
}

/**
 * The organizer widens: a new proposing round over new candidates, replies
 * cleared, disclosures kept (they were about the household, not the date).
 * Allowed from a SETTLED plan too — §13: a family changing its mind after
 * the confirm "reopens the fold" — within the same round ceiling.
 */
export function widen(plan: GroupPlan, candidates: readonly unknown[], nowMs: number): PlanResult {
  if (plan.state !== 'folded' && plan.state !== 'confirming' && plan.state !== 'settled') {
    return refuse('wrong_state', plan.state);
  }
  const validated = validateCandidates(candidates);
  if (!validated.ok) return validated;
  return openRound(
    touch(plan, nowMs, { state: 'proposing', chosen: null, fold: null, candidates: validated.slots }),
    nowMs,
  );
}

/**
 * The organizer drops a required guest to optional — it changes the fold,
 * never the asks. Allowed while a round is still open (§13: "the plan
 * proceeds on the organizer's say with that family marked optional, or
 * waits"), after it folded, and at confirm (a family that reneged is let go
 * and the rest settle). Never after the plan settled or was abandoned.
 */
export function makeOptional(plan: GroupPlan, contactDid: string, nowMs: number): PlanResult {
  if (plan.state === 'settled' || plan.state === 'abandoned') return refuse('wrong_state', plan.state);
  const i = guestIndex(plan, contactDid);
  if (i < 0) return refuse('unknown_guest', contactDid);
  const guests = plan.guests.slice();
  guests[i] = { ...guests[i], required: false };
  if (!guests.some((g) => g.required)) return refuse('no_required_guest');
  const state: GroupPlanState = plan.state === 'folded' ? 'proposing' : plan.state;
  return foldPlan(touch(plan, nowMs, { guests, state }), nowMs);
}

/** The organizer stops. A settled plan can be stopped too (§13 "organizer cancels"); a stopped one cannot be stopped twice. */
export function abandon(plan: GroupPlan, nowMs: number): PlanResult {
  if (plan.state === 'abandoned') return refuse('wrong_state', plan.state);
  return { ok: true, plan: touch(plan, nowMs, { state: 'abandoned' }) };
}

/**
 * What leaves the node for a vendor (§6 point 4, §10): counts by kind, in a
 * fixed order, and not one field that names a household. A test pins that no
 * DID and no disclosure text survives this function.
 */
export function deriveRequirements(plan: GroupPlan): Requirement[] {
  const counts = new Map<DisclosureKind, number>();
  const needs = new Map<DisclosureKind, string[]>();
  for (const guest of plan.guests) {
    for (const d of guest.disclosures) {
      if (d.kind === 'note' || d.kind === 'transport') continue; // not a requirement a vendor fills
      counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
      const lines = needs.get(d.kind) ?? [];
      if (!lines.includes(d.text)) lines.push(d.text);
      needs.set(d.kind, lines);
    }
  }
  // Needs are sorted: their order must not follow the guest list, or the
  // list itself would say who asked for what.
  return DISCLOSURE_KINDS.filter((k) => counts.has(k)).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
    needs: [...(needs.get(kind) ?? [])].sort(),
  }));
}
