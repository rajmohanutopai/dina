/**
 * DISCLOSURE EGRESS — the guest-side attach rule
 * (docs/GROUP_COORDINATION_ARCHITECTURE.md §6, §16 rules 5–6).
 *
 * A guest's Dina may say, beyond its availability, that someone in the
 * household is gluten-free, or needs step-free access, or can drive. Whether
 * a line like that LEAVES the node is never the model's decision and never
 * the organizer's; it is decided here, in Core, on the way out:
 *
 *   1. The category decides the gate. `dietary` and `accessibility` are
 *      health-category data; `transport` and `note` are general. A disclosure
 *      leaves only if the guest's sharing tier for THIS contact admits its
 *      category — the per-category policy when one was set, else the
 *      contact's own tier. `none` and `locked` admit nothing.
 *   2. A health fact needs the owner's yes. Even under an admitting tier, a
 *      reply carrying a dietary or accessibility disclosure is HELD and the
 *      owner is asked once; a yes sends the reply with it, a no sends the
 *      availability without it. Nothing leaves while the card is open.
 *   3. `about` is always `'household'`. Anything else is dropped before the
 *      tier is even consulted, and the drop is counted, never quoted.
 *
 * The gate is a `ResponseEgressGate` on the workflow service, so it sees the
 * completed result of EVERY provider answer — the delegation and plugin
 * bridge lanes, the reasoning lane's staged commit, and the owner's manual
 * `/v1/service/respond` — and passes every capability but this one through
 * untouched. The hold is an ordinary approval task; the owner's approve or
 * deny reaches the `ApprovalDecisionHandler` here.
 *
 * THE CARD IS A DECISION, NOT A PAYLOAD. What the release sends is rebuilt
 * from the execution task's OWN stored result and gated again; the card
 * carries the task id, the identity of the response, and the lines the owner
 * is asked about — never bytes that could be released as they are. A card
 * planted through any other door cannot make Core send what Core did not
 * itself produce, and the workflow create route refuses this type outright.
 */

import { appendAudit } from '../audit/service';
import { getContact } from '../contacts/directory';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { WorkflowConflictError } from '../workflow/repository';
import {
  getWorkflowService,
  type ApprovalDecisionHandler,
  type IngressResultDecision,
  type ResponseEgressGate,
  type ServiceQueryBridgeContext,
  type WorkflowService,
} from '../workflow/service';

import {
  GROUP_COORDINATION_CAPABILITY,
  contactDisclosureTier,
  disclosureCategory,
  tierAdmitsDisclosure,
  type DisclosureTierResolver,
} from './disclosure_policy';
import { normaliseDisclosure, type Disclosure, type DisclosureKind } from './group_plan';

export { disclosureCategory, tierAdmitsDisclosure } from './disclosure_policy';

export const DISCLOSURE_REVIEW_APPROVAL_TYPE = 'disclosure_review';

export interface DisclosureGateDeps {
  /** The sharing tier for a contact and category; the module globals by default. */
  tierFor: DisclosureTierResolver;
  workflow: () => WorkflowService | null;
  /** The name the owner knows the requester by, for the card. */
  contactName: (contactDID: string) => string | null;
  nowMs: () => number;
}

function defaultDeps(over: Partial<DisclosureGateDeps>): DisclosureGateDeps {
  return {
    tierFor: over.tierFor ?? contactDisclosureTier,
    workflow: over.workflow ?? getWorkflowService,
    contactName: over.contactName ?? ((did) => getContact(did)?.displayName ?? null),
    nowMs: over.nowMs ?? (() => Date.now()),
  };
}

export interface GatedDisclosures {
  kept: Disclosure[];
  malformed: number;
  refusedByTier: number;
  /** A health kind survived: the owner must say yes before it leaves. */
  reviewRequired: boolean;
}

/** Rules 1 and 3, applied to whatever the model put in `disclosures`. */
export function gateDisclosures(
  contactDID: string,
  raw: readonly unknown[],
  tierFor: DisclosureTierResolver,
): GatedDisclosures {
  const kept: Disclosure[] = [];
  let malformed = 0;
  let refusedByTier = 0;
  for (const value of raw) {
    const d = normaliseDisclosure(value);
    if (d === null) {
      malformed += 1;
      continue;
    }
    if (!tierAdmitsDisclosure(tierFor(contactDID, disclosureCategory(d.kind)))) {
      refusedByTier += 1;
      continue;
    }
    if (!kept.some((k) => k.kind === d.kind && k.text === d.text)) kept.push(d);
  }
  return {
    kept,
    malformed,
    refusedByTier,
    reviewRequired: kept.some((d) => disclosureCategory(d.kind) === 'health'),
  };
}

// ---------------------------------------------------------------------------
// The result on the wire: where `disclosures` sits, and how to put it back
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

interface Located {
  parsed: Record<string, unknown>;
  wrapped: boolean;
  result: Record<string, unknown>;
}

/** The bridge accepts the bare result or a `{status:'success', result}` wrapper; find the result. */
function locateResult(json: string): Located | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.status === 'success' && isRecord(parsed.result)) return { parsed, wrapped: true, result: parsed.result };
  if (parsed.status === 'unavailable' || parsed.status === 'error') return null;
  return { parsed, wrapped: false, result: parsed };
}

/** A slot with its free text removed: the date is availability, the note is prose. */
function bareSlot(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { note: _note, ...rest } = value;
  return rest;
}

/**
 * Put the result back together. `withheld` is true when the gate removed a
 * disclosure the model attached — refused by tier, malformed, or denied by
 * the owner — and then the reply leaves as AVAILABILITY ONLY: no `message`,
 * no slot `note`. The first live run showed why: told to disclose a diet in
 * the structured field, the model also wrote it into `message`, and the
 * owner's "no" would have stripped the field and shipped the sentence. Free
 * text is the model's and cannot be gated line by line; a "no" to any part
 * of what it chose to add is a "no" to all of it.
 */
function rebuild(located: Located, disclosures: Disclosure[] | null, withheld: boolean): string {
  const { disclosures: _dropped, message: _message, ...rest } = located.result;
  const base: Record<string, unknown> = withheld
    ? {
        ...rest,
        ...(Array.isArray(rest.accepted_slots) ? { accepted_slots: rest.accepted_slots.map(bareSlot) } : {}),
        ...(Array.isArray(rest.counter_slots) ? { counter_slots: rest.counter_slots.map(bareSlot) } : {}),
      }
    : { ...rest, ...(located.result.message !== undefined ? { message: located.result.message } : {}) };
  const result = disclosures === null ? base : { ...base, disclosures };
  return JSON.stringify(located.wrapped ? { ...located.parsed, result } : result);
}

/** The two answers a held result can become, recomputed from the bytes Core holds. */
function gatedVariants(
  json: string,
  fromDID: string,
  tierFor: DisclosureTierResolver,
): { located: Located; gated: GatedDisclosures; withKept: string; without: string } | null {
  const located = locateResult(json);
  if (located === null || !Array.isArray(located.result.disclosures)) return null;
  const raw = located.result.disclosures;
  const gated = gateDisclosures(fromDID, raw, tierFor);
  const removed = gated.refusedByTier + gated.malformed > 0;
  return {
    located,
    gated,
    // Everything the model attached survived: the prose goes with it.
    withKept: rebuild(located, gated.kept, removed),
    // Something the model attached is not leaving — by tier, by shape, or by
    // the owner's no — so neither is anything it wrote in prose.
    without: rebuild(located, null, raw.length > 0),
  };
}

// ---------------------------------------------------------------------------
// The hold
// ---------------------------------------------------------------------------

/** The identity of a response — everything the bridge needs but the bytes. */
export type ResponseIdentity = Omit<ServiceQueryBridgeContext, 'resultJSON'>;

export interface DisclosureReviewPayload {
  type: typeof DISCLOSURE_REVIEW_APPROVAL_TYPE;
  /** The task whose stored result is the ONLY thing a decision can release. */
  execution_task_id: string;
  /** Where the response goes and what it answers; bound to the task at release. */
  context: ResponseIdentity;
  /** What leaves if the owner says yes — the lines the card shows; never released as such. */
  disclosures: Disclosure[];
}

export function reviewTaskIdFor(executionTaskId: string): string {
  return `disclosure-review-${executionTaskId}`;
}

function isIdentity(v: unknown): v is ResponseIdentity {
  return (
    isRecord(v) &&
    typeof v.taskId === 'string' &&
    v.taskId !== '' &&
    typeof v.fromDID === 'string' &&
    v.fromDID !== '' &&
    typeof v.queryId === 'string' &&
    typeof v.capability === 'string' &&
    typeof v.ttlSeconds === 'number' &&
    typeof v.serviceName === 'string'
  );
}

export function parseDisclosureReviewPayload(raw: string): DisclosureReviewPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== DISCLOSURE_REVIEW_APPROVAL_TYPE) return null;
  if (
    typeof parsed.execution_task_id !== 'string' ||
    parsed.execution_task_id === '' ||
    !isIdentity(parsed.context) ||
    parsed.context.taskId !== parsed.execution_task_id ||
    !Array.isArray(parsed.disclosures)
  ) {
    return null;
  }
  const disclosures: Disclosure[] = [];
  for (const d of parsed.disclosures) {
    const n = normaliseDisclosure(d);
    if (n === null) return null;
    disclosures.push(n);
  }
  return {
    type: DISCLOSURE_REVIEW_APPROVAL_TYPE,
    execution_task_id: parsed.execution_task_id,
    context: parsed.context,
    disclosures,
  };
}

/** One line the owner reads on the card: the kinds, never the text. */
function describeReview(requester: string, kinds: DisclosureKind[]): string {
  const what = [...new Set(kinds)].join(' and ');
  return `Tell ${requester} about a household ${what} need?`;
}

/**
 * Create the review card, or report that one already stands. The card
 * expires when the query does — the execution task's own deadline, which the
 * provider set from the requester's TTL on arrival — because past the
 * requester's window there is nothing to release. False when no card can be
 * made, so the caller answers without the fact rather than not at all.
 */
function holdForReview(ctx: ServiceQueryBridgeContext, gated: GatedDisclosures, deps: DisclosureGateDeps): boolean {
  const workflow = deps.workflow();
  if (workflow === null) return false;
  const execution = workflow.store().getById(ctx.taskId);
  const expiresAtSec = execution?.expires_at ?? Math.floor(deps.nowMs() / 1000) + Math.max(1, ctx.ttlSeconds);
  const requester = deps.contactName(ctx.fromDID) ?? ctx.fromDID;
  const { resultJSON: _bytes, ...context } = ctx;
  const payload: DisclosureReviewPayload = {
    type: DISCLOSURE_REVIEW_APPROVAL_TYPE,
    execution_task_id: ctx.taskId,
    context,
    disclosures: gated.kept,
  };
  try {
    workflow.create({
      id: reviewTaskIdFor(ctx.taskId),
      kind: WorkflowTaskKind.Approval,
      description: describeReview(
        requester,
        gated.kept.filter((d) => disclosureCategory(d.kind) === 'health').map((d) => d.kind),
      ),
      payload: JSON.stringify(payload),
      correlationId: ctx.queryId,
      idempotencyKey: reviewTaskIdFor(ctx.taskId),
      expiresAtSec,
      origin: 'd2d',
      initialState: WorkflowTaskState.PendingApproval,
    });
  } catch (error) {
    // The card already stands for this completion: the hold holds. Any
    // other failure to make the card is reported, and the caller answers
    // without the fact — never silence, never the fact.
    if (!(error instanceof WorkflowConflictError)) {
      appendAudit('disclosure_gate', 'disclosure_review_unavailable', ctx.taskId, `reason=create_failed`);
      return false;
    }
  }
  return true;
}

/**
 * The gate. Passes every other capability through untouched; for this one,
 * drops what may not leave, and holds what needs a yes.
 */
export function makeDisclosureEgressGate(over: Partial<DisclosureGateDeps> = {}): ResponseEgressGate {
  const deps = defaultDeps(over);
  return (ctx): IngressResultDecision => {
    if (ctx.capability !== GROUP_COORDINATION_CAPABILITY) return { kind: 'passthrough' };
    const variants = gatedVariants(ctx.resultJSON, ctx.fromDID, deps.tierFor);
    // Not a success with disclosures, or not readable: the bridge answers a
    // malformed result itself, and an error result carries nothing to gate.
    if (variants === null) return { kind: 'passthrough' };
    const { gated, withKept, without } = variants;
    appendAudit(
      'disclosure_gate',
      'disclosure_gate_applied',
      ctx.taskId,
      `kept=${gated.kept.length} refused_by_tier=${gated.refusedByTier} malformed=${gated.malformed} review=${gated.reviewRequired ? 1 : 0}`,
    );
    if (gated.kept.length === 0) return { kind: 'replace', json: without };
    if (!gated.reviewRequired) return { kind: 'replace', json: withKept };
    // A health fact waits for the owner. With no workflow store to hold it in,
    // the availability still answers — without the fact: fail closed on the
    // disclosure, never on the reply.
    if (!holdForReview(ctx, gated, deps)) return { kind: 'replace', json: without };
    return { kind: 'withhold', reason: 'disclosure_review_pending' };
  };
}

/**
 * The bytes a decision may release: the execution task's own stored result,
 * bound to the identity the card names. Null when the task is gone, not
 * completed, holds no result, or answers a different requester than the
 * card claims — a planted card releases nothing.
 */
function heldResult(workflow: WorkflowService, payload: DisclosureReviewPayload): { task: WorkflowTask; resultJSON: string } | null {
  const task = workflow.store().getById(payload.execution_task_id);
  if (task === null || task.status !== WorkflowTaskState.Completed || typeof task.result !== 'string') return null;
  // A delegation or approval task carries its own identity: the card must agree with it.
  const own = workflow.outgoingContextFor(task, task.result);
  if (own !== null) {
    const c = payload.context;
    if (own.fromDID !== c.fromDID || own.queryId !== c.queryId || own.capability !== c.capability) return null;
  }
  return { task, resultJSON: task.result };
}

/**
 * The owner decided. Yes releases the response with the disclosures; no
 * releases it without them. Either way the requester hears once, and what
 * they hear is what Core stored, gated again now.
 */
export function makeDisclosureDecisionHandler(over: Partial<DisclosureGateDeps> = {}): ApprovalDecisionHandler {
  const deps = defaultDeps(over);
  return ({ task, decision }) => {
    const payload = parseDisclosureReviewPayload(task.payload);
    if (payload === null) return;
    const workflow = deps.workflow();
    if (workflow === null) return;
    const held = heldResult(workflow, payload);
    let released = false;
    if (held !== null) {
      const variants = gatedVariants(held.resultJSON, payload.context.fromDID, deps.tierFor);
      const resultJSON =
        variants === null ? held.resultJSON : decision === 'approved' ? variants.withKept : variants.without;
      released = workflow.releaseBridge({ ...payload.context, resultJSON });
    }
    appendAudit(
      'disclosure_gate',
      decision === 'approved' ? 'disclosure_review_approved' : 'disclosure_review_denied',
      task.id,
      `disclosures=${payload.disclosures.length} released=${released ? 1 : 0}`,
    );
    if (decision === 'approved') settleApprovedReview(workflow, task, released, deps.nowMs());
  };
}

/** The approve moved the card to `queued`; its execution is the send, so it completes here. */
function settleApprovedReview(workflow: WorkflowService, task: WorkflowTask, released: boolean, now: number): void {
  try {
    workflow.store().transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, now);
    if (released) {
      workflow.complete(task.id, JSON.stringify({ decision: 'approved' }), 'sent with the household disclosure');
    } else {
      workflow.fail(task.id, 'the answer this card held no longer exists');
    }
  } catch {
    /* a raced transition changes nothing the owner decided */
  }
}

/**
 * Both hooks, composed once so the three hosts that build a workflow service
 * cannot wire one and forget the other — the admission sweep taught that the
 * half assembled separately at each root is the half that drifts.
 */
export function coordinationWorkflowHooks(over: Partial<DisclosureGateDeps> = {}): {
  responseEgressGate: ResponseEgressGate;
  approvalDecisionHandler: ApprovalDecisionHandler;
} {
  return {
    responseEgressGate: makeDisclosureEgressGate(over),
    approvalDecisionHandler: makeDisclosureDecisionHandler(over),
  };
}
