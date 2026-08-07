/**
 * Shared wire-shape primitives: bounded identifiers, DID shape, ISO
 * UTC timestamps, hex digests, and protocol-version negotiation
 * (§9.13).
 *
 * Timestamps are canonical ISO 8601 UTC with a `Z` suffix and either
 * no fractional seconds or exactly three digits — one spelling per
 * instant, so timestamps inside digest inputs cannot drift between
 * implementations.
 */

export const MAX_ID_LENGTH = 128;
export const MAX_DID_LENGTH = 256;
export const MAX_TEXT_FIELD_LENGTH = 512;

const ID_SHAPE = /^[A-Za-z0-9._:-]+$/;
const DID_SHAPE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const VERSION_SHAPE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Bounded opaque identifier (request_id, quote_id, purchase_order_id, line_id, …). */
export function validateId(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `${field}: must be a non-empty string`;
  }
  if (value.length > MAX_ID_LENGTH) return `${field}: exceeds ${MAX_ID_LENGTH} characters`;
  if (!ID_SHAPE.test(value)) return `${field}: contains characters outside [A-Za-z0-9._:-]`;
  return null;
}

export function validateDid(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `${field}: must be a non-empty string`;
  }
  if (value.length > MAX_DID_LENGTH) return `${field}: exceeds ${MAX_DID_LENGTH} characters`;
  if (!DID_SHAPE.test(value)) return `${field}: is not a DID`;
  return null;
}

export function validateHex64(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    return `${field}: must be a 64-char lowercase hex string`;
  }
  return null;
}

/** Canonical ISO 8601 UTC instant (`Z`, fraction absent or 3 digits). */
export function validateIsoUtc(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) {
    return `${field}: must be a canonical ISO 8601 UTC timestamp (Z suffix, optional .mmm)`;
  }
  if (Number.isNaN(Date.parse(value))) return `${field}: is not a real instant`;
  return null;
}

/** Millisecond epoch of a VALIDATED canonical ISO UTC string. */
export function isoUtcMillis(value: string): number {
  return Date.parse(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Protocol version negotiation (§9.13)
// ---------------------------------------------------------------------------

/** The commerce protocol version this package implements. */
export const COMMERCE_PROTOCOL_VERSION = '1.0';
export const COMMERCE_PROTOCOL_MAJOR = '1';
export const SUPPORTED_COMMERCE_VERSIONS: readonly string[] = [COMMERCE_PROTOCOL_VERSION];

/** Typed rejection for an unknown MAJOR (§9.13): the receiver never
 *  best-effort-parses across majors; it lists what it supports. */
export interface UnsupportedVersionError {
  code: 'unsupported_version';
  requested_version: string;
  supported_versions: string[];
}

/** Structural check: `MAJOR.MINOR`, canonical integers. */
export function validateProtocolVersionShape(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || !VERSION_SHAPE.test(value)) {
    return `${field}: must be "MAJOR.MINOR" with canonical integers`;
  }
  return null;
}

export function protocolMajor(version: string): string {
  return version.split('.')[0] as string;
}

/**
 * Version admission: null when this implementation can parse the
 * document (same MAJOR — MINOR is strictly additive, §9.13), or the
 * typed error when it cannot.
 */
export function checkProtocolVersion(version: string): UnsupportedVersionError | null {
  if (protocolMajor(version) === COMMERCE_PROTOCOL_MAJOR) return null;
  return {
    code: 'unsupported_version',
    requested_version: version,
    supported_versions: [...SUPPORTED_COMMERCE_VERSIONS],
  };
}
