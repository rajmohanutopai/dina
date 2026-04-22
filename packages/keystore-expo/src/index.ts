/**
 * Expo keystore adapter — string-value secrets keyed by `service` name.
 *
 * Thin wrapper over `react-native-keychain` that:
 *   - hides its `{ username, password }` shape behind a single-string API
 *     (Dina callers don't care about the username; they store one value
 *     per service), and
 *   - returns `null` on cache-miss rather than the library's `false`.
 *
 * Per-service examples Dina uses today:
 *   - `dina.identity`         — current did:plc
 *   - `dina.identity.signing` — signing-key seed (hex)
 *   - `dina.identity.rotation` — rotation-key seed (hex)
 *   - `dina.seed.wrapped`     — wrapped master seed blob (JSON)
 *   - `dina.role`             — user role preference
 *   - `dina.ai.provider`      — active AI provider config
 *
 * Implements the conventions `apps/mobile/src/services/*.ts` already
 * used with `react-native-keychain` directly. Task 1.14.6 swaps those
 * direct calls for this wrapper.
 *
 * Port-interface conformance (`KeystorePort` in @dina/core) lands in
 * Phase 2 — this package will implement the same contract as
 * `@dina/keystore-node`.
 *
 * Extracted per docs/HOME_NODE_LITE_TASKS.md task 1.14.3e.
 */

import * as Keychain from 'react-native-keychain';

// All per-service rows share the same username field — it's an
// implementation-detail of the Keychain API, not a Dina concept.
const KEYCHAIN_USERNAME = 'dina';

/** Read a secret. Returns `null` when no row exists. */
export async function getSecret(service: string): Promise<string | null> {
  const row = await Keychain.getGenericPassword({ service });
  if (!row) return null;
  return row.password;
}

/** Write/overwrite a secret. */
export async function setSecret(service: string, value: string): Promise<void> {
  await Keychain.setGenericPassword(KEYCHAIN_USERNAME, value, { service });
}

/** Delete a secret. No-op when the row doesn't exist. */
export async function deleteSecret(service: string): Promise<void> {
  await Keychain.resetGenericPassword({ service });
}
