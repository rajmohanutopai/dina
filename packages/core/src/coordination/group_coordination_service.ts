/**
 * GROUP COORDINATION — the Core-owned fan-out
 * (docs/GROUP_COORDINATION_ARCHITECTURE.md §4, §5, §11): N ordinary 1:1
 * `availability_coordination` spokes, one shared window, a fold on read.
 *
 * WHAT IT IS NOT. Not a coordinator and not a sweeper. Nothing here runs on a
 * timer, no node waits on the plan, and no message on the wire names it — a
 * spoke's `query_id` is random, and its params are the organizer's own intent
 * and candidates and nothing else (§16 rule 4). Every spoke is the 1:1 lane's
 * own `service.query` (`submitServiceQuery`): a guest with a stored
 * `service.offer` is queried at once; a guest without one is asked for reach
 * through the 1:1 preflight (`service.grant_request`, CONTACT_SERVICES §5.2)
 * and queried the moment the offer lands, exactly as the Talk thread does for
 * one contact.
 *
 * THE FOLD HAPPENS WHEN THE PLAN IS READ. Reading a plan consults its spoke
 * tasks, records the replies that landed, applies the closed window, and
 * recomputes the intersection. A plan nobody reads costs nothing, and a crash
 * between reads loses nothing: the spokes are ordinary tasks in the workflow
 * store and the plan is rebuilt from them on the next read.
 *
 * THE WINDOW IS THE PLAN'S. Every spoke of a round closes at the same instant
 * (`windowClosesAt`) whatever became of it — no offer, a failed send, a soft
 * refusal, an outage, silence. The organizer sees per guest `answered` or
 * `unreachable`, and learns a negative outcome only when the window closes,
 * so neither the outcome nor its timing says which of those it was (§5, §16
 * rule 9). A reply that lands before the window closes is recorded at once:
 * a yes is the guest's to give, and giving it early tells the organizer
 * nothing the guest did not choose to say.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { MSG_TYPE_SERVICE_GRANT_REQUEST, type ServiceGrantRequestBody } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { getContact, type TrustLevel } from '../contacts/directory';
import {
  getServiceOfferRepository,
  type ServiceOffer,
  type ServiceOfferRepository,
} from '../contacts/service_offers_repository';
import { onServiceOfferReceived } from '../d2d/service_offer_events';
import { getD2DSender, type D2DSender } from '../server/routes/d2d_msg';
import {
  getServiceQuerySender,
  submitServiceQuery,
  type ServiceQuerySender,
} from '../server/routes/service_query';
import { oneLine } from '../util/one_line';
import { WorkflowTaskState, isTerminal, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService, type WorkflowService } from '../workflow/service';

import {
  GROUP_COORDINATION_CAPABILITY,
  contactDisclosureTier,
  disclosureCategory,
  tierAdmitsDisclosure,
  type DisclosureTierResolver,
} from './disclosure_policy';
import { isMeetingSlot, type MeetingSlot, type SpokeReply } from './group_fold';
import {
  MAX_DISCLOSURE_CHARS,
  MAX_INTENT_CHARS,
  MAX_SLOT_CHARS,
  abandon,
  choose,
  createGroupPlan,
  currentSpoke,
  foldPlan,
  makeOptional,
  markUnreachable,
  normaliseDisclosure,
  openRound,
  recordReply,
  recordSpoke,
  widen,
  windowClosesAt,
  type Disclosure,
  type GroupPlan,
  type GroupPlanRefusal,
  type GuestRecord,
  type PlanResult,
} from './group_plan';
import { getGroupPlanRepository, type GroupPlanRepository } from './group_plan_repository';

export { GROUP_COORDINATION_CAPABILITY } from './disclosure_policy';

export type GroupCoordinationRefusal =
  | GroupPlanRefusal
  | 'guest_not_a_contact'
  | 'not_found'
  | 'not_wired';

export type GroupCoordinationResult =
  | { ok: true; plan: GroupPlan }
  | { ok: false; refusal: GroupCoordinationRefusal; detail?: string };

/**
 * What the service reaches for. Every member defaults to the module global
 * the host wired at boot; a test injects what it wants to observe.
 */
export interface GroupCoordinationDeps {
  plans: GroupPlanRepository;
  offers: ServiceOfferRepository;
  workflow: WorkflowService;
  /** The 1:1 submit path — validated, persisted as a task, sent. */
  submitQuery: typeof submitServiceQuery;
  /** The sender the submit path hands a `service.query` to. */
  querySender: ServiceQuerySender;
  /** The raw D2D sender, for the reach preflight. */
  sendD2D: D2DSender;
  /** Layer 1 (§5): the organizer's own contact record for a guest. */
  contactTrust: (did: string) => TrustLevel | null;
  /**
   * §13: a disclosure the organizer's own tier for that contact does not
   * admit is dropped on receipt — the same resolver the guest's egress gate
   * reads, applied on the way in.
   */
  holdTier: DisclosureTierResolver;
  nowMs: () => number;
  /** A random, non-secret identifier — plan ids, query ids, request ids. */
  newId: () => string;
}

type Resolved = { ok: true; deps: GroupCoordinationDeps } | { ok: false; refusal: 'not_wired'; detail: string };

function resolveDeps(over: Partial<GroupCoordinationDeps>): Resolved {
  const plans = over.plans ?? getGroupPlanRepository();
  if (plans === null) return { ok: false, refusal: 'not_wired', detail: 'group plan store' };
  const offers = over.offers ?? getServiceOfferRepository();
  if (offers === null) return { ok: false, refusal: 'not_wired', detail: 'service-offer store' };
  const workflow = over.workflow ?? getWorkflowService();
  if (workflow === null) return { ok: false, refusal: 'not_wired', detail: 'workflow service' };
  const querySender = over.querySender ?? getServiceQuerySender();
  if (querySender === null) return { ok: false, refusal: 'not_wired', detail: 'service-query sender' };
  const sendD2D = over.sendD2D ?? getD2DSender();
  if (sendD2D === null) return { ok: false, refusal: 'not_wired', detail: 'D2D sender' };
  return {
    ok: true,
    deps: {
      plans,
      offers,
      workflow,
      querySender,
      sendD2D,
      submitQuery: over.submitQuery ?? submitServiceQuery,
      contactTrust: over.contactTrust ?? ((did) => getContact(did)?.trustLevel ?? null),
      holdTier: over.holdTier ?? contactDisclosureTier,
      nowMs: over.nowMs ?? (() => Date.now()),
      newId: over.newId ?? (() => bytesToHex(randomBytes(16))),
    },
  };
}

// ---------------------------------------------------------------------------
// One plan at a time. A read, a choose, and the offer listener can all reach
// for the same row with an `await` in the middle; serialising per plan keeps
// the last write from dropping the one before it.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

async function withPlan<T>(planId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(planId) ?? Promise.resolve();
  const mine = previous.then(fn, fn);
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );
  locks.set(planId, settled);
  try {
    return await mine;
  } finally {
    if (locks.get(planId) === settled) locks.delete(planId);
  }
}

/** A transition that cannot refuse here; a refusal is a broken invariant, not user input. */
function must(result: PlanResult): GroupPlan {
  if (!result.ok) throw new Error(`group_plan: invariant broken (${result.refusal})`);
  return result.plan;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// The spoke
// ---------------------------------------------------------------------------

/** A single bounded line of a slot, or null when there is no `start` left. */
function sanitiseSlot(value: unknown): MeetingSlot | null {
  if (!isMeetingSlot(value)) return null;
  const start = oneLine(value.start, MAX_SLOT_CHARS);
  if (start === '') return null;
  const end = value.end === undefined ? undefined : oneLine(value.end, MAX_SLOT_CHARS);
  const note = value.note === undefined ? undefined : oneLine(value.note, MAX_DISCLOSURE_CHARS);
  return {
    start,
    ...(end !== undefined && end !== '' ? { end } : {}),
    ...(note !== undefined && note !== '' ? { note } : {}),
  };
}

function sanitiseSlots(value: unknown): MeetingSlot[] | null {
  if (!Array.isArray(value)) return null;
  const out: MeetingSlot[] = [];
  for (const v of value) {
    const slot = sanitiseSlot(v);
    // A reply this node cannot read as slots is no reply (it resolves with
    // the window), never a reply that "accepts nothing": a buggy peer must
    // not be read as a refusal.
    if (slot === null) return null;
    out.push(slot);
  }
  return out;
}

/** The 1:1 result body as the fold reads it; null when it cannot be read. */
export function toSpokeReply(value: unknown): SpokeReply | null {
  if (!isRecord(value)) return null;
  const message =
    value.message === undefined
      ? undefined
      : typeof value.message === 'string'
        ? oneLine(value.message, MAX_INTENT_CHARS)
        : null;
  if (message === null) return null;
  switch (value.status) {
    case 'accepted': {
      const slots = value.accepted_slots === undefined ? undefined : sanitiseSlots(value.accepted_slots);
      if (slots === null) return null;
      return { status: 'accepted', ...(slots !== undefined ? { accepted_slots: slots } : {}), ...(message !== undefined ? { message } : {}) };
    }
    case 'counter': {
      const slots = value.counter_slots === undefined ? undefined : sanitiseSlots(value.counter_slots);
      if (slots === null) return null;
      return { status: 'counter', ...(slots !== undefined ? { counter_slots: slots } : {}), ...(message !== undefined ? { message } : {}) };
    }
    case 'needs_more_info':
      return { status: 'needs_more_info', ...(message !== undefined ? { message } : {}) };
    default:
      return null;
  }
}

interface Answer {
  reply: SpokeReply;
  disclosures: Disclosure[];
}

/**
 * What a completed spoke task says, or null. Only a `success` response with a
 * readable result is an answer; `unavailable`, `error`, a failed or expired
 * task and a malformed body all resolve with the window (§5). Malformed
 * disclosures are dropped and counted — never their text (§13).
 */
function readAnswer(
  task: WorkflowTask | null,
  planId: string,
  contactDid: string,
  holdTier: DisclosureTierResolver,
): Answer | null {
  if (task === null || task.status !== WorkflowTaskState.Completed || typeof task.result !== 'string') {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(task.result);
  } catch {
    appendAudit('group_plan', 'group_plan_reply_malformed', planId, `task=${task.id} reason=not_json`);
    return null;
  }
  if (!isRecord(body) || body.status !== 'success') return null;
  const reply = toSpokeReply(body.result);
  if (reply === null) {
    appendAudit('group_plan', 'group_plan_reply_malformed', planId, `task=${task.id} reason=result`);
    return null;
  }
  const raw = isRecord(body.result) && Array.isArray(body.result.disclosures) ? body.result.disclosures : [];
  const disclosures: Disclosure[] = [];
  let dropped = 0;
  let refused = 0;
  for (const d of raw) {
    const n = normaliseDisclosure(d);
    if (n === null) {
      dropped += 1;
    } else if (!tierAdmitsDisclosure(holdTier(contactDid, disclosureCategory(n.kind)))) {
      // §13: the organizer's own tier for this contact does not admit the
      // category — dropped on receipt, counted, never quoted. The slots stay.
      refused += 1;
    } else {
      disclosures.push(n);
    }
  }
  if (dropped > 0) {
    appendAudit('group_plan', 'group_plan_disclosure_dropped', planId, `task=${task.id} dropped=${dropped}`);
  }
  if (refused > 0) {
    appendAudit('group_plan', 'group_plan_disclosure_refused', planId, `task=${task.id} refused=${refused}`);
  }
  // The same rule the guest's gate applies on the way out (§6, §13): a
  // disclosure the organizer will not hold is not held in prose either. The
  // reply keeps its availability — status and slots — and loses its free text.
  return { reply: dropped + refused > 0 ? availabilityOnly(reply) : reply, disclosures };
}

/** A reply reduced to what a fold reads: status and slot times, no prose. */
function availabilityOnly(reply: SpokeReply): SpokeReply {
  const bare = (slots: MeetingSlot[] | undefined): MeetingSlot[] | undefined =>
    slots?.map((s) => ({ start: s.start, ...(s.end !== undefined ? { end: s.end } : {}) }));
  switch (reply.status) {
    case 'accepted':
      return { status: 'accepted', ...(reply.accepted_slots !== undefined ? { accepted_slots: bare(reply.accepted_slots) } : {}) };
    case 'counter':
      return { status: 'counter', ...(reply.counter_slots !== undefined ? { counter_slots: bare(reply.counter_slots) } : {}) };
    default:
      return { status: 'needs_more_info' };
  }
}

/** A stored, unexpired offer from this guest for the capability, newest first. */
function liveOffer(offers: ServiceOfferRepository, contactDid: string, nowSec: number): ServiceOffer | null {
  return (
    offers
      .findByProviderDidAndCapability(contactDid, GROUP_COORDINATION_CAPABILITY)
      .find((o) => o.expiresAt === undefined || o.expiresAt > nowSec) ?? null
  );
}

/**
 * The one body every spoke of a round carries (§16 rule 4): the organizer's
 * intent and the organizer's candidates. A confirm round says so in the
 * intent, since a guest's node reads the intent and not the plan.
 */
export function spokeParams(plan: GroupPlan): { intent: string; candidate_slots: MeetingSlot[] } {
  const intent =
    plan.state === 'confirming' && plan.chosen !== null
      ? oneLine(`Confirming ${describeSlot(plan.chosen)}: ${plan.intent}`, MAX_INTENT_CHARS)
      : plan.intent;
  return { intent, candidate_slots: plan.candidates.map((s) => ({ ...s })) };
}

function describeSlot(slot: MeetingSlot): string {
  return slot.end === undefined ? slot.start : `${slot.start} to ${slot.end}`;
}

function taskIdOf(body: unknown): string | null {
  return isRecord(body) && typeof body.task_id === 'string' && body.task_id !== '' ? body.task_id : null;
}

/** Send the round's question to one guest through the 1:1 lane, and record the spoke. */
async function querySpoke(
  plan: GroupPlan,
  guest: GuestRecord,
  offer: ServiceOffer,
  deps: GroupCoordinationDeps,
): Promise<GroupPlan> {
  const now = deps.nowMs();
  const closesAt = windowClosesAt(plan);
  if (closesAt === null) throw new Error('group_plan: no round is open');
  // The task expires with the plan's window, not a window of its own.
  const ttl = Math.min(plan.windowSeconds, Math.max(1, Math.ceil((closesAt - now) / 1000)));
  const queryId = deps.newId();
  const res = await deps.submitQuery(
    {
      to_did: guest.contactDid,
      capability: GROUP_COORDINATION_CAPABILITY,
      query_id: queryId,
      params: spokeParams(plan),
      ttl_seconds: ttl,
      service_uri: offer.serviceUri,
      grant_id: offer.grantId,
      service_name: offer.serviceName,
      ...(offer.schemaHash !== '' ? { schema_hash: offer.schemaHash } : {}),
      // The spoke's surface is the plan card, not a Talk thread: the chat
      // deliverer skips this origin so a per-spoke outcome never renders on
      // its own, at its own time, with its own reason (§5). Local only —
      // `origin_channel` never rides the wire.
      origin_channel: `group_plan:${plan.planId}`,
    },
    {
      sender: deps.querySender,
      nowSecFn: () => Math.floor(now / 1000),
      dedupeScope: `${plan.planId}:${plan.round}`,
    },
  );
  const taskId = taskIdOf(res.body);
  if (taskId === null) {
    // 400/500/503 is a fault in this node's wiring, not a guest's state.
    throw new Error(`group_plan: spoke submit failed (${res.status})`);
  }
  if (res.status !== 200) {
    // The send failed; the task is named and failed. It resolves with the window.
    appendAudit('group_plan', 'group_plan_spoke_send_failed', plan.planId, `status=${res.status}`);
  }
  return must(recordSpoke(plan, guest.contactDid, { stage: 'queried', taskId, queryId }, deps.nowMs()));
}

/** Ask a guest with no stored offer for reach — the 1:1 preflight — and record the spoke. */
async function preflightSpoke(plan: GroupPlan, guest: GuestRecord, deps: GroupCoordinationDeps): Promise<GroupPlan> {
  const requestId = deps.newId();
  const body: ServiceGrantRequestBody = {
    request_id: requestId,
    capability: GROUP_COORDINATION_CAPABILITY,
    requested_surface: 'talk',
    intent: plan.intent,
  };
  try {
    await deps.sendD2D(guest.contactDid, MSG_TYPE_SERVICE_GRANT_REQUEST, body as unknown as Record<string, unknown>);
  } catch {
    // Resolves with the window like every other negative path.
    appendAudit('group_plan', 'group_plan_preflight_send_failed', plan.planId, `round=${plan.round}`);
  }
  return must(recordSpoke(plan, guest.contactDid, { stage: 'grant_requested', requestId }, deps.nowMs()));
}

async function sendSpoke(plan: GroupPlan, guest: GuestRecord, deps: GroupCoordinationDeps): Promise<GroupPlan> {
  const offer = liveOffer(deps.offers, guest.contactDid, Math.floor(deps.nowMs() / 1000));
  return offer === null ? preflightSpoke(plan, guest, deps) : querySpoke(plan, guest, offer, deps);
}

/**
 * One spoke, faults contained: a submit that fails in this node's own wiring
 * (a 400/500/503, a thrown sender) is audited and leaves the guest without
 * a spoke for this round. The next read RESUMES the fan-out for such a
 * guest while the window is open, and the window closes them like any other
 * silence if it never succeeds. Nothing here throws a plan half-sent.
 */
async function trySendSpoke(plan: GroupPlan, guest: GuestRecord, deps: GroupCoordinationDeps): Promise<GroupPlan> {
  try {
    return await sendSpoke(plan, guest, deps);
  } catch (error) {
    appendAudit(
      'group_plan',
      'group_plan_spoke_fault',
      plan.planId,
      `round=${plan.round} reason=${error instanceof Error ? oneLine(error.message, 80) : 'unknown'}`,
    );
    return plan;
  }
}

/** One round to every guest, persisted spoke by spoke so a crash mid-fan-out keeps what was sent. */
async function fanOut(plan: GroupPlan, deps: GroupCoordinationDeps): Promise<GroupPlan> {
  deps.plans.put(plan);
  for (const guest of plan.guests) {
    plan = await trySendSpoke(plan, guest, deps);
    deps.plans.put(plan);
  }
  return plan;
}

/**
 * A new round supersedes the last: a spoke task still live from the previous
 * round is cancelled on this node, so a late reply to the old question can
 * never be read as an answer to the new one. Nothing is sent — the guest's
 * node holds nothing that depends on the plan (§7).
 */
function cancelLiveSpokes(plan: GroupPlan, deps: GroupCoordinationDeps, reason: string): void {
  for (const guest of plan.guests) {
    const spoke = currentSpoke(guest, plan.round);
    if (spoke === null || spoke.stage !== 'queried') continue;
    const task = deps.workflow.store().getById(spoke.taskId);
    if (task === null || isTerminal(task.status as WorkflowTaskState)) continue;
    try {
      deps.workflow.cancel(spoke.taskId, reason);
    } catch {
      /* raced to terminal — nothing to supersede */
    }
  }
}

// ---------------------------------------------------------------------------
// The fold on read
// ---------------------------------------------------------------------------

/**
 * Bring the current round up to date: record the replies that landed, query
 * a guest whose offer arrived while the window was open, close the window
 * for whoever is still waiting once it has passed, and fold.
 */
async function settleRound(plan: GroupPlan, deps: GroupCoordinationDeps): Promise<{ plan: GroupPlan; changed: boolean }> {
  if (plan.state === 'settled' || plan.state === 'abandoned') return { plan, changed: false };
  const closesAt = windowClosesAt(plan);
  if (closesAt === null) return { plan, changed: false };
  // One clock reading for the whole pass: the window closes for every guest
  // at once, or for none of them.
  const now = deps.nowMs();
  const closed = now >= closesAt;
  let changed = false;
  for (const contactDid of plan.guests.map((g) => g.contactDid)) {
    let guest = guestOf(plan, contactDid);
    if (guest.outcome !== 'waiting') continue;
    let spoke = currentSpoke(guest, plan.round);
    if (spoke === null && !closed) {
      // The fan-out never reached this guest (a crash or a fault mid-loop):
      // resume it now, inside the same window. Idempotent — a query already
      // on the wire for this plan and round dedupes onto its task in ANY
      // state (the scoped lookup includes terminal tasks), so a reply that
      // landed before the plan row was written is re-linked, not lost.
      plan = await trySendSpoke(plan, guest, deps);
      changed = true;
      guest = guestOf(plan, contactDid);
      spoke = currentSpoke(guest, plan.round);
    }
    if (spoke?.stage === 'grant_requested' && !closed) {
      // The offer may have landed while nobody was listening (a restart
      // between the preflight and the reply); the stored offer is the record.
      const offer = liveOffer(deps.offers, contactDid, Math.floor(now / 1000));
      if (offer !== null) {
        plan = await querySpoke(plan, guest, offer, deps);
        changed = true;
        guest = guestOf(plan, contactDid);
        spoke = currentSpoke(guest, plan.round);
      }
    }
    if (spoke?.stage === 'queried') {
      const task = deps.workflow.store().getById(spoke.taskId);
      // A reply counts only when it landed inside the window. The store
      // already refuses to complete an expired task; the plan does not lean
      // on that, so a closed round reads the same on every store.
      const answer =
        task !== null && task.updated_at <= closesAt
          ? readAnswer(task, plan.planId, contactDid, deps.holdTier)
          : null;
      if (answer !== null) {
        plan = must(recordReply(plan, { contactDid, reply: answer.reply, disclosures: answer.disclosures }, now));
        changed = true;
        continue;
      }
    }
    if (closed) {
      plan = must(markUnreachable(plan, contactDid, now));
      changed = true;
    }
  }
  if (changed || plan.fold === null) {
    plan = must(foldPlan(plan, now));
    changed = true;
  }
  return { plan, changed };
}

function guestOf(plan: GroupPlan, contactDid: string): GuestRecord {
  const guest = plan.guests.find((g) => g.contactDid === contactDid);
  if (guest === undefined) throw new Error('group_plan: invariant broken (guest)');
  return guest;
}

async function loadSettled(planId: string, deps: GroupCoordinationDeps): Promise<GroupPlan | null> {
  const stored = deps.plans.get(planId);
  if (stored === null) return null;
  const { plan, changed } = await settleRound(stored, deps);
  if (changed) deps.plans.put(plan);
  return plan;
}

// ---------------------------------------------------------------------------
// The organizer's verbs
// ---------------------------------------------------------------------------

export interface OpenGroupPlanInput {
  intent: string;
  guests: readonly { contactDid: string; required: boolean }[];
  candidates: readonly unknown[];
  windowSeconds?: number;
}

/**
 * Open a plan and send the first round. Refused whole before anything is on
 * the wire: the bounds (§12), and a guest who is not a contact or is blocked
 * (§5 layer 1 — the organizer's own record, so naming it costs no guest
 * anything).
 */
export async function openGroupPlan(
  input: OpenGroupPlanInput,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<GroupCoordinationResult> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  const { deps } = resolved;
  const created = createGroupPlan({
    planId: `gp_${deps.newId()}`,
    intent: input.intent,
    guests: input.guests,
    candidates: input.candidates,
    ...(input.windowSeconds !== undefined ? { windowSeconds: input.windowSeconds } : {}),
    nowMs: deps.nowMs(),
  });
  if (!created.ok) return created;
  for (const guest of created.plan.guests) {
    const trust = deps.contactTrust(guest.contactDid);
    if (trust === null || trust === 'blocked') {
      return { ok: false, refusal: 'guest_not_a_contact', detail: guest.contactDid };
    }
  }
  const planId = created.plan.planId;
  return withPlan(planId, async () => {
    const opened = must(openRound(created.plan, deps.nowMs()));
    appendAudit(
      'group_plan',
      'group_plan_opened',
      planId,
      `guests=${opened.guests.length} candidates=${opened.candidates.length} window=${opened.windowSeconds}`,
    );
    const plan = await fanOut(opened, deps);
    return { ok: true, plan };
  });
}

/** The plan, folded as of now. */
export async function readGroupPlan(
  planId: string,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<GroupCoordinationResult> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  return withPlan(planId, async () => {
    const plan = await loadSettled(planId, resolved.deps);
    return plan === null ? { ok: false, refusal: 'not_found' } : { ok: true, plan };
  });
}

/** Every open plan, each folded as of now, newest first. */
export async function listGroupPlans(over: Partial<GroupCoordinationDeps> = {}): Promise<GroupPlan[] | null> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return null;
  const out: GroupPlan[] = [];
  for (const stored of resolved.deps.plans.listOpen()) {
    const result = await readGroupPlan(stored.planId, over);
    if (result.ok) out.push(result.plan);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** How many plans a handle list carries: the recent ones a turn could mean. */
export const MAX_PLAN_HANDLES = 20;

/**
 * The recent plans as handles (§11) — id, intent, state, chosen — each
 * folded as of now so a settled plan reads as settled. Nothing about guests.
 */
export async function listGroupPlanHandles(over: Partial<GroupCoordinationDeps> = {}): Promise<GroupPlan[] | null> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return null;
  const out: GroupPlan[] = [];
  for (const stored of resolved.deps.plans.listRecent(MAX_PLAN_HANDLES)) {
    const result = await readGroupPlan(stored.planId, over);
    if (result.ok) out.push(result.plan);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The organizer picks an agreed slot; the confirm round goes out. */
export async function chooseSlot(
  planId: string,
  slot: MeetingSlot,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<GroupCoordinationResult> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  const { deps } = resolved;
  return withPlan(planId, async () => {
    const plan = await loadSettled(planId, deps);
    if (plan === null) return { ok: false, refusal: 'not_found' };
    const chosen = choose(plan, slot, deps.nowMs());
    if (!chosen.ok) return chosen;
    cancelLiveSpokes(plan, deps, 'superseded by the confirm round');
    return { ok: true, plan: await fanOut(chosen.plan, deps) };
  });
}

/** The organizer widens: a new proposing round over new candidates. */
export async function widenPlan(
  planId: string,
  candidates: readonly unknown[],
  over: Partial<GroupCoordinationDeps> = {},
): Promise<GroupCoordinationResult> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  const { deps } = resolved;
  return withPlan(planId, async () => {
    const plan = await loadSettled(planId, deps);
    if (plan === null) return { ok: false, refusal: 'not_found' };
    const widened = widen(plan, candidates, deps.nowMs());
    if (!widened.ok) return widened;
    cancelLiveSpokes(plan, deps, 'superseded by a wider round');
    return { ok: true, plan: await fanOut(widened.plan, deps) };
  });
}

/** The organizer drops a guest from required. Nothing is sent. */
export async function makeGuestOptional(
  planId: string,
  contactDid: string,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<GroupCoordinationResult> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  const { deps } = resolved;
  return withPlan(planId, async () => {
    const plan = await loadSettled(planId, deps);
    if (plan === null) return { ok: false, refusal: 'not_found' };
    const result = makeOptional(plan, contactDid, deps.nowMs());
    if (!result.ok) return result;
    deps.plans.put(result.plan);
    return result;
  });
}

/** The organizer stops. Live spokes are cancelled on this node; nothing is sent. */
export async function abandonPlan(
  planId: string,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<GroupCoordinationResult> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  const { deps } = resolved;
  return withPlan(planId, async () => {
    const plan = await loadSettled(planId, deps);
    if (plan === null) return { ok: false, refusal: 'not_found' };
    const result = abandon(plan, deps.nowMs());
    if (!result.ok) return result;
    cancelLiveSpokes(plan, deps, 'plan abandoned');
    deps.plans.put(result.plan);
    return result;
  });
}

/** Delete the plan and everything guests disclosed for it (§7). Live spokes are cancelled. */
export async function deleteGroupPlan(
  planId: string,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<{ ok: true; removed: boolean } | { ok: false; refusal: 'not_wired'; detail: string }> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return resolved;
  const { deps } = resolved;
  return withPlan(planId, async () => {
    const plan = deps.plans.get(planId);
    if (plan === null) return { ok: true, removed: false };
    cancelLiveSpokes(plan, deps, 'plan deleted');
    // What a guest disclosed lives in two places: the plan row, and the
    // completed spoke task that carried the reply. Deleting the plan scrubs
    // both (§7): every spoke of every round loses its stored result.
    const store = deps.workflow.store();
    const now = deps.nowMs();
    for (const guest of plan.guests) {
      for (const spoke of guest.spokes) {
        if (spoke.stage === 'queried') store.scrubResult(spoke.taskId, now);
      }
    }
    return { ok: true, removed: deps.plans.remove(planId) };
  });
}

// ---------------------------------------------------------------------------
// The offer that unlocks a spoke
// ---------------------------------------------------------------------------

/**
 * When a guest's `service.offer` lands while a round is open and that guest's
 * spoke is still the preflight, send the question now. The event is the
 * trigger; the stored offer is what is read (one source), and the sender DID
 * is the transport-authenticated one the pipeline stamped on the event.
 */
export async function replayOfferForOpenPlans(
  providerDID: string,
  over: Partial<GroupCoordinationDeps> = {},
): Promise<number> {
  const resolved = resolveDeps(over);
  if (!resolved.ok) return 0;
  const { deps } = resolved;
  let sent = 0;
  for (const open of deps.plans.listOpen()) {
    const waiting = open.guests.find((g) => g.contactDid === providerDID && g.outcome === 'waiting');
    if (waiting === undefined) continue;
    await withPlan(open.planId, async () => {
      // Re-read under the lock: `settleRound` sends for a `grant_requested`
      // spoke whose offer is stored — or for a guest the fan-out never
      // reached — which is exactly this case; a guest already queried is
      // left alone.
      const before = deps.plans.get(open.planId);
      const stage = before === null ? null : currentSpoke(guestOf(before, providerDID), before.round)?.stage;
      if (stage === 'queried') return;
      const plan = await loadSettled(open.planId, deps);
      if (plan === null) return;
      const guest = plan.guests.find((g) => g.contactDid === providerDID);
      if (guest !== undefined && currentSpoke(guest, plan.round)?.stage === 'queried') sent += 1;
    });
  }
  return sent;
}

/** Subscribe the replay to inbound offers. Returns the disposer. Hosts call this at boot. */
export function wireGroupCoordinationOfferReplay(over: Partial<GroupCoordinationDeps> = {}): () => void {
  return onServiceOfferReceived((event) => {
    if (event.capability !== GROUP_COORDINATION_CAPABILITY) return;
    void replayOfferForOpenPlans(event.providerDID, over).catch(() => {
      /* the listener must never break D2D ingress; the read path is the fallback */
    });
  });
}
