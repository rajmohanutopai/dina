/**
 * Reconciliation (§12.7): the contract that resolves `outcome_unknown`
 * without blind duplication.
 *
 * Six outcomes. Every `received_*` decision outcome CARRIES the
 * recorded signed acknowledgement, kind-narrowed — a bare claim is
 * invalid. `received_processing` = decision not yet at the external
 * boundary (pre_effect); `received_unresolved` = the effect MAY have
 * fired (effect_started) — it loops without ever authorizing
 * resubmission and has NO buyer-side timeout into a terminal state.
 * `never_received` alone authorizes byte-identical resubmission, and
 * only when the buyer presented no supplier-signed evidence (§16.2
 * re-adoption rule).
 */

import { validateOrderAcknowledgement, type OrderAcknowledgement } from './acknowledgement';
import { isRecord, validateHex64, validateId, validateProtocolVersionShape } from './common';
import { validateCommerceOrderStatus, type CommerceOrderStatus } from './status';

import type { Sha256Fn } from './digests';

/**
 * The D2D message a buyer retained, in the exact shape its signature was
 * computed over.
 *
 * WHY THE WHOLE MESSAGE AND NOT JUST A SIGNATURE. Nothing in commerce
 * signs a record on its own — `SignedQuote`, `OrderAcknowledgement` and
 * `CommerceOrderStatus` all carry a content digest and no signature
 * field, because in this product "signed" means "authenticated by the
 * D2D envelope it arrived in". So the only supplier signature a buyer
 * can hold is the envelope's, and an envelope signature is checkable
 * only against the envelope's own bytes. A `{record, signature}` pair
 * with no envelope was unverifiable by construction: no receiver could
 * reconstruct what those bytes were.
 *
 * Field-for-field the D2D wire shape, because the signature is over the
 * deterministic serialization of exactly these six fields in this order.
 * `body` is the plaintext body string, pre-base64 — the encoding is the
 * wire builder's business, not the buyer's.
 *
 * TYPES MATTER HERE IN A WAY THEY USUALLY DO NOT. `created_time` is a
 * number and `to` is an array because that is what the serialization
 * emits; storing the timestamp as a string would produce
 * `"created_time":"1770000000"` where the signature covers
 * `"created_time":1770000000`, and every verification would fail for a
 * reason no error message would explain.
 */
export interface RetainedEnvelope {
  id: string;
  type: string;
  from: string;
  to: string[];
  created_time: number;
  body: string;
}

/** Cap on a retained body, so presenting evidence cannot become an upload. */
export const MAX_RETAINED_ENVELOPE_BODY = 64 * 1024;

/**
 * A record the BUYER retained, together with the supplier-signed message
 * that carried it (§12.7, §16.2).
 *
 * The signature is the whole point. A record plus its content digest
 * proves nothing: the digest is a hash of the record, so anyone holding
 * the record — or inventing one — can compute it. Held evidence decides
 * whether a supplier re-adopts an order or answers `never_received`,
 * so it has to be unforgeable, which means a signature by the supplier's
 * own key over bytes the supplier chose.
 *
 * `signature` is hex-encoded Ed25519 over `envelope`'s canonical
 * serialization. `record` is the record the buyer read OUT of that
 * envelope; a receiver must bind the two (the record's digest has to
 * appear in the signed body) rather than trust the pairing, or a buyer
 * could present one message's signature beside another message's record.
 * `signer_key_id` names the supplier verification method the buyer saw,
 * so a receiver can select the right key across a rotation.
 */
export interface HeldEvidence<T> {
  record: T;
  envelope: RetainedEnvelope;
  signature: string;
  signer_key_id?: string;
}

export interface OrderReconcileRequest {
  protocol_version: string;
  purchase_order_id: string;
  order_digest: string;
  idempotency_key: string;
  held_acknowledgement?: HeldEvidence<OrderAcknowledgement>;
  held_status_receipts?: HeldEvidence<CommerceOrderStatus>[];
}

export type OrderReconcileResult =
  | { outcome: 'received_accepted'; acknowledgement: OrderAcknowledgement & { kind: 'accepted' } }
  | { outcome: 'received_rejected'; acknowledgement: OrderAcknowledgement & { kind: 'rejected' } }
  | {
      outcome: 'received_countered';
      acknowledgement: OrderAcknowledgement & { kind: 'counterproposal' };
    }
  | { outcome: 'received_processing'; retry_after_seconds: number }
  | { outcome: 'received_unresolved'; retry_after_seconds: number }
  | { outcome: 'never_received' };

export const MAX_HELD_STATUS_RECEIPTS = 100;
export const MAX_RETRY_AFTER_SECONDS = 86400;

const ACK_KIND_BY_OUTCOME: Readonly<Record<string, string>> = {
  received_accepted: 'accepted',
  received_rejected: 'rejected',
  received_countered: 'counterproposal',
};

/**
 * Structural check for a retained D2D envelope.
 *
 * Required, not optional. A held-evidence submission without the
 * envelope carries a signature over bytes no receiver can reconstruct,
 * so accepting the shape would mean accepting evidence that can only
 * ever fail to verify — reported later as a fork or a `never_received`
 * rather than as the malformed request it is.
 */
function validateRetainedEnvelope(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return `reconcile.${field}: required — a signature with no signed bytes is unverifiable`;
  }
  for (const key of ['id', 'type', 'from'] as const) {
    const raw = value[key];
    if (typeof raw !== 'string' || raw.length === 0) {
      return `reconcile.${field}.${key}: must be a non-empty string`;
    }
  }
  if (typeof value.created_time !== 'number' || !Number.isFinite(value.created_time)) {
    return `reconcile.${field}.created_time: must be a finite number`;
  }
  const body = value.body;
  if (typeof body !== 'string' || body.length === 0) {
    return `reconcile.${field}.body: must be a non-empty string`;
  }
  if (body.length > MAX_RETAINED_ENVELOPE_BODY) {
    return `reconcile.${field}.body: exceeds ${MAX_RETAINED_ENVELOPE_BODY} bytes`;
  }
  if (!Array.isArray(value.to) || value.to.length === 0) {
    return `reconcile.${field}.to: must be a non-empty array`;
  }
  if (value.to.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return `reconcile.${field}.to: every recipient must be a non-empty string`;
  }
  return null;
}

/**
 * Structural check for held evidence. Only the SHAPE lives here — the
 * signature itself is verified by compiled Core against the supplier's
 * key, because this package is zero-dependency and holds no crypto.
 */
function validateHeldEvidenceShape(value: unknown, field: string): string | null {
  if (!isRecord(value)) return `reconcile.${field}: must be an object`;
  if (!isRecord(value.record)) return `reconcile.${field}.record: must be an object`;
  const sig = value.signature;
  if (typeof sig !== 'string' || sig.length === 0) {
    return `reconcile.${field}.signature: required — a record and its content digest prove nothing`;
  }
  if (!/^[0-9a-f]+$/.test(sig) || sig.length % 2 !== 0) {
    return `reconcile.${field}.signature: must be lowercase hex`;
  }
  if (value.signer_key_id !== undefined && typeof value.signer_key_id !== 'string') {
    return `reconcile.${field}.signer_key_id: must be a string when present`;
  }
  const envelopeError = validateRetainedEnvelope(value.envelope, `${field}.envelope`);
  if (envelopeError) return envelopeError;
  return null;
}

export function validateOrderReconcileRequest(request: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(request)) return 'reconcile: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(request.protocol_version, 'reconcile.protocol_version'),
    validateId(request.purchase_order_id, 'reconcile.purchase_order_id'),
    validateHex64(request.order_digest, 'reconcile.order_digest'),
    validateId(request.idempotency_key, 'reconcile.idempotency_key'),
  ];
  for (const err of checks) if (err) return err;
  if (request.held_acknowledgement !== undefined) {
    const shape = validateHeldEvidenceShape(request.held_acknowledgement, 'held_acknowledgement');
    if (shape) return shape;
    const evidence = request.held_acknowledgement as HeldEvidence<unknown>;
    const err = validateOrderAcknowledgement(evidence.record, sha256);
    if (err) return `reconcile.held_acknowledgement.record: ${err}`;
  }
  if (request.held_status_receipts !== undefined) {
    if (!Array.isArray(request.held_status_receipts)) {
      return 'reconcile.held_status_receipts: must be an array';
    }
    if (request.held_status_receipts.length > MAX_HELD_STATUS_RECEIPTS) {
      return `reconcile.held_status_receipts: exceeds ${MAX_HELD_STATUS_RECEIPTS}`;
    }
    for (const entry of request.held_status_receipts) {
      const shape = validateHeldEvidenceShape(entry, 'held_status_receipts[]');
      if (shape) return shape;
      const err = validateCommerceOrderStatus((entry as HeldEvidence<unknown>).record, sha256);
      if (err) return `reconcile.held_status_receipts[].record: ${err}`;
    }
  }
  return null;
}

export function validateOrderReconcileResult(result: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(result)) return 'reconcileResult: must be an object';
  if (typeof result.outcome !== 'string') return 'reconcileResult.outcome: must be a string';
  switch (result.outcome) {
    case 'received_accepted':
    case 'received_rejected':
    case 'received_countered': {
      const err = validateOrderAcknowledgement(result.acknowledgement, sha256);
      if (err) return `reconcileResult: a decision outcome must carry the signed evidence — ${err}`;
      const ack = result.acknowledgement as OrderAcknowledgement;
      const expectedKind = ACK_KIND_BY_OUTCOME[result.outcome];
      if (ack.kind !== expectedKind) {
        return `reconcileResult: outcome "${result.outcome}" must carry a "${String(expectedKind)}" acknowledgement — kind narrowing is schema-invalid otherwise (§12.7)`;
      }
      return null;
    }
    case 'received_processing':
    case 'received_unresolved': {
      const retry = result.retry_after_seconds;
      if (
        typeof retry !== 'number' ||
        !Number.isInteger(retry) ||
        retry < 1 ||
        retry > MAX_RETRY_AFTER_SECONDS
      ) {
        return `reconcileResult.retry_after_seconds: must be an integer in [1, ${MAX_RETRY_AFTER_SECONDS}]`;
      }
      return null;
    }
    case 'never_received':
      return null;
    default:
      return 'reconcileResult.outcome: unknown outcome';
  }
}

/**
 * The §12.7/§16.2 resubmission + re-adoption gate:
 * - resubmission is authorized ONLY by `never_received`;
 * - `never_received` is LEGAL only when the buyer presented no
 *   supplier-signed evidence — against a held acknowledgement the
 *   supplier must re-adopt instead.
 */
export function reconcileOutcomePermitsResubmission(result: OrderReconcileResult): boolean {
  return result.outcome === 'never_received';
}

export function neverReceivedIsLegal(request: OrderReconcileRequest): string | null {
  if (request.held_acknowledgement !== undefined) {
    return 'reconcile: never_received is illegal against a held supplier-signed acknowledgement — the supplier must re-adopt the order (§16.2)';
  }
  if (request.held_status_receipts !== undefined && request.held_status_receipts.length > 0) {
    return 'reconcile: never_received is illegal against held supplier-signed status receipts — the order provably existed (§16.2)';
  }
  return null;
}
