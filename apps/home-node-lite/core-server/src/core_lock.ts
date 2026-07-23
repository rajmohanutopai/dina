/**
 * Item 2c — `core.lock` discovery + single-owner guard (§8 lifecycle).
 *
 * On boot Core writes `<vaultDir>/core.lock` with its pid, the REAL bound
 * host:port, and its node DID, so a second same-machine agent (or a restarting
 * plugin) can discover the running Core. The file also guards against a SECOND
 * Core booting on the same vault dir — two Cores sharing one vault's SQLite
 * would corrupt state, so we refuse to boot when a LIVE foreign Core holds the
 * lock. A stale lock (dead pid, or our own) is ignored and overwritten.
 *
 * A subsequent same-machine agent that has no bootstrap token (item 2a is a
 * one-shot first-boot capability) enrols through the normal owner-approved
 * pairing flow — it cannot self-mint enrolment authority.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const LOCK_FILE_NAME = 'core.lock';

export interface LockInfo {
  pid: number;
  host: string;
  port: number;
  nodeDid: string | null;
  startedAtMs: number;
}

/** Is a process with this pid alive? `signal 0` probes without signalling. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → exists but owned by another user
    // (still alive). Any other error → treat as not provably alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read + parse the lock file, or null if absent/unreadable/malformed. */
export function readLock(vaultDir: string): LockInfo | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(vaultDir, LOCK_FILE_NAME), 'utf8'),
    ) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      nodeDid: typeof parsed.nodeDid === 'string' ? parsed.nodeDid : null,
      startedAtMs: typeof parsed.startedAtMs === 'number' ? parsed.startedAtMs : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Refuse to boot when another LIVE Core already owns this vault dir. Call
 * BEFORE opening the vault's SQLite. A stale lock (dead pid) or our own lock is
 * ignored.
 *
 * NOTE: prefer {@link acquireLock} on the boot path — this read-then-decide form
 * is a TOCTOU race (two Cores can both observe "no live lock" and both open the
 * same SQLite). Kept for callers that only need a non-mutating probe.
 */
export function assertNoLiveForeignLock(vaultDir: string): void {
  const existing = readLock(vaultDir);
  if (existing !== null && existing.pid !== process.pid && isPidAlive(existing.pid)) {
    throw new Error(
      `core.lock: another Dina Core (pid ${existing.pid}, ${existing.host}:${existing.port}) ` +
        `already owns ${vaultDir}. Stop it first, or use a different DINA_VAULT_DIR.`,
    );
  }
}

/**
 * ATOMICALLY acquire the single-owner lock BEFORE opening any vault database
 * (audit — closes the check-then-write race). Uses `open(…, 'wx')` = O_CREAT|
 * O_EXCL, which the kernel guarantees only one process can win. On contention
 * (`EEXIST`) it refuses to boot if the current owner is a LIVE foreign Core, or
 * recovers a STALE lock (dead pid / our own / unreadable) by removing it and
 * retrying the atomic create. Returns after the lock is ours; call
 * {@link writeLock} later to refresh it with the real bound port + node DID.
 */
export function acquireLock(vaultDir: string, info: LockInfo): void {
  fs.mkdirSync(vaultDir, { recursive: true });
  const target = path.join(vaultDir, LOCK_FILE_NAME);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(target, 'wx'); // atomic create-or-fail
      try {
        fs.writeSync(fd, JSON.stringify(info));
      } finally {
        fs.closeSync(fd);
      }
      return; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readLock(vaultDir);
      if (existing !== null && existing.pid !== process.pid && isPidAlive(existing.pid)) {
        throw new Error(
          `core.lock: another Dina Core (pid ${existing.pid}, ${existing.host}:${existing.port}) ` +
            `already owns ${vaultDir}. Stop it first, or use a different DINA_VAULT_DIR.`,
        );
      }
      // Stale / our own / unreadable → drop it and retry the atomic create.
      // If a peer removes it first, the next openSync just wins or re-contends.
      try {
        fs.rmSync(target);
      } catch {
        /* raced with another remover — retry */
      }
    }
  }
  throw new Error(`core.lock: could not acquire the single-owner lock for ${vaultDir} (contended).`);
}

/** Write/refresh the discovery lock atomically (temp → rename). */
export function writeLock(vaultDir: string, info: LockInfo): void {
  const target = path.join(vaultDir, LOCK_FILE_NAME);
  const tmp = path.join(vaultDir, `.${LOCK_FILE_NAME}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(info));
  fs.renameSync(tmp, target);
}

/** Remove the lock on clean shutdown — only if it is ours (never a live peer's). */
export function releaseLock(vaultDir: string): void {
  const existing = readLock(vaultDir);
  if (existing !== null && existing.pid === process.pid) {
    try {
      fs.rmSync(path.join(vaultDir, LOCK_FILE_NAME));
    } catch {
      /* best-effort */
    }
  }
}
