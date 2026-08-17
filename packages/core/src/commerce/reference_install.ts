/**
 * Installing the FIRST-PARTY commerce reference packs (§18.1 / X-04).
 *
 * `planCommerceInstall` turns the owner's choice into manifests, and the
 * general install machinery (`plugins/install_service.ts`) owns pending
 * rows, consent, device binding and activation. What was missing is the
 * step between them: a production caller for `beginInstallVerified` that
 * is honest about WHO vouches for these manifests.
 *
 * THE AUTHORITY STORY. The reference manifests are compiled into this
 * build — they are not fetched from any repo, so `repo_proof` would claim
 * a verification that never ran, and `debug_unsigned` is refused in
 * production by design. The truthful anchor is `local_publisher_key`: the
 * software this node is running vouches for the bytes it shipped with,
 * under a key id that names exactly that. The CID is content-derived from
 * the canonical manifest (same dag-cbor/sha2-256 shape every release CID
 * uses), so the §5 content-address invariant holds here too: the stored
 * address IS the hash of what was installed.
 *
 * FIRST-PARTY ONLY, BY CONSTRUCTION. The role is the whole input; the
 * manifest comes from the compiled-in table. No caller-supplied manifest
 * can reach this path, so it cannot become a side door around the P0
 * third-party install flow (repo proofs, marketplace consent screens).
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { utf8Bytes } from '@dina/commerce-protocol';
import { base32Encode, canonicalJson, normalizePluginManifest } from '@dina/protocol';

import {
  attestVerifiedRelease,
  beginInstallVerified,
  type BeginInstallResult,
} from '../plugins/install_service';

import { BUYER_REFERENCE_MANIFEST, SUPPLIER_REFERENCE_MANIFEST } from './reference_manifests';

import type { CommerceRole } from './install_plan';
import type { PluginManifest } from '@dina/protocol';

const MANIFEST_BY_ROLE: Readonly<Record<CommerceRole, PluginManifest>> = {
  buyer: BUYER_REFERENCE_MANIFEST,
  supplier: SUPPLIER_REFERENCE_MANIFEST,
};

/** The consent-facing name of the build's own vouching authority. */
export const KERNEL_REFERENCE_KEY_ID = 'dina-kernel-reference';

/**
 * The content-derived CID of a reference manifest: CIDv1, dag-cbor,
 * sha2-256 over the canonical normalized manifest bytes — the exact shape
 * `releaseRkeyFromCid` parses, so the install row's content address is
 * re-provable from the manifest alone.
 */
export function referenceManifestCid(manifest: PluginManifest): string {
  const digest = sha256(utf8Bytes(canonicalJson(normalizePluginManifest(manifest))));
  const bytes = new Uint8Array(4 + digest.length);
  bytes[0] = 0x01; // CIDv1
  bytes[1] = 0x71; // dag-cbor
  bytes[2] = 0x12; // sha2-256
  bytes[3] = 0x20; // 32 bytes
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

/**
 * Create the PENDING install for one role. Consent and (for these
 * runner-mode packs) device binding stay separate calls on purpose — a
 * begin that also consented would put the §14 decision behind one tap.
 */
export function beginReferenceInstall(args: {
  role: CommerceRole;
  /** The node's own DID — the identity this build publishes under. */
  publisherDid: string;
  nowMs: number;
}): BeginInstallResult {
  const manifest = MANIFEST_BY_ROLE[args.role];
  const attestation = attestVerifiedRelease({
    cid: referenceManifestCid(manifest),
    publisherDid: args.publisherDid,
    trustAnchor: { kind: 'local_publisher_key', keyId: KERNEL_REFERENCE_KEY_ID },
    manifest,
  });
  return beginInstallVerified({
    manifest,
    attestation,
    label: manifest.display_name,
    nowMs: args.nowMs,
  });
}
