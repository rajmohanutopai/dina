/**
 * Active AI provider — single source of truth, durable across launches.
 *
 * This module is the only thing that writes / reads the selection:
 *   - Settings calls `saveActiveProvider(p)` on selection.
 *   - `buildBootInputs` calls `loadActiveProvider()` so the agentic
 *     loop uses whatever the user picked.
 *
 * The in-memory cache mirrors the keychain so synchronous consumers
 * (render-time reads in Settings) don't need to await every time.
 */

import * as Keychain from 'react-native-keychain';

import { PROVIDERS } from './provider';

import type { ProviderType } from './provider';

const SERVICE = 'dina.active_provider';
const USERNAME = 'dina_active_provider';

/**
 * In-memory cache — mirrors keychain state. `null` means "not loaded
 * yet" until `loadActiveProvider()` runs once; after that `null` means
 * "explicitly none configured".
 */
let cached: ProviderType | null = null;
let loaded = false;

function isValidProvider(s: string): s is ProviderType {
  return s in PROVIDERS;
}

/**
 * Load the persisted active provider from keychain into the cache.
 * Idempotent — subsequent calls return the cached value.
 */
export async function loadActiveProvider(): Promise<ProviderType | null> {
  if (loaded) return cached;
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  if (row !== false && row.password !== '') {
    cached = isValidProvider(row.password) ? row.password : null;
  } else {
    cached = null;
  }
  loaded = true;
  return cached;
}

/** Persist the active provider (or clear with `null`) and update the cache. */
export async function saveActiveProvider(provider: ProviderType | null): Promise<void> {
  if (provider === null) {
    await Keychain.resetGenericPassword({ service: SERVICE });
    cached = null;
    loaded = true;
    return;
  }
  if (!isValidProvider(provider)) {
    throw new Error(`saveActiveProvider: invalid provider "${provider}"`);
  }
  await Keychain.setGenericPassword(USERNAME, provider, { service: SERVICE });
  cached = provider;
  loaded = true;
}

/**
 * Synchronous peek — returns whatever's in cache. Will be `null` until
 * `loadActiveProvider()` has resolved at least once. Use this in render
 * paths that can tolerate an initial null (the Settings screen mounts
 * after boot, which already resolved the cache).
 */
export function peekActiveProvider(): ProviderType | null {
  return cached;
}

/**
 * Reset cache state (for tests). Does NOT clear keychain — pair with
 * `resetKeychainMock()` when you need a clean slate.
 */
export function resetActiveProviderCache(): void {
  cached = null;
  loaded = false;
}
