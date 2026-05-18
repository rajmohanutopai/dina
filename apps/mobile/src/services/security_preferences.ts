/**
 * Security preferences — durable storage for non-secret security
 * settings that need to survive a cold launch.
 *
 * Today this is just the auto-lock background timeout (Settings →
 * Security → Auto-lock when backgrounded). The Core module's
 * `setBackgroundTimeout` is module-memory only, so without a hydrate
 * step every cold launch resets to the 5-minute default — and the
 * user's "1 minute" pick from the previous session silently reverts
 * (MT-40-I3 found during live verification of MT-40-I2).
 *
 * Keychain is used for consistency with the rest of mobile prefs
 * (`infra_preferences.ts`, `startup_preferences.ts`). The value isn't
 * a secret per se, but the cost of using Keychain for a single
 * integer is negligible and the project already pulls in
 * `react-native-keychain` for everything else.
 *
 * Storage shape: one Keychain row, value is the integer-as-string
 * (e.g. `"60"`). Negative or non-numeric values are treated as "not
 * set" and the caller falls back to the Core default.
 */

import * as Keychain from './keychain';

const SERVICE_BG_TIMEOUT = 'dina.security.background_timeout_s';

/**
 * Load the persisted background timeout in seconds. Returns `null`
 * when the preference has never been set (caller falls back to the
 * Core default — currently 300s).
 */
export async function loadBackgroundTimeoutPreference(): Promise<number | null> {
  const row = await Keychain.getGenericPassword({ service: SERVICE_BG_TIMEOUT });
  if (!row) return null;
  const n = Number.parseInt(row.password, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Persist the user's chosen background timeout. */
export async function saveBackgroundTimeoutPreference(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('saveBackgroundTimeoutPreference: must be a non-negative integer');
  }
  await Keychain.setGenericPassword(
    SERVICE_BG_TIMEOUT,
    String(Math.floor(seconds)),
    { service: SERVICE_BG_TIMEOUT },
  );
}

/** Clear the persisted preference. Used by full local wipe. */
export async function clearBackgroundTimeoutPreference(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE_BG_TIMEOUT });
}
