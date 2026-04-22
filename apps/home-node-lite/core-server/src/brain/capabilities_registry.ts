/**
 * Task 5.45 — capabilities registry.
 *
 * Central in-process registry of supported D2D service capabilities.
 * Used by three call-sites:
 *
 *   1. **VaultContextAssembler** — TTL lookup for the `query_service`
 *      tool (how long to cache a response before considering it
 *      stale).
 *   2. **ServiceHandler** — params-validation anchor on the provider
 *      side. When a query arrives for a known capability, the
 *      registry's schema is authoritative.
 *   3. **Guardian / Formatter** — response-formatting hints for
 *      rich notifications ("Bus 42 — 12 min to Castro" style).
 *
 * **Relationship to task 6.17 (`ProfileBuilder`)**:
 *   - `ProfileBuilder` builds an AT Protocol publishing record from
 *     a config object.
 *   - `CapabilityRegistry` is the *local* in-memory cache of what
 *     capabilities the brain knows about. The two feed each other:
 *     when Brain starts, it reads `service_config.capability_schemas`
 *     (from Core) + registers each into the registry.
 *
 * **TTL resolution** (matches Python reference `get_ttl`):
 *   1. Provider-published schema's `default_ttl_seconds` wins when
 *      present — any capability (known or not) can carry its own
 *      TTL hint in the AT Protocol record.
 *   2. Registry's `defaultTtlSeconds` for capabilities the brain
 *      specifically knows about.
 *   3. Hard fallback: 60 seconds.
 *
 * **Immutable once frozen**: capabilities are registered at boot.
 * `freeze()` locks the registry so a late misbehaving module can't
 * silently add a capability with a wrong schema mid-flight.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.45.
 */

import { computeSchemaHash } from '../appview/schema_hash';

export type JsonSchema = Record<string, unknown>;

export interface CapabilityDefinition {
  /** Capability name (e.g. `"eta_query"`). */
  name: string;
  description: string;
  paramsSchema: JsonSchema;
  resultSchema: JsonSchema;
  /** Default TTL when provider doesn't publish one. Defaults to 60s. */
  defaultTtlSeconds?: number;
}

export interface RegisteredCapability {
  name: string;
  description: string;
  paramsSchema: JsonSchema;
  resultSchema: JsonSchema;
  defaultTtlSeconds: number;
  /** SHA-256 of canonical {description, params, result} — computed at register time. */
  schemaHash: string;
}

export type CapabilityRegistryEvent =
  | { kind: 'registered'; name: string }
  | { kind: 'rejected_duplicate'; name: string }
  | { kind: 'rejected_frozen'; name: string }
  | { kind: 'frozen'; count: number };

export interface CapabilityRegistryOptions {
  onEvent?: (event: CapabilityRegistryEvent) => void;
}

export const DEFAULT_CAPABILITY_TTL_SECONDS = 60;

export class CapabilityRegistry {
  private readonly capabilities: Map<string, RegisteredCapability> = new Map();
  private readonly onEvent?: (event: CapabilityRegistryEvent) => void;
  private frozen = false;

  constructor(opts: CapabilityRegistryOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /**
   * Register a capability. Returns the computed `schemaHash` so
   * callers can cross-check against the AT Protocol record. Throws
   * `RangeError` for invalid input.
   *
   * **Refuses duplicates** + **refuses after `freeze()`** so the
   * registry's contents are discoverable via a single start-up
   * trace rather than surprising registrations during request
   * handling.
   */
  register(def: CapabilityDefinition): RegisteredCapability {
    if (this.frozen) {
      this.emit({ kind: 'rejected_frozen', name: def?.name ?? '' });
      throw new Error('CapabilityRegistry: cannot register after freeze()');
    }
    validateDefinition(def);
    if (this.capabilities.has(def.name)) {
      this.emit({ kind: 'rejected_duplicate', name: def.name });
      throw new Error(
        `CapabilityRegistry: capability "${def.name}" already registered`,
      );
    }
    const ttl =
      def.defaultTtlSeconds === undefined
        ? DEFAULT_CAPABILITY_TTL_SECONDS
        : def.defaultTtlSeconds;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new RangeError(
        `CapabilityRegistry: defaultTtlSeconds for "${def.name}" must be a positive integer`,
      );
    }
    const schemaHash = computeSchemaHash({
      description: def.description,
      params: def.paramsSchema,
      result: def.resultSchema,
    });
    const registered: RegisteredCapability = {
      name: def.name,
      description: def.description,
      paramsSchema: def.paramsSchema,
      resultSchema: def.resultSchema,
      defaultTtlSeconds: ttl,
      schemaHash,
    };
    this.capabilities.set(def.name, registered);
    this.emit({ kind: 'registered', name: def.name });
    return registered;
  }

  /**
   * Register many in one call. Useful at boot from
   * `service_config.capability_schemas`. On a bad entry, nothing is
   * registered — the whole batch fails atomically so the registry
   * never sees half-populated state.
   */
  registerMany(defs: CapabilityDefinition[]): RegisteredCapability[] {
    if (this.frozen) {
      throw new Error('CapabilityRegistry: cannot register after freeze()');
    }
    // Validate all first (atomicity).
    for (const d of defs) validateDefinition(d);
    const names = new Set<string>();
    for (const d of defs) {
      if (this.capabilities.has(d.name) || names.has(d.name)) {
        throw new Error(
          `CapabilityRegistry: duplicate capability "${d.name}" in batch`,
        );
      }
      names.add(d.name);
    }
    const out: RegisteredCapability[] = [];
    for (const d of defs) out.push(this.register(d));
    return out;
  }

  /**
   * Lock the registry. Further `register()` calls throw. Returns the
   * count of locked capabilities for logging.
   */
  freeze(): number {
    this.frozen = true;
    this.emit({ kind: 'frozen', count: this.capabilities.size });
    return this.capabilities.size;
  }

  /** True when `freeze()` has been called. */
  isFrozen(): boolean {
    return this.frozen;
  }

  get(name: string): RegisteredCapability | null {
    const c = this.capabilities.get(name);
    return c ? shallowFreeze(c) : null;
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  list(): RegisteredCapability[] {
    return Array.from(this.capabilities.values())
      .map(shallowFreeze)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  size(): number {
    return this.capabilities.size;
  }

  /**
   * Resolve the effective TTL in seconds for a capability. Honours
   * provider-published schema hints first (they know what their
   * service supports), then falls back to the registry's default,
   * then to `DEFAULT_CAPABILITY_TTL_SECONDS`.
   */
  ttlFor(capability: string, providerSchema?: JsonSchema): number {
    if (providerSchema && typeof providerSchema === 'object') {
      const hint = providerSchema['default_ttl_seconds'];
      if (Number.isInteger(hint) && (hint as number) > 0) {
        return hint as number;
      }
    }
    const known = this.capabilities.get(capability);
    if (known) return known.defaultTtlSeconds;
    return DEFAULT_CAPABILITY_TTL_SECONDS;
  }

  private emit(event: CapabilityRegistryEvent): void {
    this.onEvent?.(event);
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateDefinition(def: CapabilityDefinition): void {
  if (!def || typeof def !== 'object') {
    throw new TypeError('CapabilityRegistry: definition must be an object');
  }
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    throw new TypeError(
      'CapabilityRegistry: definition.name must be a non-empty string',
    );
  }
  if (typeof def.description !== 'string' || def.description.trim() === '') {
    throw new TypeError(
      `CapabilityRegistry: definition "${def.name}" must have a non-empty description`,
    );
  }
  if (
    def.paramsSchema === null ||
    typeof def.paramsSchema !== 'object' ||
    Array.isArray(def.paramsSchema)
  ) {
    throw new TypeError(
      `CapabilityRegistry: definition "${def.name}" paramsSchema must be an object`,
    );
  }
  if (
    def.resultSchema === null ||
    typeof def.resultSchema !== 'object' ||
    Array.isArray(def.resultSchema)
  ) {
    throw new TypeError(
      `CapabilityRegistry: definition "${def.name}" resultSchema must be an object`,
    );
  }
}

/**
 * Return a frozen shallow copy of a capability so the caller can't
 * mutate the stored map. The schemas themselves are not deep-frozen —
 * deep-freezing every schema on every read is expensive + the
 * read-mostly access pattern makes a per-read shallow copy enough
 * defence against typical mistakes.
 */
function shallowFreeze(c: RegisteredCapability): RegisteredCapability {
  return Object.freeze({ ...c });
}
