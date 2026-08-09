/**
 * The owner-facing plugin UPDATE flow (§9.13, §16.5 — WS-3.7).
 *
 * `UpdateRebindCoordinator` was correct and unreachable; its ledger entry named
 * the reason ("the owner-facing update discovery + consent flow is still
 * unbuilt"). These drive the flow that closes it, against a real SQLite
 * registry and the real repo-proof verifier seam — because the two things most
 * worth proving here are both about REACHING the coordinator with the right
 * arguments, and a stubbed coordinator would prove neither.
 *
 * The two rules the whole file exists for:
 *
 *   1. the publisher comes from the INSTALL, never from the caller;
 *   2. a §16.5 re-consent binds to the exact findings the owner saw.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  base32Encode,
  PLUGIN_NSIDS,
  releaseRkeyFromCid,
  type PluginManifest,
  type RepoProofResult,
  type RepoProofVerifier,
} from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLiteDrainAuthorizationRepository,
  setDrainAuthorizationRepository,
} from '../../src/plugins/drain_authorizations';
import { setRepoProofVerifier } from '../../src/plugins/install_service';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { UpdateRebindCoordinator } from '../../src/plugins/update_rebind';
import {
  clearPreparedUpdates,
  confirmUpdate,
  prepareUpdate,
  setUpdateRebindCoordinator,
  PREPARED_UPDATE_TTL_MS,
} from '../../src/plugins/update_service';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { tier0TxRunner } from '../../src/run/tx';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerPluginUpdateRoutes } from '../../src/server/routes/plugin_updates';
import { rebindListingsForUpdate } from '../../src/service/listing_rebind';
import {
  SQLiteServiceConfigRepository,
  setServiceConfigRepository,
} from '../../src/service/service_config_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = 1_750_000_000_000;
const PUBLISHER = 'did:plc:acme';
const IMPOSTOR = 'did:plc:impostor';
const PLUGIN_ID = 'com.acme.supplier';
const PLUGIN_DEVICE = 'did:plc:plugindevice';

/** A real CIDv1 (dag-cbor / sha2-256), so `releaseRkeyFromCid` accepts it. */
function cidFor(seed: string): string {
  const digest = sha256(new TextEncoder().encode(seed));
  const bytes = new Uint8Array(36);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

function manifest(over: Partial<Record<string, unknown>> = {}): PluginManifest {
  return {
    $type: PLUGIN_NSIDS.release,
    plugin_id: PLUGIN_ID,
    version: '1.0.0',
    display_name: 'Supplier',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: 'com.acme.supplier.catalog',
        display_name: 'Read the catalog',
        interaction: 'query',
        action_class: 'read',
        privacy_class: 'personal',
        kinds: ['tool'],
        effects: { idempotency: 'unsupported' },
        data_scope: { max_context_items: 5, categories: [] },
      },
    ],
    ...over,
  } as unknown as PluginManifest;
}

/**
 * The §16.5 case, widening on TWO axes: the pack can now place orders AND
 * reads more context than the owner agreed to.
 *
 * TWO on purpose. With a single finding, "the consent must cover exactly the
 * detected set" and "the consent must overlap it somewhere" agree on every
 * case a test can write — a mutation weakening the check to `some` survived
 * the first version of this file for exactly that reason. A partial consent is
 * only expressible when there is more than one thing to be partial about.
 */
function wideningManifest(): PluginManifest {
  return manifest({
    version: '2.0.0',
    capabilities: [
      {
        id: 'com.acme.supplier.catalog',
        display_name: 'Read the catalog',
        interaction: 'query',
        action_class: 'read',
        privacy_class: 'personal',
        kinds: ['tool'],
        effects: { idempotency: 'unsupported' },
        // Raised, but within the §11 ceiling of 25 — a manifest ABOVE it fails
        // validation before the widening check is even reached, which would
        // test the wrong gate.
        data_scope: { max_context_items: 20, categories: [] },
      },
      {
        id: 'com.acme.supplier.place-order',
        display_name: 'Place an order',
        interaction: 'query',
        action_class: 'write',
        privacy_class: 'personal',
        kinds: ['tool'],
        effects: { idempotency: 'unsupported' },
        data_scope: { max_context_items: 5, categories: [] },
      },
    ],
  });
}

/**
 * A verifier over a small repo: publisher DID → rkey → record. Keyed on the
 * DID as well as the rkey, so a test can prove the flow asked the RIGHT repo.
 */
function repoWith(entries: { did: string; cid: string; record: PluginManifest }[]): {
  verifier: RepoProofVerifier;
  asked: { did: string; rkey: string }[];
} {
  const asked: { did: string; rkey: string }[] = [];
  const verifier: RepoProofVerifier = async (req) => {
    asked.push({ did: req.did, rkey: req.rkey });
    const hit = entries.find((e) => e.did === req.did && releaseRkeyFromCid(e.cid) === req.rkey);
    if (hit === undefined) {
      return { ok: false, code: 'not_found', transient: false, message: 'no such release' };
    }
    return { ok: true, cid: hit.cid, rev: 'rev1', record: hit.record } as RepoProofResult;
  };
  return { verifier, asked };
}

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let installId: string;
const FROM_CID = cidFor('release-1');
const TO_CID = cidFor('release-2');
const WIDE_CID = cidFor('release-wide');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-update-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);

  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setDrainAuthorizationRepository(new SQLiteDrainAuthorizationRepository(adapter));
  setServiceConfigRepository(new SQLiteServiceConfigRepository(adapter));
  setUpdateRebindCoordinator(
    new UpdateRebindCoordinator({
      installs: () => installs,
      drains: () => new SQLiteDrainAuthorizationRepository(adapter),
      rebindListings: (args) => rebindListingsForUpdate(adapter, args),
      tx: tier0TxRunner(adapter),
      now: () => T0,
    }),
  );

  installId = installs.createPending({
    publisherDid: PUBLISHER,
    pluginId: PLUGIN_ID,
    label: '',
    executionMode: 'runner',
    currentCid: FROM_CID,
    currentVersion: '1.0.0',
    manifest: manifest(),
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { 'com.acme.supplier.catalog': 'h'.repeat(64) },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
    nowMs: T0,
  });
  installs.activate(installId, PLUGIN_DEVICE, T0);
  clearPreparedUpdates();
});

afterEach(() => {
  clearPreparedUpdates();
  setUpdateRebindCoordinator(null);
  setRepoProofVerifier(null);
  setPluginInstallRepository(null);
  setDrainAuthorizationRepository(null);
  setServiceConfigRepository(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const rkeyOf = (cid: string): string => releaseRkeyFromCid(cid) as string;

describe('prepareUpdate — whose repo is asked', () => {
  it('asks the INSTALL publisher, not a caller-named one', async () => {
    // The single most important line in the flow. A caller-named publisher
    // would let anyone re-point an install at their own pack and inherit the
    // consent the owner gave to somebody else's.
    const repo = repoWith([
      { did: PUBLISHER, cid: TO_CID, record: manifest({ version: '1.1.0' }) },
    ]);
    setRepoProofVerifier(repo.verifier);

    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    expect(repo.asked).toEqual([{ did: PUBLISHER, rkey: rkeyOf(TO_CID) }]);
  });

  it('cannot be pointed at another publisher who happens to host that rkey', async () => {
    // The impostor's repo holds a release at the same rkey. The flow never
    // looks there, so this is `not_found` rather than a successful review.
    const repo = repoWith([{ did: IMPOSTOR, cid: TO_CID, record: manifest({ version: '9.9.9' }) }]);
    setRepoProofVerifier(repo.verifier);

    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    expect(repo.asked.every((a) => a.did === PUBLISHER)).toBe(true);
  });
});

describe('prepareUpdate — what it refuses', () => {
  it('refuses a release for a DIFFERENT pack', async () => {
    // Applying it would keep the install's identity, grants and listings while
    // running somebody else's code.
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest({ plugin_id: 'com.acme.other' }) }])
        .verifier,
    );
    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result).toMatchObject({ ok: false, code: 'different_plugin' });
  });

  it('refuses the release the install already runs', async () => {
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: FROM_CID, record: manifest() }]).verifier,
    );
    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(FROM_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result).toMatchObject({ ok: false, code: 'cid_unchanged' });
  });

  it.each([
    [
      'an interpreted-mode manifest, which has no runtime on this build',
      { version: '1.1.0', execution: { mode: 'interpreted' } },
      'validation_failed',
    ],
    [
      'a manifest needing a plugin protocol this Dina does not speak',
      { version: '1.1.0', min_plugin_protocol: 2 },
      'needs_newer_dina',
    ],
    [
      'a manifest that is not structurally a manifest at all',
      { version: '1.1.0', capabilities: [] },
      'validation_failed',
    ],
  ])('refuses %s, with the code an INSTALL would give', async (_why, over, code) => {
    // The property, not the branch: the update path runs `vetReleaseManifest`,
    // the same function the install path runs, so anything that could never
    // have been installed here cannot arrive through the update door either.
    // Which gate catches it is the gate's business — that the answer MATCHES
    // the install path is the contract.
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest(over) }]).verifier,
    );
    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('fails closed with no verifier wired, and never trusts on first use', async () => {
    setRepoProofVerifier(null);
    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result).toMatchObject({ ok: false, code: 'verifier_unavailable', transient: true });
  });

  it('refuses to update a paused install rather than updating sideways', async () => {
    installs.pause(installId, T0);
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest({ version: '1.1.0' }) }]).verifier,
    );
    const result = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result).toMatchObject({ ok: false, code: 'install_not_active' });
  });

  it('applies NOTHING — the install is untouched by a review', async () => {
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest({ version: '1.1.0' }) }]).verifier,
    );
    await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
    expect(installs.getById(installId)?.currentVersion).toBe('1.0.0');
  });
});

describe('confirmUpdate — the ordinary path', () => {
  /**
   * Returns the REVIEWED behavior hash, because §16.5 now requires a confirm
   * to echo it. Returning it rather than recomputing keeps the tests honest:
   * they confirm what the review said, which is what an owner taps.
   */
  async function prepareNarrow(): Promise<string> {
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest({ version: '1.1.0' }) }]).verifier,
    );
    const prep = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error('fixture failed to prepare');
    return prep.review.toBehaviorHash;
  }

  it('applies the reviewed release', async () => {
    const behaviorHash = await prepareNarrow();
    const result = confirmUpdate({
      installId,
      toCid: TO_CID,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.ok).toBe(true);
    expect(installs.getById(installId)?.currentCid).toBe(TO_CID);
    expect(installs.getById(installId)?.currentVersion).toBe('1.1.0');
  });

  /**
   * §16.5 / §20.12 — BEHAVIOR, not only scope.
   *
   * "Manifest CID, behavior hash, schemas, network domains, issuer, execution
   * mode, or data scope changes follow the generic plugin update and
   * re-consent rules", and §20.12 lists "behavior and scope hashes" side by
   * side among the controls against a malicious update. The review carried the
   * scope hashes and NOT this one, so material executable behavior could
   * change under an existing install with nothing to compare and nothing to
   * show.
   */
  describe('the behavior hash (§16.5)', () => {
    it('shows the owner the hash BEFORE and AFTER, not merely that it moved', async () => {
      // An owner asked to approve a behavior change is entitled to see what
      // they are approving, and an audit entry recording only "it changed"
      // cannot be checked afterwards.
      setRepoProofVerifier(
        repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest({ version: '1.1.0' }) }])
          .verifier,
      );
      const prep = await prepareUpdate({
        installId,
        rkey: rkeyOf(TO_CID),
        trustAnchor: { kind: 'repo_proof' },
        nowMs: T0,
      });
      if (!prep.ok) throw new Error('expected a review');
      expect(prep.review.fromBehaviorHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prep.review.toBehaviorHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prep.review.behaviorChanged).toBe(
        prep.review.fromBehaviorHash !== prep.review.toBehaviorHash,
      );
      // And the change is a re-consent event in its own right.
      expect(prep.review.requiresReconsent).toBe(true);
    });

    it('REFUSES a confirm that does not echo the reviewed behavior hash', async () => {
      await prepareNarrow();
      const result = confirmUpdate({ installId, toCid: TO_CID, nowMs: T0 });
      expect(result).toMatchObject({ ok: false, code: 'behavior_change_unreviewed' });
      expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
    });

    it('REFUSES a confirm echoing SOME OTHER hash', async () => {
      // Content-bound, like the widening list and for the same reason: a
      // boolean "yes I saw it" proves nothing about WHAT was seen, and a
      // re-prepare in another tab would make one tap apply another release.
      await prepareNarrow();
      const result = confirmUpdate({
        installId,
        toCid: TO_CID,
        acceptedBehaviorHash: 'f'.repeat(64),
        nowMs: T0,
      });
      expect(result).toMatchObject({ ok: false, code: 'behavior_change_unreviewed' });
      expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
    });

    it('leaves the review usable, so the owner can look again and accept', async () => {
      const behaviorHash = await prepareNarrow();
      expect(confirmUpdate({ installId, toCid: TO_CID, nowMs: T0 }).ok).toBe(false);
      expect(
        confirmUpdate({ installId, toCid: TO_CID, acceptedBehaviorHash: behaviorHash, nowMs: T0 })
          .ok,
      ).toBe(true);
      expect(installs.getById(installId)?.currentCid).toBe(TO_CID);
    });
  });

  it('refuses a confirm that names a release the owner was not shown', async () => {
    const behaviorHash = await prepareNarrow();
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result).toMatchObject({ ok: false, code: 'candidate_mismatch' });
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('refuses a confirm with nothing prepared', () => {
    const result = confirmUpdate({ installId, toCid: TO_CID, nowMs: T0 });
    expect(result).toMatchObject({ ok: false, code: 'nothing_prepared' });
  });

  it('refuses a review that has gone stale', async () => {
    await prepareNarrow();
    const result = confirmUpdate({ installId, toCid: TO_CID, nowMs: T0 + PREPARED_UPDATE_TTL_MS });
    expect(result).toMatchObject({ ok: false, code: 'nothing_prepared' });
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('refuses when the install moved between the review and the tap', async () => {
    await prepareNarrow();
    // Something else advanced this install. The review described a transition
    // that no longer starts where it said.
    installs.applyUpdate(
      installId,
      {
        cid: cidFor('release-elsewhere'),
        version: '1.0.5',
        manifest: manifest({ version: '1.0.5' }),
        installScopeHash: 's'.repeat(64),
        capabilityHashes: { 'com.acme.supplier.catalog': 'h'.repeat(64) },
        behaviorHash: 'b'.repeat(64),
        presentationHash: 'p'.repeat(64),
      },
      T0,
      { currentCid: FROM_CID },
    );
    const result = confirmUpdate({ installId, toCid: TO_CID, nowMs: T0 });
    expect(result).toMatchObject({ ok: false, code: 'install_moved' });
  });

  it('spends the review, so one preparation applies once', async () => {
    const behaviorHash = await prepareNarrow();
    expect(
      confirmUpdate({ installId, toCid: TO_CID, acceptedBehaviorHash: behaviorHash, nowMs: T0 }).ok,
    ).toBe(true);
    expect(confirmUpdate({ installId, toCid: TO_CID, nowMs: T0 })).toMatchObject({
      ok: false,
      code: 'nothing_prepared',
    });
  });
});

describe('§16.5 — an update cannot silently widen', () => {
  async function prepareWide(): Promise<{
    widening: { kind: string; capabilityId: string }[];
    behaviorHash: string;
  }> {
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: WIDE_CID, record: wideningManifest() }]).verifier,
    );
    const prep = await prepareUpdate({
      installId,
      rkey: rkeyOf(WIDE_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!prep.ok) throw new Error('fixture failed to prepare a widening update');
    return { widening: prep.review.widening, behaviorHash: prep.review.toBehaviorHash };
  }

  it('shows the owner EVERY widening, not the first', async () => {
    // A card naming one escalation while another rides along is worse than
    // none, so the count matters as much as the contents.
    const { widening, behaviorHash } = await prepareWide();
    expect(widening.length).toBeGreaterThanOrEqual(2);
    expect(widening.some((f) => f.capabilityId === 'com.acme.supplier.place-order')).toBe(true);
    expect(widening.some((f) => f.capabilityId === 'com.acme.supplier.catalog')).toBe(true);
  });

  it('refuses a confirm that does not accept them', async () => {
    const { behaviorHash } = await prepareWide();
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.outcome.ok).toBe(false);
    expect(result.ok && !result.outcome.ok && result.outcome.refusal).toBe('requires_reconsent');
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('applies once the owner accepts EXACTLY those findings', async () => {
    const { widening, behaviorHash } = await prepareWide();
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedWidening: widening as never,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok && result.outcome.ok).toBe(true);
    expect(installs.getById(installId)?.currentCid).toBe(WIDE_CID);
  });

  it('refuses a PARTIAL acceptance', async () => {
    // A consent covering one escalation while another rides along is the exact
    // failure §16.5 names. Only expressible because the fixture widens twice.
    const { widening, behaviorHash } = await prepareWide();
    expect(widening.length).toBeGreaterThanOrEqual(2);
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedWidening: widening.slice(0, 1) as never,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok && !result.outcome.ok).toBe(true);
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('refuses an acceptance listing MORE than was detected', async () => {
    // The stale direction, and it is not pedantry: a consent given against a
    // wider release must not carry over to a narrower re-prepare, because the
    // owner would then be applying a release they never reviewed under a yes
    // they gave to a different one.
    const { widening, behaviorHash } = await prepareWide();
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedWidening: [
        ...widening,
        { kind: 'new_capability', capabilityId: 'com.acme.supplier.ghost', to: 'write' },
      ] as never,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok && !result.outcome.ok).toBe(true);
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('refuses an acceptance for DIFFERENT escalations of the same COUNT', async () => {
    // The forged-consent case, and it has to match on count: a check that
    // compared only how MANY findings were accepted would pass this, and the
    // owner's yes would cover escalations they never saw. The owner's consent
    // is bound to content.
    const { widening, behaviorHash } = await prepareWide();
    const forged = widening.map((f, i) => ({
      kind: f.kind,
      capabilityId: `com.acme.supplier.ghost-${String(i)}`,
      to: 'read',
    }));
    expect(forged).toHaveLength(widening.length);
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedWidening: forged as never,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok && !result.outcome.ok).toBe(true);
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('refuses an acceptance naming the right capability but a milder escalation', async () => {
    // The realistic forgery: the owner's card said "catalog now WRITES", the
    // echo says "catalog reads a bit more". Same capability, same count, and a
    // consent compared on the capability alone would honour it. Every field of
    // a finding is part of what was agreed.
    const { widening, behaviorHash } = await prepareWide();
    const softened = widening.map((f) => ({ ...f, to: 'read', from: 'read' }));
    const result = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedWidening: softened as never,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(result.ok && !result.outcome.ok).toBe(true);
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('leaves the review usable after a re-consent refusal', async () => {
    // The owner reads the findings, decides to accept, and taps again. Making
    // them fetch the release a second time would be a worse card for no gain.
    const { widening, behaviorHash } = await prepareWide();
    confirmUpdate({ installId, toCid: WIDE_CID, acceptedBehaviorHash: behaviorHash, nowMs: T0 });
    const second = confirmUpdate({
      installId,
      toCid: WIDE_CID,
      acceptedWidening: widening as never,
      acceptedBehaviorHash: behaviorHash,
      nowMs: T0,
    });
    expect(second.ok && second.outcome.ok).toBe(true);
  });
});

/**
 * THE ROUTE, not the coordinator.
 *
 * `confirmUpdate`'s behaviour gate was correct and had a full unit suite, and
 * the only production caller could not satisfy it: `POST /confirm` read
 * `install_id`, `to_cid` and `accepted_widening` and no behaviour hash at all.
 * So every update whose behaviour hash had moved was refused for ever, and the
 * branch where an owner's re-consent is ACCEPTED existed only in tests.
 *
 * Two suites passing separately is exactly how that hides. These drive the
 * route.
 */
describe('POST /v1/plugins/update/confirm — the owner surface (§20.12)', () => {
  const OWNER = 'did:plc:owner-of-this-node';
  const OWNER_CAP = 'test-owner-capability-secret';
  let router: CoreRouter;

  function post(body: Record<string, unknown>): CoreRequest {
    return {
      method: 'POST',
      path: '/v1/plugins/update/confirm',
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      callerDID: OWNER,
      ownerCapability: OWNER_CAP,
    };
  }

  beforeEach(() => {
    setNodeDID(OWNER);
    router = new CoreRouter();
    registerPluginUpdateRoutes(router, OWNER_CAP);
  });

  afterEach(() => {
    clearPairingState();
  });

  /**
   * Prepares a behaviour-CHANGING update and returns the hash the owner saw.
   *
   * Prepared at the REAL clock, unlike the unit tests above, because the route
   * confirms at `Date.now()` — it takes no clock injection, and that is
   * correct for a surface an owner taps. Preparing at the fixed `T0` used
   * elsewhere in this file puts the prepared entry more than a year in the
   * past, and the confirm answers `nothing_prepared` before it ever reaches
   * the behaviour gate.
   */
  async function prepareChanged(): Promise<string> {
    setRepoProofVerifier(
      repoWith([{ did: PUBLISHER, cid: TO_CID, record: manifest({ version: '1.1.0' }) }]).verifier,
    );
    const prep = await prepareUpdate({
      installId,
      rkey: rkeyOf(TO_CID),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: Date.now(),
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) throw new Error('fixture failed to prepare');
    // The premise of the whole describe. If the fixture stopped changing
    // behaviour these tests would pass while proving nothing.
    expect(prep.review.behaviorChanged).toBe(true);
    return prep.review.toBehaviorHash;
  }

  it('refuses when the owner echoes NO behaviour hash', async () => {
    await prepareChanged();
    const resp = await router.handle(post({ install_id: installId, to_cid: TO_CID }));
    expect(resp.body).toMatchObject({ ok: false, code: 'behavior_change_unreviewed' });
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('refuses when the owner echoes the WRONG behaviour hash', async () => {
    await prepareChanged();
    const resp = await router.handle(
      post({
        install_id: installId,
        to_cid: TO_CID,
        accepted_behavior_hash: 'f'.repeat(64),
      }),
    );
    expect(resp.body).toMatchObject({ ok: false, code: 'behavior_change_unreviewed' });
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });

  it('APPLIES when the owner echoes the hash the review showed them', async () => {
    const behaviorHash = await prepareChanged();
    const resp = await router.handle(
      post({
        install_id: installId,
        to_cid: TO_CID,
        accepted_behavior_hash: behaviorHash,
      }),
    );
    expect(resp.body).toMatchObject({ ok: true });
    expect(installs.getById(installId)?.currentCid).toBe(TO_CID);
    expect(installs.getById(installId)?.currentVersion).toBe('1.1.0');
  });

  it('refuses a non-owner even with the correct hash', async () => {
    const behaviorHash = await prepareChanged();
    const resp = await router.handle({
      ...post({
        install_id: installId,
        to_cid: TO_CID,
        accepted_behavior_hash: behaviorHash,
      }),
      callerType: 'agent',
      ownerCapability: undefined,
    } as CoreRequest);
    expect(resp.status).toBe(403);
    expect(installs.getById(installId)?.currentCid).toBe(FROM_CID);
  });
});
