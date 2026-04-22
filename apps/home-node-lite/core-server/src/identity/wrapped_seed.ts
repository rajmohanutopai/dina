/**
 * Task 4.53 — wrapped-seed persistence (AES-256-GCM under a passphrase).
 *
 * The "security" mode alternative to the convenience-keyfile
 * persistence from task 4.52. The master seed is encrypted with
 * AES-256-GCM using a KEK derived from the operator passphrase via
 * Argon2id (all done inside `@dina/core`'s `wrapSeed` / `unwrapSeed`).
 * The encrypted blob + salt + Argon2id params are serialized to
 * `<vaultDir>/wrapped_seed.bin` — filesystem read access alone is
 * insufficient to recover the seed (attacker needs the passphrase).
 *
 * **File format (v1)**: self-describing JSON so future rotations of
 * the wrapping parameters don't break backward compatibility. Raw
 * bytes would be tighter but the seed is small (~64 B) and the
 * Argon2id params are useful to persist (a future tightening could
 * re-wrap with different costs). JSON serialization also lets ops
 * eyeball the file to confirm it's a Dina wrapped seed, not arbitrary
 * binary garbage.
 *
 * File schema:
 * ```json
 * {
 *   "dina_wrapped_seed_version": 1,
 *   "salt_hex": "...",
 *   "wrapped_hex": "...",
 *   "params": { "memory": 131072, "iterations": 3, "parallelism": 4 }
 * }
 * ```
 *
 * **Mode**: `0o600` on the wrapped-seed file too. Even though the
 * bytes are encrypted, restricting filesystem visibility reduces
 * offline-attack surface (the fewer copies that leak, the better).
 *
 * **Passphrase source**: the `DINA_SEED_PASSPHRASE` env var when set;
 * fallback to prompt (not wired here — bin.ts / install script owns
 * the interactive flow). This module only handles the file layer.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g task 4.53.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  wrapSeed,
  unwrapSeed,
  type WrappedSeed,
} from '@dina/core';
import { WRAPPED_SEED_NAME } from './master_seed';

export const WRAPPED_SEED_FILE_VERSION = 1;
export const WRAPPED_SEED_FILE_MODE = 0o600;

interface WrappedSeedFileV1 {
  dina_wrapped_seed_version: 1;
  salt_hex: string;
  wrapped_hex: string;
  params: {
    memory: number;
    iterations: number;
    parallelism: number;
  };
}

/**
 * Wrap a seed under a passphrase and persist it atomically at
 * `<vaultDir>/wrapped_seed.bin`. Overwrites any existing file.
 *
 * Caller is responsible for first removing the `keyfile` (convenience
 * mode) if they're migrating away from it — this module only writes
 * the wrapped form; it does not manage the coexistence of the two.
 */
export async function writeWrappedSeed(
  vaultDir: string,
  seed: Uint8Array,
  passphrase: string,
): Promise<void> {
  if (!vaultDir) throw new Error('writeWrappedSeed: vaultDir is required');
  if (!passphrase || passphrase.length === 0) {
    throw new Error('writeWrappedSeed: passphrase must be non-empty');
  }
  await fs.mkdir(vaultDir, { recursive: true });

  const wrapped = await wrapSeed(passphrase, seed);
  const fileDoc: WrappedSeedFileV1 = {
    dina_wrapped_seed_version: 1,
    salt_hex: toHex(wrapped.salt),
    wrapped_hex: toHex(wrapped.wrapped),
    params: wrapped.params,
  };

  const target = path.join(vaultDir, WRAPPED_SEED_NAME);
  const tmp = path.join(
    vaultDir,
    `.${WRAPPED_SEED_NAME}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`,
  );
  try {
    await fs.writeFile(tmp, JSON.stringify(fileDoc), { mode: WRAPPED_SEED_FILE_MODE });
    await fs.chmod(tmp, WRAPPED_SEED_FILE_MODE);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Read + decrypt the wrapped seed from `<vaultDir>/wrapped_seed.bin`.
 * Returns the raw master seed. Throws on wrong passphrase (the GCM
 * auth tag fails to verify) or corrupt file.
 */
export async function readWrappedSeed(
  vaultDir: string,
  passphrase: string,
): Promise<Uint8Array> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error('readWrappedSeed: passphrase must be non-empty');
  }
  const p = path.join(vaultDir, WRAPPED_SEED_NAME);
  const raw = await fs.readFile(p, 'utf8');

  let parsed: WrappedSeedFileV1;
  try {
    parsed = JSON.parse(raw) as WrappedSeedFileV1;
  } catch (err) {
    throw new Error(`readWrappedSeed: ${p} is not valid JSON (${(err as Error).message})`);
  }
  if (parsed.dina_wrapped_seed_version !== WRAPPED_SEED_FILE_VERSION) {
    throw new Error(
      `readWrappedSeed: unsupported wrapped-seed file version ${parsed.dina_wrapped_seed_version}; expected ${WRAPPED_SEED_FILE_VERSION}`,
    );
  }
  if (!parsed.salt_hex || !parsed.wrapped_hex || !parsed.params) {
    throw new Error('readWrappedSeed: file is missing required fields (salt_hex, wrapped_hex, params)');
  }

  const wrapped: WrappedSeed = {
    salt: fromHex(parsed.salt_hex),
    wrapped: fromHex(parsed.wrapped_hex),
    params: parsed.params,
  };

  try {
    return await unwrapSeed(passphrase, wrapped);
  } catch (err) {
    // Don't leak the underlying GCM failure — report as a generic auth
    // failure so shell history / logs don't reveal whether the file is
    // corrupt vs. the passphrase is wrong.
    throw new Error(
      `readWrappedSeed: unwrap failed (wrong passphrase or corrupt file): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`non-hex char at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
