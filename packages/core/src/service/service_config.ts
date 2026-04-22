/**
 * Service Config — local description of which capabilities this home node
 * offers, whether they are public, and which MCP tool backs each one.
 *
 * Read by:
 *   - D2D ingress for `service.query`: checks whether the requested
 *     capability is configured locally (contact-gate bypass).
 *   - Brain `ServicePublisher`: publishes the profile to the community PDS.
 *   - Brain `ServiceHandler`: validates inbound params against published schema.
 *
 * Persistence shape is a single row `(key='self', value=<JSON>)`. The schema
 * matches what the Python reference stores under a dedicated table — one row
 * so GET returns the current config as an atomic blob.
 *
 * Source: core/internal/service/service_config.go  (Go reference)
 */

import { getServiceConfigRepository } from './service_config_repository';
import { configEventChannel } from './config_event_channel';

/** Policy for how the provider responds to a `service.query`. */
// Capability schema + service-config types moved to @dina/protocol in
// Phase 1b task 1.17 (category 1.16e). Re-exported here so core's public
// API surface stays intact for downstream consumers.
export type {
  ServiceResponsePolicy,
  ServiceCapabilityConfig,
  ServiceCapabilitySchemas,
  ServiceConfig,
} from '@dina/protocol';
import type { ServiceConfig } from '@dina/protocol';

/** Listener fired after a successful config write. Fresh config is passed. */
export type ConfigChangeListener = (config: ServiceConfig | null) => void;

// ---------------------------------------------------------------------------
// In-memory state — the source of truth within the process. Repository (when
// wired) mirrors writes to SQLite so config survives restart.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'self';

let current: ServiceConfig | null = null;
const listeners = new Set<ConfigChangeListener>();

/**
 * Return the current service config, or `null` if none has been set.
 *
 * **Phase 2.3 (task 2.3).** Reads strictly from the in-memory
 * `current` state — no lazy hydrate. Callers that need to restore
 * persisted state on boot invoke `await hydrateServiceConfig()`
 * explicitly. Staying sync keeps `isCapabilityConfigured` sync on
 * the D2D ingress hot path.
 */
export function getServiceConfig(): ServiceConfig | null {
  return current;
}

/**
 * Restore `current` from the wired repository. Call at boot after
 * `setServiceConfigRepository(...)` and before any `getServiceConfig`
 * reads that should see persisted data. A no-op when no repo is
 * wired or when the repo returns nothing.
 *
 * Corrupt stored rows (invalid JSON / failed validation) leave
 * `current` null — a subsequent `setServiceConfig` overwrites.
 */
export async function hydrateServiceConfig(): Promise<void> {
  const repo = getServiceConfigRepository();
  if (repo === null) return;
  const raw = await repo.get(STORAGE_KEY);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw) as ServiceConfig;
    validateServiceConfig(parsed);
    current = parsed;
  } catch {
    // Corrupt row — leave `current` null.
    current = null;
  }
}

/**
 * Replace the current service config. Caller supplies a fully-formed object;
 * no partial updates. Triggers listeners synchronously after the write.
 *
 * **Phase 2.3.** Repo write is fire-and-forget — in-memory `current`
 * is authoritative within the process; persistence survives restart
 * but a transient write failure doesn't affect this call's result.
 * Double-guarded (outer try/catch + inner .catch) to handle both
 * sync-throw mocks and async rejections.
 *
 * Throws if the config fails structural validation — the write is atomic,
 * so the previous value is preserved on error.
 */
export function setServiceConfig(config: ServiceConfig): void {
  validateServiceConfig(config);
  const repo = getServiceConfigRepository();
  const json = JSON.stringify(config);
  if (repo !== null) {
    try {
      void repo.put(STORAGE_KEY, json, Date.now()).catch(() => {
        /* fail-safe — transient SQL write loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant (mocked repos) */
    }
  }
  current = config;
  notifyListeners(current);
  configEventChannel().emitConfigChanged();
}

/**
 * Clear the config. When `isDiscoverable` flips to `false` the caller can either
 * `setServiceConfig({...existing, isDiscoverable: false})` (keeping the config row
 * for diagnostics) or `clearServiceConfig()` (removing it entirely).
 */
export function clearServiceConfig(): void {
  const repo = getServiceConfigRepository();
  if (repo !== null) {
    try {
      void repo.remove(STORAGE_KEY).catch(() => {
        /* fail-safe — transient SQL delete loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant */
    }
  }
  current = null;
  notifyListeners(null);
  configEventChannel().emitConfigChanged();
}

/** Reset module state — tests only. */
export function resetServiceConfigState(): void {
  current = null;
  listeners.clear();
}

/**
 * Subscribe to config changes. The returned disposer unsubscribes.
 * Listener errors are swallowed and logged — one broken subscriber must not
 * cascade to the others.
 */
export function onServiceConfigChanged(listener: ConfigChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Return whether this home node advertises `capability` to inbound
 * `service.query` traffic. Used by D2D ingress as the contact-gate bypass
 * check.
 */
export function isCapabilityConfigured(capability: string): boolean {
  const cfg = getServiceConfig();
  if (cfg === null || !cfg.isDiscoverable) return false;
  return Object.prototype.hasOwnProperty.call(cfg.capabilities, capability);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
//
// Phase 2.3 removed the private `hydrate()` helper. Its logic lives
// inside the public async `hydrateServiceConfig()` now; lazy hydrate
// from `getServiceConfig()` was removed so that sync hot paths
// (`isCapabilityConfigured` on D2D ingress) don't need to await.

function notifyListeners(cfg: ServiceConfig | null): void {
  for (const l of listeners) {
    try {
      l(cfg);
    } catch {
      // Intentional: a faulty listener should not break the caller's write.
    }
  }
}

/**
 * Structural validation. Throws `Error` with a precise message naming the
 * first violated invariant. Matches the wire-level invariants the Go code
 * enforces in the HTTP handler.
 */
export function validateServiceConfig(value: unknown): asserts value is ServiceConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('service_config: must be a JSON object');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.isDiscoverable !== 'boolean') {
    throw new Error('service_config: isDiscoverable must be a boolean');
  }
  if (typeof v.name !== 'string' || v.name === '') {
    throw new Error('service_config: name is required');
  }
  if (v.description !== undefined && typeof v.description !== 'string') {
    throw new Error('service_config: description must be a string when present');
  }
  if (!v.capabilities || typeof v.capabilities !== 'object') {
    throw new Error('service_config: capabilities must be an object');
  }
  const caps = v.capabilities as Record<string, unknown>;
  // Review #19: a discoverable profile with zero capabilities is a
  // hostile advertisement — it tells AppView "I'm here" but any
  // requester searching for a capability will bounce off. Block it at
  // validation time so the screen's Save button can't put it there.
  if (v.isDiscoverable === true && Object.keys(caps).length === 0) {
    throw new Error(
      'service_config: a discoverable profile must advertise at least one capability (add capabilities or set isDiscoverable to false)',
    );
  }
  for (const [name, entryU] of Object.entries(caps)) {
    if (!name) {
      throw new Error('service_config: capability name cannot be empty');
    }
    if (!entryU || typeof entryU !== 'object') {
      throw new Error(`service_config: capabilities.${name} must be an object`);
    }
    const entry = entryU as Record<string, unknown>;
    if (typeof entry.mcpServer !== 'string' || entry.mcpServer === '') {
      throw new Error(`service_config: capabilities.${name}.mcpServer is required`);
    }
    if (typeof entry.mcpTool !== 'string' || entry.mcpTool === '') {
      throw new Error(`service_config: capabilities.${name}.mcpTool is required`);
    }
    if (entry.responsePolicy !== 'auto' && entry.responsePolicy !== 'review') {
      throw new Error(
        `service_config: capabilities.${name}.responsePolicy must be "auto" or "review"`,
      );
    }
    if (entry.schemaHash !== undefined && typeof entry.schemaHash !== 'string') {
      throw new Error(
        `service_config: capabilities.${name}.schemaHash must be a string when present`,
      );
    }
  }
  if (v.capabilitySchemas !== undefined) {
    if (!v.capabilitySchemas || typeof v.capabilitySchemas !== 'object') {
      throw new Error('service_config: capabilitySchemas must be an object');
    }
    const schemas = v.capabilitySchemas as Record<string, unknown>;
    for (const [name, schemaU] of Object.entries(schemas)) {
      if (!schemaU || typeof schemaU !== 'object') {
        throw new Error(`service_config: capabilitySchemas.${name} must be an object`);
      }
      const s = schemaU as Record<string, unknown>;
      if (!s.params || typeof s.params !== 'object') {
        throw new Error(`service_config: capabilitySchemas.${name}.params is required`);
      }
      if (!s.result || typeof s.result !== 'object') {
        throw new Error(`service_config: capabilitySchemas.${name}.result is required`);
      }
      if (typeof s.schemaHash !== 'string' || s.schemaHash === '') {
        throw new Error(`service_config: capabilitySchemas.${name}.schemaHash is required`);
      }
      if (s.description !== undefined && typeof s.description !== 'string') {
        throw new Error(
          `service_config: capabilitySchemas.${name}.description must be a string when present`,
        );
      }
      if (
        s.defaultTtlSeconds !== undefined &&
        (typeof s.defaultTtlSeconds !== 'number' ||
          !Number.isFinite(s.defaultTtlSeconds) ||
          s.defaultTtlSeconds <= 0)
      ) {
        throw new Error(
          `service_config: capabilitySchemas.${name}.defaultTtlSeconds must be a positive number when present`,
        );
      }
    }
  }
}
