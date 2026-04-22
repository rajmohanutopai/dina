/**
 * Task 5.8 — Service key loader from keydir.
 *
 * At install time, `install.sh` derives every service's Ed25519 key
 * via SLIP-0010 under purpose `m/9999'/3'` and writes the raw 32-byte
 * seed (the secret material — the public key is derived from it) to a
 * keydir file with mode `0600`:
 *
 *   Core  → `m/9999'/3'/0'` → `<keydir>/core.ed25519`
 *   Brain → `m/9999'/3'/1'` → `<keydir>/brain.ed25519`
 *
 * At runtime, the brain-server MUST be able to **load** its existing
 * key. It must NEVER generate one — fail-closed. This primitive is the
 * load path.
 *
 * **Why raw 32 bytes, not hex or JWK**:
 *   - Hex would double the file size + force newline/whitespace
 *     trimming at every load site.
 *   - JWK would add a JSON parse + validation hoop for zero security
 *     gain — the file lives under `chmod 600` on a single host.
 *   - `install.sh` writes the raw seed. A 32-byte binary file is the
 *     simplest, unambiguous contract.
 *
 * **Fingerprint**: `SHA-256(seed).slice(0, 8)` rendered as lowercase hex
 * (16 chars). Used in logs + operator UIs to identify which key a
 * service is using without revealing the key itself. SHA-256 is
 * one-way; the fingerprint is a commitment to the seed. Operators can
 * compare the fingerprint in the brain's startup log against the
 * fingerprint printed by `install.sh` to confirm the right key loaded.
 *
 * **Structured outcome** — never throws. `{ok: true, seed, fingerprint, path}`
 * on success; `{ok: false, reason, detail}` on every failure mode
 * (missing file, wrong length, read error, bad input). The brain-server
 * crashes on `ok: false` (fail-closed), but the transport is the same
 * structured shape every other primitive uses so call-site patterns
 * stay uniform.
 *
 * **Injectable I/O**: `readFileFn` defaults to `node:fs/promises`;
 * `sha256Fn` defaults to `node:crypto`. Tests supply synchronous
 * in-memory substitutes so there's no filesystem hop in the 99% path.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5b task 5.8.
 */

import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Ed25519 seed length — fixed by the RFC 8032 standard. */
export const ED25519_SEED_BYTES = 32;
/** Default keydir filename for the brain service. */
export const DEFAULT_BRAIN_KEY_FILENAME = 'brain.ed25519';
/** Length of the hex fingerprint rendered in logs / UI. */
export const FINGERPRINT_HEX_LENGTH = 16;

export interface ServiceKeyLoadInput {
  /** Directory containing the provisioned key file (e.g. `~/.dina/brain/keys`). */
  keyDir: string;
  /** Filename within `keyDir`. Defaults to `brain.ed25519`. */
  fileName?: string;
  /** Injectable reader. Defaults to `fs/promises.readFile`. */
  readFileFn?: (path: string) => Promise<Uint8Array>;
  /** Injectable SHA-256 — defaults to node:crypto. Return raw 32-byte digest. */
  sha256Fn?: (data: Uint8Array) => Uint8Array;
}

export type ServiceKeyLoadReason =
  | 'invalid_input'
  | 'not_found'
  | 'read_failed'
  | 'wrong_length';

export type ServiceKeyLoadOutcome =
  | {
      ok: true;
      /** Raw 32-byte Ed25519 seed — PRIVATE. Don't log. Hand to crypto. */
      seed: Uint8Array;
      /** Short hash used in logs/admin UI. 16 lowercase-hex chars. */
      fingerprint: string;
      /** Absolute path the seed was loaded from. */
      path: string;
    }
  | {
      ok: false;
      reason: ServiceKeyLoadReason;
      detail: string;
    };

/**
 * Load a brain-service Ed25519 seed from the keydir.
 * Returns a structured outcome; never throws.
 */
export async function loadServiceKey(
  input: ServiceKeyLoadInput,
): Promise<ServiceKeyLoadOutcome> {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input', detail: 'input is required' };
  }
  if (typeof input.keyDir !== 'string' || input.keyDir === '') {
    return { ok: false, reason: 'invalid_input', detail: 'keyDir must be a non-empty string' };
  }
  const fileName = input.fileName ?? DEFAULT_BRAIN_KEY_FILENAME;
  if (typeof fileName !== 'string' || fileName === '') {
    return { ok: false, reason: 'invalid_input', detail: 'fileName must be a non-empty string' };
  }
  const path = join(input.keyDir, fileName);
  const readFileFn = input.readFileFn ?? defaultReadFile;
  const sha256Fn = input.sha256Fn ?? defaultSha256;

  let bytes: Uint8Array;
  try {
    bytes = await readFileFn(path);
  } catch (err) {
    const reason = classifyReadError(err);
    return {
      ok: false,
      reason,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (bytes.byteLength !== ED25519_SEED_BYTES) {
    return {
      ok: false,
      reason: 'wrong_length',
      detail: `expected ${ED25519_SEED_BYTES} bytes, got ${bytes.byteLength}`,
    };
  }

  // Copy so caller mutations to `bytes` don't corrupt internal state.
  const seed = new Uint8Array(bytes);
  const digest = sha256Fn(seed);
  const fingerprint = toHex(digest.subarray(0, FINGERPRINT_HEX_LENGTH / 2));

  return { ok: true, seed, fingerprint, path };
}

// ── Internals ──────────────────────────────────────────────────────────

function defaultReadFile(path: string): Promise<Uint8Array> {
  return fsReadFile(path);
}

function defaultSha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function classifyReadError(err: unknown): ServiceKeyLoadReason {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
  return 'read_failed';
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
