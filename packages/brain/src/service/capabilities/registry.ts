/**
 * Central capability registry for D2D service discovery.
 *
 * Consumed by:
 *   - ServiceHandler (provider-side params validation)
 *   - ServiceQueryOrchestrator (requester-side TTL lookup + param pre-validation)
 *   - ServicePublisher (schema + schema_hash publication)
 *   - Guardian (result formatting on inbound workflow events)
 *
 * Adding a new capability: drop a module in this folder that exports its
 * typed params/result, their JSON Schemas, and runtime validators, then
 * register it in `CAPABILITIES` below.
 *
 * Source: brain/src/service/capabilities/registry.py
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { resolveCanonicalCapability } from '@dina/protocol';

import {
  AppointmentAvailabilityParamsSchema,
  AppointmentAvailabilityResultSchema,
  AppointmentBookParamsSchema,
  AppointmentBookResultSchema,
  validateAppointmentAvailabilityParams,
  validateAppointmentAvailabilityResult,
  validateAppointmentBookParams,
  validateAppointmentBookResult,
} from './appointment';
import {
  AvailabilityCoordinationParamsSchema,
  AvailabilityCoordinationResultSchema,
  validateAvailabilityCoordinationParams,
  validateAvailabilityCoordinationResult,
} from './availability_coordination';
import {
  EtaQueryParamsSchema,
  EtaQueryResultSchema,
  validateEtaQueryParams,
  validateEtaQueryResult,
} from './eta_query';

/** Runtime validator contract. Returns `null` on success. */
export type Validator = (value: unknown) => string | null;

/** Metadata for a single capability. */
export interface CapabilityDef {
  /** Stable identifier used on the D2D wire and in AppView records. */
  name: string;
  /** Short human description for tool/help surfaces. */
  description: string;
  /** Default TTL (seconds) applied when a caller does not supply one. */
  defaultTtlSeconds: number;
  /** JSON Schema (draft-07) for the `params` payload. */
  paramsSchema: Record<string, unknown>;
  /** JSON Schema (draft-07) for the `result` payload. */
  resultSchema: Record<string, unknown>;
  /** Runtime validator for `params`. */
  validateParams: Validator;
  /** Runtime validator for `result`. */
  validateResult: Validator;
}

const CAPABILITIES: Readonly<Record<string, CapabilityDef>> = Object.freeze({
  eta_query: {
    name: 'eta_query',
    description: 'Query estimated time of arrival for a transit service.',
    defaultTtlSeconds: 60,
    paramsSchema: EtaQueryParamsSchema as unknown as Record<string, unknown>,
    resultSchema: EtaQueryResultSchema as unknown as Record<string, unknown>,
    validateParams: validateEtaQueryParams,
    validateResult: validateEtaQueryResult,
  },
  appointment_availability: {
    name: 'appointment_availability',
    description: 'Available appointment or consultation slots (salons, consultants, clinics).',
    defaultTtlSeconds: 120,
    paramsSchema: AppointmentAvailabilityParamsSchema as unknown as Record<string, unknown>,
    resultSchema: AppointmentAvailabilityResultSchema as unknown as Record<string, unknown>,
    validateParams: validateAppointmentAvailabilityParams,
    validateResult: validateAppointmentAvailabilityResult,
  },
  appointment_book: {
    name: 'appointment_book',
    description: 'Book an appointment slot. Always review-gated by the provider.',
    // Review policy means a human approves before the answer exists —
    // give the round trip the full wire maximum (MAX_SERVICE_TTL).
    defaultTtlSeconds: 300,
    paramsSchema: AppointmentBookParamsSchema as unknown as Record<string, unknown>,
    resultSchema: AppointmentBookResultSchema as unknown as Record<string, unknown>,
    validateParams: validateAppointmentBookParams,
    validateResult: validateAppointmentBookResult,
  },
  availability_coordination: {
    name: 'availability_coordination',
    description:
      'Coordinate a mutual meeting time with a contact (symmetric: both have calendars, both confirm).',
    // A round can require the owner's input (counter/accept may be review-gated
    // per listing), so budget the full wire maximum like appointment_book.
    defaultTtlSeconds: 300,
    paramsSchema: AvailabilityCoordinationParamsSchema as unknown as Record<string, unknown>,
    resultSchema: AvailabilityCoordinationResultSchema as unknown as Record<string, unknown>,
    validateParams: validateAvailabilityCoordinationParams,
    validateResult: validateAvailabilityCoordinationResult,
  },
});

/** Fallback TTL applied when a capability is unknown. Mirrors Go default. */
export const FALLBACK_TTL_SECONDS = 60;

/** List of registered capability names. Stable across calls. */
export const SUPPORTED_CAPABILITIES: readonly string[] = Object.freeze(Object.keys(CAPABILITIES));

/**
 * Resolve a (possibly alias) capability name to its CAPABILITIES key.
 * Exact match first (covers canonical-keyed defs + any local-only name),
 * then fold through the shared canonical registry so a known alias
 * (`bus_eta`) resolves to its canonical def (`eta_query`). Returns the
 * key to index `CAPABILITIES` with, or `undefined` when nothing matches.
 */
function resolveLocalKey(name: string): string | undefined {
  if (name in CAPABILITIES) return name;
  const canonical = resolveCanonicalCapability(name);
  if (canonical !== null && canonical in CAPABILITIES) return canonical;
  return undefined;
}

/**
 * Return the capability definition, or `undefined` if not registered.
 * Alias-aware: `getCapability('bus_eta')` returns the `eta_query` def, so
 * sender/provider-side local validation isn't skipped for alias names.
 */
export function getCapability(name: string): CapabilityDef | undefined {
  const key = resolveLocalKey(name);
  return key === undefined ? undefined : CAPABILITIES[key];
}

/**
 * Return the default TTL (seconds) for `capability`, or `FALLBACK_TTL_SECONDS`
 * when unknown. Never throws — callers routinely pass user input through
 * this path. Alias-aware (same canonical resolution as `getCapability`).
 */
export function getTTL(capability: string): number {
  const key = resolveLocalKey(capability);
  return key === undefined ? FALLBACK_TTL_SECONDS : CAPABILITIES[key].defaultTtlSeconds;
}

/** Return a shallow copy of every registered capability definition. */
export function listCapabilities(): readonly CapabilityDef[] {
  return SUPPORTED_CAPABILITIES.map((n) => CAPABILITIES[n]);
}

// ---------------------------------------------------------------------------
// Schema hashing
// ---------------------------------------------------------------------------

/**
 * Compute a stable SHA-256 over a schema object. Used for:
 *   - publishing `schema_hash` alongside a capability's JSON Schema
 *   - the requester's sender-side version check before posting a query
 *   - the provider's `schema_version_mismatch` early-return
 *
 * The serialisation is canonical: object keys are sorted recursively and
 * whitespace is stripped. This matches the Python reference (`json.dumps`
 * with `sort_keys=True`, `separators=(",", ":")`).
 */
export function computeSchemaHash(schema: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJSON(schema))));
}

/**
 * Canonical JSON serialisation with sorted object keys and no whitespace.
 * Exported for tests / cross-runtime parity checks.
 *
 * Handles: string, number, boolean, null, array, plain object. Rejects
 * `undefined`, functions, symbols, bigints, non-finite numbers — these would
 * round-trip differently from the Python reference and silently corrupt the
 * hash.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJSON: non-finite number (${value}) is not representable`);
      }
      // JSON.stringify emits the shortest round-trip form — matches Python.
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map(canonicalJSON).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) continue; // match JSON.stringify semantics
        parts.push(JSON.stringify(k) + ':' + canonicalJSON(v));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new Error(
        `canonicalJSON: unsupported type "${typeof value}" — only JSON-representable values allowed`,
      );
  }
}
