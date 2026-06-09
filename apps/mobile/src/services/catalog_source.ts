/**
 * Mobile service-capability catalog source (SERVICE_CAPABILITY_CATALOG_DESIGN.md §2).
 *
 * The official catalog is served by AppView (`com.dinakernel.catalog.capabilities`)
 * and cached by mobile. Mobile ships a small BUNDLED fallback (the
 * `@dina/protocol` catalog it was built against) for offline / pre-fetch setup;
 * the live AppView catalog WINS when available and valid (§2: "AppView catalog
 * wins when available").
 *
 * This module is the pure source-resolution + selector layer the provider-setup
 * picker consumes. The concrete AppView fetch + persistence is injected so this
 * stays testable without the network: `resolveCatalog(fetched)` picks live-or-
 * bundled, and the selectors drive the Category → Capability picker.
 */

import {
  CATALOG_CATEGORIES,
  CATALOG_CAPABILITIES,
  type CapabilityDefinition,
  type CatalogCategory,
  type Discoverability,
} from '@dina/protocol';

export interface CatalogData {
  readonly categories: readonly CatalogCategory[];
  readonly capabilities: readonly CapabilityDefinition[];
  /** Where this data came from — `live` (AppView) or `bundled` (fallback). */
  readonly source: 'live' | 'bundled';
}

/** The fallback catalog mobile was built with. Used until AppView responds. */
export const BUNDLED_CATALOG: CatalogData = {
  categories: CATALOG_CATEGORIES,
  capabilities: CATALOG_CAPABILITIES,
  source: 'bundled',
};

/** Minimal shape of an AppView catalog payload (validated structurally here). */
interface FetchedCatalogShape {
  readonly categories?: unknown;
  readonly capabilities?: unknown;
}

/**
 * Choose the catalog to use: the fetched (live) catalog when it is structurally
 * valid, non-empty, AND policy-complete, else the bundled fallback. Never
 * returns an empty catalog — a malformed/empty AppView response degrades to
 * bundled rather than leaving the picker with nothing (§2: fallback is treated
 * as fallback only).
 *
 * Policy-completeness gate (PUBLIC_SERVICES_TAXONOMY §3): a STALE AppView
 * snapshot (pre-2026-06-09) lacks the routing-policy fields and still carries
 * the old defaults (e.g. school_homework_status → `unlisted` instead of
 * `known_only`). "Live wins" over a NEWER bundled catalog would silently
 * revert the shipped safety defaults and feed `undefined` into any policy
 * read — so a live catalog whose capabilities are missing `intent_routable` /
 * `requires_subject_authorization` is treated as stale and degraded to
 * bundled, exactly like a malformed payload.
 */
export function resolveCatalog(fetched: FetchedCatalogShape | null | undefined): CatalogData {
  if (
    fetched !== null &&
    fetched !== undefined &&
    Array.isArray(fetched.categories) &&
    fetched.categories.length > 0 &&
    Array.isArray(fetched.capabilities) &&
    fetched.capabilities.length > 0 &&
    fetched.capabilities.every(
      (cap) =>
        typeof cap === 'object' &&
        cap !== null &&
        typeof (cap as { intent_routable?: unknown }).intent_routable === 'boolean' &&
        typeof (cap as { requires_subject_authorization?: unknown })
          .requires_subject_authorization === 'boolean',
    )
  ) {
    return {
      categories: fetched.categories as CatalogCategory[],
      capabilities: fetched.capabilities as CapabilityDefinition[],
      source: 'live',
    };
  }
  return BUNDLED_CATALOG;
}

/** Categories ordered for the provider-setup UI (spec §36 ordering). */
export function sortedCategories(catalog: CatalogData): CatalogCategory[] {
  // `hidden` categories are not offered for new listings (spec §7).
  return catalog.categories
    .filter((c) => c.lifecycle !== 'hidden')
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Capabilities a provider can pick under a given category (cross-category aware
 * — a capability appears in every category in its `category_ids`, spec §9.1).
 * `retired` capabilities are hidden from new creation (spec §7); `deprecated`
 * are kept (existing providers still work, new listings discouraged) but the UI
 * can label them.
 */
export function capabilitiesInCategory(
  catalog: CatalogData,
  categoryId: string,
): CapabilityDefinition[] {
  return catalog.capabilities.filter(
    (c) => c.lifecycle !== 'retired' && c.category_ids.includes(categoryId),
  );
}

/** Look up one capability by canonical id within a resolved catalog. */
export function findCapability(catalog: CatalogData, id: string): CapabilityDefinition | null {
  return catalog.capabilities.find((c) => c.id === id) ?? null;
}

/** Restrictiveness order: public (most open) → known_only (most private). */
const DISCOVERABILITY_RANK: Record<Discoverability, number> = {
  public: 0,
  unlisted: 1,
  known_only: 2,
};

/**
 * The safest (most restrictive) discoverability to DEFAULT to for a set of
 * chosen capabilities (spec mobile #12/#13). Each official capability carries a
 * catalog `default_discoverability` — developer/ops, security, identity/access,
 * data/analytics, AI-model-ops, and home-automation capabilities default to
 * `known_only`; a custom (or unknown-to-this-catalog) capability defaults to
 * `unlisted`. Returns the MOST restrictive default across all chosen
 * capabilities so a provider never accidentally publishes a sensitive service
 * to public search; the provider can still explicitly override it. An empty
 * selection yields `public` (the neutral baseline — you can't publish public
 * with no capabilities anyway).
 */
export function defaultDiscoverabilityForCapabilities(
  keys: readonly string[],
  catalog: CatalogData,
): Discoverability {
  let rank = DISCOVERABILITY_RANK.public;
  for (const key of keys) {
    const cap = findCapability(catalog, key);
    // Official → its catalog default; custom/unknown → unlisted (spec #13).
    const d: Discoverability = cap?.default_discoverability ?? 'unlisted';
    if (DISCOVERABILITY_RANK[d] > rank) rank = DISCOVERABILITY_RANK[d];
  }
  return rank === DISCOVERABILITY_RANK.known_only
    ? 'known_only'
    : rank === DISCOVERABILITY_RANK.unlisted
      ? 'unlisted'
      : 'public';
}

// ─── AppView fetch + load (live-wins, fallback-on-any-failure) ───────────────

/** xRPC path AppView serves the catalog at. */
export const CATALOG_XRPC_PATH = '/xrpc/com.dinakernel.catalog.capabilities';

/**
 * Minimal Fetch contract the catalog loader drives — a strict subset of the
 * platform `fetch` so it's injectable in tests + works with the iOS
 * `expo/fetch` swap (see [[project_ios_rn_fetch_expo]]).
 */
export type CatalogFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Fetch the live catalog payload from AppView. Returns the raw payload, or
 * `null` on ANY failure (empty URL, non-2xx, network error, timeout, bad JSON)
 * — the caller degrades to bundled. Fail-soft by design: catalog setup must
 * never hard-error just because AppView is unreachable (spec §2).
 */
export async function fetchLiveCatalog(
  appViewUrl: string,
  fetchImpl: CatalogFetch,
  timeoutMs = 8000,
): Promise<FetchedCatalogShape | null> {
  const base = appViewUrl.trim().replace(/\/$/, '');
  if (base === '') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}${CATALOG_XRPC_PATH}`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as FetchedCatalogShape;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the catalog: fetch the live AppView catalog and resolve to live-or-
 * bundled. Never rejects, never returns empty — on any failure the result is
 * the bundled fallback. The caller holds the result in React state (the picker)
 * and may re-load on focus.
 */
export async function loadCatalog(appViewUrl: string, fetchImpl: CatalogFetch): Promise<CatalogData> {
  const fetched = await fetchLiveCatalog(appViewUrl, fetchImpl);
  return resolveCatalog(fetched);
}
