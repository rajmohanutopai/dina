/**
 * Backing up and restoring through the store (USER_BACKUP.md §4.2, §4.5).
 *
 * The counter: a new copy takes the highest counter the store lists, or the
 * highest this device last wrote if that is higher, plus one. Never the
 * restored copy's counter plus one, so restoring copy 10 while 11–20 are kept
 * and backing up again writes 21 and leaves 11–20 alone. Two devices racing
 * for one counter: the store refuses the second (409), which lists again and
 * takes the next.
 *
 * A device that is still running knows the counter it last wrote. When the
 * store lists nothing that high, it is holding newer copies back (or lost
 * them); the run reports `storeBehind` so the caller can warn the owner
 * (§6). A new phone after a loss has nothing to compare with; it shows the
 * copy's date and the owner judges.
 *
 * What the store sees: the sealed bytes, the counter, the size and the time.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import {
  buildArchivePayload,
  getArchiveDataSource,
  importArchivePayload,
  type ArchivePayloadV1,
} from '../export/archive';
import { kvGet, kvSet } from '../kv/store';

import { countVaultItems, openBackup, sealBackup, type BackupCopyMeta } from './sealed';
import { BackupStoreError, type BackupStoreClient } from './store_client';

import type { BackupIdentity } from './keys';

/**
 * kv_store keys this module keeps. Callers store them under the `backup:`
 * prefix, which the archive leaves out (`export/archive.ts`).
 */
export const BACKUP_LAST_COUNTER_KEY = 'last_counter';
export const BACKUP_LAST_AT_KEY = 'last_at';
/** What the last copy held, by its per-table checksums. */
export const BACKUP_LAST_FINGERPRINT_KEY = 'last_fingerprint';
/** When a due run last found nothing changed. */
export const BACKUP_LAST_CHECKED_AT_KEY = 'last_checked_at';

export interface BackupKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The installed kv store, under `backup:` (left out of every archive). */
export const kvBackupStore: BackupKV = {
  get: (key) => kvGet(key, 'backup'),
  set: (key, value) => kvSet(key, value, 'backup'),
};

export interface BackupRunDeps {
  identity: BackupIdentity;
  client: Pick<BackupStoreClient, 'list' | 'put' | 'get'>;
  kv: BackupKV;
  did: string;
  handle: string;
  now?: () => number;
}

export interface BackupRunResult {
  counter: number;
  size: number;
  itemCount: number;
  /** The store listed nothing as high as this device last wrote. */
  storeBehind: boolean;
}

let restoring = false;

/** True while a restore from the store runs; backups refuse meanwhile (§4.4). */
export function isBackupRestoreInProgress(): boolean {
  return restoring;
}

async function lastWritten(kv: BackupKV): Promise<number> {
  const raw = await kv.get(BACKUP_LAST_COUNTER_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The payload's content, without the time it was built: its table checksums. */
function fingerprint(payload: ArchivePayloadV1): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(canonicalJson(payload.header.checksums))),
  );
}

async function currentPayload(): Promise<ArchivePayloadV1> {
  if (restoring) throw new Error('backup: a restore is in progress');
  const ds = getArchiveDataSource();
  if (ds === null) throw new Error('backup: no archive data source installed');
  return buildArchivePayload(ds);
}

/** "Back up now": always writes a copy. */
export async function backUpNow(deps: BackupRunDeps): Promise<BackupRunResult> {
  return writeCopy(deps, await currentPayload());
}

export type BackupDueResult =
  | { ran: false; reason: 'not_due' | 'unchanged' }
  | { ran: true; result: BackupRunResult };

/**
 * The scheduled run (§4.4): a copy when the last is at least `everyMs` old
 * and something changed since. A run that finds nothing changed waits
 * another `everyMs` before looking again, so a large vault is not read every
 * tick for nothing.
 */
export async function backUpIfDue(
  deps: BackupRunDeps,
  opts: { everyMs: number },
): Promise<BackupDueResult> {
  const now = deps.now ?? Date.now;
  const at = async (key: string): Promise<number> => Number((await deps.kv.get(key)) ?? 0) || 0;
  const since = Math.max(await at(BACKUP_LAST_AT_KEY), await at(BACKUP_LAST_CHECKED_AT_KEY));
  if (now() - since < opts.everyMs) return { ran: false, reason: 'not_due' };
  const payload = await currentPayload();
  if ((await deps.kv.get(BACKUP_LAST_FINGERPRINT_KEY)) === fingerprint(payload)) {
    await deps.kv.set(BACKUP_LAST_CHECKED_AT_KEY, String(now()));
    return { ran: false, reason: 'unchanged' };
  }
  return { ran: true, result: await writeCopy(deps, payload) };
}

async function writeCopy(deps: BackupRunDeps, payload: ArchivePayloadV1): Promise<BackupRunResult> {
  const now = deps.now ?? Date.now;
  const mine = await lastWritten(deps.kv);

  for (let attempt = 0; ; attempt++) {
    const listed = await deps.client.list();
    const top = listed.reduce((m, c) => Math.max(m, c.counter), 0);
    const counter = Math.max(top, mine) + 1;
    const sealed = sealBackup(payload, deps.identity, {
      did: deps.did,
      handle: deps.handle,
      counter,
      createdAt: now(),
    });
    try {
      await deps.client.put(counter, sealed);
    } catch (err) {
      if (err instanceof BackupStoreError && err.status === 409 && attempt < 2) continue;
      throw err;
    }
    await deps.kv.set(BACKUP_LAST_COUNTER_KEY, String(counter));
    await deps.kv.set(BACKUP_LAST_AT_KEY, String(now()));
    await deps.kv.set(BACKUP_LAST_FINGERPRINT_KEY, fingerprint(payload));
    return {
      counter,
      size: sealed.length,
      itemCount: countVaultItems(payload),
      storeBehind: mine > 0 && top < mine,
    };
  }
}

export interface FoundBackup {
  meta: BackupCopyMeta;
  bytes: Uint8Array;
}

/**
 * The copy a restore would use: the newest, or the one named. Opened, so its
 * date, item count, DID and handle can be shown before anything is written.
 * Null when the store holds nothing.
 */
export async function findBackup(
  identity: BackupIdentity,
  client: Pick<BackupStoreClient, 'get'>,
  counter: number | 'latest' = 'latest',
): Promise<FoundBackup | null> {
  const bytes = await client.get(counter);
  if (bytes === null) return null;
  return { meta: openBackup(bytes, identity).meta, bytes };
}

/** Restore a copy `findBackup` returned. Same checks as a manual import. */
export async function restoreBackup(
  identity: BackupIdentity,
  found: FoundBackup,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (restoring) throw new Error('backup: a restore is already in progress');
  restoring = true;
  try {
    const { payload } = openBackup(found.bytes, identity);
    await importArchivePayload(payload, opts);
  } finally {
    restoring = false;
  }
}
