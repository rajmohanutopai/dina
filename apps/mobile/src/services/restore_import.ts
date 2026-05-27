/**
 * Backup restore (issues.txt §3) — pick a `.dina` archive + import it.
 *
 * The file IO (OS document picker + reading bytes) is injected via
 * `configureRestore` so this module — and the Admin screen that drives it
 * — stays testable without `expo-document-picker` / `expo-file-system` at
 * runtime (same pattern as `useShareExport`'s `configureSharing`). The
 * production picker is wired once at app boot.
 *
 * Restore is a DATA restore into the CURRENT identity (the archive
 * excludes the master seed), so it runs post-onboarding from
 * Settings → Admin. Core enforces clean-install-only unless `force`.
 */

import { importArchive, listArchiveContents } from '@dina/core';

/** A picked backup file. */
export interface PickedBackup {
  uri: string;
  name: string;
}

let pickFileFn: (() => Promise<PickedBackup | null>) | null = null;
let readFileFn: ((uri: string) => Promise<Uint8Array>) | null = null;

/** Wire the native file picker + reader (app boot). */
export function configureRestore(config: {
  pickFile: () => Promise<PickedBackup | null>;
  readFile: (uri: string) => Promise<Uint8Array>;
}): void {
  pickFileFn = config.pickFile;
  readFileFn = config.readFile;
}

/** Reset wiring (tests). */
export function resetRestore(): void {
  pickFileFn = null;
  readFileFn = null;
}

/** True once the native picker is wired (the UI hides Restore otherwise). */
export function isRestoreConfigured(): boolean {
  return pickFileFn !== null && readFileFn !== null;
}

/**
 * Present the OS picker and read the chosen `.dina` file into bytes.
 * Returns `null` when the user cancels. Throws if restore isn't wired.
 */
export async function pickBackupBytes(): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (pickFileFn === null || readFileFn === null) {
    throw new Error('restore: file picker not configured (needs a dev-client rebuild)');
  }
  const picked = await pickFileFn();
  if (picked === null) return null;
  const bytes = await readFileFn(picked.uri);
  return { name: picked.name, bytes };
}

export interface BackupPreview {
  personas: { name: string; tier: string }[];
  totalPersonas: number;
  createdAt: number;
}

/**
 * Decrypt + read the manifest WITHOUT writing anything — used to confirm
 * the passphrase is right and show the user what they're about to restore.
 * Throws on wrong passphrase / corrupt / unsupported version.
 */
export async function previewBackup(bytes: Uint8Array, passphrase: string): Promise<BackupPreview> {
  const contents = await listArchiveContents(bytes, passphrase);
  return {
    personas: contents.personas,
    totalPersonas: contents.total_personas,
    createdAt: contents.created_at,
  };
}

/**
 * Restore the archive into the local databases. `force` overwrites a
 * non-clean target (Core throws "not a clean install" without it).
 * After this returns, the caller should prompt the user to relaunch —
 * `initializePersistence` re-hydrates every in-memory store from the
 * restored SQL on the next cold boot.
 */
export async function restoreBackup(
  bytes: Uint8Array,
  passphrase: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  await importArchive(bytes, passphrase, opts);
}
