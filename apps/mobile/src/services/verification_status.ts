/**
 * verification_status — tracks whether the user has confirmed they
 * actually wrote down their recovery phrase.
 *
 * Three states a user can be in:
 *
 *   - **Verified**: completed the in-onboarding "Quick check" step,
 *     OR completed the deferred Confirm flow from Settings later. We
 *     represent this by ABSENCE of the keychain entry — that way
 *     legacy installs (pre-feature) aren't pestered with the
 *     "confirm your phrase" banner.
 *   - **Pending**: tapped "I'll do this later" during onboarding. We
 *     write `'pending'` to keychain. Chat home shows a confirm-now
 *     banner; Settings exposes a "Confirm recovery phrase" row.
 *   - **(Legacy/never set)**: same observable state as Verified —
 *     the field is absent and we don't surface any banner.
 *
 * Why keychain (not the SQLite vault): the verification status is
 * read on every chat-home mount, including the moments right after
 * unlock when the persistence layer is mid-bring-up. Keychain is
 * always-on, fast, and survives an unlock cycle the same way the
 * wrapped seed does.
 *
 * Lifecycle: `clearOrphanKeychainState` (`install_marker.ts`) wipes
 * this entry on reinstall along with every other `dina.*` keychain
 * service, so a new install starts in the legacy/Verified state and
 * the in-onboarding flow re-decides.
 */

import * as Keychain from './keychain';

export type VerificationStatus = 'pending' | 'verified';

const SERVICE = 'dina.verification_status';
// react-native-keychain wants a non-empty username field even when
// only the password slot carries data. Same convention as
// `startup_preferences`.
const USERNAME = 'dina';

/**
 * Read the user's current verification status. Returns `'pending'`
 * iff they explicitly skipped the in-onboarding check; `'verified'`
 * for everyone else (legacy installs included).
 */
export async function loadVerificationStatus(): Promise<VerificationStatus> {
  try {
    const row = await Keychain.getGenericPassword({ service: SERVICE });
    if (row && row.password === 'pending') return 'pending';
    return 'verified';
  } catch {
    // Keychain read failure → fail open (treat as verified) so we
    // don't surface a confirm banner on a transient native error.
    // The next successful read will reflect reality.
    return 'verified';
  }
}

/**
 * Mark verification as pending. Called when the user taps "I'll do
 * this later" during onboarding.
 */
export async function markVerificationPending(): Promise<void> {
  await Keychain.setGenericPassword(USERNAME, 'pending', { service: SERVICE });
}

/**
 * Mark verification complete. Called from two places:
 *   1. The in-onboarding "Quick check" success path (clearing any
 *      legacy 'pending' state that survived a reinstall — defensive).
 *   2. The deferred Confirm-from-Settings flow on success.
 *
 * Implemented as a keychain delete: absence == verified, so removing
 * the entry is the canonical signal.
 */
export async function markVerified(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
