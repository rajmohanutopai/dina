/**
 * Commerce epoch record (§16.2) — the restore fence.
 *
 * Lives in the supplier's OWN repo at a fixed collection + rkey,
 * outside every backup; activation is CAS at the PDS. This module
 * owns the record's wire contract and chain rules; publication and
 * watermark storage are Core work.
 */

import {
  isRecord,
  validateDid,
  validateHex64,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { verifyCommerceRecordDigest, type Sha256Fn } from './digests';
import { validateCanonicalPositiveInteger } from './numeric';
import { MAX_EPOCH_DIGITS } from './quote';

/** Fixed repo location (§16.2). */
export const COMMERCE_EPOCH_COLLECTION = 'com.dinakernel.commerce.epoch';
export const COMMERCE_EPOCH_RKEY = 'self';

export interface CommerceEpochRecord {
  protocol_version: string;
  business_did: string;
  epoch: string; // canonical positive integer, "1"-based
  previous_epoch_digest?: string; // required after epoch "1"
  reason: 'initial' | 'restore';
  activated_at: string;
  epoch_digest: string;
}

export function validateCommerceEpochRecord(record: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(record)) return 'epoch: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(record.protocol_version, 'epoch.protocol_version'),
    validateDid(record.business_did, 'epoch.business_did'),
    validateIsoUtc(record.activated_at, 'epoch.activated_at'),
  ];
  for (const err of checks) if (err) return err;
  const epochError = validateCanonicalPositiveInteger(record.epoch as string, MAX_EPOCH_DIGITS);
  if (epochError) return `epoch.epoch: ${epochError}`;
  if (record.reason !== 'initial' && record.reason !== 'restore') {
    return 'epoch.reason: must be initial | restore';
  }
  const isGenesis = record.epoch === '1';
  if (isGenesis) {
    if (record.reason !== 'initial') return 'epoch: epoch "1" must carry reason "initial"';
    if (record.previous_epoch_digest !== undefined) {
      return 'epoch: genesis carries no previous_epoch_digest';
    }
  } else {
    if (record.reason !== 'restore') {
      return 'epoch: only a restore increments the epoch — reason must be "restore" after "1"';
    }
    const err = validateHex64(record.previous_epoch_digest, 'epoch.previous_epoch_digest');
    if (err) return err;
  }
  return verifyCommerceRecordDigest('epoch', record, sha256);
}

/** Chain rule: N+1 by exactly one, chained to the prior digest, same
 *  business identity. */
export function verifyEpochSuccession(
  previous: CommerceEpochRecord,
  next: CommerceEpochRecord,
): string | null {
  if (next.business_did !== previous.business_did) return 'epoch: business_did changed';
  if (BigInt(next.epoch) !== BigInt(previous.epoch) + 1n) {
    return `epoch: expected epoch ${(BigInt(previous.epoch) + 1n).toString(10)}, got ${next.epoch}`;
  }
  if (next.previous_epoch_digest !== previous.epoch_digest) {
    return 'epoch: previous_epoch_digest does not chain to the prior record';
  }
  return null;
}
