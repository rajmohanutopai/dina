/**
 * Central capability registry for D2D service discovery: the first-party
 * capabilities' params/result schemas, validators and default TTLs.
 *
 * Consumed by:
 *   - Core's service-query ingress (`service/query_ingress.ts`: provider-side
 *     params validation, result schema for the reasoning lane, approval TTL)
 *   - Brain's ServiceQueryOrchestrator (requester-side TTL lookup + param pre-validation)
 *   - Brain's ServicePublisher (schemas for publication; the hash is Core's
 *     `capabilitySchemaHash`)
 *   - Brain's Guardian (result formatting on inbound workflow events)
 *
 * Adding a new capability: drop a module in this folder that exports its
 * typed params/result, their JSON Schemas, and runtime validators, then
 * register it in `CAPABILITIES` below.
 *
 * Source: brain/src/service/capabilities/registry.py
 */

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
  // Own keys only: `in` would find `toString` and `constructor` on the
  // prototype, and a capability of that name would "resolve" to a function.
  if (Object.prototype.hasOwnProperty.call(CAPABILITIES, name)) return name;
  const canonical = resolveCanonicalCapability(name);
  if (canonical !== null && Object.prototype.hasOwnProperty.call(CAPABILITIES, canonical)) return canonical;
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
