/**
 * The owner-facing plugin UPDATE flow (§9.13, §16.5 — WS-3.7).
 *
 * `UpdateRebindCoordinator` has been correct and unreachable: it moves an
 * install to a new manifest CID, creates prior-contract authorizations and
 * rebinds listings, all in one transaction — and nothing called it. Its ledger
 * entry named the reason exactly: "the owner-facing update discovery + consent
 * flow is still unbuilt and is the real owner of the boot wiring." This is that
 * flow.
 *
 * TWO STEPS, LIKE INSTALL, AND FOR THE SAME REASON. `prepareUpdate` fetches,
 * authenticates and vets a candidate release and returns what the owner must
 * see; `confirmUpdate` applies the one they saw. Collapsing them would mean
 * the act of LOOKING at an update applied it, which is precisely the "silently
 * widen" §16.5 forbids.
 *
 * THE PUBLISHER COMES FROM THE INSTALL, NEVER FROM THE CALLER. An update is a
 * new release from the same publisher; accepting a caller-named publisher would
 * let anyone re-point an install at their own pack and inherit the consent the
 * owner gave to somebody else's. That is the single most important line here,
 * and it is one line.
 *
 * WHAT IS NOT BUILT: automatic discovery. A release rkey is content-derived
 * (§5), so the next version's key cannot be computed — finding it needs a repo
 * LISTING, which Core has no transport for. The owner (or an app that lists on
 * their behalf) supplies the rkey. Adding a lister later changes nothing here:
 * it would feed this same `prepareUpdate`.
 */

import { checkReleaseIntegrity } from '@dina/protocol';

import { getRepoProofVerifier, vetReleaseManifest, type InstallFailure } from './install_service';
import { getPluginInstallRepository } from './registry';
import { detectUpdateWidening, type WideningFinding } from './update_widening';

import type { UpdateRebindCoordinator, RebindOutcome } from './update_rebind';
import type { PluginManifest, PluginTrustAnchor } from '@dina/protocol';

export type UpdateRefusal =
  /** No such install, or it is not this node's to update. */
  | 'install_unknown'
  /** Paused or pending. Resume or finish consent first; do not update sideways. */
  | 'install_not_active'
  /** The release is a different pack, not a new version of this one. */
  | 'different_plugin'
  /** The release this install already runs. */
  | 'cid_unchanged'
  /** Nothing was prepared, or what was prepared has expired. */
  | 'nothing_prepared'
  /** The confirm names a release the owner was not shown. */
  | 'candidate_mismatch'
  /**
   * §16.5 / §20.12 — the release changes WHAT THE PLUGIN DOES, and the
   * confirm did not echo back the behavior hash that was reviewed.
   *
   * Separate from `requires_reconsent`, which is about SCOPE. An update can
   * keep every declared boundary and still replace the executable behind it;
   * "immutable release CID, verified publisher identity, behavior and scope
   * hashes" lists them side by side because they are different questions.
   */
  | 'behavior_change_unreviewed'
  /** The install moved between prepare and confirm. */
  | 'install_moved'
  | 'coordinator_unavailable';

export interface UpdateReview {
  installId: string;
  publisherDid: string;
  pluginId: string;
  fromVersion: string;
  toVersion: string;
  fromCid: string;
  toCid: string;
  displayName: string;
  capabilities: PluginManifest['capabilities'];
  perCapabilityScopeHashes: Record<string, string>;
  /**
   * Every §16.5 widening, never the first. A card naming one escalation while
   * three rode along would be worse than none.
   */
  widening: WideningFinding[];
  /** True when the owner must accept the widenings before this can apply. */
  requiresReconsent: boolean;
  /**
   * §16.5 — the BEHAVIOR HASH, before and after.
   *
   * "Manifest CID, behavior hash, schemas, network domains, issuer, execution
   * mode, or data scope changes follow the generic plugin update and
   * re-consent rules", and §20.12 lists "behavior and scope hashes" among the
   * controls against a malicious update. The review carried the scope hashes
   * and not this one, so material executable behavior could change under an
   * existing install with nothing to compare and nothing to show.
   *
   * Reported as a PAIR rather than a boolean: an owner asked to approve a
   * behavior change is entitled to see what they are approving, and an audit
   * entry that records only "it changed" cannot be checked afterwards.
   */
  fromBehaviorHash: string;
  toBehaviorHash: string;
  /** Convenience for the card; always `fromBehaviorHash !== toBehaviorHash`. */
  behaviorChanged: boolean;
}

export type PrepareUpdateResult =
  | { ok: true; review: UpdateReview }
  | InstallFailure
  | { ok: false; code: UpdateRefusal; message: string; transient: false };

export type ConfirmUpdateResult =
  | { ok: true; outcome: RebindOutcome }
  | { ok: false; code: UpdateRefusal; message: string; transient: false };

/**
 * How long a prepared candidate stays confirmable.
 *
 * Bounded because a review is a snapshot of a publisher's repo at one moment,
 * and applying a week-old one would swap the install onto a release the owner
 * looked at before the publisher pulled it.
 */
export const PREPARED_UPDATE_TTL_MS = 15 * 60 * 1000;

interface PreparedUpdate {
  installId: string;
  fromCid: string;
  cid: string;
  version: string;
  manifest: PluginManifest;
  installScopeHash: string;
  capabilityHashes: Record<string, string>;
  behaviorHash: string;
  presentationHash: string;
  widening: WideningFinding[];
  expiresAtMs: number;
}

/**
 * IN MEMORY, DELIBERATELY, and the tradeoff is worth stating.
 *
 * A durable row would survive a restart between the review and the tap. What it
 * would BUY is not applying a stale candidate — it would save the owner a
 * second prepare. What it would COST is a table holding a fetched third-party
 * manifest as consent-shaped state, which is exactly the kind of row that
 * outlives the reason it was written.
 *
 * Losing it costs a re-prepare, which re-fetches and re-verifies. That is the
 * safe direction: the failure mode of forgetting is "ask again", never "apply
 * something the owner did not see".
 */
const prepared = new Map<string, PreparedUpdate>();

/** Test/teardown hook. Production never calls it outside identity teardown. */
export function clearPreparedUpdates(): void {
  prepared.clear();
}

let coordinator: UpdateRebindCoordinator | null = null;

/**
 * Install the coordinator at boot, beside the plugin registry.
 *
 * A registry rather than a parameter, for the reason the WBS row already
 * recorded: the update flow is the coordinator's only caller, and the
 * composition root is the only place that knows how to build one.
 */
export function setUpdateRebindCoordinator(value: UpdateRebindCoordinator | null): void {
  coordinator = value;
}

export function getUpdateRebindCoordinator(): UpdateRebindCoordinator | null {
  return coordinator;
}

/**
 * Fetch, authenticate and vet a candidate release; return what the owner sees.
 *
 * NOTHING IS APPLIED. On success the candidate is remembered so `confirmUpdate`
 * applies exactly these bytes — a confirm that re-fetched could get a different
 * release under the same rkey only if the content address were broken, but it
 * could certainly get a different ANSWER from a flaky repo, and "apply whatever
 * arrives second" is not a thing to build.
 */
export async function prepareUpdate(args: {
  installId: string;
  /** Content-derived release rkey of the candidate (§5). */
  rkey: string;
  trustAnchor: PluginTrustAnchor;
  nowMs: number;
}): Promise<PrepareUpdateResult> {
  const installs = getPluginInstallRepository();
  if (installs === null) {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'plugin registry not wired',
      transient: true,
    };
  }
  const install = installs.getById(args.installId);
  if (install === null) {
    return { ok: false, code: 'install_unknown', message: 'no such install', transient: false };
  }
  if (install.status !== 'active') {
    return {
      ok: false,
      code: 'install_not_active',
      message: `an install in status "${install.status}" cannot be updated`,
      transient: false,
    };
  }

  const verifier = getRepoProofVerifier();
  if (verifier === null) {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'repo-proof verifier not wired — update refused, never trust-on-first-use',
      transient: true,
    };
  }
  if (args.trustAnchor.kind !== 'repo_proof') {
    // Same P0 restriction the install path enforces: running the repo-proof
    // verifier and then recording a different anchor would MISLABEL the
    // authority the install claims to hold.
    return {
      ok: false,
      code: 'authenticity_failed',
      message: `trust anchor "${args.trustAnchor.kind}" is not supported in P0 — only repo_proof (§12)`,
      transient: false,
    };
  }
  if (args.rkey === '' || args.rkey.length > 256) {
    return {
      ok: false,
      code: 'authenticity_failed',
      message: 'release rkey is missing or malformed (§5)',
      transient: false,
    };
  }

  let proof: Awaited<ReturnType<typeof verifier>>;
  try {
    proof = await verifier({
      // THE PUBLISHER IS THE INSTALL'S, not the caller's. See the header.
      did: install.publisherDid,
      collection: 'com.dinakernel.plugin.release',
      rkey: args.rkey,
    });
  } catch {
    // The message stays a fixed public string: a verifier throw propagates from
    // network / DID-resolution / CAR-parsing libraries and can carry URLs,
    // response bodies or credentials, and this result is rendered on a card.
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
      message: 'release authenticity verification failed',
      transient: proof.transient,
    };
  }

  const integrity = checkReleaseIntegrity({ rkey: args.rkey, cid: proof.cid });
  if (integrity !== null) {
    return { ok: false, code: 'integrity_failed', message: integrity.message, transient: false };
  }

  // Every gate an INSTALL runs. An update that skipped one would swap the
  // install onto a manifest that could never have been installed here.
  const vetted = vetReleaseManifest(proof.record as PluginManifest);
  if (!vetted.ok) return vetted;
  const { manifest, digests } = vetted;

  if (manifest.plugin_id !== install.pluginId) {
    // A different pack is not an update. Applying it would keep the install's
    // identity, its grants and its listings while running somebody else's code
    // — the same swap the publisher check prevents, one level down.
    return {
      ok: false,
      code: 'different_plugin',
      message: `this release is "${manifest.plugin_id}", not an update to "${install.pluginId}"`,
      transient: false,
    };
  }
  if (proof.cid === install.currentCid) {
    return {
      ok: false,
      code: 'cid_unchanged',
      message: 'this is the release the install already runs',
      transient: false,
    };
  }

  const widening = detectUpdateWidening(install.manifest, manifest);
  prepared.set(args.installId, {
    installId: args.installId,
    fromCid: install.currentCid,
    cid: proof.cid,
    version: manifest.version,
    manifest,
    installScopeHash: digests.installScopeHash,
    capabilityHashes: { ...digests.perCapability },
    behaviorHash: digests.behaviorHash,
    presentationHash: digests.presentationHash,
    widening: widening.findings,
    expiresAtMs: args.nowMs + PREPARED_UPDATE_TTL_MS,
  });

  return {
    ok: true,
    review: {
      installId: args.installId,
      publisherDid: install.publisherDid,
      pluginId: install.pluginId,
      fromVersion: install.currentVersion,
      toVersion: manifest.version,
      fromCid: install.currentCid,
      toCid: proof.cid,
      displayName: manifest.display_name,
      capabilities: manifest.capabilities,
      perCapabilityScopeHashes: { ...digests.perCapability },
      widening: widening.findings,
      // §16.5 puts the behavior hash in the SAME sentence as scope and data
      // scope, so a behavior change is a re-consent event on its own terms.
      // It is not a "widening" — nothing here can rank executable behavior —
      // which is why it gates through its own flag rather than being smuggled
      // into the widening list where a card would have to invent a direction
      // for it.
      requiresReconsent: widening.widens || install.behaviorHash !== digests.behaviorHash,
      fromBehaviorHash: install.behaviorHash,
      toBehaviorHash: digests.behaviorHash,
      behaviorChanged: install.behaviorHash !== digests.behaviorHash,
    },
  };
}

/**
 * Apply the update the owner reviewed.
 *
 * `toCid` is not decoration: it is the owner saying WHICH release they agreed
 * to. A confirm naming a different one than was prepared is refused rather than
 * resolved in either direction — the two disagree, and guessing which is
 * current is how a re-prepare in another tab applies something nobody looked at.
 */
export function confirmUpdate(args: {
  installId: string;
  toCid: string;
  /**
   * §16.5 — the widenings the owner accepted, echoed back from the review.
   * Passed through to the coordinator, which compares them against what it
   * detects itself. Absent on the ordinary path where nothing widened.
   */
  acceptedWidening?: readonly WideningFinding[];
  /**
   * §16.5 — the BEHAVIOR HASH the owner reviewed, echoed back.
   *
   * CONTENT-BOUND, like the widening list and for the same reason: a boolean
   * "yes I saw it" proves nothing about WHAT was seen, and a re-prepare in
   * another tab would make an owner's tap apply a different release's
   * behavior. Required only when the review reported a change.
   */
  acceptedBehaviorHash?: string;
  nowMs: number;
}): ConfirmUpdateResult {
  const candidate = prepared.get(args.installId);
  if (candidate === undefined || candidate.expiresAtMs <= args.nowMs) {
    prepared.delete(args.installId);
    return {
      ok: false,
      code: 'nothing_prepared',
      message: 'no reviewed update is waiting for this install',
      transient: false,
    };
  }
  if (candidate.cid !== args.toCid) {
    return {
      ok: false,
      code: 'candidate_mismatch',
      message: 'the confirmed release is not the one that was reviewed',
      transient: false,
    };
  }

  const installs = getPluginInstallRepository();
  const install = installs?.getById(args.installId) ?? null;
  if (install === null) {
    return { ok: false, code: 'install_unknown', message: 'no such install', transient: false };
  }
  if (install.currentCid !== candidate.fromCid) {
    // Something else updated this install between the review and the tap. The
    // review described a transition that no longer starts where it said.
    prepared.delete(args.installId);
    return {
      ok: false,
      code: 'install_moved',
      message: 'this install changed since the update was reviewed',
      transient: false,
    };
  }

  // §16.5 / §20.12 — material executable behavior may not change under an
  // existing install without the owner having seen the change. Checked HERE
  // rather than in the coordinator because the coordinator is given a
  // manifest, and "what did the owner previously run" is an install fact.
  if (install.behaviorHash !== candidate.behaviorHash) {
    if (args.acceptedBehaviorHash !== candidate.behaviorHash) {
      return {
        ok: false,
        code: 'behavior_change_unreviewed',
        message:
          'this release changes what the plugin DOES; the reviewed behavior hash must be confirmed (§16.5)',
        transient: false,
      };
    }
  }

  const rebind = coordinator;
  if (rebind === null) {
    return {
      ok: false,
      code: 'coordinator_unavailable',
      message: 'update coordinator not wired',
      transient: false,
    };
  }

  const outcome = rebind.apply({
    installId: args.installId,
    cid: candidate.cid,
    version: candidate.version,
    manifest: candidate.manifest,
    installScopeHash: candidate.installScopeHash,
    capabilityHashes: candidate.capabilityHashes,
    behaviorHash: candidate.behaviorHash,
    presentationHash: candidate.presentationHash,
    ...(args.acceptedWidening === undefined ? {} : { consentedWidening: args.acceptedWidening }),
  });

  // Spent on success only. A refusal leaves the candidate confirmable, so an
  // owner who accepts the widenings after a `requires_reconsent` does not have
  // to fetch the release again.
  if (outcome.ok) prepared.delete(args.installId);
  return { ok: true, outcome };
}
