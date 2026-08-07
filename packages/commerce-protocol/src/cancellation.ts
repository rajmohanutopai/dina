/**
 * Cancellation contract (§12.8).
 *
 * Cancellation is a new effectful request — it never rewrites history
 * or claims to undo fulfilment already started. The supplier resolves
 * cancellation against acceptance/dispatch ATOMICALLY (exactly one
 * wins; that atomicity lives in Core's order state machine — this
 * module owns the wire contract). `pending_review` is non-terminal
 * and closes via a later result carrying the SAME cancellation_id. A
 * terminal `cancelled` result is CAS-bound into the status chain via
 * `status_digest_at_resolution`.
 */

import { MAX_REASON_CODE_LENGTH } from './acknowledgement';
import {
  isRecord,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { verifyCommerceRecordDigest, type Sha256Fn } from './digests';

export interface CancellationRequest {
  protocol_version: string;
  cancellation_id: string;
  purchase_order_id: string;
  order_digest: string;
  reason_code?: string;
  idempotency_key: string;
  issued_at: string;
  cancellation_digest: string;
}

export type CancellationResultKind =
  | 'cancelled'
  | 'refused_already_dispatched'
  | 'refused_policy'
  | 'pending_review';

export interface CancellationResult {
  protocol_version: string;
  cancellation_id: string;
  purchase_order_id: string;
  result: CancellationResultKind;
  resolved_at: string;
  status_digest_at_resolution?: string;
  result_digest: string;
}

const RESULT_KINDS: ReadonlySet<string> = new Set([
  'cancelled',
  'refused_already_dispatched',
  'refused_policy',
  'pending_review',
]);

export function validateCancellationRequest(request: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(request)) return 'cancellation: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(request.protocol_version, 'cancellation.protocol_version'),
    validateId(request.cancellation_id, 'cancellation.cancellation_id'),
    validateId(request.purchase_order_id, 'cancellation.purchase_order_id'),
    validateHex64(request.order_digest, 'cancellation.order_digest'),
    validateId(request.idempotency_key, 'cancellation.idempotency_key'),
    validateIsoUtc(request.issued_at, 'cancellation.issued_at'),
  ];
  for (const err of checks) if (err) return err;
  if (request.reason_code !== undefined) {
    if (
      typeof request.reason_code !== 'string' ||
      request.reason_code.length === 0 ||
      request.reason_code.length > MAX_REASON_CODE_LENGTH ||
      !/^[a-z0-9_]+$/.test(request.reason_code)
    ) {
      return 'cancellation.reason_code: must be a bounded snake_case code';
    }
  }
  return verifyCommerceRecordDigest('cancellation', request, sha256);
}

export function validateCancellationResult(result: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(result)) return 'cancellationResult: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(result.protocol_version, 'cancellationResult.protocol_version'),
    validateId(result.cancellation_id, 'cancellationResult.cancellation_id'),
    validateId(result.purchase_order_id, 'cancellationResult.purchase_order_id'),
    validateIsoUtc(result.resolved_at, 'cancellationResult.resolved_at'),
  ];
  for (const err of checks) if (err) return err;
  if (typeof result.result !== 'string' || !RESULT_KINDS.has(result.result)) {
    return 'cancellationResult.result: must be cancelled | refused_already_dispatched | refused_policy | pending_review';
  }
  if (result.result === 'cancelled') {
    const err = validateHex64(
      result.status_digest_at_resolution,
      'cancellationResult.status_digest_at_resolution',
    );
    if (err) {
      return `cancellationResult: terminal "cancelled" must carry the status head it ruled on — ${err}`;
    }
  } else if (result.status_digest_at_resolution !== undefined) {
    const err = validateHex64(
      result.status_digest_at_resolution,
      'cancellationResult.status_digest_at_resolution',
    );
    if (err) return err;
  }
  return verifyCommerceRecordDigest('result', result, sha256);
}

/**
 * Correlation rule (§12.8): a later result closes a `pending_review`
 * only when it carries the SAME cancellation_id (and order), and a
 * terminal result never reopens.
 */
export function verifyCancellationResolution(
  pending: CancellationResult,
  final: CancellationResult,
): string | null {
  if (pending.result !== 'pending_review') {
    return 'cancellation: only pending_review awaits a later resolution';
  }
  if (final.cancellation_id !== pending.cancellation_id) {
    return 'cancellation: resolution must carry the same cancellation_id';
  }
  if (final.purchase_order_id !== pending.purchase_order_id) {
    return 'cancellation: resolution must reference the same order';
  }
  if (final.result === 'pending_review') {
    return 'cancellation: pending_review must terminate in a terminal result';
  }
  return null;
}
