/**
 * Change-passphrase orchestration — the durable path behind Settings →
 * Security → "Change passphrase".
 *
 * The passphrase never encrypts vault content directly; it wraps the
 * master seed (Argon2id KEK → AES-256-GCM). So "changing the passphrase"
 * is a re-wrap of the SAME seed, which means every persona DEK (derived
 * from the seed via HKDF) is untouched and all existing vault data keeps
 * decrypting. No re-encryption of content, no data migration.
 *
 * The four steps, in the only safe order:
 *   1. Load the persisted wrapped seed (the source of truth for unlock).
 *   2. Re-wrap it: unwrap with the old passphrase, wrap with the new.
 *      A wrong old passphrase fails the GCM tag here and aborts before
 *      anything is written.
 *   3. Persist the new wrapped seed (`saveWrappedSeed`). After this the
 *      new passphrase is the real unlock secret.
 *   4. If the user picked "Unlock automatically", refresh the cached
 *      passphrase so silent boot still works. This is best-effort: the
 *      wrapped seed is already updated, so a failure here only costs the
 *      user one manual unlock — the cache self-heals on the next manual
 *      unlock. We never let a cache hiccup report the change as failed.
 *
 * `doChangePassphrase` in `useSecurity.ts` is the legacy in-memory
 * version that never persisted (and was never wired to a screen); this
 * service is the persistent replacement the UI calls.
 */

import { changePassphrase } from '@dina/core';

import { validatePassphrase } from '../hooks/useSecurity';

import {
  loadStartupMode,
  saveAutoPassphrase,
} from './startup_preferences';
import { loadWrappedSeed, saveWrappedSeed } from './wrapped_seed_store';

export type ChangePassphraseResult = { ok: true } | { ok: false; error: string };

/**
 * Re-wrap the master seed under a new passphrase and persist it.
 *
 * Returns a discriminated result rather than throwing so the screen can
 * render a single inline error. The error strings are deliberately
 * generic about the wrong-passphrase case (no oracle about which step
 * failed), matching the recovery-phrase + unlock gates.
 */
export async function changeVaultPassphrase(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<ChangePassphraseResult> {
  if (oldPassphrase === '') {
    return { ok: false, error: 'Enter your current passphrase.' };
  }

  const validation = validatePassphrase(newPassphrase);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join('. ') };
  }

  if (oldPassphrase === newPassphrase) {
    return { ok: false, error: 'New passphrase must be different from your current one.' };
  }

  const wrapped = await loadWrappedSeed();
  if (wrapped === null) {
    return {
      ok: false,
      error: "Couldn't find your vault on this device. Try fully relaunching the app.",
    };
  }

  let rewrapped;
  try {
    rewrapped = await changePassphrase(oldPassphrase, newPassphrase, wrapped);
  } catch {
    // Wrong old passphrase (GCM tag mismatch) or a corrupt seed. One
    // generic surface — don't leak which step failed.
    return { ok: false, error: 'That current passphrase is incorrect.' };
  }

  // The wrapped seed is the unlock source of truth — write it first so
  // the new passphrase is live even if the auto-cache update below fails.
  await saveWrappedSeed(rewrapped);

  // Keep "Unlock automatically" working. Best-effort: a failure here is
  // non-fatal because the wrapped seed is already the new one, so the
  // unlock gate just falls back to a one-time manual prompt and re-caches.
  try {
    const mode = await loadStartupMode();
    if (mode === 'auto') {
      await saveAutoPassphrase(newPassphrase);
    }
  } catch {
    // swallow — change already succeeded durably
  }

  return { ok: true };
}
