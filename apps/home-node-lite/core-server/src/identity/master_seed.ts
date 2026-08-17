/**
 * Task 4.51 + 4.52 — master-seed load / generate + convenience keyfile.
 *
 * The Home Node's root secret is the mnemonic's 32-byte BIP-39 entropy.
 * Every identity, persona DEK, and service key is SLIP-0010-derived
 * from it (see tasks 4.54-4.55). On first boot the server generates
 * a fresh mnemonic + prints the phrase exactly once for the operator
 * to write down; on subsequent boots it loads the persisted seed.
 *
 * **Two persistence modes** (ARCHITECTURE.md §5.3):
 *
 *   1. **Convenience** (task 4.52): raw seed material written to
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
  mnemonicToEntropy,
  readWrappedSeed,
  unwrapSeed,
  validateMnemonic,
} from '@dina/core';

/** Posix-mode-600 — owner read/write only. */
export const KEYFILE_MODE = 0o600;
/** Filename under `vaultDir`. */
export const KEYFILE_NAME = 'keyfile';
/** Placeholder name for the wrapped-seed path (task 4.53). */
export const WRAPPED_SEED_NAME = 'wrapped_seed.bin';
/**
 * First-boot recovery-phrase file. The mnemonic is the master seed in
 * human-readable form, so it is written here at mode 0o600 (owner-only) and
 * NEVER sent to the structured logger — secrets stay out of logs (AGENTS.md).
 * The operator records it offline and deletes the file.
 */
export const RECOVERY_PHRASE_NAME = 'recovery-phrase.txt';
/** Expected master-seed length — Dina uses raw 256-bit mnemonic entropy. */
export const SEED_LEN_BYTES = 32;
/** Pre-portable-identity Home Nodes persisted the BIP-39 PBKDF2 seed. */
export const LEGACY_SEED_LEN_BYTES = 64;

export type SeedSource =
  | { kind: 'generated'; mnemonic: string; seed: Uint8Array; recoveryPhrasePath: string }
  | { kind: 'loaded_convenience'; seed: Uint8Array }
  /**
   * Task 4.53 (first slice): the wrapped seed UNWRAPPED at boot with the
   * operator-supplied `DINA_UNLOCK_PASSPHRASE` — the server analogue of
   * typing the passphrase on the phone, delivered the way server secrets
   * are (env / systemd credential), same as `DINA_OWNER_CAPABILITY`. The
   * wrapped path rides along so the §10-item-9 presence verifier can
   * re-verify a passphrase against the SAME stored secret per attempt.
   */
  | { kind: 'loaded_wrapped'; seed: Uint8Array; wrappedPath: string }
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
    // Task 4.53 first slice: a server in security mode unlocks at boot with
    // an OPERATOR-SUPPLIED passphrase — env / systemd credential, the same
    // delivery `DINA_OWNER_CAPABILITY` uses. A wrong passphrase REFUSES to
    // boot (GCM tag mismatch) rather than falling back to a limited state
    // that looks alive; an absent one keeps the pre-slice behaviour: the
    // boot trace's 'pending' identity step.
    const passphrase = process.env.DINA_UNLOCK_PASSPHRASE ?? '';
    if (passphrase !== '') {
      const wrapped = readWrappedSeed(wrappedPath);
      const seed = await unwrapSeed(passphrase, wrapped);
      return { kind: 'loaded_wrapped', seed, wrappedPath };
    }
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
  // Dina's canonical cross-runtime master seed is raw BIP-39 entropy, not
  // the unrelated 64-byte PBKDF2 seed. This keeps HNL, mobile, recovery, and
  // the legacy Go implementation on the same phrase -> keys -> DID mapping.
  const seed = mnemonicToEntropy(mnemonic);
  if (seed.length !== SEED_LEN_BYTES) {
    throw new Error(
      `loadOrGenerateSeed: generated seed has wrong length (${seed.length}, want ${SEED_LEN_BYTES})`,
    );
  }
  await writeKeyfileAtomic(keyfilePath, seed);
  // Persist the human-readable recovery phrase to a 0o600 file (co-located,
  // atomic) so the operator can record it. It is NEVER logged — the mnemonic
  // is the seed. Written alongside the keyfile so a first boot always leaves a
  // recoverable phrase, independent of the caller.
  const recoveryPhrasePath = await writeRecoveryPhraseAtomic(vaultDir, mnemonic);
  return { kind: 'generated', mnemonic, seed, recoveryPhrasePath };
}

/**
 * Validate + read a keyfile. Enforces 600 mode + a supported seed length.
 *
 * Existing 64-byte files must be consumed unchanged: they were the source of
 * the node's derived DID and vault keys. Rewriting them as 32-byte entropy is
 * impossible without the original mnemonic and would rotate the identity.
 * New Home Nodes still persist only canonical 32-byte entropy.
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
  if (buf.length !== SEED_LEN_BYTES && buf.length !== LEGACY_SEED_LEN_BYTES) {
    throw new Error(
      `keyfile length is ${buf.length} bytes, expected ${SEED_LEN_BYTES} ` +
        `or legacy ${LEGACY_SEED_LEN_BYTES}`,
    );
  }
  return new Uint8Array(buf);
}

/**
 * Atomic, mode-enforced write: write to `.<name>.tmp-<pid>-<hrtime>`, chmod,
 * rename. A crash mid-write leaves no half-written target file.
 */
async function atomicWrite(target: string, data: Buffer, mode: number): Promise<void> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`);
  try {
    // `fs.writeFile` with `mode` creates the file directly with the mode.
    await fs.writeFile(tmp, data, { mode });
    // Belt-and-suspenders: ensure the mode even if the filesystem ignored the
    // creation-time hint (e.g. some mount options).
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Persist the raw seed to the convenience keyfile (0o600, atomic). */
async function writeKeyfileAtomic(keyfilePath: string, seed: Uint8Array): Promise<void> {
  // Buffer.from(seed) preserves bytes; no transcoding.
  await atomicWrite(keyfilePath, Buffer.from(seed), KEYFILE_MODE);
}

/**
 * Persist the human-readable recovery phrase to `<vaultDir>/recovery-phrase.txt`
 * at mode 0o600, atomically. Returns the path. The phrase is the seed in words,
 * so it never touches the logger — this file is the only on-disk copy outside
 * the operator's own records, and they are told to delete it.
 */
async function writeRecoveryPhraseAtomic(vaultDir: string, mnemonic: string): Promise<string> {
  const target = path.join(vaultDir, RECOVERY_PHRASE_NAME);
  const body =
    '# Dina recovery phrase\n' +
    '#\n' +
    '# These words ARE your identity and the key to your vault. Anyone who has\n' +
    '# them can impersonate you and decrypt everything you own. Write them down\n' +
    '# somewhere safe and OFFLINE, then delete this file.\n' +
    '#\n' +
    '# Never commit, log, screenshot, or share this file.\n' +
    '\n' +
    `${mnemonic}\n`;
  await atomicWrite(target, Buffer.from(body, 'utf8'), KEYFILE_MODE);
  return target;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
