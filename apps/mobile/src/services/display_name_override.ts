/**
 * Local display-name override.
 *
 * The DID this node publishes under is anchored at `plc.directory` —
 * along with the `alsoKnownAs[]` handle (`alice.test-pds.dinakernel.com`)
 * the user picked at onboarding. Re-publishing PLC to change the handle
 * is a destructive operation that touches the rotation key + costs an
 * AppView re-index, so the user-facing UI separates two concerns:
 *
 *   1. The published handle  — canonical, on plc.directory.
 *   2. A LOCAL display name  — friendly label, visible only in this
 *                              app on this device.
 *
 * This module owns (2). The override is stored in the OS keychain
 * alongside the role + identity records (same pattern as
 * `role_preference`), hydrated into an in-memory snapshot at boot, and
 * re-emitted via the `useSyncExternalStore` contract so admin-page
 * edits propagate without a remount.
 *
 * Self-only by design: see `displayName_with_override.ts` — the
 * override is consulted only when the rendered DID matches the node's
 * own DID. Renaming someone else would be a per-contact alias feature,
 * which lives on `contacts.directory` if/when we add it.
 */

import * as Keychain from 'react-native-keychain';

const SERVICE = 'dina.display_name_override';
const USERNAME = 'dina_display_name_override';

const MAX_LENGTH = 64;

let snapshot: string | null = null;
const listeners = new Set<() => void>();
let hydrated = false;

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — subscriber bug can't break emit */
    }
  }
}

/**
 * Trim + length-cap. Returning `null` rather than the empty string so
 * the override store has a single "absent" representation and callers
 * never have to distinguish '' from null.
 */
function normalize(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_LENGTH ? trimmed.slice(0, MAX_LENGTH) : trimmed;
}

/**
 * Hydrate the snapshot from the keychain. Idempotent — safe to call
 * from boot and from any UI that mounts before boot has finished.
 */
export async function hydrateDisplayNameOverride(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const row = await Keychain.getGenericPassword({ service: SERVICE });
    if (row && row.password.length > 0) {
      snapshot = normalize(row.password);
      notify();
    }
  } catch {
    // Keychain unavailable (simulator without entitlements, dev build
    // edge case) — leave snapshot as null. The override is a UX
    // convenience, not load-bearing.
  }
}

/**
 * Set or clear the local display name override. Pass an empty string
 * to clear. Returns the normalized value that was actually persisted
 * so the caller can reflect any trim/truncation in the UI.
 */
export async function setDisplayNameOverride(value: string): Promise<string | null> {
  const next = normalize(value);
  if (next === null) {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } else {
    await Keychain.setGenericPassword(USERNAME, next, { service: SERVICE });
  }
  if (snapshot !== next) {
    snapshot = next;
    notify();
  }
  hydrated = true;
  return next;
}

/** Wipe — called from sign-out / erase-everything flows. */
export async function clearDisplayNameOverride(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    // Best-effort; the wipe path tolerates partial failures by design.
  }
  if (snapshot !== null) {
    snapshot = null;
    notify();
  }
}

export function getDisplayNameOverride(): string | null {
  return snapshot;
}

export function subscribeDisplayNameOverride(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset for tests. */
export function resetDisplayNameOverrideForTest(): void {
  snapshot = null;
  hydrated = false;
  listeners.clear();
}
