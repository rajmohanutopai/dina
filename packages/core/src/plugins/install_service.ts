/**
 * Plugin install lifecycle — install-by-AT-URI, consent, activation,
 * uninstall, and the abandoned-install sweep
 * (PLUGIN_ARCHITECTURE.md §5, §14, §20 P0).
 *
 * The authenticity flow (§5 rule 5) runs through the INJECTED
 * `RepoProofVerifier` (the @dina/protocol contract): resolve DID doc →
 * proof-carrying CAR → commit signature vs the DID's signing key →
 * only then pin the CID. This module refuses to install when no
 * verifier is wired — fail-closed, no trust-on-first-use, no "install
 * anyway". The pure halves of rule 5 run here regardless:
 * `rkey == f(cid)` (enforced immutability) and manifest validation
 * identical to AppView's ingest gate.
 *
 * Compatibility (§14): the requirement set is DERIVED from manifest
 * structure (validate.ts), unioned with `required_features`, and every
 * entry must be in this node's supported set — a consented kind the
 * node cannot deliver must be unreachable, not silently dead.
 *
 * Lifecycle: `pending` install (with expiry) → [runner: pairing] →
 * consent → `activate` (the single atomic commit point). Everything
 * before activation is reversible; decline/sweep revokes any device
 * paired during the ceremony via the injected `revokeDevice`.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  PLUGIN_CAPS,
  canonicalJson,
  checkReleaseIntegrity,
  computePluginDigests,
  hasUnsafeText,
  isValidTrustAnchor,
  normalizePluginManifest,
  pluginLane,
  releaseRkeyFromCid,
  validatePluginManifest,
  type PluginManifest,
  type PluginTrustAnchor,
  type RepoProofVerifier,
} from '@dina/protocol';

import { getCommerceRuntime } from '../commerce/runtime';
import { getWorkflowService } from '../workflow/service';

import { recordDecisionSafe } from './decisions';
import { getDrainAuthorizationRepository } from './drain_authorizations';
import { getExtensionOperationRegistry } from './extension_ops';
import { getPluginGrantRepository } from './grants';
import { getPluginInstallRepository, type PluginInstallRef } from './registry';

/**
 * Features this node actually ships (P0: the tool lane end-to-end).
 * The §14 gate: derived ∪ declared ⊆ supported, else "needs a newer
 * Dina". kind.provider / kind.ingest / kind.notify / session / op.*
 * arrive in P2/P3/P1 respectively and are ABSENT here on purpose.
 *
 * P2-9: `config` is DROPPED — a `config_schema` needs an encrypted
 * config-VALUE store to be meaningful, and P0 has only `config_revision`
 * (a counter). Advertising it would let a plugin install claiming owner
 * configuration that can never be supplied. Restore it with the store.
 */
export const NODE_SUPPORTED_FEATURES: ReadonlySet<string> = new Set([
  'kind.tool',
  // §11.2a — provider-kind capabilities answer inbound D2D service queries
  // through `createProviderIngressTask`. Shipping this feature is what makes
  // a Supplier plugin installable at all; until now the manifest vocabulary
  // existed but the install gate rejected it, so every commerce engine
  // behind it was unreachable in production.
  //
  // The execution lane is the same one tools use — `plugin:<install_id>`
  // with identical claim-token, lease, retry and pinned-schema discipline —
  // and the claim guard already refuses a provider envelope on a tool-only
  // consent and vice versa. So this is the LAST gate, not a new lane.
  'kind.provider',
  'idempotent_retry',
]);

/**
 * Feature-token prefix for §3.4 extension operations.
 *
 * The validator derives one token per declared `host_operations` entry, so
 * the install gate can refuse a plugin whose operations this node has no
 * adapter for. Without it, such a manifest installed cleanly and failed at
 * DISPATCH — after the owner had already consented to something the node
 * could never do.
 */
export const HOST_OP_FEATURE_PREFIX = 'host_op.';

/**
 * Is this extension operation registered on THIS node?
 *
 * Fail closed when no registry is installed: a node with no extension-op
 * plane cannot serve any of them, and treating "not wired yet" as "yes"
 * is how the gate came to pass everything in the first place.
 */
function hostOperationAvailable(operationName: string): boolean {
  return getExtensionOperationRegistry()?.get(operationName) !== undefined;
}

/**
 * The coarse features registered operations advertise (§3.4).
 *
 * `ExtensionOperationDef.requiredFeature` — "compatibility gate at install
 * time" — was declared on every registered operation and read by nothing.
 * It answers a question the per-operation check cannot: a manifest may
 * declare `required_features: ['commerce-host-ops-v1']` to say "I need a
 * node that does commerce host operations at all", without naming which.
 *
 * The two checks catch different lies. Per-operation catches "you asked
 * for an adapter I do not have"; this catches "you declared a family I do
 * not serve". Neither subsumes the other.
 */
function registeredOperationFeatures(): ReadonlySet<string> {
  const registry = getExtensionOperationRegistry();
  if (registry === null) return new Set();
  return new Set(registry.list().map((op) => op.requiredFeature));
}

/** Pending installs expire after 15 minutes un-consented (§14 sweeper). */
export const PENDING_INSTALL_TTL_SEC = 15 * 60;

// Runtime-neutral SHA-256 (@noble/hashes) — NOT node:crypto. This module
// is re-exported through the @dina/core barrel, which mobile boots from;
// a `node:crypto` import breaks the Metro/Hermes bundle. Every other core
// hasher already uses this exact import (`Sha256Fn`-shaped: bytes→32 bytes).
let repoProofVerifier: RepoProofVerifier | null = null;

/** Wired at boot with the network CAR/MST adapter; tests inject fakes. */
/**
 * Read the wired verifier. Exported so the UPDATE path authenticates a
 * candidate release through the SAME verifier an install goes through — a
 * second one would be a second thing to wire and a second thing to forget.
 */
export function getRepoProofVerifier(): RepoProofVerifier | null {
  return repoProofVerifier;
}

export function setRepoProofVerifier(v: RepoProofVerifier | null): void {
  repoProofVerifier = v;
}

export type InstallFailure =
  | { ok: false; code: 'verifier_unavailable'; message: string; transient: boolean }
  | { ok: false; code: 'authenticity_failed'; message: string; transient: boolean }
  | { ok: false; code: 'integrity_failed'; message: string; transient: false }
  | { ok: false; code: 'validation_failed'; message: string; transient: false; errors: unknown }
  | { ok: false; code: 'needs_newer_dina'; message: string; transient: false; missing: string[] };

export interface InstallPendingResult {
  ok: true;
  installId: string;
  /** What the consent screen renders — locally computed, never claims. */
  consent: {
    publisherDid: string;
    pluginId: string;
    version: string;
    displayName: string;
    executionMode: 'interpreted' | 'runner';
    capabilities: PluginManifest['capabilities'];
    perCapabilityScopeHashes: Record<string, string>;
  };
}

export type BeginInstallResult = InstallPendingResult | InstallFailure;

/**
 * Install-by-AT-URI (§20 P0): fetch + authenticate the release via the
 * repo-proof verifier, run the pure gates, mint a `pending` install.
 * Nothing runs until consent + activation.
 */
export async function beginInstall(args: {
  publisherDid: string;
  /** Content-derived release rkey (§5). */
  rkey: string;
  label?: string;
  trustAnchor: PluginTrustAnchor;
  nowMs: number;
}): Promise<BeginInstallResult> {
  const installs = getPluginInstallRepository();
  if (installs === null) {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'plugin registry not wired',
      transient: true,
    };
  }

  // Debug-unsigned is DEBUG BUILDS ONLY (§12/§20) — production refuses
  // the anchor outright; the dev path enters via beginInstallVerified.
  if (args.trustAnchor.kind === 'debug_unsigned') {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'unsigned manifests cannot install in production (§20)',
      transient: false,
    };
  }

  // P0 supports exactly ONE authenticity path: the repo proof. `org_key`
  // and `local_publisher_key` (§12) are typed but their verification is
  // NOT implemented yet — running the repo-proof verifier against a
  // publisher DID and then storing an `org_key` anchor would MISLABEL
  // the authority. Fail closed until each anchor gets its own verifier.
  if (args.trustAnchor.kind !== 'repo_proof') {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: `trust anchor "${args.trustAnchor.kind}" is not supported in P0 — only repo_proof (§12)`,
      transient: false,
    };
  }

  if (repoProofVerifier === null) {
    // Fail-closed: no verifier, no install. Never TOFU (§5 rule 5).
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'repo-proof verifier not wired — install refused, never trust-on-first-use',
      transient: true,
    };
  }

  // PLG-30 #19: bound the caller inputs BEFORE invoking the verifier. The verifier
  // does network I/O, DID resolution, and CAR parsing — a malformed / oversized
  // publisher DID or rkey, or a structurally invalid trust anchor, should be
  // rejected cheaply here, not after a wasted resolver round-trip. finishBegin
  // re-checks publisher + cid as defense-in-depth for the beginInstallVerified
  // (attestation) path, which does not pass through this function.
  if (
    args.publisherDid === '' ||
    args.publisherDid.length > 256 ||
    !args.publisherDid.startsWith('did:') ||
    // PLG-32 #24: reject control / bidi / zero-width / BOM chars in the publisher
    // DID — the same `hasUnsafeText` gate the install LABEL and the manifest's
    // `issuer.did` already use. Without it a homoglyph/bidi publisher identity
    // reaches the consent card + persisted authority metadata (spoofing).
    hasUnsafeText(args.publisherDid) ||
    args.rkey === '' ||
    args.rkey.length > 256 ||
    !isValidTrustAnchor(args.trustAnchor)
  ) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'install authority (publisher DID / rkey / anchor) is missing or malformed (§12)',
      transient: false,
    };
  }

  // Round-6 #9: the injected verifier does network I/O, DID resolution, and CAR
  // parsing — any of which can REJECT (throw) rather than return a typed
  // `{ok:false}`. An uncaught rejection would escape the documented
  // BeginInstallResult contract and crash the caller. Wrap it: an unexpected
  // throw becomes a TRANSIENT failure (retry), never a silent success and never
  // an uncaught crash. Explicit typed `{ok:false}` outcomes still flow through.
  let proof: Awaited<ReturnType<RepoProofVerifier>>;
  try {
    proof = await repoProofVerifier({
      did: args.publisherDid,
      collection: 'com.dinakernel.plugin.release',
      rkey: args.rkey,
    });
  } catch {
    // PLG-30 #20: do NOT interpolate the raw thrown error into the caller-facing
    // `message`. A verifier throw propagates from the underlying network / DID-
    // resolution / CAR-parsing libraries and can carry URLs, response bodies,
    // credentials, or control characters. The machine-readable outcome is the
    // bounded `code`; the message stays a fixed public string. Raw diagnostics
    // belong in a server log, never in a result a consent UI may render.
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'repo-proof verification failed (transient)',
      transient: true,
    };
  }
  if (!proof.ok) {
    return {
      ok: false,
      code: 'authenticity_failed',
      // PLG-30 #20: the provider-supplied `proof.message` is likewise returned as
      // a fixed public reason — the `code` carries the outcome; the free text
      // does not leak verifier internals to the caller.
      message: 'release authenticity verification failed',
      transient: proof.transient,
    };
  }

  // Enforced immutability: rkey == f(cid) at EVERY verifier (§5).
  const integrity = checkReleaseIntegrity({ rkey: args.rkey, cid: proof.cid });
  if (integrity !== null) {
    return { ok: false, code: 'integrity_failed', message: integrity.message, transient: false };
  }

  // The verifier returns the record as `unknown`; a hostile or buggy
  // PDS could hand back a non-manifest shape. Guard BEFORE normalize —
  // otherwise `normalizePluginManifest` throws on `.capabilities.map`
  // and the failure is a crash, not a fail-closed rejection.
  if (!isManifestShaped(proof.record)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'fetched record is not a plugin manifest',
      transient: false,
      errors: [],
    };
  }

  return finishBegin(
    proof.record,
    proof.cid,
    args.publisherDid,
    args.trustAnchor,
    args.label ?? '',
    args.nowMs,
  );
}

/**
 * Cheap structural guard so a malformed fetched record fails CLOSED
 * (validation_failed) instead of throwing inside normalize. Full
 * validation still runs in `finishBegin`; this only keeps the pipeline
 * from crashing on a non-object / missing-capabilities value.
 */
function isManifestShaped(v: unknown): v is PluginManifest {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as { capabilities?: unknown; execution?: unknown };
  if (!Array.isArray(m.capabilities)) return false;
  // P2-6: normalize maps over each capability and reads its fields — a null or
  // non-object entry (`capabilities: [null]`) would throw a TypeError there
  // instead of failing closed. execution is likewise dereferenced. Reject any
  // malformed nested shape HERE so normalization only ever sees objects.
  if (m.capabilities.some((c) => c === null || typeof c !== 'object' || Array.isArray(c))) {
    return false;
  }
  if (m.execution === null || typeof m.execution !== 'object' || Array.isArray(m.execution)) {
    return false;
  }
  return true;
}

/**
 * The already-authenticated entry: callers that verified the release
 * out-of-band (the invite-bootstrap path with a pinned snapshot, or
 * `dina-plugin dev` in DEBUG builds with `debug_unsigned`). The pure
 * gates still run — authenticity is the only step skipped, and the
 * trust anchor records exactly which kind of authority vouched.
 */
/**
 * P2-5: proof-of-verification for `beginInstallVerified`. A boolean flag is
 * not provenance — any caller can set `true`. This branded object can only be
 * minted by `attestVerifiedRelease` (below), which is where a real authenticity
 * verifier hands back what it checked: the exact CID it vouches for, the rkey
 * (so the content-address invariant is re-provable), and WHICH verifier kind
 * produced it. `beginInstallVerified` reads authority from this token, never
 * from loose args, so a caller cannot label an arbitrary manifest `repo_proof`
 * without having actually run the repo-proof verifier that mints the token.
 *
 * The brand is a MODULE-PRIVATE symbol: it is not exported, so downstream code
 * cannot even name the key to fabricate a matching object literal (compile-time
 * gate), and it is tagged at runtime (belt) — the only blessed producer is the
 * constructor below.
 */
const VERIFIED_RELEASE_BRAND: unique symbol = Symbol('dina.plugin.verified_release');
export interface VerifiedReleaseAttestation {
  readonly [VERIFIED_RELEASE_BRAND]: true;
  readonly cid: string;
  readonly rkey?: string;
  /**
   * Round-10 #9: the publisher DID + EXACT trust anchor the verifier bound the
   * release to — carried IN the attestation (not passed as loose args), so a
   * proof for publisher A / anchor X cannot be replayed to install as publisher
   * B / anchor Y. `beginInstallVerified` reads authority from here.
   */
  readonly publisherDid: string;
  readonly trustAnchor: PluginTrustAnchor;
  /**
   * Round-9 #4 + round-10 #10: an IMMUTABLE snapshot — the canonical JSON of the
   * NORMALIZED manifest the verifier checked. A string, not an object reference,
   * so a post-attest mutation of the caller's manifest (normalize shares nested
   * schema/machine objects by reference) cannot drift what was "verified".
   * `beginInstallVerified` refuses unless the installed manifest canonicalizes
   * to exactly this — closing "verify release A, install manifest B".
   */
  readonly manifestCanonical: string;
}

/**
 * The SOLE constructor of a {@link VerifiedReleaseAttestation}. A real verifier
 * (repo-proof / org-key / signed-record) calls this AFTER it has checked the
 * release out of band; `debug_unsigned` is the only kind that may skip an
 * out-of-band check (debug builds). It asserts it verified `manifest` at `cid`
 * for `publisherDid` under `trustAnchor`. The manifest is snapshotted to an
 * immutable canonical string here (round-10 #10) so it cannot drift later.
 */
export function attestVerifiedRelease(args: {
  cid: string;
  rkey?: string;
  publisherDid: string;
  trustAnchor: PluginTrustAnchor;
  manifest: PluginManifest;
}): VerifiedReleaseAttestation {
  return {
    [VERIFIED_RELEASE_BRAND]: true,
    cid: args.cid,
    ...(args.rkey !== undefined ? { rkey: args.rkey } : {}),
    publisherDid: args.publisherDid,
    trustAnchor: args.trustAnchor,
    manifestCanonical: canonicalJson(normalizePluginManifest(args.manifest)),
  };
}

export function beginInstallVerified(args: {
  manifest: PluginManifest;
  /**
   * P2-5 + round-10 #9: verifier-minted proof (see {@link attestVerifiedRelease}).
   * CID, rkey, publisher DID, trust anchor AND the verified manifest snapshot are
   * all read from HERE — not from loose args — so the persisted install's
   * authority always traces to exactly what a verifier produced. A boolean can
   * be forged; this branded token cannot, and it now binds the party + anchor +
   * bytes, not just a CID.
   */
  attestation: VerifiedReleaseAttestation;
  /**
   * Debug builds ONLY (§20). Must be `true` for a `debug_unsigned`
   * anchor to be accepted — production callers never set it, so
   * `beginInstallVerified` cannot become a soft path around
   * `beginInstall`'s production-unsigned refusal. A build wires this
   * from its debug flag; it is never derived from request data.
   */
  allowUnsigned?: boolean;
  label?: string;
  nowMs: number;
}): BeginInstallResult {
  // Round-14 #1: the attestation is TYPED as verifier-minted, but a caller can
  // cast a hand-rolled object past the compiler — or reconstruct one across a
  // serialization boundary (the brand SYMBOL does not survive JSON). Verify the
  // brand at RUNTIME so ONLY attestVerifiedRelease's output (the sole holder of
  // the module-private symbol) can drive an install; anything else fails closed
  // rather than installing with an attacker-chosen cid / anchor / publisher.
  const rawAttestation = args.attestation as unknown;
  if (
    rawAttestation === null ||
    typeof rawAttestation !== 'object' ||
    (rawAttestation as Record<symbol, unknown>)[VERIFIED_RELEASE_BRAND] !== true
  ) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'install attestation is not a verifier-minted release token (§12)',
      transient: false,
    };
  }
  const { attestation } = args;
  const trustAnchor = attestation.trustAnchor;
  // Unsigned installs are debug-only, EVERYWHERE — this entry included.
  // Without this gate a caller could route an unsigned manifest around
  // beginInstall's §20 refusal via the "already-verified" door.
  if (trustAnchor.kind === 'debug_unsigned' && args.allowUnsigned !== true) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'unsigned manifests cannot install in production (§20)',
      transient: false,
    };
  }
  // rkey is optional on the invite-bootstrap path (the verifier may vouch for a
  // CID directly), but WHEN present the content address must still hold — an
  // overwritten release is rejected here too (§5).
  if (attestation.rkey !== undefined) {
    const integrity = checkReleaseIntegrity({ rkey: attestation.rkey, cid: attestation.cid });
    if (integrity !== null) {
      return { ok: false, code: 'integrity_failed', message: integrity.message, transient: false };
    }
  }
  // Round-9 #4 + round-10 #10: the manifest asked to install must canonicalize
  // to EXACTLY the immutable snapshot the verifier checked — else a caller could
  // verify release A and install manifest B. Compared over the NORMALIZED form.
  // A malformed supplied manifest (normalize throws, e.g. `new Set(7)`) fails
  // closed as validation_failed rather than crashing the install path.
  let suppliedCanonical: string;
  try {
    suppliedCanonical = canonicalJson(normalizePluginManifest(args.manifest));
  } catch {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'manifest is malformed',
      transient: false,
      errors: 'manifest is malformed',
    };
  }
  if (suppliedCanonical !== attestation.manifestCanonical) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'installed manifest does not match the verified release (§12)',
      transient: false,
    };
  }
  return finishBegin(
    args.manifest,
    attestation.cid,
    attestation.publisherDid,
    trustAnchor,
    args.label ?? '',
    args.nowMs,
  );
}

function finishBegin(
  rawManifest: PluginManifest,
  cid: string,
  publisherDid: string,
  trustAnchor: PluginTrustAnchor,
  label: string,
  nowMs: number,
): BeginInstallResult {
  const installs = getPluginInstallRepository();
  if (installs === null) {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'plugin registry not wired',
      transient: true,
    };
  }

  // Round-14 #5: validate the AUTHORITY inputs before persisting a pending
  // install. finishBegin is reached from beginInstall (values derived from a
  // fresh verify) AND beginInstallVerified (attestation-driven). A malformed
  // trust anchor, an empty publisher DID, or an empty CID must never reach
  // createPending — the claim guard and rowToInstall later trust these columns
  // as authority, and rowToInstall would quarantine an anchor that fails
  // isValidTrustAnchor anyway (so persisting it just yields a dead row). Fail
  // closed here instead.
  //
  // PLG-29 #15: `beginInstall` derives cid/publisher from a fresh verify (so
  // both are well-formed by the time we get here), but `beginInstallVerified`
  // reads them straight off the attestation — an unbounded / non-`did:` publisher
  // or a non-content-address cid would be persisted as authority and then rendered
  // + trusted by the claim guard. Bound the publisher DID the same way the
  // manifest validator bounds `issuer.did` (did:-prefixed, ≤256), and require the
  // cid to be a REAL CIDv1 (dag-cbor / sha2-256) — `releaseRkeyFromCid` returns
  // null for any other shape, so a garbage / malleable cid can't become the
  // stored content address.
  if (
    !isValidTrustAnchor(trustAnchor) ||
    publisherDid === '' ||
    publisherDid.length > 256 ||
    !publisherDid.startsWith('did:') ||
    // PLG-32 #24: the shared choke point BOTH beginInstall and
    // beginInstallVerified pass through — reject control/bidi/zero-width publisher
    // DIDs here too (beginInstallVerified takes the DID straight off the
    // attestation and persists it, so this is the real enforcement point).
    hasUnsafeText(publisherDid) ||
    cid === '' ||
    releaseRkeyFromCid(cid) === null
  ) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'install authority (anchor / publisher / cid) is missing or malformed (§12)',
      transient: false,
    };
  }

  // PLG-28 #16: `label` is a CALLER param (not manifest-derived), so it bypasses
  // the validator's bounds + spoof-char checks that every manifest consent string
  // gets — yet it is persisted to the registry and rendered on settings/consent
  // surfaces. Bound it + reject control/bidi/zero-width chars here, at the write
  // boundary, so a future install route can't store a huge / spoofing label.
  if (label.length > PLUGIN_CAPS.MAX_DISPLAY_NAME_LENGTH || hasUnsafeText(label)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: `install label must be ≤ ${PLUGIN_CAPS.MAX_DISPLAY_NAME_LENGTH} chars with no control/bidi/zero-width chars`,
      transient: false,
      errors: [{ code: 'bad_label', path: 'label' }],
    };
  }

  // Every gate a release must pass, run through the ONE function the update
  // path also calls. A second copy of this list is a second thing to keep in
  // step, and the copy that fell behind would be the one letting a manifest
  // this build cannot serve past the door.
  const vetted = vetReleaseManifest(rawManifest);
  if (!vetted.ok) return vetted;
  const { manifest, digests } = vetted;

  // PLG-30 #15: `createPending` is the one persistence I/O step in finishBegin,
  // and it was the only step outside the typed-result boundary — a disk-full /
  // closed-DB / unexpected-constraint throw here would escape the documented
  // `BeginInstallResult` contract (reject the Promise / throw synchronously) and
  // crash a future UI caller. Wrap it like the verifier + normalize steps do:
  // an unexpected persistence failure becomes a TRANSIENT typed failure.
  let installId: string;
  try {
    installId = installs.createPending({
      publisherDid,
      pluginId: manifest.plugin_id,
      label,
      executionMode: manifest.execution.mode,
      currentCid: cid,
      currentVersion: manifest.version,
      manifest,
      installScopeHash: digests.installScopeHash,
      capabilityHashes: { ...digests.perCapability },
      behaviorHash: digests.behaviorHash,
      presentationHash: digests.presentationHash,
      trustAnchor,
      pendingExpiresAtSec: Math.floor(nowMs / 1000) + PENDING_INSTALL_TTL_SEC,
      nowMs,
    });
  } catch {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'install could not be persisted',
      transient: true,
    };
  }

  return {
    ok: true,
    installId,
    consent: {
      publisherDid,
      pluginId: manifest.plugin_id,
      version: manifest.version,
      displayName: manifest.display_name,
      executionMode: manifest.execution.mode,
      capabilities: manifest.capabilities,
      perCapabilityScopeHashes: { ...digests.perCapability },
    },
  };
}

/**
 * PLG-28 #7 / PLG-29 #7: verifies the bound DID names a REAL, unrevoked,
 * role='plugin' device. The device registry lives ABOVE this package
 * (devices/registry → plugins/install_service already), so importing it here
 * would form a cycle — instead production WIRES this verifier at boot via
 * `setPluginDeviceVerifier` (mirroring `setRepoProofVerifier`). A runner install
 * canNOT activate unless a verifier is wired AND it approves the device — this is
 * an ENFORCEABLE boundary, not the PLG-28 optional-param convention.
 */
export type VerifyPluginDevice = (deviceDid: string) => boolean;

let pluginDeviceVerifier: VerifyPluginDevice | null = null;
export function setPluginDeviceVerifier(v: VerifyPluginDevice | null): void {
  pluginDeviceVerifier = v;
}

/**
 * Consent confirmed → activation, the single atomic commit point (§14).
 * Runner installs pass the paired instance device DID; interpreted
 * installs pass undefined (no pairing leg at all, §7).
 */
export function confirmConsent(
  installId: string,
  deviceDid: string | undefined,
  nowMs: number,
): boolean {
  const installs = getPluginInstallRepository();
  if (installs === null) return false;
  const install = installs.getById(installId);
  if (install === null) return false;
  if (install.executionMode === 'runner') {
    // P1-1: runner activation REQUIRES the instance device pre-bound to THIS
    // pending install during its pairing ceremony (`bindPendingDevice`), and
    // the consenting device must be exactly that one. Two failure modes this
    // closes: (a) an UNBOUND pending — pairing never completed, so there is no
    // instance to serve the lane; (b) a DIFFERENT device presenting its own
    // DID to hijack activation. Prior code only rejected (b) when a device was
    // already bound, and accepted (a) outright. Require a non-empty bound DID
    // that matches the consenting device.
    if (
      install.deviceDid === undefined ||
      install.deviceDid === '' ||
      deviceDid === undefined ||
      deviceDid === '' ||
      deviceDid !== install.deviceDid
    ) {
      return false;
    }
    // PLG-28 #7: the bound DID must also be a REAL, unrevoked, role='plugin'
    // device. `bindPendingDevice` accepts any nonempty DID and the match above
    // only compares strings, so a wiring error could bind an ordinary user/agent
    // device that `uninstall` would later revoke as plugin collateral. The
    // registry check is WIRED at boot (import would cycle). PLG-29 #7: FAIL
    // CLOSED — a runner install cannot activate unless a verifier is wired AND it
    // approves the device. An unwired verifier is a misconfigured boot, not a
    // license to skip the check.
    if (pluginDeviceVerifier === null || !pluginDeviceVerifier(deviceDid)) {
      return false;
    }
  } else if (deviceDid !== undefined) {
    // PLG-28 #9: interpreted installs pair NO device (§7). Reject a device DID on
    // a non-runner activation so uninstall never treats an arbitrary DID as
    // plugin-owned and revokes it as collateral. (Latent — interpreted is
    // P0-blocked at install today — but makes the "pass undefined" doc a hard
    // invariant.)
    return false;
  }
  // Expiry guard (§14): the abandoned sweeper removes stale pendings,
  // but between its ticks an EXPIRED pending still exists — activating
  // it would resurrect consent the owner walked away from. Refuse; the
  // sweeper will clean it up (and revoke any paired device).
  if (
    install.pendingExpiresAt !== undefined &&
    install.pendingExpiresAt <= Math.floor(nowMs / 1000)
  ) {
    return false;
  }
  const ok = installs.activate(installId, deviceDid, nowMs);
  if (ok) {
    // PLG-28 #2: the activation ALREADY committed — a failing audit write must
    // not turn this success into a caller-visible failure.
    recordDecisionSafe({
      installId,
      decision: 'consent_granted',
      nowSec: Math.floor(nowMs / 1000),
    });
  }
  return ok;
}

/**
 * Round-5 #6: the outcome of a lifecycle teardown (decline / uninstall). When a
 * `revokeDevice` callback is supplied, the operation OWNS the whole teardown in
 * the safe order — so `removed:false` means the paired-device revoke threw and
 * the install row was RETAINED as a retry anchor (the abandoned-install sweeper
 * will finish it), rather than deleting the only record that remembers the
 * device still needs revoking.
 */
export interface PluginTeardownResult {
  /** The install row was deleted (false only when a required device revoke
   *  failed and the row was kept as a retry anchor). */
  removed: boolean;
  /** The paired instance device DID, if any (the caller's cue to revoke when no
   *  callback was supplied). */
  deviceDid?: string;
  /** revokeDevice ran and succeeded — present only when a callback was given. */
  deviceRevoked?: boolean;
}

/**
 * Round-6 #1: the typed, ASYNC device-revoke callback the lifecycle ops accept.
 * `revokeDeviceByDidDurable` (devices/registry) satisfies it. It MUST return
 * confirmed `{ durable: true }` before an install row is deleted — the earlier
 * sync `(deviceDid) => void` shape silently dropped the real (async) revoke's
 * Promise and let the row be deleted before the device was durably revoked.
 */
export type RevokeDeviceByDid = (deviceDid: string) => Promise<{ durable: boolean }>;

/** Await the device revoke and report whether it durably succeeded. Never
 * throws — a rejection is treated as not-durable (retain the row). */
async function revokeDeviceConfirmed(
  revokeDevice: RevokeDeviceByDid,
  deviceDid: string,
): Promise<boolean> {
  try {
    return (await revokeDevice(deviceDid)).durable;
  } catch {
    return false;
  }
}

/**
 * Consent declined / ceremony cancelled: unwind the pending install and revoke
 * any device paired during the ceremony (§14: no orphan plugin devices). When
 * `revokeDevice` is supplied the operation owns the teardown in the SAFE order —
 * revoke the device FIRST and only delete the row once the revoke is CONFIRMED
 * durable; on failure the row is retained as a retry anchor (Round-5 #6 +
 * Round-6 #1). Without a callback it returns the device DID for the caller.
 */
export async function declineConsent(
  installId: string,
  nowMs: number,
  revokeDevice?: RevokeDeviceByDid,
): Promise<PluginTeardownResult | null> {
  const installs = getPluginInstallRepository();
  if (installs === null) return null;
  const install = installs.getById(installId);
  // Round-14 #6: `getById` returns null for BOTH a genuinely-missing row AND a
  // CORRUPT-but-present one (rowToInstall quarantines → null). A corrupt pending
  // row would otherwise be un-declinable — stuck forever with a possibly-bound
  // device. Fall back to the RAW scalars: only proceed when a raw row exists,
  // preserving the pending-only guard against the raw status.
  const rawStatusAtEntry = install === null ? installs.rawStatus(installId) : null;
  if (install === null && rawStatusAtEntry === null) return null;
  // Round-9 #15: decline is a PENDING-only transition. A stale/racing decline
  // against an install that has since ACTIVATED must not revoke its device and
  // delete a live plugin — mirror `activate`'s pending-only CAS and refuse.
  const statusAtEntry = install !== null ? install.status : rawStatusAtEntry;
  if (statusAtEntry !== 'pending') return null;
  const deviceDid =
    install !== null ? install.deviceDid : (installs.rawDeviceDid(installId) ?? undefined);
  if (deviceDid !== undefined) {
    // Round-7 #5: a bound device makes the durable revoker MANDATORY. Without a
    // callback we would delete the row and merely hand the DID back, leaving
    // device cleanup to non-transactional caller discipline (an orphan on any
    // crash). Retain the row as the retry anchor instead of silently orphaning.
    if (revokeDevice === undefined) {
      return { removed: false, deviceDid };
    }
    const durable = await revokeDeviceConfirmed(revokeDevice, deviceDid);
    if (!durable) {
      // Keep the pending row as a retry anchor; the sweeper (or a retry) will
      // re-attempt the revoke. Deleting it now would orphan the device.
      return { removed: false, deviceDid, deviceRevoked: false };
    }
  }
  // Round-10 #3 + Round-12 #12: re-check via RAW status AFTER the await. Two
  // things can happen during the `revokeDeviceConfirmed` yield, and a projecting
  // getById cannot tell them apart (it returns null for both a removed row and a
  // corrupt one):
  //   - the durable revoke's cascade ALREADY removed this pending row
  //     (`disablePluginAuthorityForDevice` removes pending installs) → status is
  //     null → teardown SUCCEEDED; record the decline + report removed, rather
  //     than misreporting it as a retained retry anchor.
  //   - a racing `confirmConsent` activated it → status is not 'pending' → refuse
  //     (deleting a now-live install would destroy authority; Round-9 #15 only
  //     checked pending at ENTRY).
  //   - still 'pending' → remove it ourselves (raw-keyed, status-agnostic remove).
  const status = installs.rawStatus(installId);
  if (status !== null && status !== 'pending') {
    return { removed: false, ...(deviceDid !== undefined ? { deviceDid } : {}) };
  }
  // PLG-29 #10: between the probe above and this delete a concurrent
  // confirmConsent could activate the pending row. `removeIfStatus` re-checks
  // inside the delete transaction and only removes while it is STILL pending, so
  // a decline can never destroy a freshly-activated install.
  // PLG-30 #2: HONOR that boolean. If the CAS refused (the row raced to active
  // between the probe and here), the plugin is LIVE — report not-removed and do
  // NOT append a false `consent_declined`. `status === null` means the durable
  // revoke cascade already removed it → a genuine decline (fall through).
  if (status === 'pending' && !installs.removeIfStatus(installId, ['pending'])) {
    return { removed: false, ...(deviceDid !== undefined ? { deviceDid } : {}) };
  }
  recordDecisionSafe({
    installId,
    decision: 'consent_declined',
    nowSec: Math.floor(nowMs / 1000),
  });
  return {
    removed: true,
    ...(deviceDid !== undefined ? { deviceDid } : {}),
    ...(revokeDevice !== undefined && deviceDid !== undefined ? { deviceRevoked: true } : {}),
  };
}

/**
 * P1-4: terminate in-flight work on an install's lane when it is revoked or
 * uninstalled. Each non-terminal task is `cancel()`ed — a running declared-
 * effectful task parks as `outcome_unknown` (the effect may already have
 * happened), queued ones cancel — so a runner completion can never apply
 * through the revoke/uninstall seam. Returns the terminated task ids. No-op
 * when the workflow service isn't wired. */
export function terminateInstallInFlight(
  installId: string,
  reason: string,
  nowMs: number,
): string[] {
  // §9.13: teardown also drops every drain authorization — a revoked
  // install must not keep admitting prior-CID work through stale entries.
  getDrainAuthorizationRepository()?.removeByInstall(installId);
  const service = getWorkflowService();
  if (service === null) return [];
  const lane = pluginLane(installId);
  const terminated: string[] = [];
  for (const task of service.store().listNonTerminalByRunner(lane)) {
    // Round-14 #19: `cancel()` returns 0 when the task was ALREADY terminal —
    // it raced a completion/lease-sweep between the list and this call and no
    // transition happened. Only report ids we actually terminalized; otherwise
    // the caller's audit/decision record overstates what this teardown stopped.
    if (service.store().cancel(task.id, reason, nowMs) > 0) {
      terminated.push(task.id);
    }
  }
  return terminated;
}

/**
 * Uninstall: one tap, immediate, no publisher cooperation (§14). Registry
 * removal cascades grants + uses. When `revokeDevice` is supplied the operation
 * owns the whole teardown in the SAFE order (Round-5 #6): terminate in-flight →
 * revoke grants → revoke the paired device → only THEN delete the row. A device
 * revoke that throws retains the row (grants already gone, so no authority
 * survives) so a retry/sweep can finish it. Without a callback it returns the
 * device DID for the caller to revoke.
 */
/**
 * §16.4 — refuses a teardown that would strand open commercial obligations.
 * A typed error rather than a boolean: an uninstall the owner asked for and
 * did not get must say why, and the count is what makes the message
 * actionable ("3 orders still open") rather than a wall.
 */
export class PluginCommerceObligationError extends Error {
  constructor(readonly openObligations: number) {
    super(
      `plugin uninstall refused: ${openObligations} commerce order(s) are still open. ` +
        'Resolve them (deliver, cancel, or reconcile) before removing the plugin that answers for them (§16.4).',
    );
    this.name = 'PluginCommerceObligationError';
  }
}

export async function uninstall(
  installId: string,
  nowMs: number,
  revokeDevice?: RevokeDeviceByDid,
): Promise<PluginTeardownResult | null> {
  const installs = getPluginInstallRepository();
  if (installs === null) return null;
  const install = installs.getById(installId);
  // Round-14 #6: `getById` returns null for a genuinely-missing row AND a
  // CORRUPT-but-present one. A corrupt install with a bound device must still be
  // uninstallable — fall back to raw scalars so the device is revoked and the
  // row removed rather than leaving a stuck, un-torn-down install.
  const rawStatusAtEntry = install === null ? installs.rawStatus(installId) : null;
  if (install === null && rawStatusAtEntry === null) return null;
  // §16.4 — business records survive an uninstall, but SURVIVING IN STORAGE
  // is not the promise. Every commerce lifecycle capability (`order_status`,
  // `cancel_order`, `order_reconcile`) reaches its answer through this
  // install's binding, so tearing it down while obligations are open leaves
  // the buyer permanently unable to learn the outcome of an order this
  // supplier committed to. The records would be intact and unreachable.
  //
  // So the uninstall is REFUSED while anything is open. The operator resolves
  // those orders first — deliver, cancel, or reconcile them — which is the
  // accountability the rule exists to protect.
  //
  // SCOPED TO THIS INSTALL (WS-4.5). The order reference records which
  // install served it, so a node running two commerce plugins can remove one
  // while the other has work open. It was node-wide until that column
  // existed — safe, but it made an operator resolve somebody else's orders to
  // remove this pack.
  //
  // Orders admitted before the column existed carry '' and therefore belong
  // to no install, so they no longer block any uninstall. That is the right
  // trade for a pre-release schema: the alternative is every legacy row
  // blocking every teardown for ever, which is a refusal nobody can clear.
  const commerce = getCommerceRuntime();
  if (commerce !== null) {
    const open = commerce.inFlightCount(installId);
    if (open > 0) {
      throw new PluginCommerceObligationError(open);
    }
  }

  const nowSec = Math.floor(nowMs / 1000);
  const deviceDid =
    install !== null ? install.deviceDid : (installs.rawDeviceDid(installId) ?? undefined);
  // PLG-27 #9 + PLG-28 #8: close the claim lane BEFORE enumerating in-flight work
  // + revoking grants, for EVERY install (not only device-bound ones). Under a
  // single synchronous Core there is no await between these synchronous calls, so
  // the ordering is a strict no-op today; under multiple Core workers a NEW task
  // could be claimed against a still-`active`/`pending` install in the window
  // between terminate and the lane-close. PLG-28 #8: an INTERPRETED install has
  // no device, so gating the lane-close on `deviceDid` skipped it entirely — hoist
  // it. Lane-close covers all three reachable states:
  //   - Round-14/15 #4: an ACTIVE row → paused. Grants are revoked below, but a
  //     CARD-backed task (authorization_kind 'card') rides INSTALL-level
  //     authority (claim-guard checks 5/6), not a grant — while the row stays
  //     `active` a new card task can still be claimed.
  //   - Round-16 #4: a MANUALLY-paused row → escalate the hold (pause() no-ops on
  //     a paused row) so resume() refuses it instead of permitting a 'manual'
  //     resume that reactivates the card-level authority.
  //   - PLG-27 #4: a PENDING row → tombstone to `revoked` (pause + escalate both
  //     skip pending). Otherwise, on either failure exit below (no callback /
  //     non-durable revoke) the row stays `pending` and confirmConsent→activate's
  //     `status='pending'` CAS can still bring it live AFTER the owner uninstalled
  //     it. markRevoked is scoped to pending, so it never clobbers the paused row.
  // The raw-status probe + remove() below are status-agnostic, so they still fire
  // correctly on the now paused/revoked row (a no-device install removes inline).
  if (!installs.pause(installId, nowMs, 'device_revoked')) {
    installs.escalatePauseReason(installId, 'device_revoked', nowMs);
  }
  installs.markRevoked(installId, nowMs);
  // P1-4: terminate in-flight — a running task must not complete during the
  // uninstall seam. Effectful → outcome_unknown, queued → cancelled.
  terminateInstallInFlight(installId, 'plugin uninstalled', nowMs);
  // Belt: revoke grants BEFORE the row disappears, so any concurrent
  // authorizeAndConsume in flight sees revoked, not no-row.
  getPluginGrantRepository()?.revokeAllForInstall(installId, nowSec);
  // Round-5 #6 + Round-6 #1: revoke the device and only delete once the revoke is
  // CONFIRMED durable; retain the (now paused/revoked) row on failure. Authority
  // (grants + lane) is already gone above, so a retained row carries no live
  // access — it is purely the retry anchor for the outstanding device revoke.
  if (deviceDid !== undefined) {
    // Round-7 #5: a bound device makes the durable revoker MANDATORY — without
    // it we would delete the row and leave device cleanup to caller discipline.
    if (revokeDevice === undefined) {
      return { removed: false, deviceDid };
    }
    const durable = await revokeDeviceConfirmed(revokeDevice, deviceDid);
    if (!durable) {
      return { removed: false, deviceDid, deviceRevoked: false };
    }
  }
  // Round-13 #12: a PENDING install bound to the revoked device is cascade-
  // removed by the durable revoke (disablePluginAuthorityForDevice removes
  // pending rows). A plain `remove()` then returns null and uninstall would
  // misreport failure. Use a raw-status probe (the same three-way declineConsent
  // uses, PLG-22 #12): row GONE = cascade already removed it (SUCCESS), row
  // present = remove it now. (Active/paused installs are PAUSED by the cascade,
  // not removed, so this only affects the pending-with-device case.)
  // PLG-31 #18: `remove()` returns the PROJECTED row, which is null for a corrupt-
  // but-present install even AFTER it successfully raw-deletes it — so gating the
  // failure branch on `remove() === null` misreported a corrupt install's
  // successful teardown as failure AND skipped the `uninstalled` decision record.
  // Determine success from RAW existence after the delete, not the projection.
  const rawAfter = installs.rawStatus(installId);
  if (rawAfter !== null) {
    installs.remove(installId);
    if (installs.rawStatus(installId) !== null) return null; // genuinely not deleted
  }
  recordDecisionSafe({
    installId,
    decision: 'uninstalled',
    nowSec,
  });
  return {
    removed: true,
    ...(deviceDid !== undefined ? { deviceDid } : {}),
    ...(revokeDevice !== undefined && deviceDid !== undefined ? { deviceRevoked: true } : {}),
  };
}

/**
 * Abandoned-install sweep (§14): expire stale pendings AND revoke their
 * devices — the dangerous case is a pairing that completed but whose
 * consent was never confirmed; the sweeper must revoke that device, not
 * just delete the pending row.
 */
export async function sweepAbandonedInstalls(
  nowSec: number,
  revokeDevice: RevokeDeviceByDid,
): Promise<PluginInstallRef[]> {
  const installs = getPluginInstallRepository();
  if (installs === null) return [];
  const swept: PluginInstallRef[] = [];
  // P2-11 + Round-6 #1: revoke the paired device FIRST and delete the pending
  // row ONLY once the revoke is confirmed durable. A revoke that fails (or its
  // async Promise not resolving durable) leaves the row as a retry anchor for
  // the next sweep, rather than orphaning the device with nothing left to clean
  // up.
  //
  // Round-12 #11: enumerate RAW (`listRawStalePending`) — the projecting
  // `listStalePending` quarantines a corrupt row to null, so a corrupt
  // abandoned pending would never be swept and its device would leak.
  for (const ref of installs.listRawStalePending(nowSec)) {
    if (ref.deviceDid !== undefined) {
      const durable = await revokeDeviceConfirmed(revokeDevice, ref.deviceDid);
      if (!durable) {
        continue; // keep the pending row; the next sweep retries the revoke
      }
    }
    // Round-11 #3 + Round-12 #12: re-check via RAW status after the revoke await.
    // A projecting getById cannot tell "removed" from "corrupt-still-present":
    //   - null       → the revoke cascade ALREADY removed this pending row →
    //                  teardown SUCCEEDED; count it swept (don't misreport it as
    //                  skipped, #12).
    //   - not pending → a racing `confirmConsent` activated it during the yield →
    //                  leave it (deleting a now-ACTIVE install destroys authority).
    //   - 'pending'  → still ours: remove it (remove() is raw-keyed, so a corrupt
    //                  row is deletable too, #11 / Round-11 #10).
    const status = installs.rawStatus(ref.installId);
    // PLG-28 #3: a 'revoked' tombstone (a failed-uninstall row we just re-revoked
    // above) is also ours to finish — remove it now that the device is durably
    // gone. 'pending' = abandoned consent (as before). null = the cascade already
    // removed it. active/paused = a racing confirmConsent/resume → leave it.
    if (status === null) {
      swept.push(ref);
      continue;
    }
    // PLG-29 #10: the probe above and the delete are not atomic — a racing
    // confirmConsent/resume on another Core worker could activate/resume the row
    // in between. `removeIfStatus` re-checks the status INSIDE the delete
    // transaction and only deletes while it is still pending/revoked, so the
    // sweep can never destroy an install that just went live. A no-op (false)
    // means it raced live → leave it, don't report it swept.
    if (installs.removeIfStatus(ref.installId, ['pending', 'revoked'])) {
      swept.push(ref);
    }
  }
  return swept;
}

/**
 * The PURE gates every release passes, install or update (§5, §8.1, §14).
 *
 * EXTRACTED so the update path runs exactly these and not a copy. The list is
 * long and each entry is load-bearing — normalize before anything, because the
 * normalized form is the stored form; validate with the ingest-identical gate;
 * refuse an execution mode no runtime here can serve; refuse features and a
 * protocol this build does not speak. An update that skipped any one of them
 * would swap an install onto a manifest that could never have been installed.
 *
 * No I/O and no persistence: it takes bytes and returns either the normalized
 * manifest with its digests, or the same typed failure an install would give.
 */
export function vetReleaseManifest(
  rawManifest: PluginManifest,
):
  | { ok: true; manifest: PluginManifest; digests: ReturnType<typeof computePluginDigests> }
  | InstallFailure {
  // P2-6: totality guard — normalize dereferences every capability/execution
  // field and would throw on a malformed shape (`capabilities: [null]`).
  // beginInstall checks this before calling us, but beginInstallVerified does
  // not, so guard here too: fail CLOSED, never crash.
  if (!isManifestShaped(rawManifest)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'record is not structurally a plugin manifest',
      transient: false,
      errors: [],
    };
  }
  // Normalize FIRST — the normalized form is the stored form (§8.1):
  // what validates, what hashes, what runs.
  //
  // Round-5 #2: normalization iterates nested set-like fields
  // (`data_scope.categories`, `kinds`, …). `isManifestShaped` only proves the
  // OUTER capability/execution objects — a remote manifest with
  // `data_scope.categories: 7` reaches `new Set(7)` and THROWS. That is a
  // malformed input, not a Dina bug: catch it and fail CLOSED as a validation
  // error, never crash the install path.
  let manifest: PluginManifest;
  try {
    manifest = normalizePluginManifest(rawManifest);
  } catch (err) {
    return {
      ok: false,
      code: 'validation_failed',
      message: `manifest could not be normalized (malformed nested field): ${
        err instanceof Error ? err.message : String(err)
      }`,
      transient: false,
      errors: [],
    };
  }
  const validation = validatePluginManifest(manifest);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'manifest failed the ingest-identical validation gate (§5 rule 3)',
      transient: false,
      errors: validation.errors,
    };
  }

  // P2-9: P0 ships ONLY the runner tool lane — there is no interpreter.
  // The feature gate catches session capabilities (they derive `session`),
  // but an interpreted-mode capability that derives nothing would otherwise
  // activate a lane no runtime can serve. Reject the mode explicitly.
  if (manifest.execution.mode !== 'runner') {
    return {
      ok: false,
      code: 'needs_newer_dina',
      message: `interpreted-mode plugins need an interpreter this Dina hasn't shipped (P0 is runner-only)`,
      transient: false,
      missing: [`execution_mode:${manifest.execution.mode}`],
    };
  }

  // §14 compatibility gate: derived (∪ declared) ⊆ supported — fail
  // closed on anything this node doesn't recognize.
  //
  // `host_op.*` is resolved against the LIVE registry rather than the
  // constant set, because what a node can do for a plugin is what its boot
  // registered, not what its build shipped. Two nodes on the same Dina
  // version can differ here — one has a stock adapter installed, the other
  // does not — and the constant would have to lie about one of them.
  const operationFeatures = registeredOperationFeatures();
  const missing = validation.derivedFeatures.filter((f) =>
    f.startsWith(HOST_OP_FEATURE_PREFIX)
      ? !hostOperationAvailable(f.slice(HOST_OP_FEATURE_PREFIX.length))
      : !NODE_SUPPORTED_FEATURES.has(f) && !operationFeatures.has(f),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'needs_newer_dina',
      message: `this plugin needs features this Dina hasn't shipped: ${missing.join(', ')}`,
      transient: false,
      missing,
    };
  }
  const minProtocol = manifest.min_plugin_protocol ?? 1;
  if (minProtocol > 1) {
    return {
      ok: false,
      code: 'needs_newer_dina',
      message: `this plugin needs plugin protocol ${minProtocol}; this Dina speaks 1`,
      transient: false,
      missing: [`min_plugin_protocol:${minProtocol}`],
    };
  }

  const digests = computePluginDigests(manifest, sha256);
  return { ok: true, manifest, digests };
}
