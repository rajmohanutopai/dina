/**
 * Per-provider, per-tier model overrides.
 *
 * Tier defaults live in `getProviderTiers()` (driven by `models.json`
 * at build time). When the user picks a non-default model in the
 * picker, the choice persists here and `resolveModelId` consults the
 * override before falling back to the tier default.
 *
 * Storage: piggybacks on the same keychain abstraction the rest of
 * the AI module uses (see `active_provider.ts`) — one entry per
 * `<provider>:<tier>` keyed by service name. Model ids aren't
 * secrets; reusing the keychain just avoids pulling in a new
 * storage dependency.
 *
 * Reads from `peekModelOverride` are synchronous because
 * `resolveModelId` (the hot path) needs to stay sync. We hydrate the
 * in-memory cache once at boot via `loadModelOverrides()`. Writes
 * update both the cache and the keychain atomically.
 */

import * as Keychain from '../services/keychain';

import type { LLMTier, ProviderType } from './provider';

const SERVICE_PREFIX = 'dina.llm.model_override.';

type OverrideKey = `${ProviderType}:${LLMTier}`;

const PROVIDER_TYPES: ProviderType[] = [
  'openai',
  'gemini',
  'claude',
  'openrouter',
];
const TIERS: LLMTier[] = ['primary', 'lite', 'heavy'];

let cache: Partial<Record<OverrideKey, string>> = {};
let hydrated = false;

function keyOf(provider: ProviderType, tier: LLMTier): OverrideKey {
  return `${provider}:${tier}`;
}

function serviceOf(provider: ProviderType, tier: LLMTier): string {
  return `${SERVICE_PREFIX}${keyOf(provider, tier)}`;
}

/** Hydrate the in-memory cache from the keychain. Idempotent. */
export async function loadModelOverrides(): Promise<void> {
  if (hydrated) return;
  const next: Partial<Record<OverrideKey, string>> = {};
  for (const provider of PROVIDER_TYPES) {
    for (const tier of TIERS) {
      try {
        const row = await Keychain.getGenericPassword({
          service: serviceOf(provider, tier),
        });
        if (row !== false && row.password !== '') {
          next[keyOf(provider, tier)] = row.password;
        }
      } catch {
        // Ignore — missing keychain entry is the common case.
      }
    }
  }
  cache = next;
  hydrated = true;
}

/** Read the in-memory override. Returns `null` when none is set. */
export function peekModelOverride(
  provider: ProviderType,
  tier: LLMTier,
): string | null {
  return cache[keyOf(provider, tier)] ?? null;
}

/** Persist (and cache) an override. */
export async function setModelOverride(
  provider: ProviderType,
  tier: LLMTier,
  model: string,
): Promise<void> {
  cache = { ...cache, [keyOf(provider, tier)]: model };
  await Keychain.setGenericPassword(`${provider}_${tier}`, model, {
    service: serviceOf(provider, tier),
  });
}

/** Remove an override so the tier default applies again. */
export async function clearModelOverride(
  provider: ProviderType,
  tier: LLMTier,
): Promise<void> {
  const next = { ...cache };
  delete next[keyOf(provider, tier)];
  cache = next;
  await Keychain.resetGenericPassword({ service: serviceOf(provider, tier) });
}

/** Test hook — wipe state between test cases. */
export function _resetModelOverridesForTest(): void {
  cache = {};
  hydrated = false;
}
