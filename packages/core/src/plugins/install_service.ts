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
  checkReleaseIntegrity,
  computePluginDigests,
  normalizePluginManifest,
  pluginLane,
  validatePluginManifest,
  type PluginManifest,
  type PluginTrustAnchor,
  type RepoProofVerifier,
} from '@dina/protocol';

import { getWorkflowService } from '../workflow/service';

import { getPluginDecisionRepository } from './decisions';
import { getPluginGrantRepository } from './grants';
import { getPluginInstallRepository, type PluginInstall } from './registry';

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
  'idempotent_retry',
]);

/** Pending installs expire after 15 minutes un-consented (§14 sweeper). */
export const PENDING_INSTALL_TTL_SEC = 15 * 60;

// Runtime-neutral SHA-256 (@noble/hashes) — NOT node:crypto. This module
// is re-exported through the @dina/core barrel, which mobile boots from;
// a `node:crypto` import breaks the Metro/Hermes bundle. Every other core
// hasher already uses this exact import (`Sha256Fn`-shaped: bytes→32 bytes).
let repoProofVerifier: RepoProofVerifier | null = null;

/** Wired at boot with the network CAR/MST adapter; tests inject fakes. */
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
  } catch (err) {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: `repo-proof verifier threw (transient): ${
        err instanceof Error ? err.message : String(err)
      }`,
      transient: true,
    };
  }
  if (!proof.ok) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: proof.message,
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
  readonly verifierKind: PluginTrustAnchor['kind'];
}

/**
 * The SOLE constructor of a {@link VerifiedReleaseAttestation}. A real verifier
 * (repo-proof / org-key / signed-record) calls this AFTER it has checked the
 * release out of band; `debug_unsigned` is the only kind that may skip an
 * out-of-band check (debug builds). Whatever produces this token is asserting
 * it verified `cid` under `verifierKind`.
 */
export function attestVerifiedRelease(args: {
  cid: string;
  rkey?: string;
  verifierKind: PluginTrustAnchor['kind'];
}): VerifiedReleaseAttestation {
  return {
    [VERIFIED_RELEASE_BRAND]: true,
    cid: args.cid,
    ...(args.rkey !== undefined ? { rkey: args.rkey } : {}),
    verifierKind: args.verifierKind,
  };
}

export function beginInstallVerified(args: {
  manifest: PluginManifest;
  /**
   * P2-5: verifier-minted proof (see {@link attestVerifiedRelease}). The CID
   * and rkey are read from HERE — not from loose args — so the persisted
   * manifest's authority always traces to something a verifier actually
   * produced. A boolean can be forged; this branded token cannot.
   */
  attestation: VerifiedReleaseAttestation;
  publisherDid: string;
  trustAnchor: PluginTrustAnchor;
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
  const { attestation, trustAnchor } = args;
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
  // P2-5: the token's verifier kind must match the anchor being recorded — a
  // repo_proof attestation cannot be used to persist an org_key/debug anchor.
  // This binds the provenance token to the trust label it authorizes.
  if (attestation.verifierKind !== trustAnchor.kind) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'attestation verifier kind does not match the trust anchor (§12)',
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
  return finishBegin(
    args.manifest,
    attestation.cid,
    args.publisherDid,
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
  const missing = validation.derivedFeatures.filter((f) => !NODE_SUPPORTED_FEATURES.has(f));
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
  const installId = installs.createPending({
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
    getPluginDecisionRepository()?.record({
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
  if (install === null) return null;
  const deviceDid = install.deviceDid;
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
  const removed = installs.remove(installId);
  if (removed === null) return null;
  getPluginDecisionRepository()?.record({
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
  const service = getWorkflowService();
  if (service === null) return [];
  const lane = pluginLane(installId);
  const terminated: string[] = [];
  for (const task of service.store().listNonTerminalByRunner(lane)) {
    service.store().cancel(task.id, reason, nowMs);
    terminated.push(task.id);
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
export async function uninstall(
  installId: string,
  nowMs: number,
  revokeDevice?: RevokeDeviceByDid,
): Promise<PluginTeardownResult | null> {
  const installs = getPluginInstallRepository();
  if (installs === null) return null;
  const install = installs.getById(installId);
  if (install === null) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const deviceDid = install.deviceDid;
  // P1-4: terminate in-flight FIRST — a running task must not complete during
  // the uninstall seam. Effectful → outcome_unknown, queued → cancelled.
  terminateInstallInFlight(installId, 'plugin uninstalled', nowMs);
  // Belt: revoke grants BEFORE the row disappears, so any concurrent
  // authorizeAndConsume in flight sees revoked, not no-row.
  getPluginGrantRepository()?.revokeAllForInstall(installId, nowSec);
  // Round-5 #6 + Round-6 #1: revoke the device FIRST and only delete once the
  // revoke is CONFIRMED durable; retain the row on failure. Authority (grants)
  // is already gone above, so a retained row carries no live access — it is
  // purely the retry anchor for the outstanding device revoke.
  if (deviceDid !== undefined) {
    // Round-7 #5: a bound device makes the durable revoker MANDATORY — without
    // it we would delete the row and leave device cleanup to caller discipline.
    // Retain the row (authority already revoked above) as the retry anchor.
    if (revokeDevice === undefined) {
      return { removed: false, deviceDid };
    }
    const durable = await revokeDeviceConfirmed(revokeDevice, deviceDid);
    if (!durable) {
      return { removed: false, deviceDid, deviceRevoked: false };
    }
  }
  const removed = installs.remove(installId);
  if (removed === null) return null;
  getPluginDecisionRepository()?.record({
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
): Promise<PluginInstall[]> {
  const installs = getPluginInstallRepository();
  if (installs === null) return [];
  const swept: PluginInstall[] = [];
  // P2-11 + Round-6 #1: revoke the paired device FIRST and delete the pending
  // row ONLY once the revoke is confirmed durable. A revoke that fails (or its
  // async Promise not resolving durable) leaves the row as a retry anchor for
  // the next sweep, rather than orphaning the device with nothing left to clean
  // up.
  for (const install of installs.listStalePending(nowSec)) {
    if (install.deviceDid !== undefined) {
      const durable = await revokeDeviceConfirmed(revokeDevice, install.deviceDid);
      if (!durable) {
        continue; // keep the pending row; the next sweep retries the revoke
      }
    }
    installs.remove(install.installId);
    swept.push(install);
  }
  return swept;
}
