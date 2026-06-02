/**
 * First-boot PDS account provisioning for the lite Home Node.
 *
 * Mirrors the mobile onboarding's `provisionIdentity` flow
 * (`apps/mobile/src/onboarding/provision.ts`) for the Node runtime:
 * given the identity derivations bundle + master seed + a target
 * PDS, ensure there's an atproto account this node owns, and persist
 * its DID + handle + password so subsequent boots can re-authenticate
 * without re-provisioning.
 *
 * **Why lite needs this.** Without a PDS account, lite Core stays
 * on its locally-minted `did:key` and can publish nothing to the
 * AppView — `ServiceProfilePublisher` has no PDS `putRecord` to call,
 * so the home node is invisible to the network. The mobile onboarding
 * solved this end-to-end (PDS-first did:plc); this module is the Node
 * equivalent so lite can be a real provider, not a dev-only requester.
 *
 * **Idempotence.** `PDSAccountClient.ensureAccount` tries `createSession`
 * first and only falls back to `createAccount` if the account doesn't
 * exist. On the FIRST boot for a given (handle, password) pair the
 * account gets minted. On every subsequent boot we either:
 *   - skip entirely (pds_identity.json already on disk), or
 *   - rehydrate the same DID via createSession.
 *
 * **Persistence.** We write `<vaultDir>/pds_identity.json` mode 0600
 * with `{did, handle, password, email, pdsUrl}`. The password is
 * derived from the master seed via HMAC — same recovery property as
 * mobile: re-derive the same seed → re-derive the same password →
 * `createSession` works without re-running provisioning.
 *
 * **What's NOT in this module.** The PLC update step from mobile's
 * provision (adding `dina_signing` VM + `dina-messaging` service to
 * the PLC document) is a separate concern. This module gets the
 * account + DID; downstream callers handle PLC-level publishing.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md — analog of Phase 4g task 4.56
 * but PDS-first instead of direct-to-PLC.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { secp256k1ToDidKeyMultibase } from '@dina/core';
import { PDSAccountClient, PDSAccountError } from '@dina/brain';
import { applyDinaPlcUpdate } from '@dina/home-node';

import type { IdentityDerivations } from './derivations';

/** Filename under `vaultDir`. */
export const PDS_IDENTITY_FILE = 'pds_identity.json';
/** Owner-only file mode. Matches `keyfile` + `did.txt` policy. */
export const PDS_IDENTITY_MODE = 0o600;

/** Persisted PDS account record. JSON-serialisable, written 0600. */
export interface PdsIdentity {
  /** atproto did:plc minted (or rehydrated) for this account. */
  did: string;
  /** Account handle (e.g. `myhandle.test-pds.dinakernel.com`). */
  handle: string;
  /** Account password — derived from master seed via HMAC. */
  password: string;
  /** Account email (synthetic when not user-supplied). */
  email: string;
  /** PDS URL the account lives on. */
  pdsUrl: string;
  /**
   * `true` once the PLC document carries the Dina additions
   * (`dina_signing` VM + `dina-messaging` service). Set during
   * provisioning; gates a one-shot fix-up on boots where it's missing.
   * Required for D2D — `sendD2D` resolves the recipient's `dina_signing`
   * key to seal envelopes, and a missing key surfaces as
   * "no Ed25519 signing key in its DID doc".
   */
  dinaUpdateApplied?: boolean;
}

export interface ProvisionPdsOptions {
  /** Where to read/write `pds_identity.json`. */
  vaultDir: string;
  /** Identity derivations bundle from `deriveIdentity`. */
  identity: IdentityDerivations;
  /** Master seed bytes (32 or 64) — used to derive the PDS password. */
  masterSeed: Uint8Array;
  /** PDS URL, e.g. `https://test-pds.dinakernel.com`. */
  pdsUrl: string;
  /**
   * Account handle to claim. When omitted, lite throws — handles are
   * user-facing so we don't auto-derive; the operator picks one via
   * `DINA_PDS_HANDLE` env. (Mobile's onboarding has its own random
   * suffix path because it owns the UX; lite is server-side, run
   * once by an operator who supplies the handle.)
   */
  handle: string;
  /** Account email; auto-synthesised from the handle if omitted. */
  email?: string;
  /** MsgBox endpoint to publish in the `dina-messaging` service. */
  msgboxEndpoint: string;
  /** Root signing public key (Ed25519) — published as `dina_signing`. */
  signingPublicKey: Uint8Array;
  /** Optional injected PLC directory (defaults to https://plc.directory). */
  plcURL?: string;
  /** Optional injected fetch (for tests). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Load `pds_identity.json` if present, otherwise provision a fresh
 * PDS account via `PDSAccountClient.ensureAccount` and persist the
 * result. Always returns the same DID for a given (vaultDir, handle,
 * masterSeed) tuple — the persisted file is the source of truth on
 * subsequent boots.
 */
export async function loadOrProvisionPdsIdentity(
  opts: ProvisionPdsOptions,
): Promise<PdsIdentity> {
  if (!opts.vaultDir) throw new Error('loadOrProvisionPdsIdentity: vaultDir required');
  if (!opts.handle) throw new Error('loadOrProvisionPdsIdentity: handle required');
  if (!opts.pdsUrl) throw new Error('loadOrProvisionPdsIdentity: pdsUrl required');
  if (!opts.identity?.rotation?.publicKey) {
    throw new Error('loadOrProvisionPdsIdentity: identity.rotation.publicKey required');
  }
  if (!(opts.masterSeed instanceof Uint8Array) || opts.masterSeed.length < 32) {
    throw new Error('loadOrProvisionPdsIdentity: masterSeed must be ≥32 bytes');
  }

  const filePath = path.join(opts.vaultDir, PDS_IDENTITY_FILE);

  // Fast path: file already on disk → trust it. Still applies the
  // Dina PLC additions on this boot if they haven't been published
  // yet (e.g. an earlier provision predated this step).
  if (await fileExists(filePath)) {
    const raw = await fs.readFile(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `loadOrProvisionPdsIdentity: ${filePath} is malformed JSON — ` +
          'delete it to re-provision (only safe if you intend to mint a new DID)',
      );
    }
    const identity = validatePdsIdentity(parsed, filePath);
    // Fail closed when the persisted identity no longer matches the configured
    // handle / PDS URL. Booting (and publishing) as a stale DID after the
    // DINA_PDS_HANDLE / PDS URL changed is almost never intended — silently
    // trusting the file would re-bind to the old account. An operator who
    // really did change the handle/PDS sets DINA_PDS_ALLOW_IDENTITY_MISMATCH=1
    // to accept the existing identity, or deletes the file to mint a fresh one.
    const normUrl = (u: string): string => u.replace(/\/+$/, '');
    const mismatch =
      identity.handle !== opts.handle || normUrl(identity.pdsUrl) !== normUrl(opts.pdsUrl);
    if (mismatch && process.env.DINA_PDS_ALLOW_IDENTITY_MISMATCH !== '1') {
      throw new Error(
        `loadOrProvisionPdsIdentity: persisted identity (${identity.handle} @ ${identity.pdsUrl}) ` +
          `does not match configured (${opts.handle} @ ${opts.pdsUrl}). Refusing to boot as a stale ` +
          `DID. Set DINA_PDS_ALLOW_IDENTITY_MISMATCH=1 to keep the existing identity, or delete ` +
          `${filePath} to mint a fresh one for the new handle.`,
      );
    }
    if (identity.dinaUpdateApplied !== true) {
      await applyDinaPlcUpdate({
        did: identity.did,
        handle: identity.handle,
        msgboxEndpoint: opts.msgboxEndpoint,
        signingPubKey: opts.signingPublicKey,
        masterSeed: opts.masterSeed,
        ...(opts.plcURL !== undefined ? { plcURL: opts.plcURL } : {}),
      });
      identity.dinaUpdateApplied = true;
      await writeAtomic(filePath, JSON.stringify(identity, null, 2));
    }
    return identity;
  }

  // Slow path: ensure account on PDS, then persist.
  const password = derivePdsPassword(opts.masterSeed);
  const email = opts.email ?? defaultEmailForHandle(opts.handle);
  const recoveryKey = `did:key:${secp256k1ToDidKeyMultibase(opts.identity.rotation.publicKey)}`;

  const client = new PDSAccountClient({
    pdsUrl: opts.pdsUrl,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });

  // We can't use `ensureAccount` here because its fallback only fires
  // on HTTP 400 + xrpcError `AccountNotFound`/`InvalidIdentifier`. The
  // reference atproto PDS implementation returns HTTP 401 +
  // `AuthenticationRequired` when the handle doesn't exist (matches
  // the password-wrong path so attackers can't probe handle existence),
  // so `ensureAccount`'s fallback never trips for fresh first-boots.
  //
  // Strategy: try `createAccount` first. If it succeeds, we have a
  // fresh account. If it fails with `HandleNotAvailable` the handle is
  // already registered — fall back to `createSession` with the
  // seed-derived password (recovery path: same seed → same password →
  // rebinds to the existing account).
  let session;
  try {
    session = await client.createAccount({
      handle: opts.handle,
      password,
      email,
      recoveryKey,
    });
  } catch (err) {
    if (err instanceof PDSAccountError && isHandleTakenError(err)) {
      // Handle already exists — rebind via the seed-derived password.
      // If the password doesn't match (e.g. someone else owns this
      // handle), this throws AuthenticationRequired and propagates up.
      session = await client.createSession({
        identifier: opts.handle,
        password,
      });
    } else {
      throw err;
    }
  }

  const identity: PdsIdentity = {
    did: session.did,
    handle: opts.handle,
    password,
    email,
    pdsUrl: opts.pdsUrl,
    dinaUpdateApplied: false,
  };

  // Publish the Dina PLC additions on this boot too — otherwise the
  // node has a did:plc but no `dina_signing` VM, so D2D recipients
  // can't seal envelopes to it.
  await applyDinaPlcUpdate({
    did: identity.did,
    handle: identity.handle,
    msgboxEndpoint: opts.msgboxEndpoint,
    signingPubKey: opts.signingPublicKey,
    masterSeed: opts.masterSeed,
    ...(opts.plcURL !== undefined ? { plcURL: opts.plcURL } : {}),
  });
  identity.dinaUpdateApplied = true;

  await writeAtomic(filePath, JSON.stringify(identity, null, 2));
  return identity;
}

/**
 * True when a `createAccount` failure means "this handle is already
 * registered" — the signal to fall back to seed-derived-password
 * `createSession` (the recovery path that rebinds a fresh disk to an
 * existing account).
 *
 * The canonical atproto code is `HandleNotAvailable`, but real PDS
 * implementations diverge: `test-pds.dinakernel.com` (and reference
 * atproto builds) return HTTP 400 `InvalidRequest` with the message
 * "Handle already taken: <handle>". Matching ONLY the canonical code
 * silently broke recovery — a node whose `/tmp`/disk was wiped (so
 * `pds_identity.json` is gone) but whose handle is still registered
 * would throw on `createAccount`, never attempt `createSession`, and
 * fall back to a useless `did:key` (no PDS repo → invisible to AppView).
 * Match the message too so the deterministic-password recovery the whole
 * design relies on actually fires.
 */
function isHandleTakenError(err: PDSAccountError): boolean {
  if (err.xrpcError === 'HandleNotAvailable') return true;
  if (err.status !== 400) return false;
  const m = err.message?.toLowerCase() ?? '';
  return (
    m.includes('handle already taken') ||
    m.includes('already taken') ||
    m.includes('handle is unavailable') ||
    m.includes('handle not available')
  );
}

/**
 * Deterministic PDS password derived from the master seed. Same scheme
 * as mobile (`apps/mobile/src/onboarding/provision.ts::derivePdsPassword`)
 * so the seed → password mapping is the only thing that has to match
 * for recovery on a fresh disk: re-derive the seed, re-derive the
 * password, `createSession` rebinds to the same account.
 *
 * Versioned tag so we can rotate the derivation later without losing
 * access to existing accounts (bump v1 → v2, keep both readers).
 */
export function derivePdsPassword(masterSeed: Uint8Array): string {
  const tag = new TextEncoder().encode('dina:pds_password:v1');
  return bytesToHex(hmac(sha256, masterSeed, tag));
}

/**
 * Synthetic email when the operator didn't supply one. The PDS only
 * requires uniqueness + a valid-looking address; `<localpart>@dina.invalid`
 * is reserved by RFC 2606 and won't collide with real mailboxes.
 */
function defaultEmailForHandle(handle: string): string {
  const local = handle.split('.')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'dina';
  return `${local}@dina.invalid`;
}

function validatePdsIdentity(parsed: unknown, source: string): PdsIdentity {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${source}: expected JSON object, got ${typeof parsed}`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const k of ['did', 'handle', 'password', 'email', 'pdsUrl']) {
    if (typeof obj[k] !== 'string' || (obj[k] as string).length === 0) {
      throw new Error(`${source}: missing or empty field '${k}'`);
    }
  }
  return {
    did: obj.did as string,
    handle: obj.handle as string,
    password: obj.password as string,
    email: obj.email as string,
    pdsUrl: obj.pdsUrl as string,
    ...(typeof obj.dinaUpdateApplied === 'boolean'
      ? { dinaUpdateApplied: obj.dinaUpdateApplied }
      : {}),
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${process.hrtime.bigint().toString(36)}`,
  );
  try {
    await fs.writeFile(tmp, content, { mode: PDS_IDENTITY_MODE });
    await fs.chmod(tmp, PDS_IDENTITY_MODE);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
