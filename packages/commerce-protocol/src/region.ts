/**
 * Region references and delivery projections (§9.0).
 *
 * A DeliveryProjection contains ONLY the fields required at the
 * current disclosure stage; `projection_digest` is recomputed over
 * exactly the present fields, so widening the projection between
 * quote and order produces a different digest. `projectionExtends`
 * implements the §9.9 order rule: every priced-stage field must
 * reappear byte-identically; only additions are legal.
 */

import { canonicalJson } from './canonical';
import { isRecord, validateDid, validateHex64 } from './common';
import { commerceRecordDigest, verifyCommerceRecordDigest, type Sha256Fn } from './digests';

export interface RegionRef {
  scheme: 'country' | 'admin_area' | 'postal_area' | 'geohash' | 'custom';
  value: string;
  issuer_did?: string; // required for custom
}

export interface DeliveryProjection {
  region: RegionRef;
  locality?: string;
  postal_code?: string;
  address_lines?: string[];
  recipient_name?: string;
  recipient_phone?: string;
  projection_digest: string;
}

export const MAX_REGION_VALUE_LENGTH = 100;
export const MAX_PROJECTION_FIELD_LENGTH = 200;
export const MAX_ADDRESS_LINES = 5;

const REGION_SCHEMES: ReadonlySet<string> = new Set([
  'country',
  'admin_area',
  'postal_area',
  'geohash',
  'custom',
]);

export function validateRegionRef(region: unknown): string | null {
  if (!isRecord(region)) return 'region: must be an object';
  if (typeof region.scheme !== 'string' || !REGION_SCHEMES.has(region.scheme)) {
    return 'region: scheme must be country | admin_area | postal_area | geohash | custom';
  }
  if (typeof region.value !== 'string' || region.value.length === 0) {
    return 'region: value must be a non-empty string';
  }
  if (region.value.length > MAX_REGION_VALUE_LENGTH) {
    return `region: value exceeds ${MAX_REGION_VALUE_LENGTH} characters`;
  }
  if (region.scheme === 'custom') {
    const didError = validateDid(region.issuer_did, 'region.issuer_did');
    if (didError) return `region: custom scheme requires issuer_did — ${didError}`;
  } else if (region.issuer_did !== undefined) {
    const didError = validateDid(region.issuer_did, 'region.issuer_did');
    if (didError) return didError;
  }
  return null;
}

function validateBoundedString(value: unknown, field: string, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `${field}: must be a non-empty string`;
  }
  if (value.length > maxLength) return `${field}: exceeds ${maxLength} characters`;
  return null;
}

/**
 * Structural validation of a projection at any disclosure stage,
 * including its stage-scoped digest (`projection` domain).
 */
export function validateDeliveryProjection(projection: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(projection)) return 'projection: must be an object';
  const regionError = validateRegionRef(projection.region);
  if (regionError) return `projection: ${regionError}`;

  for (const field of ['locality', 'postal_code', 'recipient_name', 'recipient_phone'] as const) {
    if (projection[field] !== undefined) {
      const err = validateBoundedString(
        projection[field],
        `projection.${field}`,
        MAX_PROJECTION_FIELD_LENGTH,
      );
      if (err) return err;
    }
  }
  if (projection.address_lines !== undefined) {
    if (!Array.isArray(projection.address_lines) || projection.address_lines.length === 0) {
      return 'projection.address_lines: must be a non-empty array when present';
    }
    if (projection.address_lines.length > MAX_ADDRESS_LINES) {
      return `projection.address_lines: exceeds ${MAX_ADDRESS_LINES} lines`;
    }
    for (const line of projection.address_lines) {
      const err = validateBoundedString(
        line,
        'projection.address_lines[]',
        MAX_PROJECTION_FIELD_LENGTH,
      );
      if (err) return err;
    }
  }
  const digestShapeError = validateHex64(
    projection.projection_digest,
    'projection.projection_digest',
  );
  if (digestShapeError) return digestShapeError;
  return verifyCommerceRecordDigest('projection', projection, sha256);
}

/** Compute the stage-scoped digest for a projection's present fields. */
export function computeProjectionDigest(
  projection: Omit<DeliveryProjection, 'projection_digest'>,
  sha256: Sha256Fn,
): string {
  return commerceRecordDigest('projection', projection as Record<string, unknown>, sha256);
}

/**
 * §9.9 order rule: every field present in the PRICED projection must
 * appear byte-identically in the ORDER projection; only fields absent
 * at quote stage may be added. Returns null when the order projection
 * extends the priced one; an error naming the first violation
 * otherwise.
 */
export function projectionExtends(
  priced: Record<string, unknown>,
  order: Record<string, unknown>,
): string | null {
  for (const [key, value] of Object.entries(priced)) {
    if (key === 'projection_digest' || value === undefined) continue;
    if (!(key in order) || order[key] === undefined) {
      return `projection: priced field "${key}" is missing from the order projection`;
    }
    if (canonicalJson(order[key]) !== canonicalJson(value)) {
      return `projection: priced field "${key}" changed between quote and order — requote required`;
    }
  }
  return null;
}
