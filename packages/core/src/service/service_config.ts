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

import { effectiveDiscoverability, resolveCanonicalCapability } from '@dina/protocol';

import { configEventChannel } from './config_event_channel';
import { getServiceConfigRepository } from './service_config_repository';
// Layer 5 (SERVICES_LAUNCH_ARCHITECTURE.md Part 1) — canonicalize the
// inbound capability so an alias-configured provider accepts the
// canonical query. Pure/sync from the shared registry; keeps
// `isCapabilityConfigured` synchronous (see port_async_gate test).

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

/**
 * Default listing key. A single-listing provider uses `'self'`; a multi-listing
 * provider (one DID, many storefront/product listings) keys each listing by its
 * own rkey. ONE local listing == ONE published
 * `com.dinakernel.service.profile/<rkey>` record; `rkey` is the join key (the
 * same rkey a listing's `service_uri` carries).
 */
export const DEFAULT_LISTING_RKEY = 'self';

/**
 * Listener fired after a successful config write. Receives the `rkey` that
 * changed and the fresh config for that listing (`null` when the listing was
 * cleared). The rkey lets a subscriber act on exactly the changed listing —
 * publish/update on a config, unpublish on `null` — without re-reading the
 * whole catalog.
 */
export type ConfigChangeListener = (rkey: string, config: ServiceConfig | null) => void;

// ---------------------------------------------------------------------------
// In-memory state — the source of truth within the process. Repository (when
// wired) mirrors writes to SQLite so config survives restart. Keyed by rkey:
// one entry per listing (multi-listing per DID).
// ---------------------------------------------------------------------------

const configs = new Map<string, ServiceConfig>();
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
export function getServiceConfig(rkey: string = DEFAULT_LISTING_RKEY): ServiceConfig | null {
  return configs.get(rkey) ?? null;
}

/**
 * List every configured listing (multi-listing per DID). Sorted by rkey for a
 * stable order. SYNC — reads the in-memory map populated by
 * `hydrateServiceConfig()` + every `setServiceConfig`.
 */
export function listServiceConfigs(): { rkey: string; config: ServiceConfig }[] {
  return [...configs.entries()]
    .map(([rkey, config]) => ({ rkey, config }))
    .sort((a, b) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0));
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
  const rows = await repo.list();
  // The repo is the source of truth: replace in-memory state rather than merge,
  // so a listing the repo no longer has can't survive as a stale in-memory entry
  // across a re-hydrate.
  configs.clear();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.configJSON) as ServiceConfig;
      validateServiceConfig(parsed);
      configs.set(row.rkey, parsed);
    } catch {
      // Corrupt row — skip this listing; a subsequent setServiceConfig overwrites.
    }
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
export function setServiceConfig(
  config: ServiceConfig,
  rkey: string = DEFAULT_LISTING_RKEY,
): void {
  validateServiceConfig(config);
  const repo = getServiceConfigRepository();
  const json = JSON.stringify(config);
  if (repo !== null) {
    try {
      void repo.put(rkey, json, Date.now()).catch(() => {
        /* fail-safe — transient SQL write loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant (mocked repos) */
    }
  }
  configs.set(rkey, config);
  notifyListeners(rkey, config);
  configEventChannel().emitConfigChanged();
}

/**
 * Durable upsert (P1.4): persist the config BEFORE reporting success, so a
 * route that returns 200 has actually written the row (it won't vanish on
 * restart). A failed write REJECTS and the in-memory `current` is left
 * unchanged — the caller (the PUT route) surfaces the failure instead of
 * falsely claiming the provider's config saved. Use this on the request path;
 * the fire-and-forget `setServiceConfig` is for best-effort callers (boot
 * hydration) that intentionally tolerate transient write loss.
 */
export async function setServiceConfigDurable(
  config: ServiceConfig,
  rkey: string = DEFAULT_LISTING_RKEY,
): Promise<void> {
  validateServiceConfig(config);
  const repo = getServiceConfigRepository();
  if (repo !== null) {
    await repo.put(rkey, JSON.stringify(config), Date.now());
  }
  configs.set(rkey, config);
  notifyListeners(rkey, config);
  configEventChannel().emitConfigChanged();
}

/**
 * Clear the config. When `isDiscoverable` flips to `false` the caller can either
 * `setServiceConfig({...existing, isDiscoverable: false})` (keeping the config row
 * for diagnostics) or `clearServiceConfig()` (removing it entirely).
 */
export function clearServiceConfig(rkey: string = DEFAULT_LISTING_RKEY): void {
  const repo = getServiceConfigRepository();
  if (repo !== null) {
    try {
      void repo.remove(rkey).catch(() => {
        /* fail-safe — transient SQL delete loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant */
    }
  }
  configs.delete(rkey);
  notifyListeners(rkey, null);
  configEventChannel().emitConfigChanged();
}

/**
 * Durable delete (mirror of `setServiceConfigDurable`): remove the row from the
 * repository BEFORE updating in-memory state + notifying, so a route that
 * returns 200 has actually persisted the deletion. A failed repo delete REJECTS
 * and leaves the in-memory listing + its published record untouched — the caller
 * (the DELETE route) surfaces 503 instead of falsely claiming the listing was
 * removed (otherwise the local row resurrects on restart and republishes stale
 * data while the PDS record is already gone). Use this on the request path; the
 * fire-and-forget `clearServiceConfig` is for best-effort callers.
 */
export async function clearServiceConfigDurable(
  rkey: string = DEFAULT_LISTING_RKEY,
): Promise<void> {
  const repo = getServiceConfigRepository();
  if (repo !== null) {
    await repo.remove(rkey);
  }
  configs.delete(rkey);
  notifyListeners(rkey, null);
  configEventChannel().emitConfigChanged();
}

/** Reset module state — tests only. */
export function resetServiceConfigState(): void {
  configs.clear();
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
 *
 * SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 5 (the layer that makes
 * execution actually work): consumer discovery hands out the CANONICAL
 * capability name, so an inbound `service.query` carries canonical
 * `eta_query` even if THIS provider configured itself under an alias
 * (`bus_eta`). A raw `hasOwnProperty` exact-match would then drop the
 * provider's own query as `not_configured`. So we compare on the
 * canonical name: resolve the inbound capability to canonical, and accept
 * if ANY configured capability resolves to the same canonical. An
 * unknown (non-registry) capability falls back to exact-match so
 * out-of-registry/custom capabilities still work.
 *
 * Multi-listing: a DID may publish many listings (one row per rkey). The
 * bypass is allowed if ANY published (public or unlisted) listing offers the capability, so
 * this walks every configured listing — not just `self`.
 *
 * Stays SYNC — `resolveCanonicalCapability` is a pure local function from
 * the shared registry (no AppView fetch), preserving the sync-hot-path
 * invariant this function is documented to uphold.
 */
export function isCapabilityConfigured(capability: string): boolean {
  // Multi-listing: a DID may publish many listings; the contact-gate bypass
  // is allowed if ANY published (public or unlisted) listing offers the capability. Walk every
  // configured listing, not just `self`.
  const inboundCanonical = resolveCanonicalCapability(capability);
  for (const cfg of configs.values()) {
    // A listing is queryable iff it's PUBLISHED to the network (catalog §5.2):
    // public + unlisted accept inbound queries (unlisted is reached via its
    // service_uri from a link/QR — the URI authority is checked separately in
    // bypass.ts); known_only is local-only and never reachable this way. Using
    // effectiveDiscoverability keeps this symmetric with the publish gate
    // (`shouldPublishListing`) — anything published is queryable. Back-compat: a
    // legacy `isDiscoverable=false` config derives `known_only` → still skipped.
    if (effectiveDiscoverability(cfg) === 'known_only') continue;

    // Fast path: exact match against a configured key (covers both
    // canonical-configured providers and out-of-registry custom keys).
    if (Object.prototype.hasOwnProperty.call(cfg.capabilities, capability)) {
      return true;
    }

    // Canonical match: the inbound capability and the configured keys are
    // compared by their canonical names, so alias-vs-canonical mismatches
    // between consumer and provider still resolve. Skipped for an
    // out-of-registry capability (no canonical → exact match only above).
    if (inboundCanonical === null) continue;
    for (const configured of Object.keys(cfg.capabilities)) {
      if (resolveCanonicalCapability(configured) === inboundCanonical) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
//
// Phase 2.3 removed the private `hydrate()` helper. Its logic lives
// inside the public async `hydrateServiceConfig()` now; lazy hydrate
// from `getServiceConfig()` was removed so that sync hot paths
// (`isCapabilityConfigured` on D2D ingress) don't need to await.

function notifyListeners(rkey: string, cfg: ServiceConfig | null): void {
  for (const l of listeners) {
    try {
      l(rkey, cfg);
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
