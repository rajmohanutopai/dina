/**
 * §25.6 step 1: the reference packs are INSTALLABLE (WS-3.9).
 *
 * `reference_manifests.ts` ships both packs as product artefacts rather than
 * test fixtures, on the argument that a manifest is a published contract and a
 * pair living only in a `.test.ts` is one nothing can install or review. That
 * argument is only worth anything if the packs actually install — and until
 * now nothing ran them through the install path. They were validated (a pure
 * gate) and used as fixtures by journeys that skipped straight to an activated
 * install by writing rows.
 *
 * So this drives the REAL door: publish each pack as a `plugin.release` at the
 * content-derived rkey §5 requires, then `beginInstall` → `confirmConsent`
 * through the repo-proof verifier seam. Every gate a stranger's pack meets,
 * ours meets.
 *
 * WHY THAT ORDER OF DOUBT MATTERS. A reference pack is the thing a third-party
 * author copies. If ours cannot pass our own door, the instruction "publish a
 * manifest like this one" is wrong, and the first person to find out is
 * somebody outside this repo.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  base32Encode,
  canonicalJson,
  normalizePluginManifest,
  PLUGIN_NSIDS,
  releaseRkeyFromCid,
  validatePluginManifest,
  type PluginManifest,
  type RepoProofResult,
} from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  BUYER_REFERENCE_MANIFEST,
  SUPPLIER_REFERENCE_MANIFEST,
} from '../../src/commerce/reference_manifests';
import {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
} from '../../src/plugins/decisions';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import {
  beginInstall,
  confirmConsent,
  setPluginDeviceVerifier,
  setRepoProofVerifier,
} from '../../src/plugins/install_service';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = Date.parse('2026-08-09T09:00:00.000Z');
const PUBLISHER = 'did:plc:dinakernelpub';
const RUNNER_DID = 'did:plc:packrunner';

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;

/**
 * PUBLISH a manifest the way §5 says a release is published: content-addressed,
 * with the rkey DERIVED from the CID.
 *
 * The CID here is a real CIDv1 (dag-cbor / sha2-256) over the NORMALIZED
 * manifest's canonical bytes — normalized, because the normalized form is the
 * stored form and a CID over the raw one would name a document the install
 * never keeps.
 */
function publishRelease(manifest: PluginManifest): { rkey: string; cid: string } {
  const digest = sha256(new TextEncoder().encode(canonicalJson(normalizePluginManifest(manifest))));
  const bytes = new Uint8Array(36);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  const cid = `b${base32Encode(bytes)}`;
  const rkey = releaseRkeyFromCid(cid);
  if (rkey === null) throw new Error('the published CID is not a content address');
  return { rkey, cid };
}

/** A repo serving exactly the releases handed to it, at their own rkeys. */
function repoServing(entries: { rkey: string; cid: string; record: PluginManifest }[]): void {
  setRepoProofVerifier(async (request) => {
    if (request.collection !== PLUGIN_NSIDS.release) {
      return { ok: false, code: 'not_found', transient: false, message: 'wrong collection' };
    }
    const hit = entries.find((e) => e.rkey === request.rkey);
    if (hit === undefined) {
      return { ok: false, code: 'not_found', transient: false, message: 'no such release' };
    }
    return { ok: true, cid: hit.cid, rev: 'rev1', record: hit.record } as RepoProofResult;
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ref-pack-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(adapter));
  // A runner install cannot activate without a verified plugin device (§5).
  setPluginDeviceVerifier((did) => did === RUNNER_DID);
});

afterEach(() => {
  setRepoProofVerifier(null);
  setPluginDeviceVerifier(null);
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const PACKS: [string, PluginManifest][] = [
  ['supplier', SUPPLIER_REFERENCE_MANIFEST],
  ['buyer', BUYER_REFERENCE_MANIFEST],
];

describe('the shipped reference packs', () => {
  it.each(PACKS)('%s: passes the ingest-identical validator', (_name, manifest) => {
    // The gate every fetched manifest meets. Kept separate from the install
    // below so a failure says WHICH half broke.
    expect(validatePluginManifest(manifest).ok).toBe(true);
  });

  it.each(PACKS)('%s: installs through the real door, by AT-URI', async (_name, manifest) => {
    const release = publishRelease(manifest);
    repoServing([{ ...release, record: manifest }]);

    const begun = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: release.rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!begun.ok) throw new Error(`INSTALL: ${JSON.stringify(begun)}`);

    // The consent card is computed LOCALLY from the manifest — it never
    // repeats a claim the publisher made about itself.
    expect(begun.consent.pluginId).toBe(manifest.plugin_id);
    expect(begun.consent.publisherDid).toBe(PUBLISHER);
    expect(begun.consent.executionMode).toBe('runner');
    expect(begun.consent.capabilities.length).toBe(manifest.capabilities.length);
    for (const capability of manifest.capabilities) {
      expect(begun.consent.perCapabilityScopeHashes[capability.id]).toMatch(/^[0-9a-f]{64}$/);
    }

    // Nothing runs until consent AND a device bound by the pairing ceremony.
    expect(installs.getById(begun.installId)?.status).toBe('pending');

    // §5: consent alone does not activate a runner install. The device must
    // have been PRE-BOUND to this pending during pairing — an unbound pending
    // has no instance to serve the lane, and a different device presenting its
    // own DID would be hijacking the activation. Asserted BEFORE the bind,
    // because a test that only binds proves the happy path and not the gate.
    expect(confirmConsent(begun.installId, RUNNER_DID, T0)).toBe(false);
    // And with NO device at all, which is the case the DID comparison alone
    // cannot catch: on an unbound pending both sides are undefined, so
    // `deviceDid !== install.deviceDid` is false and only the explicit
    // emptiness checks refuse. A mutation removing them survived until this
    // line existed.
    expect(confirmConsent(begun.installId, undefined, T0)).toBe(false);
    expect(installs.getById(begun.installId)?.status).toBe('pending');

    expect(installs.bindPendingDevice(begun.installId, RUNNER_DID, T0)).toBe(true);
    // A different device still cannot activate the one that was bound.
    expect(confirmConsent(begun.installId, 'did:plc:someoneelse', T0)).toBe(false);

    expect(confirmConsent(begun.installId, RUNNER_DID, T0)).toBe(true);
    expect(installs.getById(begun.installId)?.status).toBe('active');
  });

  it.each(PACKS)(
    '%s: is refused at an rkey that is not its content address',
    async (_name, manifest) => {
      // §5's immutability rule, on our own packs. A release served at a key that
      // does not derive from its CID is a release that could be swapped.
      const release = publishRelease(manifest);
      const wrongKey =
        publishRelease(SUPPLIER_REFERENCE_MANIFEST).rkey === release.rkey
          ? publishRelease(BUYER_REFERENCE_MANIFEST).rkey
          : publishRelease(SUPPLIER_REFERENCE_MANIFEST).rkey;
      // Served at somebody else's key, with its own CID.
      repoServing([{ rkey: wrongKey, cid: release.cid, record: manifest }]);

      const begun = await beginInstall({
        publisherDid: PUBLISHER,
        rkey: wrongKey,
        trustAnchor: { kind: 'repo_proof' },
        nowMs: T0,
      });
      expect(begun.ok).toBe(false);
      if (begun.ok) throw new Error('a mis-keyed release installed');
      expect(begun.code).toBe('integrity_failed');
    },
  );

  it('installs BOTH packs side by side, as §18.1 requires', async () => {
    // Two installs, two consent records. A superset install would give ONE
    // consent authority over both sides of a trade: revoking selling would
    // revoke buying, and a compromised supplier runner would carry buyer
    // authority.
    const supplier = publishRelease(SUPPLIER_REFERENCE_MANIFEST);
    const buyer = publishRelease(BUYER_REFERENCE_MANIFEST);
    repoServing([
      { ...supplier, record: SUPPLIER_REFERENCE_MANIFEST },
      { ...buyer, record: BUYER_REFERENCE_MANIFEST },
    ]);

    const ids: string[] = [];
    for (const rkey of [supplier.rkey, buyer.rkey]) {
      const begun = await beginInstall({
        publisherDid: PUBLISHER,
        rkey,
        trustAnchor: { kind: 'repo_proof' },
        nowMs: T0,
      });
      if (!begun.ok) throw new Error(JSON.stringify(begun));
      // Each install pairs its OWN runner device. One device cannot be bound
      // to two pendings — a shared runner is a shared authority, and §18.1's
      // whole point is that the two roles do not share one.
      const device = `${RUNNER_DID}-${String(ids.length)}`;
      setPluginDeviceVerifier((did) => did.startsWith(RUNNER_DID));
      expect(installs.bindPendingDevice(begun.installId, device, T0)).toBe(true);
      expect(confirmConsent(begun.installId, device, T0)).toBe(true);
      ids.push(begun.installId);
    }

    expect(new Set(ids).size).toBe(2);
    const pluginIds = ids.map((id) => installs.getById(id)?.pluginId);
    expect(new Set(pluginIds).size).toBe(2);
  });

  it('refuses an unsigned anchor even for our own pack', async () => {
    // Production installs nothing unsigned (§20), and "it is ours" is not an
    // exemption — the door does not know whose manifest it is holding.
    const release = publishRelease(SUPPLIER_REFERENCE_MANIFEST);
    repoServing([{ ...release, record: SUPPLIER_REFERENCE_MANIFEST }]);

    const begun = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: release.rkey,
      trustAnchor: { kind: 'debug_unsigned' },
      nowMs: T0,
    });
    expect(begun).toMatchObject({ ok: false, code: 'authenticity_failed' });
  });
});
