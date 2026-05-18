/**
 * Web peer for `install_marker.ts` — every export here is a safe
 * no-op on web.
 *
 * The native `install_marker.ts` solves a specific iOS/Android
 * problem: OS keychain entries survive app uninstalls but the app's
 * documents directory does not. A reinstall over an orphaned
 * keychain would otherwise boot into a confusing half-state. The
 * "install marker" is a sentinel file in the documents directory
 * that lets `unlock_gate` detect this case and wipe the orphan
 * keychain on the next boot.
 *
 * **Web has no equivalent problem.** The browser's IndexedDB sits
 * inside the SAME origin sandbox as the rest of the SPA's state —
 * if a user clears site data, both go together; if they don't, both
 * persist together. There's no way for the browser to leave a
 * "stale" keychain partition lying around without the rest of the
 * site state.
 *
 * **Why a `.web.ts` peer, not a `Platform.OS === 'web'` guard inside
 * the native file?** Because the native file imports `expo-file-system`
 * at the module top, and instantiates `new File(Paths.document, ...)`
 * unconditionally. On web `Paths.document` returns an invalid stub
 * whose `new File(...)` throws `this.validatePath is not a function`
 * — and `writeInstallMarker` calls `markerFile()` OUTSIDE its
 * try/catch, so that throw escapes the function and propagates into
 * `unlock_gate`'s outer catch, which sets mode to `'infra-setup'`
 * with a generic "Couldn't read vault state" error.
 *
 * Symptom that drove this: even though both PDS URL and AppView URL
 * were correctly persisted to IndexedDB (verified via the
 * keychain.web shim's encryption-at-rest test) the page kept
 * re-mounting on `infra-setup` after every reload because of this
 * cross-platform crash, not because of the keychain shim.
 *
 * Keeping the contract IDENTICAL to the native file means callers
 * (currently `unlock_gate.tsx` + `local_data_wipe.ts`) compile
 * without modification on either target.
 */

/** Always returns `true` on web — equivalent to "this install has
 *  not been orphaned" since the only way to clear IndexedDB on web
 *  is to also clear the rest of the site's storage. */
export function installMarkerExists(): boolean {
  return true;
}

/** No-op — same reasoning as `installMarkerExists`. */
export function deleteInstallMarker(): void {
  /* no-op */
}

/** No-op — same reasoning as `installMarkerExists`. */
export function writeInstallMarker(_now: number = Date.now()): void {
  /* no-op */
}

/**
 * Best-effort keychain wipe. Mirrors the native API surface so callers
 * (e.g. `local_data_wipe.ts`'s "Erase everything" path) compile
 * unchanged. On web we delete the entire `dina-keychain` IndexedDB
 * database, which is the equivalent thrash.
 */
export async function clearOrphanKeychainState(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('dina-keychain');
    // Resolve on success, error, or blocked — all three are
    // equivalent "we tried, move on" outcomes for the orphan path.
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * No-op on web — vault data lives on the brain-server, not in the
 * browser. The native version wipes orphaned SQLite files; nothing
 * analogous exists in IndexedDB beyond the keychain database (which
 * `clearOrphanKeychainState` already handles).
 */
export function wipeOrphanVaultFiles(): void {
  /* no-op */
}
