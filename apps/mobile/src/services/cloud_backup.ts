/**
 * Backup to Dina's store, on the phone (docs/USER_BACKUP.md §4.4–§4.6).
 *
 * The backup keys come from the master seed, so they exist only while the
 * vault is unlocked, in memory; `installBackupIdentity(null)` clears them
 * when the vault seals. iOS gives little background time, so the phone backs
 * up when the app comes to the foreground and the last copy is more than a
 * day old and something changed, or when the owner taps "Back up now".
 *
 * On by default once the owner has confirmed their recovery phrase
 * (`isBackupEnabled`). The owner's switch and the last copy's time live in
 * kv_store under `backup:`, which no archive carries.
 *
 * Recovery runs before any vault exists: `findBackupForPhrase` derives the
 * keys from the 24 words alone and asks the store for the newest copy.
 */

import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import {
  backUpIfDue,
  backUpNow,
  BACKUP_LAST_AT_KEY,
  BackupStoreClient,
  deriveBackupIdentity,
  findBackup,
  forgetBackupRuns,
  isBackupHeldForOwner,
  kvBackupStore,
  mnemonicToEntropy,
  restoreBackup,
  type BackupIdentity,
  type BackupRunResult,
  type FoundBackup,
} from '@dina/core';

import { loadPersistedDid } from './identity_record';
import { loadInfraPreferences } from './infra_preferences';
import { loadVerificationStatus } from './verification_status';

const DAY_MS = 24 * 60 * 60 * 1000;
const ENABLED_KEY = 'enabled';
const FIRST_LOOK_MS = 30_000;

let identity: BackupIdentity | null = null;
let appStateSub: NativeEventSubscription | null = null;
let firstLook: ReturnType<typeof setTimeout> | null = null;
let flight: Promise<unknown> | null = null;
/** One thing at a time reaches the store, so "Delete all" can't land under a run. */
let tail: Promise<unknown> = Promise.resolve();

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

export function backupStoreUrl(): string {
  // Static `process.env.X` reads only: Expo inlines nothing else in a release bundle.
  const override = process.env.EXPO_PUBLIC_DINA_BACKUP_URL;
  if (override !== undefined && override !== '') return override;
  return process.env.EXPO_PUBLIC_DINA_ENDPOINT_MODE === 'release'
    ? 'https://backup.dinakernel.com'
    : 'https://test-backup.dinakernel.com';
}

function client(id: BackupIdentity): BackupStoreClient {
  return new BackupStoreClient(backupStoreUrl(), id);
}

async function runDeps(id: BackupIdentity) {
  const did = (await loadPersistedDid()) ?? '';
  const handle = (await loadInfraPreferences()).pdsHandle ?? '';
  return { identity: id, client: client(id), kv: kvBackupStore, did, handle };
}

/**
 * Called at unlock with the master seed, and with null when the vault seals.
 * While installed, coming to the foreground runs the daily backup.
 */
export function installBackupIdentity(masterSeed: Uint8Array | null): void {
  appStateSub?.remove();
  appStateSub = null;
  if (firstLook !== null) clearTimeout(firstLook);
  firstLook = null;
  identity = masterSeed === null ? null : deriveBackupIdentity(masterSeed);
  if (identity === null) return;
  appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') void backUpIfDueNow();
  });
  // Unlock is busy enough; the first look waits a little.
  firstLook = setTimeout(() => {
    firstLook = null;
    void backUpIfDueNow();
  }, FIRST_LOOK_MS);
  (firstLook as { unref?: () => void }).unref?.();
}

/**
 * On when the owner turned it on; off when they turned it off; otherwise on
 * once the recovery phrase is confirmed (§8.2), since a copy only the 24
 * words open is no use to someone who never kept them.
 */
export async function isBackupEnabled(): Promise<boolean> {
  const chosen = await kvBackupStore.get(ENABLED_KEY);
  if (chosen === '1') return true;
  if (chosen === '0') return false;
  return (await loadVerificationStatus()) === 'verified';
}

export async function setBackupEnabled(on: boolean): Promise<void> {
  await kvBackupStore.set(ENABLED_KEY, on ? '1' : '0');
  if (on) void backUpIfDueNow();
}

/** The daily run. Never throws: a failed run tries again on the next foreground. */
export async function backUpIfDueNow(): Promise<void> {
  const id = identity;
  if (id === null || flight !== null || !(await isBackupEnabled())) return;
  const run = inTurn(async () => {
    try {
      // The queue may have waited: the vault can have sealed, or backup gone off.
      if (identity !== id || !(await isBackupEnabled())) return;
      await backUpIfDue(await runDeps(id), { everyMs: DAY_MS });
    } catch {
      // Offline, or the store refused; the next foreground tries again.
    } finally {
      flight = null;
    }
  });
  flight = run;
  await run;
}

/** "Back up now". Throws with the store's reason, for the screen to show. */
export async function backUpNowFromSettings(): Promise<BackupRunResult> {
  const id = identity;
  if (id === null) throw new Error('Unlock Dina to back up.');
  return inTurn(async () => backUpNow(await runDeps(id)));
}

export interface BackupStatus {
  enabled: boolean;
  /** When the last copy was written from this phone; null before the first. */
  lastAt: number | null;
  storeUrl: string;
  /**
   * The store holds copies this phone never restored, so the daily run stopped
   * rather than push them aside. The owner restores, or starts fresh.
   */
  heldForOwner: boolean;
}

export async function backupStatus(): Promise<BackupStatus> {
  const raw = await kvBackupStore.get(BACKUP_LAST_AT_KEY);
  const lastAt = raw === null ? null : Number(raw) || null;
  return {
    enabled: await isBackupEnabled(),
    lastAt,
    storeUrl: backupStoreUrl(),
    heldForOwner: await isBackupHeldForOwner(kvBackupStore),
  };
}

/**
 * "Delete all backups": every copy in the store, and backup switched off. The
 * switch goes first and the delete waits its turn, so a run already uploading
 * lands before the delete and one still queued finds backup off. A failed delete
 * puts the switch back: the copies are still there.
 */
export async function deleteAllBackups(): Promise<void> {
  const id = identity;
  if (id === null) throw new Error('Unlock Dina to delete backups.');
  const before = await kvBackupStore.get(ENABLED_KEY);
  await kvBackupStore.set(ENABLED_KEY, '0');
  try {
    await inTurn(async () => {
      await client(id).deleteAll();
      await forgetBackupRuns(kvBackupStore);
    });
  } catch (err) {
    await kvBackupStore.set(ENABLED_KEY, before ?? '');
    throw err;
  }
}

/**
 * The Backup screen's answer to a hold: bring back the newest copy, replacing
 * what this phone holds. The stores in memory still hold the old rows, so the
 * screen reloads the app after this.
 */
export async function restoreNewestBackupFromSettings(): Promise<void> {
  const id = identity;
  if (id === null) throw new Error('Unlock Dina to restore.');
  await inTurn(async () => {
    const found = await findBackup(id, client(id));
    if (found === null) throw new Error('The store holds no copy.');
    await restoreFoundBackup(found, id, { replaceLocal: true });
  });
}

/**
 * Recovery (§4.5): the newest copy for these 24 words, opened so the screen
 * can show its date, item count, DID and handle. Null when the store holds
 * none, or cannot be reached; recovery then goes on as before.
 */
export async function findBackupForPhrase(
  mnemonic: string[],
): Promise<{ found: FoundBackup; identity: BackupIdentity } | null> {
  try {
    const id = deriveBackupIdentity(mnemonicToEntropy(mnemonic.join(' ')));
    const found = await findBackup(id, client(id));
    return found === null ? null : { found, identity: id };
  } catch {
    return null;
  }
}

/**
 * Restore a copy, then keep backing up from here. Overwrites what this phone
 * holds only when the owner agreed (`replaceLocal`); otherwise a phone with its
 * own rows refuses, and they stay.
 */
export async function restoreFoundBackup(
  found: FoundBackup,
  id: BackupIdentity,
  opts: { replaceLocal?: boolean } = {},
): Promise<void> {
  await restoreBackup(id, found, { force: opts.replaceLocal === true });
  await kvBackupStore.set(ENABLED_KEY, '1');
}
