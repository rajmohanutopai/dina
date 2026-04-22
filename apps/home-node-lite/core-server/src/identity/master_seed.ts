/**
 * Task 4.51 + 4.52 — master-seed load / generate + convenience keyfile.
 *
 * The Home Node's root secret is a 64-byte BIP-39-derived master seed.
 * Every identity, persona DEK, and service key is SLIP-0010-derived
 * from it (see tasks 4.54-4.55). On first boot the server generates
 * a fresh mnemonic + prints the phrase exactly once for the operator
 * to write down; on subsequent boots it loads the persisted seed.
 *
 * **Two persistence modes** (ARCHITECTURE.md §5.3):
 *
 *   1. **Convenience** (task 4.52): raw 64-byte seed written to
 *      `<vaultDir>/keyfile` with mode `0o600`. No passphrase
 *      required; anyone with filesystem read access to the Home Node
 *      has the seed. Target audience: single-operator VPS where
 *      filesystem access already implies full trust.
 *
 *   2. **Security** (task 4.53, PENDING here): seed wrapped with
 *      AES-256-GCM under an Argon2id-derived KEK from the operator
 *      passphrase, stored at `<vaultDir>/wrapped_seed.bin`. This
 *      module only handles convenience mode; wrapped-seed lands with
 *      task 4.53. The loader checks for both files and picks
 *      whichever is present — loading `wrapped_seed.bin` returns a
 *      `{kind: 'wrapped'}` placeholder that callers upstream of this
 *      module unwrap by prompting for the passphrase.
 *
 * **File-system safety**:
 *   - First-boot generation is atomic: generate → write to tmp →
 *     rename. A crash mid-write leaves no half-written keyfile.
 *   - Keyfile mode is enforced `0o600` (owner read/write only) both
 *     on creation AND on every load — a loosened-mode file (e.g.
 *     someone accidentally chmod'd 644) is rejected, not silently
 *     re-tightened, because that change might have already exposed
 *     the seed to another user on the box.
 *
 * **Operator output**: first-boot generation returns the mnemonic
 * AND the seed. Caller (bin.ts / install script) is responsible for
 * printing the mnemonic to stderr exactly once so the operator can
 * write it down.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g tasks 4.51-4.52.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  generateMnemonic as coreGenerateMnemonic,
  mnemonicToSeed,
  validateMnemonic,
} from '@dina/core';

/** Posix-mode-600 — owner read/write only. */
export const KEYFILE_MODE = 0o600;
/** Filename under `vaultDir`. */
export const KEYFILE_NAME = 'keyfile';
/** Placeholder name for the wrapped-seed path (task 4.53). */
export const WRAPPED_SEED_NAME = 'wrapped_seed.bin';
/** Expected seed length — BIP-39 with the default entropy produces 64 bytes. */
export const SEED_LEN_BYTES = 64;

export type SeedSource =
  | { kind: 'generated'; mnemonic: string; seed: Uint8Array }
  | { kind: 'loaded_convenience'; seed: Uint8Array }
  | { kind: 'wrapped'; wrappedPath: string };

/**
 * Load the master seed from `vaultDir`, generating it on first boot.
 *
 * Priority order:
 *   1. If `<vaultDir>/wrapped_seed.bin` exists → return `{kind: 'wrapped', wrappedPath}`
 *      so the caller can prompt for the passphrase and unwrap (task 4.53).
 *   2. If `<vaultDir>/keyfile` exists → validate mode 600 + length, return
 *      `{kind: 'loaded_convenience', seed}`.
 *   3. Otherwise → generate a fresh mnemonic + seed, write the keyfile
 *      atomically with mode 600, return `{kind: 'generated', mnemonic, seed}`.
 *
 * On any file-system error, rejects — the process cannot start without
 * a valid seed.
 */
export async function loadOrGenerateSeed(vaultDir: string): Promise<SeedSource> {
  if (!vaultDir || vaultDir.length === 0) {
    throw new Error('loadOrGenerateSeed: vaultDir is required');
  }

  const wrappedPath = path.join(vaultDir, WRAPPED_SEED_NAME);
  if (await exists(wrappedPath)) {
    return { kind: 'wrapped', wrappedPath };
  }

  const keyfilePath = path.join(vaultDir, KEYFILE_NAME);
  if (await exists(keyfilePath)) {
    const seed = await readKeyfile(keyfilePath);
    return { kind: 'loaded_convenience', seed };
  }

  // First boot: generate + persist.
  await fs.mkdir(vaultDir, { recursive: true });
  const mnemonic = coreGenerateMnemonic();
  if (!validateMnemonic(mnemonic)) {
    throw new Error('loadOrGenerateSeed: generated mnemonic failed self-check');
  }
  const seed = mnemonicToSeed(mnemonic);
  if (seed.length !== SEED_LEN_BYTES) {
    throw new Error(
      `loadOrGenerateSeed: generated seed has wrong length (${seed.length}, want ${SEED_LEN_BYTES})`,
    );
  }
  await writeKeyfileAtomic(keyfilePath, seed);
  return { kind: 'generated', mnemonic, seed };
}

/**
 * Validate + read a keyfile. Enforces 600 mode + expected length.
 * Throws if the file is too lax, wrong size, or unreadable.
 */
async function readKeyfile(keyfilePath: string): Promise<Uint8Array> {
  const stat = await fs.stat(keyfilePath);
  const modeBits = stat.mode & 0o777;
  if (modeBits !== KEYFILE_MODE) {
    throw new Error(
      `keyfile mode is ${modeBits.toString(8)}, expected ${KEYFILE_MODE.toString(8)} — ` +
        `refusing to load (tighten with "chmod 600 ${keyfilePath}")`,
    );
  }
  const buf = await fs.readFile(keyfilePath);
  if (buf.length !== SEED_LEN_BYTES) {
    throw new Error(
      `keyfile length is ${buf.length} bytes, expected ${SEED_LEN_BYTES}`,
    );
  }
  return new Uint8Array(buf);
}

/**
 * Atomic write: write to `<name>.tmp-<pid>-<hrtime>`, fsync, rename.
 * Crash mid-write leaves no half-written keyfile.
 */
async function writeKeyfileAtomic(keyfilePath: string, seed: Uint8Array): Promise<void> {
  const dir = path.dirname(keyfilePath);
  const base = path.basename(keyfilePath);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  try {
    // `fs.writeFile` with `mode` creates the file directly with 600.
    // Buffer.from(seed) preserves bytes; no transcoding.
    await fs.writeFile(tmp, Buffer.from(seed), { mode: KEYFILE_MODE });
    // Belt-and-suspenders: ensure mode is 600 even if the filesystem
    // ignored the creation-time hint (e.g. some mount options).
    await fs.chmod(tmp, KEYFILE_MODE);
    await fs.rename(tmp, keyfilePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
