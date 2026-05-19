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

import {
  cidForOperation,
  publicKeyToMultibase,
  secp256k1ToDidKeyMultibase,
  updateDIDPLC,
} from '@dina/core';
import { PDSAccountClient, PDSAccountError } from '@dina/brain';

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
    if (identity.dinaUpdateApplied !== true) {
      await applyDinaPlcUpdate({
        did: identity.did,
        handle: identity.handle,
        msgboxEndpoint: opts.msgboxEndpoint,
        signingPublicKey: opts.signingPublicKey,
        masterSeed: opts.masterSeed,
        plcURL: opts.plcURL,
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
    if (
      err instanceof PDSAccountError &&
      err.xrpcError === 'HandleNotAvailable'
    ) {
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
    signingPublicKey: opts.signingPublicKey,
    masterSeed: opts.masterSeed,
    plcURL: opts.plcURL,
  });
  identity.dinaUpdateApplied = true;

  await writeAtomic(filePath, JSON.stringify(identity, null, 2));
  return identity;
}

/**
 * Merge the Dina-specific additions onto the existing PLC document.
 * Port of the mobile onboarding helper (`apps/mobile/src/onboarding/
 * provision.ts::applyDinaPLCUpdate`) — same audit-log read, same
 * merge-on-top rule, same `prev = cid(lastOp)` chaining.
 *
 * Why we can't lazily skip this: `sendD2D` needs the recipient's
 * `dina_signing` VM to seal envelopes, and the published DinaMsgBox
 * service endpoint to know where to route — both come from the PLC
 * doc.
 */
async function applyDinaPlcUpdate(params: {
  did: string;
  handle: string;
  msgboxEndpoint: string;
  signingPublicKey: Uint8Array;
  masterSeed: Uint8Array;
  plcURL?: string;
}): Promise<void> {
  const plcURL = params.plcURL ?? 'https://plc.directory';
  const auditURL = `${plcURL.replace(/\/$/, '')}/${params.did}/log/audit`;
  const resp = await fetch(auditURL, { headers: { Accept: 'application/json' } });
  if (!resp.ok) {
    throw new Error(`PLC audit log fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const auditLog = (await resp.json()) as unknown[];
  if (!Array.isArray(auditLog) || auditLog.length === 0) {
    throw new Error(`PLC audit log is empty for ${params.did}`);
  }
  const lastEntry = auditLog[auditLog.length - 1] as Record<string, unknown>;
  const lastOp = lastEntry.operation as Record<string, unknown> | undefined;
  if (lastOp === undefined) {
    throw new Error('PLC audit log entry missing `operation` field');
  }
  const priorVMs = readStringMap(lastOp.verificationMethods);
  const priorServices = readServicesMap(lastOp.services);
  const priorRotationKeys = readStringArray(lastOp.rotationKeys);
  const priorAlsoKnownAs = readStringArray(lastOp.alsoKnownAs);

  if (priorRotationKeys.length === 0) {
    throw new Error('PLC prior op has no rotation keys — refusing to publish update');
  }

  const priorCid = cidForOperation(lastOp);
  const dinaSigningDidKey = `did:key:${publicKeyToMultibase(params.signingPublicKey)}`;
  const verificationMethods: Record<string, string> = {
    ...priorVMs,
    dina_signing: dinaSigningDidKey,
  };
  const services: Record<string, { type: string; endpoint: string }> = {
    ...priorServices,
    'dina-messaging': {
      type: 'DinaMsgBox',
      endpoint: params.msgboxEndpoint,
    },
  };
  const alsoKnownAs =
    priorAlsoKnownAs.length > 0 ? priorAlsoKnownAs : [`at://${params.handle}`];

  await updateDIDPLC(
    {
      did: params.did,
      prev: priorCid,
      verificationMethods,
      rotationKeys: priorRotationKeys,
      services,
      alsoKnownAs,
      signerRotationSeed: params.masterSeed,
    },
    {
      plcURL,
      // Without an injected fetch, `updateDIDPLC` builds + signs the
      // op but never POSTs it. Pass node's global fetch so the update
      // actually lands at plc.directory.
      fetch: (input, init) =>
        fetch(input as unknown as string | URL | Request, init as RequestInit | undefined),
    },
  );
}

function readStringMap(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function readServicesMap(v: unknown): Record<string, { type: string; endpoint: string }> {
  if (v === null || typeof v !== 'object') return {};
  const out: Record<string, { type: string; endpoint: string }> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val !== null && typeof val === 'object') {
      const entry = val as Record<string, unknown>;
      const type = typeof entry.type === 'string' ? entry.type : '';
      const endpoint = typeof entry.endpoint === 'string' ? entry.endpoint : '';
      if (type !== '' && endpoint !== '') out[k] = { type, endpoint };
    }
  }
  return out;
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
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
