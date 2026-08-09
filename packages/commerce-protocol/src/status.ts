/**
 * Order status chain (§9.11, §16.2).
 *
 * - The legal transition graph is FIXED; anything else is rejected.
 * - Chain genesis is the acknowledgement: `submitted` is buyer-local
 *   and never supplier-signed. The first supplier-signed record has
 *   sequence "0", no predecessor, and a state determined by the
 *   resolving event.
 * - `lines` (required for partially_fulfilled/dispatched) is a
 *   COMPLETE snapshot: every order line exactly once, ordered units,
 *   cumulative monotone fulfilled_quantity bounded by the ordered
 *   quantity.
 * - `delivered` carries `dispute_window_ends_at`; delivered → disputed
 *   is legal only before that digest-bound deadline.
 * - Buyer-side succession is fork DETECTION; a `restore_fence` record
 *   at a higher epoch may name an ANCESTOR of the buyer's head
 *   (§16.2 takeover) — a non-fence successor may never skip the head.
 */

import {
  isRecord,
  isoUtcMillis,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { verifyCommerceRecordDigest, type Sha256Fn } from './digests';
import { validateCanonicalInteger, validateCanonicalPositiveInteger } from './numeric';
import { compareQuantities, validateQuantity, type Quantity } from './quantity';
import { MAX_EPOCH_DIGITS } from './quote';

import type { PurchaseOrderLine } from './order';

export type OrderState =
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'preparing'
  | 'partially_fulfilled'
  | 'dispatched'
  | 'delivered'
  | 'cancelled'
  | 'disputed';

export interface CommerceOrderStatus {
  protocol_version: string;
  purchase_order_id: string;
  supplier_order_id?: string;
  buyer_did: string;
  supplier_did: string;
  sequence: string;
  previous_status_digest?: string;
  state: OrderState;
  lines?: { line_id: string; fulfilled_quantity: Quantity }[];
  dispute_window_ends_at?: string;
  supplier_epoch: string;
  restore_fence?: true;
  updated_at: string;
  evidence_refs?: string[];
  status_digest: string;
}

export const MAX_SEQUENCE_DIGITS = 9;
export const MAX_EVIDENCE_REFS = 20;

/** §9.11 legal transition graph — supplier-signed states only
 *  (`submitted` is buyer-local; it appears as a FROM state for the
 *  buyer machine, never as a signed record). */
export const LEGAL_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  submitted: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'dispatched', 'cancelled', 'disputed'],
  preparing: ['partially_fulfilled', 'dispatched', 'cancelled', 'disputed'],
  partially_fulfilled: ['partially_fulfilled', 'dispatched', 'cancelled', 'disputed'],
  dispatched: ['delivered', 'disputed'],
  delivered: ['disputed'],
  rejected: [],
  cancelled: [],
  disputed: [],
};

const LINES_REQUIRED_STATES: ReadonlySet<OrderState> = new Set([
  'partially_fulfilled',
  'dispatched',
]);

/** Genesis state for each resolving event (§9.11). */
export const GENESIS_STATE_BY_EVENT = {
  accepted: 'accepted',
  rejected: 'rejected',
  cancellation_won: 'cancelled',
  counterproposal: 'rejected',
} as const;

export type GenesisEvent = keyof typeof GENESIS_STATE_BY_EVENT;

/** Absolutely terminal states; `delivered` is terminal only after its
 *  dispute window elapses. */
export function statusIsTerminal(status: CommerceOrderStatus, at_iso: string): boolean {
  if (status.state === 'rejected' || status.state === 'cancelled' || status.state === 'disputed') {
    return true;
  }
  if (status.state === 'delivered' && status.dispute_window_ends_at !== undefined) {
    return isoUtcMillis(at_iso) > isoUtcMillis(status.dispute_window_ends_at);
  }
  return false;
}

/** Structural validation of one signed status record. */
export function validateCommerceOrderStatus(status: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(status)) return 'status: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(status.protocol_version, 'status.protocol_version'),
    validateId(status.purchase_order_id, 'status.purchase_order_id'),
    validateDid(status.buyer_did, 'status.buyer_did'),
    validateDid(status.supplier_did, 'status.supplier_did'),
    validateIsoUtc(status.updated_at, 'status.updated_at'),
  ];
  for (const err of checks) if (err) return err;

  if (status.supplier_order_id !== undefined) {
    const err = validateId(status.supplier_order_id, 'status.supplier_order_id');
    if (err) return err;
  }
  const seqError = validateCanonicalInteger(status.sequence as string, MAX_SEQUENCE_DIGITS);
  if (seqError) return `status.sequence: ${seqError}`;
  const epochError = validateCanonicalPositiveInteger(
    status.supplier_epoch as string,
    MAX_EPOCH_DIGITS,
  );
  if (epochError) return `status.supplier_epoch: ${epochError}`;

  if (typeof status.state !== 'string' || !(status.state in LEGAL_TRANSITIONS)) {
    return 'status.state: unknown state';
  }
  const state = status.state as OrderState;
  if (state === 'submitted') {
    return 'status.state: "submitted" is buyer-local and never supplier-signed (§9.11 genesis rule)';
  }

  // Discriminated-union field requirements.
  if (LINES_REQUIRED_STATES.has(state)) {
    if (!Array.isArray(status.lines) || status.lines.length === 0) {
      return `status.lines: required for state "${state}"`;
    }
    const seen = new Set<string>();
    for (const line of status.lines) {
      if (!isRecord(line)) return 'status.lines[]: must be objects';
      const err =
        validateId(line.line_id, 'status.lines[].line_id') ??
        validateQuantity(line.fulfilled_quantity);
      if (err) return err;
      if (seen.has(line.line_id as string)) {
        return `status.lines: duplicate line_id "${String(line.line_id)}" — lines is a complete snapshot`;
      }
      seen.add(line.line_id as string);
    }
  } else if (status.lines !== undefined) {
    return `status.lines: forbidden for state "${state}" (discriminated union, §9.11)`;
  }

  if (state === 'delivered') {
    const err = validateIsoUtc(status.dispute_window_ends_at, 'status.dispute_window_ends_at');
    if (err) return `status: delivered requires dispute_window_ends_at — ${err}`;
  } else if (status.dispute_window_ends_at !== undefined) {
    return 'status.dispute_window_ends_at: only a delivered record carries the dispute window';
  }

  if (status.restore_fence !== undefined && status.restore_fence !== true) {
    return 'status.restore_fence: must be true when present (§16.2)';
  }
  if (status.previous_status_digest !== undefined) {
    const err = validateHex64(status.previous_status_digest, 'status.previous_status_digest');
    if (err) return err;
  }
  // §9.11 genesis coupling, enforced on the GENERAL receive path (not
  // only in validateGenesisStatus, which needs a caller-supplied
  // resolving event and so never runs for an arriving record): sequence
  // "0" is the genesis and carries NO predecessor; every later sequence
  // MUST carry one. Without this, a record claiming sequence "0" with a
  // predecessor — or a successor with none — passes validation and then
  // corrupts the head+1 arithmetic receivers rely on to spot rollback
  // and duplicate sequences.
  if (status.sequence === '0' && status.previous_status_digest !== undefined) {
    return 'status: genesis (sequence "0") carries no previous_status_digest (§9.11)';
  }
  if (status.sequence !== '0' && status.previous_status_digest === undefined) {
    return 'status: a non-genesis status must carry previous_status_digest (§9.11)';
  }
  if (status.evidence_refs !== undefined) {
    if (!Array.isArray(status.evidence_refs) || status.evidence_refs.length > MAX_EVIDENCE_REFS) {
      return `status.evidence_refs: must be an array of at most ${MAX_EVIDENCE_REFS}`;
    }
    for (const ref of status.evidence_refs) {
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > 512) {
        return 'status.evidence_refs[]: must be non-empty strings of at most 512 characters';
      }
    }
  }
  return verifyCommerceRecordDigest('status', status, sha256);
}

/**
 * Genesis rules (§9.11): sequence "0", no predecessor, state
 * determined by the resolving event. Anything else is rejected.
 */
export function validateGenesisStatus(
  status: CommerceOrderStatus,
  event: GenesisEvent,
): string | null {
  if (status.sequence !== '0') return 'genesis: first supplier-signed status has sequence "0"';
  if (status.previous_status_digest !== undefined) {
    return 'genesis: first status carries no predecessor digest';
  }
  const expected = GENESIS_STATE_BY_EVENT[event];
  if (status.state !== expected) {
    return `genesis: resolving event "${event}" yields genesis state "${expected}", got "${status.state}"`;
  }
  return null;
}

/**
 * Lines snapshot completeness + cumulative rules against the ORDER
 * (§9.11): every order line exactly once, ordered unit, monotone
 * non-decreasing vs the prior snapshot, bounded by the ordered
 * quantity.
 */
export function verifyStatusLines(
  status: CommerceOrderStatus,
  order_lines: readonly PurchaseOrderLine[],
  previous?: CommerceOrderStatus,
): string | null {
  if (status.lines === undefined) return null;
  const byLineId = new Map(order_lines.map((l) => [l.line_id, l]));
  if (status.lines.length !== order_lines.length) {
    return 'status.lines: must be a COMPLETE snapshot of every order line';
  }
  const previousByLineId = new Map(
    (previous?.lines ?? []).map((l) => [l.line_id, l.fulfilled_quantity]),
  );
  for (const line of status.lines) {
    const ordered = byLineId.get(line.line_id);
    if (!ordered) return `status.lines: "${line.line_id}" is not an order line`;
    if (line.fulfilled_quantity.unit_code !== ordered.quantity.unit_code) {
      return `status.lines: "${line.line_id}" changed unit — must equal the ordered unit`;
    }
    const vsOrdered = compareQuantities(line.fulfilled_quantity, ordered.quantity);
    if (typeof vsOrdered === 'string') return `status.lines: ${vsOrdered}`;
    if (vsOrdered > 0) {
      return `status.lines: "${line.line_id}" fulfilled_quantity exceeds the ordered quantity`;
    }
    const prior = previousByLineId.get(line.line_id);
    if (prior !== undefined) {
      const vsPrior = compareQuantities(line.fulfilled_quantity, prior);
      if (typeof vsPrior === 'string') return `status.lines: ${vsPrior}`;
      if (vsPrior < 0) {
        return `status.lines: "${line.line_id}" cumulative fulfilled_quantity regressed`;
      }
    }
  }
  return null;
}

/**
 * Buyer-side succession check for a NON-FENCE successor: identity,
 * head+1 sequence, exact predecessor digest, legal transition,
 * cumulative lines, epoch monotone. `at_iso` bounds
 * delivered → disputed against the dispute window.
 */
export function verifyStatusSuccession(
  held: CommerceOrderStatus,
  next: CommerceOrderStatus,
  order_lines: readonly PurchaseOrderLine[],
  at_iso: string,
): string | null {
  for (const field of ['purchase_order_id', 'buyer_did', 'supplier_did'] as const) {
    if (next[field] !== held[field]) return `status: immutable field ${field} changed`;
  }
  if (next.restore_fence === true) {
    return 'status: restore_fence records go through verifyRestoreFence, not ordinary succession (§16.2)';
  }
  if (next.previous_status_digest !== held.status_digest) {
    return 'status: successor does not extend the held head — supplier fork (§9.11)';
  }
  if (BigInt(next.sequence) !== BigInt(held.sequence) + 1n) {
    return `status: expected sequence ${(BigInt(held.sequence) + 1n).toString(10)}, got ${next.sequence}`;
  }
  if (BigInt(next.supplier_epoch) < BigInt(held.supplier_epoch)) {
    return 'status: supplier_epoch regressed — stale pre-restore signer (§16.2)';
  }
  const legal = LEGAL_TRANSITIONS[held.state];
  if (!legal.includes(next.state)) {
    return `status: illegal transition ${held.state} -> ${next.state}`;
  }
  if (held.state === 'delivered' && next.state === 'disputed') {
    if (
      held.dispute_window_ends_at !== undefined &&
      isoUtcMillis(at_iso) > isoUtcMillis(held.dispute_window_ends_at)
    ) {
      return 'status: delivered -> disputed is legal only before dispute_window_ends_at';
    }
  }
  return verifyStatusLines(next, order_lines, held);
}

/**
 * §16.2 restore-fence acceptance: the fence must be marked, at a
 * STRICTLY higher epoch, and name a predecessor that is the buyer's
 * head or a strict ancestor of it (post-backup signatures lost). A
 * predecessor outside the held chain is a fork. Returns
 * 'head' | 'ancestor' on acceptance, an error string on rejection.
 *
 * `at_iso` is the RECEIVER's clock, exactly as `verifyStatusSuccession`
 * takes it, and for the same reason: the fence's own `updated_at` is
 * supplier-written, so a deadline checked against it is a deadline the
 * supplier sets. It is required rather than optional because an
 * optional clock that skips the check when omitted is precisely the
 * bug this parameter was added to close.
 */
export function verifyRestoreFence(
  fence: CommerceOrderStatus,
  held_chain: readonly CommerceOrderStatus[],
  order_lines: readonly PurchaseOrderLine[],
  sha256: Sha256Fn,
  at_iso: string,
): 'head' | 'ancestor' | string {
  // Structural validation FIRST. A fence arrives from a supplier that
  // just restored from backup — the least trustworthy moment in the
  // protocol — so it earns no more benefit of the doubt than any other
  // inbound record, and its own digest must recompute.
  const structural = validateCommerceOrderStatus(fence, sha256);
  if (structural !== null) return `fence: ${structural}`;
  if (fence.restore_fence !== true) return 'fence: record is not marked restore_fence';
  if (held_chain.length === 0) return 'fence: no held chain to fence against';
  const head = held_chain[held_chain.length - 1] as CommerceOrderStatus;
  // Immutable identity, exactly as verifyStatusSuccession enforces it.
  // Without this a structurally valid higher-epoch fence could name a
  // held predecessor while REWRITING purchase_order_id, buyer_did, or
  // supplier_did — re-pointing the buyer's chain at a different order
  // or a different counterparty (§9.11 fork rule, §16.2 retained
  // evidence).
  for (const field of ['purchase_order_id', 'buyer_did', 'supplier_did'] as const) {
    if (fence[field] !== head[field]) return `fence: immutable field ${field} changed`;
  }
  if (BigInt(fence.supplier_epoch) <= BigInt(head.supplier_epoch)) {
    return 'fence: a restore fence requires a strictly higher supplier_epoch';
  }
  const predecessor = held_chain.find((s) => s.status_digest === fence.previous_status_digest);
  if (!predecessor) {
    return 'fence: predecessor is neither the held head nor an ancestor — supplier fork (§16.2)';
  }
  // A fence still advances the chain by exactly one: an arbitrary or
  // rewound sequence would break the head+1 arithmetic every later
  // successor check depends on, and would let a replayed record pass as
  // a fresh one (§9.11 "receivers reject rollback, duplicate sequence
  // with different digest").
  if (BigInt(fence.sequence) !== BigInt(predecessor.sequence) + 1n) {
    return `fence: expected sequence ${(BigInt(predecessor.sequence) + 1n).toString(10)}, got ${fence.sequence}`;
  }
  // The fence restates the supplier's best-known state: it must equal
  // the named predecessor's state or be a legal transition from it —
  // a fence cannot smuggle an otherwise-illegal state jump.
  if (
    fence.state !== predecessor.state &&
    !LEGAL_TRANSITIONS[predecessor.state].includes(fence.state)
  ) {
    return `fence: illegal state "${fence.state}" from fenced predecessor state "${predecessor.state}"`;
  }
  // The dispute deadline binds the FENCE path too.
  //
  // Without this, `delivered -> disputed` was reachable through a route
  // that never checked the window, while the ordinary route
  // (`verifyStatusSuccession`) refused it. A supplier could therefore
  // dispute an order whose window closed long ago simply by marking the
  // record `restore_fence: true` — a recovery mechanism used to escape a
  // deadline, which is the shape of every privilege escalation.
  //
  // Bound to the PREDECESSOR's window, because the predecessor is the
  // delivered record the buyer holds and its `dispute_window_ends_at` is
  // the one both sides already agreed to.
  if (predecessor.state === 'delivered' && fence.state === 'disputed') {
    if (
      predecessor.dispute_window_ends_at !== undefined &&
      isoUtcMillis(at_iso) > isoUtcMillis(predecessor.dispute_window_ends_at)
    ) {
      return 'fence: delivered -> disputed is legal only before dispute_window_ends_at (§9.11)';
    }
  }
  // Fulfilment must restate or legally advance the fenced predecessor,
  // bounded by the ORDERED quantities. A fence that silently inflates a
  // fulfilled_quantity would let a restored supplier claim delivery of
  // more than was ordered, against evidence the buyer still holds.
  const lineError = verifyStatusLines(fence, order_lines, predecessor);
  if (lineError !== null) return `fence: ${lineError}`;
  return predecessor.status_digest === head.status_digest ? 'head' : 'ancestor';
}
