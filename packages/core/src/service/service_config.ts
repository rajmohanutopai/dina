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

import {
  effectiveDiscoverability,
  effectiveListingStatus,
  isListingPublic,
  isListingPublishable,
  resolveCanonicalCapability,
} from '@dina/protocol';

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
 * Multi-listing + rkey-aware (one listing == one execution contract):
 *  - When `rkey` is given (the query carried a `service_uri`), validate ONLY
 *    that exact listing — it must be LIVE (`isListingPublishable`: active and not
 *    `known_only`, so public OR unlisted) and offer the capability. This stops a
 *    query targeting listing A from being admitted because some OTHER listing B
 *    offers the capability.
 *  - When `rkey` is omitted (a generic, link-less query), validate ONLY the
 *    DEFAULT (`self`) listing, and only when it's PUBLIC (`isListingPublic`).
 *    Non-self listings + unlisted listings are reachable only via their
 *    service_uri — matching Brain, which resolves a no-service_uri query to
 *    `self` (so Core can't admit a capability Brain would then drop).
 *
 * Stays SYNC — `resolveCanonicalCapability` is a pure local function from
 * the shared registry (no AppView fetch), preserving the sync-hot-path
 * invariant this function is documented to uphold.
 */
export function isCapabilityConfigured(capability: string, rkey?: string): boolean {
  const inboundCanonical = resolveCanonicalCapability(capability);
  // rkey-targeted: validate exactly that listing (the `service_uri` chose it).
  // A URI-targeted query may reach an `unlisted` listing — the sender got the
  // link — so the bar is `isListingPublishable` (public OR unlisted, active).
  if (rkey !== undefined) {
    const cfg = configs.get(rkey);
    if (cfg === undefined || !isListingPublishable(cfg)) return false;
    return listingOffersCapability(cfg, capability, inboundCanonical);
  }
  // Generic (no service_uri): only the DEFAULT (`self`) listing, and only when
  // it's PUBLIC + active. Two reasons:
  //   - Consistency with execution: Brain resolves a no-service_uri query to the
  //     `self` listing (rkeyForQuery → undefined → readConfig('self')). If Core
  //     admitted a capability on the strength of some OTHER public listing, Core
  //     would allow but Brain would then drop it (self doesn't offer it) — a
  //     silent mismatch. "One listing == one execution contract": a NON-self
  //     listing is reachable ONLY via its service_uri/rkey.
  //   - Unlisted stays link-only: `isListingPublic` excludes unlisted, so even
  //     `self` is reachable generically only when it's public (catalog §5.2).
  const selfCfg = configs.get(DEFAULT_LISTING_RKEY);
  if (selfCfg === undefined || !isListingPublic(selfCfg)) return false;
  return listingOffersCapability(selfCfg, capability, inboundCanonical);
}

/**
 * True iff `rkey` names a LIVE `known_only` listing that offers `capability`.
 *
 * `isCapabilityConfigured` deliberately returns false for known_only (its bar
 * is `isListingPublishable` = public|unlisted), so the ingress uses THIS to
 * detect a known_only listing — and then gates execution on a valid GRANT
 * (the caller-authorization step), NOT on the listing being publishable. A
 * known_only listing with no matching grant is NOT executable.
 */
export function isKnownOnlyCapabilityConfigured(capability: string, rkey: string): boolean {
  const cfg = configs.get(rkey);
  if (cfg === undefined) return false;
  if (effectiveDiscoverability(cfg) !== 'known_only') return false;
  if (effectiveListingStatus(cfg) !== 'active') return false;
  const inboundCanonical = resolveCanonicalCapability(capability);
  return listingOffersCapability(cfg, capability, inboundCanonical);
}

/**
 * Whether ONE listing's config advertises `capability`. Exact-match first
 * (covers canonical-configured + out-of-registry custom keys), then canonical
 * match so an alias-configured provider (`bus_eta`) still answers a canonical
 * query (`eta_query`). `inboundCanonical` is precomputed by the caller.
 */
function listingOffersCapability(
  cfg: ServiceConfig,
  capability: string,
  inboundCanonical: string | null,
): boolean {
  if (Object.prototype.hasOwnProperty.call(cfg.capabilities, capability)) return true;
  if (inboundCanonical === null) return false;
  for (const configured of Object.keys(cfg.capabilities)) {
    if (resolveCanonicalCapability(configured) === inboundCanonical) return true;
  }
  return false;
}

/**
 * Resolve `capability` (possibly an alias or canonical name) to the ACTUAL key
 * under which a listing configured it — so callers read the right
 * `capabilities` / `capabilitySchemas` entry. Same alias↔canonical logic as
 * `listingOffersCapability`, but returns the configured key (or null). Used by
 * the offer route so an alias-configured listing can be offered by its
 * canonical name (and vice versa).
 */
export function configuredCapabilityKey(cfg: ServiceConfig, capability: string): string | null {
  if (Object.prototype.hasOwnProperty.call(cfg.capabilities, capability)) return capability;
  const inboundCanonical = resolveCanonicalCapability(capability);
  if (inboundCanonical === null) return null;
  for (const configured of Object.keys(cfg.capabilities)) {
    if (resolveCanonicalCapability(configured) === inboundCanonical) return configured;
  }
  return null;
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
  if (
    v.status !== undefined &&
    v.status !== 'draft' &&
    v.status !== 'active' &&
    v.status !== 'paused'
  ) {
    throw new Error("service_config: status must be 'draft', 'active', or 'paused' when present");
  }
  if (!v.capabilities || typeof v.capabilities !== 'object') {
    throw new Error('service_config: capabilities must be an object');
  }
  const caps = v.capabilities as Record<string, unknown>;
  // NOTE: `validateServiceConfig` is STRUCTURAL ONLY. The "a LIVE listing must
  // advertise ≥1 capability" POLICY lives in `@dina/protocol`'s
  // `validateServiceListing` (`no_capabilities`), which is status-aware so an
  // in-progress `paused`/`draft` listing may legitimately be empty. Enforcing it
  // here too (the old `isDiscoverable && zero caps → throw`) contradicted that —
  // it blocked pausing an empty public listing — so the rule was removed from
  // this structural setter and centralised in `validateServiceListing` (run by
  // the Core route + the mobile publish flow).
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
