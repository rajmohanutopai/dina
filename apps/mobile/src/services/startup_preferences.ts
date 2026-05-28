/**
 * Startup preferences — remembers the user's choice of "auto unlock on
 * launch" vs "ask for passphrase each time", and (only for the auto
 * variant) caches the passphrase in keychain so the boot path can
 * unwrap the seed without prompting.
 *
 * Trade-off: auto-unlock means the passphrase is recoverable from the
 * device — convenient for daily use but useless against a determined
 * attacker who has the unlocked phone in hand. Manual mode never
 * stores the passphrase. See `passphrase_set.tsx` ModeCard copy.
 *
 * Two keychain rows so they can be cleared independently:
 *   - `dina.startup.mode` (always present once onboarding completes)
 *   - `dina.startup.passphrase` (present iff mode === 'auto')
 *
 * Both use the default Keychain accessibility (kSecAttrAccessible
 * `WhenUnlockedThisDeviceOnly` on iOS, `AES/GCM` keystore-backed on
 * Android via react-native-keychain). Keys never leave the device.
 */

import * as Keychain from './keychain';

import type { StartupMode } from '../onboarding/state';

const MODE_SERVICE = 'dina.startup.mode';
const MODE_USERNAME = 'dina_startup_mode';
const PP_SERVICE = 'dina.startup.passphrase';
const PP_USERNAME = 'dina_startup_passphrase';

export async function saveStartupMode(mode: StartupMode): Promise<void> {
  await Keychain.setGenericPassword(MODE_USERNAME, mode, { service: MODE_SERVICE });
}

export async function loadStartupMode(): Promise<StartupMode | null> {
  const row = await Keychain.getGenericPassword({ service: MODE_SERVICE });
  if (!row) return null;
  const v = row.password.trim();
  if (v === 'auto' || v === 'manual') return v;
  return null;
}

/**
 * Cache the passphrase for auto-unlock. Caller MUST only invoke this
 * when `mode === 'auto'`. For `manual` mode, call `clearAutoPassphrase`
 * to purge any prior stored copy.
 */
export async function saveAutoPassphrase(passphrase: string): Promise<void> {
  if (passphrase.length === 0) {
    throw new Error('saveAutoPassphrase: empty passphrase');
  }
  // P2.8: the auto-unlock passphrase unlocks the vault — it is the most
  // sensitive cached secret. Keep it device-bound (no iCloud/backup migration),
  // readable after first unlock. (`AFTER_FIRST_UNLOCK` not `WHEN_UNLOCKED` so a
  // post-boot background unlock still works; biometric gating would defeat the
  // auto-unlock convenience this exists for.)
  await Keychain.setGenericPassword(PP_USERNAME, passphrase, {
    service: PP_SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export async function loadAutoPassphrase(): Promise<string | null> {
  const row = await Keychain.getGenericPassword({ service: PP_SERVICE });
  if (!row) return null;
  const v = row.password;
  return v.length > 0 ? v : null;
}

export async function clearAutoPassphrase(): Promise<void> {
  await Keychain.resetGenericPassword({ service: PP_SERVICE });
}

/**
 * Convenience: persist both the mode and (when auto) the passphrase in
 * a single call. Onboarding's provisioning step uses this once the
 * user has set their passphrase.
 */
export async function persistStartupChoice(mode: StartupMode, passphrase: string): Promise<void> {
  await saveStartupMode(mode);
  if (mode === 'auto') {
    await saveAutoPassphrase(passphrase);
  } else {
    await clearAutoPassphrase();
  }
}
