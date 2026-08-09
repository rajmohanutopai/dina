/**
 * `applyDinaPlcUpdate` — publish the Dina-specific additions onto an
 * existing PLC document.
 *
 * The PDS's `createAccount` mints a `did:plc` with only the atproto-
 * managed entries (`#atproto` rotation VM + `atproto_pds` service). For
 * Dina's D2D layer to work, peers need to find:
 *   - the Ed25519 signing key (`#dina_signing` VM) so `sealMessage`
 *     can encrypt envelopes addressed to this DID, and
 *   - the MsgBox relay endpoint (`#dina-messaging` service) so peers
 *     know where to deliver D2D envelopes.
 *
 * This helper fetches the audit log, reads the last operation, merges
 * the Dina fields on top, and POSTs a chained update via
 * `@dina/core.updateDIDPLC`. The signer is the K256 rotation key
 * derived from `masterSeed` via `deriveRotationKey(seed, 0)` — the same
 * key the PDS published as `recoveryKey` on the genesis op, so the
 * update's signature verifies against `rotationKeys`.
 *
 * Used by:
 *   - mobile onboarding (`apps/mobile/src/onboarding/provision.ts`)
 *     after `createAccount` on first boot.
 *   - lite Core boot (`apps/home-node-lite/core-server/src/identity/
 *     provision_pds.ts`) after `loadOrProvisionPdsIdentity`.
 *
 * Both call sites used to carry their own near-identical copy — now
 * they import this one. Keep it runtime-agnostic: no node-fs, no
 * react-native, no expo. Fetch is injected (or falls back to the
 * platform's global) so the only platform difference is which
 * `fetch` implementation drives the HTTPS call.
 */

import { cidForOperation, publicKeyToMultibase, updateDIDPLC } from '@dina/core';

const DEFAULT_PLC_URL = 'https://plc.directory';

export interface ApplyDinaPlcUpdateOptions {
  /** The `did:plc:…` to update. */
  did: string;
  /** Handle to keep in `alsoKnownAs` when the prior op didn't carry one. */
  handle: string;
  /** Where to publish the `dina-messaging` service endpoint. */
  msgboxEndpoint: string;
  /** Ed25519 public key (32 bytes) — added as `dina_signing` VM. */
  signingPubKey: Uint8Array;
  /**
   * Master seed used to derive the K256 rotation key. Length must
   * match what `@dina/core.updateDIDPLC` accepts (>= 16 bytes after
   * the PLC-update relax-the-check change). Mobile passes 32-byte
   * BIP-39 entropy, lite passes the 64-byte BIP-39 PBKDF2 seed.
   */
  masterSeed: Uint8Array;
  /** Optional PLC directory URL. Defaults to https://plc.directory. */
  plcURL?: string;
  /**
   * Optional fetch override. Defaults to `globalThis.fetch`. Pass
   * `@dina/core/runtime`'s `defaultFetch()` in environments without
   * a global fetch (very old Node), or a stub from tests.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Apply the Dina additions to a did:plc document. Throws on any
 * audit-log fetch / signing / PLC POST failure — callers decide
 * whether to retry or mark the operation as durably applied.
 */
export async function applyDinaPlcUpdate(opts: ApplyDinaPlcUpdateOptions): Promise<void> {
  const plcURL = (opts.plcURL ?? DEFAULT_PLC_URL).replace(/\/$/, '');
  const fetchFn = opts.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('applyDinaPlcUpdate: no fetch available (pass opts.fetch)');
  }

  const auditLog = await fetchAuditLog(opts.did, plcURL, fetchFn);
  if (auditLog.length === 0) {
    throw new Error(`PLC audit log is empty for ${opts.did} — DID not yet propagated?`);
  }
  const lastEntry = auditLog[auditLog.length - 1];
  if (!lastEntry || typeof lastEntry !== 'object') {
    throw new Error('PLC audit log returned a malformed last entry');
  }
  const lastOp = (lastEntry as Record<string, unknown>).operation;
  if (!lastOp || typeof lastOp !== 'object') {
    throw new Error('PLC audit log entry missing `operation` field');
  }
  const lastOpRecord = lastOp as Record<string, unknown>;

  // Read the prior op's fields so we can MERGE on top — never overwrite
  // PDS-managed entries (atproto VM, atproto_pds service, PDS rotation
  // key).
  const priorVMs = readStringMap(lastOpRecord.verificationMethods);
  const priorServices = readServicesMap(lastOpRecord.services);
  const priorRotationKeys = readStringArray(lastOpRecord.rotationKeys);
  const priorAlsoKnownAs = readStringArray(lastOpRecord.alsoKnownAs);

  if (priorRotationKeys.length === 0) {
    throw new Error('PLC prior op has no rotation keys — refusing to publish update');
  }

  const priorCid = cidForOperation(lastOpRecord);
  const dinaSigningDidKey = `did:key:${publicKeyToMultibase(opts.signingPubKey)}`;
  const verificationMethods: Record<string, string> = {
    ...priorVMs,
    dina_signing: dinaSigningDidKey,
  };
  const services: Record<string, { type: string; endpoint: string }> = {
    ...priorServices,
    'dina-messaging': {
      type: 'DinaMsgBox',
      endpoint: opts.msgboxEndpoint,
    },
  };
  const alsoKnownAs = priorAlsoKnownAs.length > 0 ? priorAlsoKnownAs : [`at://${opts.handle}`];

  await updateDIDPLC(
    {
      did: opts.did,
      prev: priorCid,
      verificationMethods,
      rotationKeys: priorRotationKeys,
      services,
      alsoKnownAs,
      // `updateDIDPLC` re-derives the signer privkey via
      // `deriveRotationKey(seed, 0)`. Must match the seed that
      // produced the K256 we sent as `recoveryKey` to PDS — otherwise
      // the signature lands on a key not in `rotationKeys` and PLC
      // rejects.
      signerRotationSeed: opts.masterSeed,
    },
    {
      plcURL,
      fetch: fetchFn,
    },
  );
}

async function fetchAuditLog(
  did: string,
  plcURL: string,
  fetchFn: typeof globalThis.fetch,
): Promise<unknown[]> {
  const url = `${plcURL.replace(/\/$/, '')}/${did}/log/audit`;
  const resp = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) {
    throw new Error(`PLC audit log fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const body = await resp.json();
  if (!Array.isArray(body)) {
    throw new Error('PLC audit log response is not an array');
  }
  return body;
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
