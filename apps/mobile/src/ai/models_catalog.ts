/**
 * Mobile-side accessor for the repo-root `models.json` catalogue.
 *
 * `models.json` is the single source of truth for known provider /
 * model pairs — the same file `install.sh` validates against and
 * `dina-admin model set` reads when listing options. Mobile imports
 * it directly via Metro's JSON loader so the catalogue ships in the
 * JS bundle; no runtime fetch and no separate sync step with the
 * Brain container needed.
 *
 * Tier defaults (primary / lite / heavy) live in
 * `@dina/brain/llm::getProviderTiers` — those are the model ids the
 * router picks when no per-tier override exists. The picker shows
 * `getModelOptions(provider)` as candidates plus a free-text field
 * so the user can paste an arbitrary id (matches `dina-admin model
 * set`'s "not in models.json, setting anyway" behaviour).
 */

import catalog from '../../../../models.json';

import type { ProviderType } from './provider';

interface ModelEntry {
  pricing?: number[];
  display_name?: string;
  /**
   * For pseudo-ids like `gpt-5.5+thinking` that aren't real model
   * names — the underlying provider model. The picker stores the
   * pseudo-id; the adapter unpacks it before sending to the API.
   */
  real_model?: string;
  /** Set on thinking-mode pseudo-ids; the adapter passes this as
   *  `reasoning.effort` on chat calls. */
  reasoning_effort?: string;
}

interface ModelsJsonProviderBlock {
  display_name?: string;
  models?: Record<string, ModelEntry>;
}

interface ModelsJson {
  providers?: Record<string, ModelsJsonProviderBlock>;
}

const typedCatalog = catalog as ModelsJson;

/**
 * Return the list of model IDs declared for the given provider in
 * `models.json`. Empty array when the provider has no entry — the
 * picker still renders the custom text field so the user is never
 * stuck.
 */
export function getModelOptions(provider: ProviderType): string[] {
  const block = typedCatalog.providers?.[provider];
  if (!block?.models) return [];
  return Object.keys(block.models);
}

/**
 * Human-readable label for a specific model id (e.g.
 * `gpt-5.5 (thinking)` for the `gpt-5.5+thinking` pseudo-id).
 * Falls back to the raw id when no display name is set, so the
 * picker still renders sensibly for custom/uncatalogued entries.
 */
export function getModelDisplayName(provider: ProviderType, modelId: string): string {
  const entry = typedCatalog.providers?.[provider]?.models?.[modelId];
  return entry?.display_name ?? modelId;
}

/** Human-readable provider name from `models.json`. Falls back when missing. */
export function getCatalogDisplayName(provider: ProviderType): string | null {
  return typedCatalog.providers?.[provider]?.display_name ?? null;
}
