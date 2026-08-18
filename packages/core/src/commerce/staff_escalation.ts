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
 * authority is NOT explicitly marked used, and that is only safe
 * because every operation wired through this seam is single-use at the
 * domain (a delivery note takes ONE receipt — the one-answer rule), so
 * a standing approved card authorizes nothing after the operation
 * lands. A future capped scope without such an invariant must add
 * explicit consumption before reusing this seam.
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
}): StaffEscalationOutcome {
  const service = getWorkflowService();
  if (service === null) return { kind: 'unavailable' };

  const valueKey = args.value === null ? '' : `${args.value.currency}:${args.value.minor_units}`;
  const idemKey = `${STAFF_ESCALATION_APPROVAL_TYPE}:${args.deviceDid}:${args.scope}:${args.subject}:${valueKey}`;
  const existing = service.store().getActiveByIdempotencyKey(idemKey);
  if (existing !== null) {
    // `pending_approval → queued` is the approve route's one transition,
    // and nothing else claims these cards — so `queued` MEANS approved.
    if (existing.status === WorkflowTaskState.Queued) {
      return { kind: 'approved', taskId: existing.id };
    }
    return { kind: 'escalated', taskId: existing.id };
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
