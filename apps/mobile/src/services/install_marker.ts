/**
 * install_marker — distinguishes "fresh install with orphan keychain"
 * from "returning user".
 *
 * Why this exists (MT-27): on iOS, app-data files (SQLite vaults,
 * documents directory) are wiped when the user deletes the app, but
 * Keychain entries owned by the bundle id persist by default. Reinstalling
 * the same bundle id therefore lands you with:
 *
 *   - empty SQLite vaults (no contacts, no memories)
 *   - intact Keychain entries (wrapped seed, startup mode, auto-passphrase,
 *     LLM keys, infra prefs)
 *
 * The boot path (`unlock_gate`) reads the wrapped seed from Keychain and
 * concludes "returning user" — auto-unlocks against a phantom DID and
 * lands the user in a chat home with no data, no contacts, no LLM key
 * (well, the LLM key survives too, but there's nothing to ask about).
 * Worse: the user's prior DID is still published on PLC, so a second
 * person picking up the device after a sloppy uninstall would inherit
 * the original user's identity.
 *
 * The fix: write a tiny marker file into the documents directory the
 * first time the app boots. The file lives in app-data and is wiped on
 * uninstall. On every boot, before any Keychain reads, we check:
 *
 *   - marker present → returning user, normal flow
 *   - marker missing AND keychain has wrapped seed → ORPHAN — wipe all
 *     Keychain entries owned by this app and treat as fresh install
 *   - marker missing AND no wrapped seed → fresh install (normal). Write
 *     the marker so the next boot is a normal returning-user flow
 *
 * The marker is written BEFORE any keychain provisioning happens so that
 * a crash mid-onboarding doesn't strand a seed in Keychain without a
 * matching marker.
 */

import { File, Paths, type Directory } from 'expo-file-system';
import * as Keychain from 'react-native-keychain';

/**
 * The marker file name. Lives in the documents directory alongside the
 * SQLite vault files. Plain text — content is irrelevant, presence is
 * the signal.
 */
const MARKER_FILENAME = '.dina_install';

/**
 * Body written into the marker. Stamped with a version + the install
 * time so future migrations can read the file and act on age. The
 * presence/absence is what the boot logic reads — body is for forensics
 * if we ever need to ship a debug screen.
 */
function buildMarkerBody(now: number): string {
  return JSON.stringify({ version: 1, installedAt: now });
}

/**
 * Every Keychain `service` ID this app provisions. Used by
 * `clearOrphanKeychainState` to wipe state from a prior install on
 * reinstall. Keep this list in lockstep with the modules that own each
 * service — adding a new keychain-backed module without updating this
 * list reintroduces MT-27 for that field.
 *
 * Source of truth for each entry:
 *   - dina.vault.wrapped_seed         services/wrapped_seed_store.ts
 *   - dina.startup.mode               services/startup_preferences.ts
 *   - dina.startup.passphrase         services/startup_preferences.ts
 *   - dina.node_identity.did          services/identity_record.ts
 *   - dina.node_identity.signing      services/identity_store.ts
 *   - dina.node_identity.rotation     services/identity_store.ts
 *   - dina.active_provider            ai/active_provider.ts
 *   - dina.user_preferences           services/user_preferences.ts
 *   - dina.display_name_override      services/display_name_override.ts
 *   - dina.node_role                  services/role_preference.ts
 *   - dina.infra.*                    services/infra_preferences.ts (5 keys)
 *   - dina.security.background_timeout_s services/security_preferences.ts
 *   - dina.llm.<provider>             ai/provider.ts (per-provider LLM keys)
 */
const KEYCHAIN_SERVICES: readonly string[] = [
  'dina.vault.wrapped_seed',
  'dina.startup.mode',
  'dina.startup.passphrase',
  'dina.node_identity.did',
  'dina.node_identity.signing',
  'dina.node_identity.rotation',
  'dina.active_provider',
  'dina.user_preferences',
  'dina.display_name_override',
  'dina.node_role',
  'dina.verification_status',
  'dina.infra.pds_url',
  'dina.infra.pds_handle',
  'dina.infra.pds_password',
  'dina.infra.pds_email',
  'dina.infra.appview_url',
  'dina.security.background_timeout_s',
];

/**
 * LLM provider keys live under a prefix (`dina.llm.<provider>`). We
 * don't import the canonical provider list to avoid a circular boot
 * dependency on the AI module — instead we list the providers we ship
 * with here. Adding a new provider in `ai/provider.ts` requires a
 * matching entry here.
 */
const LLM_PROVIDERS: readonly string[] = ['openai', 'gemini', 'claude', 'openrouter'];

function llmServiceFor(provider: string): string {
  return `dina.llm.${provider}`;
}

function markerFile(): File {
  return new File(Paths.document, MARKER_FILENAME);
}

/**
 * True iff the marker file exists in the app's documents directory.
 * Returning `false` means either (a) genuinely fresh install or (b) a
 * reinstall over an orphan keychain — the boot logic disambiguates by
 * checking whether a wrapped seed is present in Keychain.
 */
export function installMarkerExists(): boolean {
  try {
    return markerFile().exists;
  } catch {
    // expo-file-system can throw on access errors. Fall back to "marker
    // missing" so we re-provision rather than silently boot into a
    // possibly-orphan keychain.
    return false;
  }
}

/**
 * Delete the marker. Called by the user-facing "Erase everything"
 * wipe path so the next boot is treated as a true fresh install
 * rather than a returning user with a missing wrapped seed (which
 * `unlock_gate`'s orphan-detect interprets as "wipe orphan keychain
 * defensively"). Idempotent — silent no-op when the marker is
 * already absent.
 */
export function deleteInstallMarker(): void {
  try {
    const f = markerFile();
    if (f.exists) {
      f.delete();
    }
  } catch {
    // Best-effort. The downstream orphan-detect path is the safety
    // net — if we couldn't delete the marker, the next boot will
    // still see the missing wrapped seed and re-run cleanup. The
    // marker just disambiguates "true fresh install" from "orphan
    // recovery"; a stale marker after wipe is harmless.
  }
}

/**
 * Write the marker. Idempotent — safe to call when the file already
 * exists. Called from the boot path after the orphan check completes.
 */
export function writeInstallMarker(now: number = Date.now()): void {
  const f = markerFile();
  try {
    if (f.exists) return;
    f.create();
    f.write(buildMarkerBody(now));
  } catch {
    // Best-effort. A failure here means the next boot will run the
    // orphan-detect path again. If a wrapped seed has been written by
    // then it'll be erroneously treated as orphan — narrow window
    // bounded by app-data being writable, which is a precondition for
    // SQLite to work at all.
  }
}

/**
 * Wipe every keychain entry this app owns. Called when the marker is
 * missing AND a wrapped seed is present — the keychain belongs to a
 * previous install whose data dir was deleted with the app.
 *
 * Each `resetGenericPassword` is independent — we don't fail the whole
 * sweep on a single error, since a missing service is not exceptional
 * (most installs won't have set every optional preference).
 */
export async function clearOrphanKeychainState(): Promise<void> {
  const services = [...KEYCHAIN_SERVICES, ...LLM_PROVIDERS.map(llmServiceFor)];
  for (const service of services) {
    try {
      await Keychain.resetGenericPassword({ service });
    } catch {
      // Continue — wiping is best-effort.
    }
  }
}

/**
 * Wipe every SQLite artifact left in the documents directory by a
 * prior install.
 *
 * Why this exists alongside `clearOrphanKeychainState`: on iOS
 * uninstall, the documents directory IS wiped — but only by the OS,
 * not by us. If the OS wipe didn't happen (e.g. the simulator's
 * `simctl uninstall` retains keychain but DOES wipe Documents — yet
 * a backup-restore flow can leave SQLite files behind without their
 * matching keychain seed), the new install will derive a different
 * SQLCipher DEK from the new wrapped seed and op-sqlite throws
 * `sqlite query error: file is not a database` when it tries to
 * decrypt the old file with the new key.
 *
 * Symptom before this fix: chat-home's "Dina running in dev-degraded
 * mode" banner with `persistence.in_memory` — workflow tasks +
 * service config silently in-memory because `initializePersistence`
 * threw on the orphan file.
 *
 * Implementation mirrors `eraseEverythingLocal` in
 * `services/local_data_wipe.ts` — same `.sqlite` family suffixes,
 * same per-entry tolerance. Inlined rather than imported because
 * `local_data_wipe` also wipes the keychain via `signOutLocal`,
 * which would double up on what we already do here.
 */
export function wipeOrphanVaultFiles(): void {
  try {
    const docDir = Paths.document;
    if (!docDir.exists) return;
    const entries: ReadonlyArray<Directory | File> = docDir.list();
    for (const entry of entries) {
      if (!isSqliteArtifact(entry.name)) continue;
      try {
        entry.delete();
      } catch {
        // One file failing shouldn't abort the sweep; the remaining
        // files still need to go for the new install to succeed.
      }
    }
  } catch {
    // Directory listing itself failed (very rare on iOS). The next
    // boot will retry; in the meantime, op-sqlite will throw the
    // same "file is not a database" error and the boot service
    // will surface persistence.in_memory — exactly the state we
    // were trying to prevent. There's no better recovery path
    // available pre-init without an SQLite handle.
  }
}

/** Recognises SQLCipher database files + their WAL/SHM/journal sidecars. */
function isSqliteArtifact(name: string): boolean {
  return (
    name.endsWith('.sqlite') ||
    name.endsWith('.sqlite-wal') ||
    name.endsWith('.sqlite-shm') ||
    name.endsWith('.sqlite-journal')
  );
}
