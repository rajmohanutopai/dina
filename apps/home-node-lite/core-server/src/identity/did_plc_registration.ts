/**
 * Task 4.56 — did:plc registration on first boot (community PDS).
 *
 * The Home Node's canonical identity is a `did:plc` registered with a
 * community PLC directory (e.g. `plc.directory`). Registration happens
 * exactly once per install: first boot runs the genesis operation,
 * persists the resulting DID at `<vaultDir>/did.txt`, and returns it.
 * Subsequent boots just load the persisted DID.
 *
 * **Dependency on tasks 4.51/4.54**: the genesis operation needs the
 * Ed25519 root signing key + a seed for secp256k1 rotation-key
 * derivation. Both come from the identity-derivations bundle.
 *
 * **PDS / fetch injection**: the real `createDIDPLC` calls the PLC
 * directory's HTTP API. For unit tests we inject a stubbed
 * `createFn` so coverage doesn't require a live PDS or network. The
 * real HTTP client lands with Phase 4 production deployment.
 *
 * **Persistence**: DID stored as UTF-8 at `<vaultDir>/did.txt` with
 * mode `0o600`. Small + easy to curl for ops debugging; not
 * sensitive (DIDs are public by design) but restricted anyway for
 * consistency with the other identity artifacts.
 *
 * **Idempotence**: if `did.txt` is present at boot, we skip the
 * create call entirely. The persisted DID is trusted — it's backed by
 * the PLC directory's public record. If someone deletes the file
 * but the directory already has the identity, the next boot would
 * create a NEW identity — deliberately loud: you can't silently
 * re-register under the same DID, and orphaned directory entries
 * are ops cleanup.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g task 4.56.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDIDPLC, type PLCCreateParams, type PLCCreateResult } from '@dina/core';
import type { IdentityDerivations } from './derivations';

export const DID_FILE_NAME = 'did.txt';
export const DID_FILE_MODE = 0o600;

/** Shape of the injectable create function (matches `createDIDPLC`). */
export type PLCCreateFn = (params: PLCCreateParams) => Promise<PLCCreateResult>;

export interface PlcRegisterOptions {
  vaultDir: string;
  /** Identity bundle from task 4.54 — supplies root signing pub + master seed. */
  identity: IdentityDerivations;
  /** Master seed bytes — passed through for rotation-key derivation. */
  masterSeed: Uint8Array;
  /** Optional MsgBox endpoint advertised in the DID document. */
  msgboxEndpoint?: string;
  /** Optional handle (e.g. `alice.example`). */
  handle?: string;
  /** Injected create function for tests. Defaults to `@dina/core.createDIDPLC`. */
  createFn?: PLCCreateFn;
}

export type PlcRegisterOutcome =
  | { kind: 'loaded'; did: string }
  | { kind: 'registered'; result: PLCCreateResult };

/**
 * Ensure the Home Node has a registered `did:plc`. Returns `{kind:'loaded'}`
 * on subsequent boots; `{kind:'registered', result}` on first boot.
 */
export async function ensureDIDPLC(opts: PlcRegisterOptions): Promise<PlcRegisterOutcome> {
  if (!opts.vaultDir) throw new Error('ensureDIDPLC: vaultDir is required');
  if (!opts.identity) throw new Error('ensureDIDPLC: identity is required');
  if (!opts.masterSeed || opts.masterSeed.length < 16) {
    throw new Error('ensureDIDPLC: masterSeed must be at least 16 bytes');
  }

  const didPath = path.join(opts.vaultDir, DID_FILE_NAME);

  // Idempotent path: if we already have a persisted DID, return it.
  try {
    const raw = await fs.readFile(didPath, 'utf8');
    const did = raw.trim();
    if (did.startsWith('did:plc:')) return { kind: 'loaded', did };
    throw new Error(
      `ensureDIDPLC: ${didPath} exists but contents (${JSON.stringify(raw)}) don't start with "did:plc:" — refusing to overwrite`,
    );
  } catch (err) {
    // ENOENT is the happy path: first-boot flow below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // First boot: build params + register.
  const createFn = opts.createFn ?? createDIDPLC;
  const params: PLCCreateParams = {
    signingKey: opts.identity.root.privateKey,
    rotationSeed: opts.masterSeed,
    ...(opts.msgboxEndpoint !== undefined ? { msgboxEndpoint: opts.msgboxEndpoint } : {}),
    ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
  };
  const result = await createFn(params);

  if (!result.did || !result.did.startsWith('did:plc:')) {
    throw new Error(
      `ensureDIDPLC: createFn returned invalid DID "${result.did}" (must start with "did:plc:")`,
    );
  }

  await fs.mkdir(opts.vaultDir, { recursive: true });
  await writeDidFileAtomic(didPath, result.did);
  return { kind: 'registered', result };
}

async function writeDidFileAtomic(didPath: string, did: string): Promise<void> {
  const dir = path.dirname(didPath);
  const tmp = path.join(
    dir,
    `.${DID_FILE_NAME}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`,
  );
  try {
    await fs.writeFile(tmp, `${did}\n`, { mode: DID_FILE_MODE });
    await fs.chmod(tmp, DID_FILE_MODE);
    await fs.rename(tmp, didPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
