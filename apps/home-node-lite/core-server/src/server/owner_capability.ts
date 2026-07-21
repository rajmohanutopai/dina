/**
 * Round-A A-07 — the lite server's OWNER capability (the §12.5 owner-only
 * control boundary for interactive runs + watches).
 *
 * On mobile the owner is the in-app user (in-process dispatch). On the split
 * server the owner is the HUMAN at the browser, so the credential must live
 * with the operator, never with Brain: Core mints/loads it here, the operator
 * pastes it into the SPA once, the browser presents it on every owner call
 * (`x-dina-owner-capability`), and brain-server merely forwards the header as
 * an opaque byte-pipe. Core alone validates it (timing-safe, run/watch surface
 * only) — a compromised Brain can never originate owner commands.
 *
 * Resolution order:
 *   1. `DINA_OWNER_CAPABILITY` env (operator-managed; ≥16 chars enforced).
 *   2. `<vaultDir>/owner_capability` — generated once (32 random bytes, hex)
 *      and persisted 0600 so restarts keep it and the operator can read it.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

const MIN_CAPABILITY_LENGTH = 16;

export interface ResolvedOwnerCapability {
  capability: string;
  /** Where it came from — logged (never the value). */
  source: 'env' | 'file' | 'generated';
  /** The backing file when file-based (for the operator log line). */
  filePath?: string;
}

type ExistingCapability =
  | { kind: 'valid'; value: string }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

/**
 * Round-C C-05 — the capability file authorizes every owner action, so it is
 * loaded through a SINGLE file descriptor opened `O_NOFOLLOW`, and every check
 * (regular-file, permissions, content) runs against that descriptor via
 * `fstat`/`fchmod`/`read`. That closes two holes a path-based load left open:
 *   - A symlink at the path (dangling OR live) is an attack shape — it can
 *     redirect the read or, for a dangling link, cause a later path-based write
 *     to create the freshly generated capability at an attacker-chosen target.
 *     `O_NOFOLLOW` makes the open fail (`ELOOP`) on any symlink final
 *     component, so we refuse to boot instead of trusting it.
 *   - The old `lstat(path)` → `read(path)` pair re-resolved the path twice, a
 *     check-to-use (TOCTOU) race in a writable vault dir. One descriptor
 *     resolves the path once; every operation after uses the fd.
 */
function readExistingCapability(filePath: string): ExistingCapability {
  let fd: number;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    if (code === 'ELOOP') {
      // A symlink (dangling or live) occupies the capability path.
      throw new Error(
        `owner_capability at ${filePath} is a symlink, not a regular file — refusing to boot`,
      );
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(
        `owner_capability at ${filePath} is not a regular file (dir/socket/fifo) — refusing to boot`,
      );
    }
    // Tighten a group/other-readable file in place (fd-scoped, no re-resolve).
    if ((st.mode & 0o077) !== 0) {
      fchmodSync(fd, 0o600);
    }
    const stored = readFileSync(fd, 'utf8').trim();
    return stored.length >= MIN_CAPABILITY_LENGTH
      ? { kind: 'valid', value: stored }
      : { kind: 'corrupt' };
  } finally {
    closeSync(fd);
  }
}

export function resolveOwnerCapability(
  env: NodeJS.ProcessEnv,
  vaultDir: string,
): ResolvedOwnerCapability {
  const fromEnv = env.DINA_OWNER_CAPABILITY?.trim() ?? '';
  if (fromEnv !== '') {
    if (fromEnv.length < MIN_CAPABILITY_LENGTH) {
      throw new Error(
        `DINA_OWNER_CAPABILITY must be at least ${MIN_CAPABILITY_LENGTH} characters`,
      );
    }
    return { capability: fromEnv, source: 'env' };
  }

  const filePath = path.join(vaultDir, 'owner_capability');
  const existing = readExistingCapability(filePath);
  if (existing.kind === 'valid') {
    return { capability: existing.value, source: 'file', filePath };
  }
  if (existing.kind === 'corrupt') {
    // Corrupt/truncated file: remove it so the exclusive create below makes a
    // FRESH 0600 inode (the corrupt file may carry loose permissions).
    rmSync(filePath, { force: true });
  }
  return {
    capability: writeFreshOwnerCapability(filePath),
    source: 'generated',
    filePath,
  };
}

/**
 * Create the capability file exclusively and without following a symlink, and
 * return the generated bearer. `O_EXCL` fails (`EEXIST`) if anything — including
 * a symlink an attacker slipped in after the load/rm decision — already
 * occupies the path, so the generated bearer can never be written through a
 * redirect. `fchmod` guarantees 0600 regardless of umask.
 *
 * Exported so the create-time symlink refusal has DIRECT coverage: the load
 * path rejects a symlink before creation ever runs, so a resolver-level test
 * cannot exercise this branch — a test must call it with a symlink already in
 * place at the path.
 */
export function writeFreshOwnerCapability(filePath: string): string {
  const generated = randomBytes(32).toString('hex');
  const fd = openSync(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${generated}\n`);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return generated;
}
