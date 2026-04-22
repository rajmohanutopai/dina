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
});

/** Fallback TTL applied when a capability is unknown. Mirrors Go default. */
export const FALLBACK_TTL_SECONDS = 60;

/** List of registered capability names. Stable across calls. */
export const SUPPORTED_CAPABILITIES: readonly string[] = Object.freeze(Object.keys(CAPABILITIES));

/** Return the capability definition, or `undefined` if not registered. */
export function getCapability(name: string): CapabilityDef | undefined {
  return CAPABILITIES[name];
}

/**
 * Return the default TTL (seconds) for `capability`, or `FALLBACK_TTL_SECONDS`
 * when unknown. Never throws — callers routinely pass user input through
 * this path.
 */
export function getTTL(capability: string): number {
  return CAPABILITIES[capability]?.defaultTtlSeconds ?? FALLBACK_TTL_SECONDS;
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
