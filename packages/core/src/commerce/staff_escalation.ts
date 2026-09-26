/**
 * §6.5 escalation: a staff operation above its cap becomes an OWNER
 * approval task — the `requireAgentPersonaAccess` pattern applied to
 * humans on the payroll. Idempotent per (device, scope, subject,
 * value): a clerk who presses the button twice raises one card, not
 * two, and the VALUE is part of the key so the owner's approval
 * authorizes exactly the number the card showed — a retry with a
 * different value is a different question and raises its own card.
 *
 * The card carries subject + value + who attempted, NEVER line
 * contents beyond that — the owner approving a ₹80,000 receipt needs
 * the number and the name, not the goods list, and the card renders in
 * surfaces the goods list has no business reaching.
 *
 * APPROVAL IS READ BACK HERE, not consumed by state surgery. An
 * approved card sits `queued` (the one legal post-approval state), and
 * this function reports it as `approved` so the caller proceeds. The
 * authority is NOT explicitly marked used where the operation is
 * single-use at the domain (a delivery note takes ONE receipt — the
 * one-answer rule), so a standing approved card authorizes nothing after
 * the operation lands.
 *
 * A quote is NOT single-use (a pack may set `max_uses` above 1), so the
 * purchasing doors (NEGOTIATION_PLAN §4.7) spend the card explicitly with
 * `consumeStaffEscalation` when the hold it approved succeeds, and record
 * the held order it was spent on (`commerce_staff_clearances`): one owner
 * yes, one order.
 *
 * Only Core mints these cards: the workflow API refuses the payload type and
 * the key namespace, and Brain may not decide one.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import type { StaffScope } from './staff_grants';
import type { Money } from '@dina/commerce-protocol';

export const STAFF_ESCALATION_APPROVAL_TYPE = 'commerce_staff_escalation';

export interface StaffEscalationPayload {
  type: typeof STAFF_ESCALATION_APPROVAL_TYPE;
  device_did: string;
  scope: StaffScope;
  /** What the operation concerns — an order id or a note digest. */
  subject: string;
  value: Money | null;
  reason: string;
}

/** A staff escalation card expires unactioned after 15 minutes. */
export const STAFF_ESCALATION_TTL_SEC = 15 * 60;

export type StaffEscalationOutcome =
  /** A card is pending (this call raised it, or it already stood). */
  | { kind: 'escalated'; taskId: string }
  /** The owner approved THIS value for THIS subject — proceed. */
  | { kind: 'approved'; taskId: string }
  /** No workflow service — fail CLOSED, the operation refuses outright. */
  | { kind: 'unavailable' };

export function escalateStaffOperation(args: {
  deviceDid: string;
  scope: StaffScope;
  subject: string;
  value: Money | null;
  reason: string;
  nowMs: number;
  /**
   * Is this card already spent, by a record the caller keeps (NEGOTIATION_PLAN
   * §4.7's clearances)? A spent card is finished here — whatever state a
   * crash left it in — and a new card is raised for the new question.
   */
  spentElsewhere?: (taskId: string) => boolean;
}): StaffEscalationOutcome {
  const service = getWorkflowService();
  if (service === null) return { kind: 'unavailable' };

  const valueKey = args.value === null ? '' : `${args.value.currency}:${args.value.minor_units}`;
  const idemKey = `${STAFF_ESCALATION_APPROVAL_TYPE}:${args.deviceDid}:${args.scope}:${args.subject}:${valueKey}`;
  const existing = service.store().getActiveByIdempotencyKey(idemKey);
  if (existing !== null) {
    // The card must be THIS question, minted here: a task under the key that
    // is not a Core escalation for the same device, scope, subject and value
    // is never read as the owner's yes. Fail closed — the operation refuses.
    // (The API refuses both the payload type and the key namespace, and Brain
    // may not decide the card, so this is defence behind those doors.)
    if (!isThisEscalation(existing.payload, args)) return { kind: 'unavailable' };
    if (args.spentElsewhere?.(existing.id) === true) {
      // Spent, and a crash kept the card from saying so: finish it, then ask
      // the owner afresh below.
      if (!finishSpend(existing.id, args.nowMs)) return { kind: 'unavailable' };
    } else {
      // `pending_approval → queued` is the approve route's one transition,
      // and nothing else claims these cards — so `queued` MEANS approved.
      if (existing.status === WorkflowTaskState.Queued) {
        return { kind: 'approved', taskId: existing.id };
      }
      return { kind: 'escalated', taskId: existing.id };
    }
  }

  const payload: StaffEscalationPayload = {
    type: STAFF_ESCALATION_APPROVAL_TYPE,
    device_did: args.deviceDid,
    scope: args.scope,
    subject: args.subject,
    value: args.value,
    reason: args.reason,
  };
  const shortDid =
    args.deviceDid.length > 24
      ? `${args.deviceDid.slice(0, 16)}…${args.deviceDid.slice(-6)}`
      : args.deviceDid;
  const valueText =
    args.value === null ? '' : ` for ${args.value.minor_units} ${args.value.currency} (minor units)`;
  const id = `staff-escalation-${bytesToHex(randomBytes(8))}`;
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    description: `Staff device ${shortDid} attempted ${args.scope}${valueText} — ${args.reason}`,
    payload: JSON.stringify(payload),
    expiresAtSec: Math.floor(args.nowMs / 1000) + STAFF_ESCALATION_TTL_SEC,
    idempotencyKey: idemKey,
    origin: 'agent',
    initialState: WorkflowTaskState.PendingApproval,
  });
  return { kind: 'escalated', taskId: id };
}

/** The idempotency-key namespace only this module mints; the workflow API refuses it. */
export const STAFF_ESCALATION_KEY_PREFIX = `${STAFF_ESCALATION_APPROVAL_TYPE}:`;

function isThisEscalation(
  payloadJson: string | undefined,
  args: { deviceDid: string; scope: StaffScope; subject: string; value: Money | null },
): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson ?? '');
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object') return false;
  const card = payload as Partial<StaffEscalationPayload>;
  const sameValue =
    args.value === null
      ? card.value === null
      : card.value !== null &&
        card.value !== undefined &&
        card.value.currency === args.value.currency &&
        card.value.minor_units === args.value.minor_units;
  return (
    card.type === STAFF_ESCALATION_APPROVAL_TYPE &&
    card.device_did === args.deviceDid &&
    card.scope === args.scope &&
    card.subject === args.subject &&
    sameValue
  );
}

/**
 * Mark an approved card spent (NEGOTIATION_PLAN §4.7): `queued → running` by
 * compare-and-swap, then `completed` with a result naming what it was spent
 * on, so the owner's history keeps reading "approved" (a completed approval),
 * never "denied", and the card leaves the active set. The caller records the
 * spend durably FIRST (the clearance row); this only brings the card's state
 * into line. False when there is no workflow service or the card was not
 * approved-and-unspent.
 */
export function consumeStaffEscalation(taskId: string, spentOn: string, nowMs: number): boolean {
  const service = getWorkflowService();
  if (service === null) return false;
  try {
    if (
      !service.store().transition(taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs)
    ) {
      return false;
    }
    service.complete(taskId, JSON.stringify({ spent_on: spentOn }), `spent on ${spentOn}`);
    return true;
  } catch {
    return false;
  }
}

/** Finish a spend a crash interrupted: from `queued` or `running` to `completed`. */
function finishSpend(taskId: string, nowMs: number): boolean {
  const service = getWorkflowService();
  if (service === null) return false;
  try {
    const task = service.store().getById(taskId);
    if (task === null) return false;
    if (task.status === WorkflowTaskState.Queued) {
      service.store().transition(taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    }
    service.complete(taskId, JSON.stringify({ spent: true }), 'spent (finished after an interruption)');
    return true;
  } catch {
    return false;
  }
}
