/**
 * PLG-7 — install flow: repo-proof verifier seam, install-by-AT-URI,
 * consent/activation lifecycle, uninstall, abandoned sweep
 * (PLUGIN_ARCHITECTURE.md §5, §14, §20). Real SQLite engine + an
 * injected fake verifier.
 */

import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import {
  PLUGIN_NSIDS,
  base32Encode,
  releaseRkeyFromCid,
  type PluginManifest,
  type PluginTrustAnchor,
  type RepoProofResult,
  type RepoProofVerifier,
} from '@dina/protocol';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
  getPluginInstallRepository,
} from '../../src/plugins/registry';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
  getPluginDecisionRepository,
} from '../../src/plugins/decisions';
import * as pluginsBarrel from '../../src/plugins';
import {
  attestVerifiedRelease,
  beginInstall,
  beginInstallVerified,
  confirmConsent,
  declineConsent,
  uninstall,
  sweepAbandonedInstalls,
  setRepoProofVerifier,
  setPluginDeviceVerifier,
  terminateInstallInFlight,
  type VerifiedReleaseAttestation,
} from '../../src/plugins/install_service';
import { pluginLane } from '@dina/protocol';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';
import { PLUGIN_INVOCATION_PAYLOAD_TYPE } from '../../src/workflow/plugin_envelope';

const T0 = 1_750_000_000_000;
const T0_SEC = Math.floor(T0 / 1000);
const PUBLISHER = 'did:plc:acme';

/** Round-10 #9/#10: build a verified-release attestation that binds the
 * publisher + anchor + an immutable manifest snapshot. Defaults keep the
 * common repo_proof case terse. */
function attest(
  manifest: PluginManifest,
  cid: string,
  opts: { kind?: PluginTrustAnchor['kind']; rkey?: string; publisherDid?: string } = {},
): VerifiedReleaseAttestation {
  return attestVerifiedRelease({
    cid,
    ...(opts.rkey !== undefined ? { rkey: opts.rkey } : {}),
    publisherDid: opts.publisherDid ?? PUBLISHER,
    trustAnchor: { kind: opts.kind ?? 'repo_proof' } as PluginTrustAnchor,
    manifest,
  });
}

const sha256 = (d: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(d).digest());

/** Real CIDv1 (dag-cbor, sha2-256) over a fixed body. */
function cidFor(seed: string): string {
  const digest = sha256(new TextEncoder().encode(seed));
  const bytes = new Uint8Array(36);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

function runnerManifest(): PluginManifest {
  return {
    $type: PLUGIN_NSIDS.release,
    plugin_id: 'com.acme.flightwatch',
    version: '1.2.0',
    display_name: 'Flight Watch',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: 'com.acme.flightwatch.watch',
        display_name: 'Watch a flight',
        interaction: 'query',
        action_class: 'read',
        privacy_class: 'personal',
        kinds: ['tool'],
        effects: { idempotency: 'unsupported' },
      },
    ],
  };
}

let dir: string;
let adapter: NodeSQLiteAdapter;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plg7-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(adapter));
  // PLG-29 #7: runner activation now FAILS CLOSED unless a plugin-device
  // verifier is wired. Default the whole suite to an approving verifier so
  // the happy-path runner installs still activate; individual tests override.
  setPluginDeviceVerifier(() => true);
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  setRepoProofVerifier(null);
  setPluginDeviceVerifier(null);
  setWorkflowService(null);
  try {
    adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A verifier that returns the given manifest at a content-correct rkey. */
function fakeVerifier(
  manifest: PluginManifest,
  seed = 'v1',
): { rkey: string; cid: string; verifier: RepoProofVerifier } {
  const cid = cidFor(seed);
  const rkey = releaseRkeyFromCid(cid) as string;
  const verifier: RepoProofVerifier = async (req) => {
    if (req.rkey !== rkey) {
      return { ok: false, code: 'not_found', transient: false, message: 'no such release' };
    }
    return { ok: true, cid, rev: 'rev1', record: manifest } as RepoProofResult;
  };
  return { rkey, cid, verifier };
}

// ---------------------------------------------------------------------------

describe('beginInstall — authenticity + integrity + validation gates (§5)', () => {
  it('happy path: verified release mints a pending install with locally-computed consent', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consent.pluginId).toBe('com.acme.flightwatch');
    expect(result.consent.perCapabilityScopeHashes['com.acme.flightwatch.watch']).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const install = getPluginInstallRepository()!.getById(result.installId);
    expect(install?.status).toBe('pending');
    expect(install?.trustAnchor).toEqual({ kind: 'repo_proof' });
  });

  it('fails closed when no verifier is wired (never trust-on-first-use, §5)', async () => {
    const { rkey } = fakeVerifier(runnerManifest());
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('verifier_unavailable');
    expect(result.transient).toBe(true);
  });

  it('propagates an authenticity failure (integrity vs transient split)', async () => {
    const verifier: RepoProofVerifier = async () => ({
      ok: false,
      code: 'signature_invalid',
      transient: false,
      message: 'commit signature does not verify',
    });
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: 'anything',
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('authenticity_failed');
  });

  it('round-6 #9: a verifier that THROWS becomes a transient failure, never an uncaught crash', async () => {
    // Network / DID-resolution / CAR-parse errors reject rather than return a
    // typed {ok:false}. beginInstall must catch and surface a transient failure.
    setRepoProofVerifier(async () => {
      throw new Error('ECONNRESET');
    });
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: 'anything',
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('verifier_unavailable');
    expect(result.transient).toBe(true);
  });

  it('rejects a release whose rkey does not match its CID (overwritten/forged, §5)', async () => {
    const manifest = runnerManifest();
    const cid = cidFor('real');
    const verifier: RepoProofVerifier = async () => ({ ok: true, cid, rev: 'r', record: manifest });
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: 'wrongrkeynotmatchingcid',
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('integrity_failed');
  });

  it('refuses debug_unsigned anchors in production (§20)', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'debug_unsigned' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('authenticity_failed');
  });

  it('rejects non-repo_proof anchors as unsupported in P0 (never mislabels authority, §12)', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    for (const anchor of [
      { kind: 'org_key' as const, orgDid: 'did:web:acme' },
      { kind: 'local_publisher_key' as const, keyId: 'k1' },
    ]) {
      const result = await beginInstall({
        publisherDid: PUBLISHER,
        rkey,
        trustAnchor: anchor,
        nowMs: T0,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('authenticity_failed');
      expect(result.message).toContain('not supported in P0');
    }
  });

  it('fails closed (not a crash) when the verifier returns a non-manifest record', async () => {
    const cid = cidFor('junk');
    const rkey = releaseRkeyFromCid(cid) as string;
    setRepoProofVerifier(async () => ({ ok: true, cid, rev: 'r', record: 'not a manifest' }));
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
  });

  it('runs the ingest-identical validation gate (a banned manifest is rejected)', async () => {
    const base = runnerManifest();
    const bad: PluginManifest = {
      ...base,
      capabilities: [{ ...base.capabilities[0]!, data_scope: { categories: ['companionship'] } }],
    };
    const { rkey, verifier } = fakeVerifier(bad);
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('validation_failed');
  });
});

describe('compatibility gate (§14: derived ∪ declared ⊆ supported)', () => {
  it('needs_newer_dina when the manifest declares an unshipped feature', async () => {
    const m: PluginManifest = { ...runnerManifest(), required_features: ['some.future.feature'] };
    const { rkey, verifier } = fakeVerifier(m);
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'needs_newer_dina') throw new Error(JSON.stringify(result));
    expect(result.missing).toContain('some.future.feature');
  });

  it('needs_newer_dina when a kind the node cannot yet deliver is DERIVED (notify is P3)', async () => {
    const base = runnerManifest();
    const m: PluginManifest = {
      ...base,
      capabilities: [{ ...base.capabilities[0]!, kinds: ['notify'] }],
    };
    const { rkey, verifier } = fakeVerifier(m);
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'needs_newer_dina') throw new Error(JSON.stringify(result));
    expect(result.missing).toContain('kind.notify');
  });

  it('needs_newer_dina when min_plugin_protocol exceeds this node', async () => {
    const m: PluginManifest = { ...runnerManifest(), min_plugin_protocol: 2 };
    const { rkey, verifier } = fakeVerifier(m);
    setRepoProofVerifier(verifier);
    const result = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('needs_newer_dina');
  });
});

describe('lifecycle: consent → activation → uninstall (§14)', () => {
  async function pending(): Promise<string> {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!r.ok) throw new Error('expected pending');
    return r.installId;
  }

  it('P1-1: runner activation requires the device PRE-BOUND during pairing, exact match', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    // No device passed → refused (a lane nobody can serve).
    expect(confirmConsent(id, undefined, T0 + 1)).toBe(false);
    // A device presented WITHOUT a prior pairing bind must NOT activate — this
    // is the hijack P1-1 closes: an unbound pending would otherwise commit onto
    // whatever DID the consent leg happened to carry.
    expect(confirmConsent(id, 'did:key:zunbound', T0 + 2)).toBe(false);
    expect(installs.getById(id)?.status).toBe('pending');
    // Bind the instance device through the real pairing seam.
    expect(installs.bindPendingDevice(id, 'did:key:zinstance', T0 + 3)).toBe(true);
    // A DIFFERENT device than the bound one is still refused (no overwrite).
    expect(confirmConsent(id, 'did:key:zhijack', T0 + 4)).toBe(false);
    expect(installs.getById(id)?.status).toBe('pending');
    // The exact bound device activates — the single atomic commit point.
    expect(confirmConsent(id, 'did:key:zinstance', T0 + 5)).toBe(true);
    expect(installs.getById(id)?.status).toBe('active');
    const log = getPluginDecisionRepository()!.listByInstall(id, 10);
    expect(log[0]!.decision).toBe('consent_granted');
  });

  it('declineConsent unwinds the pending install and revokes the paired device', async () => {
    const id = await pending();
    // A device paired during the ceremony — bound through the real seam.
    expect(getPluginInstallRepository()!.bindPendingDevice(id, 'did:key:zorphan', T0 + 1)).toBe(
      true,
    );
    const result = await declineConsent(id, T0 + 3, async () => ({ durable: true }));
    expect(result).toEqual({ removed: true, deviceDid: 'did:key:zorphan', deviceRevoked: true });
    expect(getPluginInstallRepository()!.getById(id)).toBeNull();
  });

  it('round-7 #5: a bound-device teardown WITHOUT a revoker retains the row (no orphan)', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zorphan', T0 + 1)).toBe(true);
    // No revoker + a bound device → the row is RETAINED (the durable revoker is
    // mandatory once a device is bound), never deleted-and-hoped.
    const result = await declineConsent(id, T0 + 3);
    expect(result).toEqual({ removed: false, deviceDid: 'did:key:zorphan' });
    expect(installs.getById(id)).not.toBeNull();
  });

  it('PLG-27 #4: a failed uninstall of a PENDING install (no revoker) leaves it NON-activatable', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zorphan', T0 + 1)).toBe(true);
    expect(installs.getById(id)?.status).toBe('pending');
    // Uninstall with NO revoker → the row is RETAINED (the durable revoker is
    // mandatory once a device is bound), but it must be TOMBSTONED to `revoked`
    // so a later confirmConsent can't bring the owner-uninstalled install live.
    const result = await uninstall(id, T0 + 3);
    expect(result).toEqual({ removed: false, deviceDid: 'did:key:zorphan' });
    expect(installs.getById(id)?.status).toBe('revoked');
    // confirmConsent → activate's `status='pending'` CAS now refuses.
    expect(confirmConsent(id, 'did:key:zorphan', T0 + 4)).toBe(false);
    expect(installs.getById(id)?.status).toBe('revoked');
  });

  it('PLG-27 #4: a PENDING uninstall whose durable revoke FAILS is also non-activatable', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zorphan', T0 + 1)).toBe(true);
    // Revoker present but the durable revoke does NOT land → row retained, and
    // still tombstoned so it cannot be reactivated.
    const result = await uninstall(id, T0 + 3, async () => ({ durable: false }));
    expect(result).toEqual({ removed: false, deviceDid: 'did:key:zorphan', deviceRevoked: false });
    expect(installs.getById(id)?.status).toBe('revoked');
    expect(confirmConsent(id, 'did:key:zorphan', T0 + 4)).toBe(false);
  });

  it('PLG-28 #3: the abandoned sweep finishes a failed-uninstall tombstone (retries the device revoke + removes it)', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    installs.bindPendingDevice(id, 'did:key:zorphan', T0 + 1);
    // Uninstall's durable revoke FAILS → a `revoked` tombstone with a device.
    await uninstall(id, T0 + 3, async () => ({ durable: false }));
    expect(installs.getById(id)?.status).toBe('revoked');
    // The sweep at a later second re-attempts the device revoke (now durable) and
    // removes the tombstone — the device credential is no longer orphaned.
    let retried = 0;
    const swept = await sweepAbandonedInstalls(Math.floor(T0 / 1000) + 100, async () => {
      retried++;
      return { durable: true };
    });
    expect(retried).toBe(1);
    expect(installs.getById(id)).toBeNull();
    expect(swept.map((r) => r.installId)).toContain(id);
  });

  it('PLG-28 #7 / PLG-29 #7: runner activation obeys the WIRED plugin-device guard and fails closed when unwired', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    installs.bindPendingDevice(id, 'did:key:zinstance', T0 + 1);
    // PLG-29 #7: an UNWIRED verifier is a misconfigured boot — a runner install
    // must NOT activate even though the bound DID matches the consenting device.
    setPluginDeviceVerifier(null);
    expect(confirmConsent(id, 'did:key:zinstance', T0 + 2)).toBe(false);
    expect(installs.getById(id)?.status).toBe('pending');
    // Guard says "not a valid plugin device" → activation refused even though the
    // DID matches the bound one.
    setPluginDeviceVerifier(() => false);
    expect(confirmConsent(id, 'did:key:zinstance', T0 + 3)).toBe(false);
    expect(installs.getById(id)?.status).toBe('pending');
    // Guard passes → activates.
    setPluginDeviceVerifier(() => true);
    expect(confirmConsent(id, 'did:key:zinstance', T0 + 4)).toBe(true);
    expect(installs.getById(id)?.status).toBe('active');
  });

  it('PLG-28 #9: an interpreted install rejects a device DID on activation (accepts undefined)', () => {
    const installs = getPluginInstallRepository()!;
    // The stored manifest's scalar identity columns (plugin_id / version /
    // execution_mode) must agree with the createPending args or rowToInstall
    // quarantines the row (Round-12 #8) — so hand it an interpreted-mode manifest.
    const interpretedManifest = {
      ...runnerManifest(),
      plugin_id: 'com.acme.battleship',
      version: '1.0.0',
      execution: { mode: 'interpreted' as const },
    };
    const id = installs.createPending({
      publisherDid: PUBLISHER,
      pluginId: 'com.acme.battleship',
      label: '',
      executionMode: 'interpreted',
      currentCid: 'bafyreicidi',
      currentVersion: '1.0.0',
      manifest: interpretedManifest,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { 'com.acme.flightwatch.watch': 'c'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    // A device DID on an interpreted activation is rejected (§7: no pairing leg).
    expect(confirmConsent(id, 'did:key:zsomething', T0 + 1)).toBe(false);
    expect(installs.getById(id)?.status).toBe('pending');
    // Undefined activates the interpreted install.
    expect(confirmConsent(id, undefined, T0 + 2)).toBe(true);
    expect(installs.getById(id)?.status).toBe('active');
  });

  it('PLG-28 #16: beginInstall rejects an oversized / spoofing install label', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const long = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      label: 'x'.repeat(200),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.code).toBe('validation_failed');
    const spoof = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      label: 'ev‮il',
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(spoof.ok).toBe(false);
  });

  it('PLG-28 #2: a throwing decision-log write does NOT fail the committed activation', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    installs.bindPendingDevice(id, 'did:key:zinstance', T0 + 1);
    // Swap in a decision repo whose record() throws (mirrors PLG-27 #18's
    // malformed-row throw). confirmConsent's activation already committed, so it
    // must still return true — the audit failure is swallowed.
    const origErr = console.error;
    console.error = (): void => {};
    setPluginDecisionRepository({
      record: () => {
        throw new Error('audit boom');
      },
      listByInstall: () => [],
      listRecent: () => [],
    });
    try {
      expect(confirmConsent(id, 'did:key:zinstance', T0 + 2)).toBe(true);
      expect(installs.getById(id)?.status).toBe('active');
    } finally {
      console.error = origErr;
    }
  });

  it('round-9 #15: declineConsent refuses an already-ACTIVE install (pending-only CAS)', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zactive', T0 + 1)).toBe(true);
    // The install has since activated (consent confirmed).
    expect(installs.activate(id, 'did:key:zactive', T0 + 2)).toBe(true);
    // A stale/racing decline must NOT revoke the device and delete a LIVE plugin.
    let revoked = false;
    const result = await declineConsent(id, T0 + 3, async () => {
      revoked = true;
      return { durable: true };
    });
    expect(result).toBeNull(); // refused
    expect(revoked).toBe(false); // the live device was never revoked
    expect(installs.getById(id)?.status).toBe('active'); // install still live
  });

  it('round-10 #3: declineConsent does not delete an install that ACTIVATES during the revoke await', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zrace', T0 + 1)).toBe(true);
    // The revoke callback yields the event loop — model confirmConsent racing in
    // during that await by activating the install before decline resumes.
    const result = await declineConsent(id, T0 + 2, async () => {
      installs.activate(id, 'did:key:zrace', T0 + 3); // pending → active mid-await
      return { durable: true };
    });
    // The post-await pending re-check refuses to delete the now-active install.
    expect(result).toEqual({ removed: false, deviceDid: 'did:key:zrace' });
    expect(installs.getById(id)?.status).toBe('active'); // NOT deleted
  });

  it('round-12 #12: a decline whose revoke cascade REMOVED the pending row still records consent_declined', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zorphan', T0 + 1)).toBe(true);
    // The REAL durable revoker's cascade removes the pending row
    // (disablePluginAuthorityForDevice removes pending installs). Model that: the
    // callback deletes the row, then reports durable. Distinct from the racing-
    // activate case above — this is cascade SUCCESS, not a race.
    const result = await declineConsent(id, T0 + 3, async () => {
      installs.remove(id); // the cascade already removed it during the await
      return { durable: true };
    });
    // Teardown SUCCEEDED — report removed + record the decline, NOT the old
    // removed:false (which reads as "retained retry anchor") with no audit.
    expect(result?.removed).toBe(true);
    expect(installs.getById(id)).toBeNull();
    const decisions = getPluginDecisionRepository()!.listByInstall(id, 10);
    expect(decisions.some((d) => d.decision === 'consent_declined')).toBe(true);
  });

  it('refuses to activate an already-expired pending (TOCTOU between sweeper ticks, §14)', async () => {
    const id = await pending();
    // Bind the instance device first so the ONLY reason activation fails below
    // is expiry, not the P1-1 unbound-device guard.
    expect(getPluginInstallRepository()!.bindPendingDevice(id, 'did:key:zinstance', T0)).toBe(true);
    // Force the pending past its expiry without the sweeper having run.
    adapter.execute('UPDATE plugin_installs SET pending_expires_at = ? WHERE install_id = ?', [
      T0_SEC - 10,
      id,
    ]);
    expect(confirmConsent(id, 'did:key:zinstance', T0 + 1)).toBe(false);
    expect(getPluginInstallRepository()!.getById(id)?.status).toBe('pending');
  });

  it('uninstall revokes grants, removes the row, and revokes the paired device', async () => {
    const id = await pending();
    expect(getPluginInstallRepository()!.bindPendingDevice(id, 'did:key:zinstance', T0)).toBe(true);
    confirmConsent(id, 'did:key:zinstance', T0 + 1);
    const result = await uninstall(id, T0 + 2, async () => ({ durable: true }));
    expect(result).toEqual({ removed: true, deviceDid: 'did:key:zinstance', deviceRevoked: true });
    expect(getPluginInstallRepository()!.getById(id)).toBeNull();
    // Decision log survives (records of the past).
    const recent = getPluginDecisionRepository()!.listByInstall(id, 10);
    expect(recent.some((d) => d.decision === 'uninstalled')).toBe(true);
  });

  it('round-13 #12: uninstalling a PENDING install whose revoke cascade removed the row still reports removed', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zorphan', T0)).toBe(true);
    // The device revoke cascade removes the pending row during the await (models
    // disablePluginAuthorityForDevice). uninstall's rawStatus probe must treat
    // the now-gone row as SUCCESS, not misreport failure (null).
    const result = await uninstall(id, T0 + 2, async () => {
      installs.remove(id);
      return { durable: true };
    });
    expect(result?.removed).toBe(true);
    expect(installs.getById(id)).toBeNull();
    expect(
      getPluginDecisionRepository()!
        .listByInstall(id, 10)
        .some((d) => d.decision === 'uninstalled'),
    ).toBe(true);
  });

  it('round-5 #6: uninstall revokes the device FIRST and retains the row when the revoke throws', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zinstance', T0)).toBe(true);
    confirmConsent(id, 'did:key:zinstance', T0 + 1);
    // Round-6 #1: a revoke that resolves NOT-durable retains the row too — the
    // callback is async and its confirmed durability gates the deletion.
    const notDurable = await uninstall(id, T0 + 2, async () => ({ durable: false }));
    expect(notDurable).toEqual({
      removed: false,
      deviceDid: 'did:key:zinstance',
      deviceRevoked: false,
    });
    expect(installs.getById(id)).not.toBeNull(); // anchor kept
    // A revoke that REJECTS is likewise treated as not-durable (row retained).
    const failed = await uninstall(id, T0 + 2, async () => {
      throw new Error('device revoke failed');
    });
    expect(failed).toEqual({
      removed: false,
      deviceDid: 'did:key:zinstance',
      deviceRevoked: false,
    });
    expect(installs.getById(id)).not.toBeNull();
    // Retry with a confirmed-durable revoke → device revoked first, THEN removed.
    const calls: string[] = [];
    const ok = await uninstall(id, T0 + 3, async (d) => {
      calls.push(d);
      return { durable: true };
    });
    expect(ok).toEqual({ removed: true, deviceDid: 'did:key:zinstance', deviceRevoked: true });
    expect(calls).toEqual(['did:key:zinstance']);
    expect(installs.getById(id)).toBeNull();
  });

  it('round-15 #5: callback-free uninstall PAUSES the active install (lane stops for card tasks)', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zinstance', T0)).toBe(true);
    confirmConsent(id, 'did:key:zinstance', T0 + 1);
    expect(installs.getById(id)?.status).toBe('active');
    // No revoke callback → the row is retained as a retry anchor, but it MUST be
    // paused so a NEW card-backed task can't ride the still-active lane before
    // the caller separately revokes the device. (PLG-24 only paused on the
    // callback path; PLG-25 #5 hoists the pause above this early return.)
    const res = await uninstall(id, T0 + 2);
    expect(res).toEqual({ removed: false, deviceDid: 'did:key:zinstance' });
    expect(installs.getById(id)?.status).toBe('paused');
  });

  it('round-16 #4: uninstall of an already-MANUALLY-paused install escalates the pause reason', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zinstance', T0)).toBe(true);
    confirmConsent(id, 'did:key:zinstance', T0 + 1);
    // The owner manually pauses it first — pause() only touches ACTIVE rows.
    expect(installs.pause(id, T0 + 2, 'manual')).toBe(true);
    expect(installs.getById(id)?.pauseReason).toBe('manual');
    // A non-durable revoke retains the row. Its pause reason MUST be escalated to
    // 'device_revoked' so resume() (which permits only 'manual') can't reactivate
    // the teardown anchor with its card-level authority intact.
    const res = await uninstall(id, T0 + 3, async () => ({ durable: false }));
    expect(res).toEqual({ removed: false, deviceDid: 'did:key:zinstance', deviceRevoked: false });
    expect(installs.getById(id)?.pauseReason).toBe('device_revoked');
    expect(installs.resume(id, T0 + 4)).toBe(false); // no longer plainly resumable
  });

  it('round-5 #6: declineConsent revokes the paired device first and retains the pending on failure', async () => {
    const id = await pending();
    const installs = getPluginInstallRepository()!;
    expect(installs.bindPendingDevice(id, 'did:key:zorphan', T0)).toBe(true);
    const failed = await declineConsent(id, T0 + 1, async () => {
      throw new Error('revoke failed');
    });
    expect(failed).toEqual({ removed: false, deviceDid: 'did:key:zorphan', deviceRevoked: false });
    expect(installs.getById(id)).not.toBeNull(); // retry anchor kept
    const calls: string[] = [];
    const ok = await declineConsent(id, T0 + 2, async (d) => {
      calls.push(d);
      return { durable: true };
    });
    expect(ok).toEqual({ removed: true, deviceDid: 'did:key:zorphan', deviceRevoked: true });
    expect(calls).toEqual(['did:key:zorphan']);
    expect(installs.getById(id)).toBeNull();
  });

  it('round-5 #2: a malformed nested manifest field fails CLOSED (validation_failed), never crashes', () => {
    // `data_scope.categories: 7` passes the outer isManifestShaped check but
    // makes normalize call `new Set(7)` → throws. Must surface as validation_
    // failed, not an uncaught crash of the install path.
    const base = runnerManifest();
    const bad = {
      ...base,
      capabilities: [{ ...base.capabilities[0], data_scope: { categories: 7 } }],
    } as unknown as PluginManifest;
    const r = beginInstallVerified({
      manifest: bad,
      // Attest a VALID manifest; installing the malformed one makes the match
      // check's normalize throw → validation_failed (fails closed, never crash).
      attestation: attest(runnerManifest(), cidFor('malformed')),
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('validation_failed');
  });
});

describe('interpreted install needs no pairing leg (§7)', () => {
  it('activates with no device', () => {
    const interpreted: PluginManifest = {
      $type: PLUGIN_NSIDS.release,
      plugin_id: 'com.acme.battleship',
      version: '1.0.0',
      display_name: 'Battleship',
      min_interpreter: 1,
      execution: { mode: 'interpreted' },
      capabilities: [
        {
          id: 'com.acme.battleship.play',
          display_name: 'Play',
          interaction: 'session',
          action_class: 'read',
          privacy_class: 'public',
          machine: {
            initial: 'a',
            states: ['a', 'b'],
            moves: { go: { type: 'object' } },
            transitions: [{ from: 'a', move: 'go', ops: ['commit'], to: 'b' }],
            turn: 'alternate',
            timeouts: { move_sec: 60, session_ttl_sec: 600 },
            terminal: ['b'],
          },
          ops_used: ['commit'],
          verify_budget: 0,
        },
      ],
    };
    const cid = cidFor('interp');
    // Interpreted plugins carry session + op.* features — NOT in P0's
    // supported set, so the compatibility gate blocks install here.
    const result = beginInstallVerified({
      manifest: interpreted,
      // P2-5: authority comes from a verifier-minted attestation, not a boolean.
      attestation: attest(interpreted, cid),
      nowMs: T0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('needs_newer_dina'); // interpreted mode is P1
  });
});

describe('abandoned-install sweep (§14)', () => {
  it('expires stale pendings and revokes their paired devices', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!r.ok) throw new Error('expected pending');
    // Pairing completed but consent never confirmed — the dangerous case.
    // The device is bound to the pending row through the real seam.
    expect(
      getPluginInstallRepository()!.bindPendingDevice(r.installId, 'did:key:zorphan', T0),
    ).toBe(true);
    const revoked: string[] = [];
    const expired = await sweepAbandonedInstalls(T0_SEC + 20 * 60, async (did) => {
      revoked.push(did);
      return { durable: true };
    });
    expect(expired).toHaveLength(1);
    expect(revoked).toEqual(['did:key:zorphan']);
    expect(getPluginInstallRepository()!.getById(r.installId)).toBeNull();
  });

  it('round-11 #3: an install that ACTIVATES during the revoke await is NOT swept (pending-only CAS)', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!r.ok) throw new Error('expected pending');
    const repo = getPluginInstallRepository()!;
    expect(repo.bindPendingDevice(r.installId, 'did:key:zorphan', T0)).toBe(true);
    // The revoke await is the yield point: a concurrent confirmConsent activates
    // the install right here. The post-await pending re-check must then skip it —
    // deleting a now-ACTIVE install would destroy live authority.
    const expired = await sweepAbandonedInstalls(T0_SEC + 20 * 60, async () => {
      repo.activate(r.installId, 'did:key:zorphan', T0 + 1);
      return { durable: true };
    });
    expect(expired).toHaveLength(0); // NOT swept — it went active mid-await
    expect(repo.getById(r.installId)?.status).toBe('active'); // authority preserved
  });

  it('round-12 #11: a CORRUPT stale-pending row is still swept (device revoked + row removed)', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!r.ok) throw new Error('expected pending');
    const repo = getPluginInstallRepository()!;
    expect(repo.bindPendingDevice(r.installId, 'did:key:zorphan', T0)).toBe(true);
    // Corrupt the manifest so the PROJECTING listStalePending drops it — the row
    // (and its bound device) would otherwise leak, never swept.
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      '{bad json',
      r.installId,
    ]);
    expect(repo.listStalePending(T0_SEC + 20 * 60)).toHaveLength(0); // projection drops it
    const revoked: string[] = [];
    const swept = await sweepAbandonedInstalls(T0_SEC + 20 * 60, async (did) => {
      revoked.push(did);
      return { durable: true };
    });
    // The raw sweep still enumerates + revokes + removes the corrupt row.
    expect(revoked).toEqual(['did:key:zorphan']);
    expect(swept.map((s) => s.installId)).toEqual([r.installId]);
    expect(
      adapter.query('SELECT 1 FROM plugin_installs WHERE install_id = ?', [r.installId]),
    ).toHaveLength(0);
  });
});

describe('P1-4 — revoke/uninstall terminates in-flight work', () => {
  function envelope(installId: string, actionClass: string): string {
    return JSON.stringify({
      type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
      install_id: installId,
      capability_id: 'com.acme.flightwatch.watch',
      params: {},
      context: [],
      manifest_cid: 'bafyreicid',
      approved_scope_hash: 'a'.repeat(64),
      schema_snapshot: null,
      config_revision: 1,
      execution_id: 'exec-x',
      idempotency_key: 'idem-x',
      action_class: actionClass,
      effects_idempotency: 'supported',
    });
  }

  it('a RUNNING effectful task on the lane parks as outcome_unknown; a QUEUED one cancels', () => {
    const wf = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: wf }));
    const installId = 'pli_p14';
    const lane = pluginLane(installId);
    wf.create({
      id: 'task-running',
      kind: 'delegation',
      status: 'running',
      priority: 'normal',
      description: 'booking',
      payload: envelope(installId, 'booking'),
      result_summary: '',
      policy: '',
      requested_runner: lane,
      created_at: T0,
      updated_at: T0,
    });
    wf.create({
      id: 'task-queued',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'read',
      payload: envelope(installId, 'read'),
      result_summary: '',
      policy: '',
      requested_runner: lane,
      created_at: T0 + 1,
      updated_at: T0 + 1,
    });

    const terminated = terminateInstallInFlight(installId, 'uninstalled', T0 + 2);
    expect(terminated.sort()).toEqual(['task-queued', 'task-running']);
    // A running declared-effectful task may have already happened → parked.
    expect(wf.getById('task-running')?.status).toBe('outcome_unknown');
    // A queued task never ran → cancelled.
    expect(wf.getById('task-queued')?.status).toBe('cancelled');
  });

  it('a task on ANOTHER install lane is untouched', () => {
    const wf = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: wf }));
    wf.create({
      id: 'task-other',
      kind: 'delegation',
      status: 'running',
      priority: 'normal',
      description: 'other',
      payload: envelope('pli_other', 'booking'),
      result_summary: '',
      policy: '',
      requested_runner: pluginLane('pli_other'),
      created_at: T0,
      updated_at: T0,
    });
    terminateInstallInFlight('pli_target', 'uninstalled', T0 + 1);
    expect(wf.getById('task-other')?.status).toBe('running');
  });
});

describe('P2 hardening — install-path robustness', () => {
  it('P2-6: a malformed record (capabilities:[null]) fails CLOSED, never crashes', async () => {
    const bad = { ...runnerManifest(), capabilities: [null] } as unknown as PluginManifest;
    const { rkey, verifier } = fakeVerifier(bad, 'p26');
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('validation_failed');
  });

  it('P2-9: a config_schema manifest needs a newer Dina (no config-value store in P0)', async () => {
    const withConfig = {
      ...runnerManifest(),
      config_schema: { type: 'object', properties: { units: { type: 'string' } } },
    } as PluginManifest;
    const { rkey, verifier } = fakeVerifier(withConfig, 'p29');
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('needs_newer_dina');
  });

  it('P2-11: a sweep whose device-revoke THROWS keeps the pending row for retry', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest(), 'p211');
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!r.ok) throw new Error('expected pending');
    getPluginInstallRepository()!.bindPendingDevice(r.installId, 'did:key:zorphan', T0);
    const swept = await sweepAbandonedInstalls(T0_SEC + 20 * 60, async () => {
      throw new Error('durable revoke failed');
    });
    expect(swept).toHaveLength(0); // nothing deleted
    expect(getPluginInstallRepository()!.getById(r.installId)).not.toBeNull(); // retry anchor kept
  });
});

describe('P2 hardening — pairing + verified-release gates', () => {
  it('round-10 #9: publisher + trust anchor are read from the attestation, not loose args', () => {
    // The attestation binds the party + anchor, so the persisted install traces
    // to exactly what the verifier attested (no reuse of a proof for A as B).
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p25'), {
        publisherDid: 'did:plc:acme',
        kind: 'repo_proof',
      }),
      nowMs: T0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = getPluginInstallRepository()!.getById(r.installId);
    expect(row?.publisherDid).toBe('did:plc:acme');
    expect(row?.trustAnchor).toEqual({ kind: 'repo_proof' });
  });

  it('round-10 #9: an unsigned attestation still cannot install in production', () => {
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p25u'), { kind: 'debug_unsigned' }),
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('authenticity_failed');
  });

  it('round-14 #1: an attestation lacking the verifier brand cannot install', () => {
    // A caller hand-rolls an object with the right shape and casts it past the
    // compiler (or it crossed a serialization boundary — the brand SYMBOL does
    // not survive JSON). Without the runtime brand check this would install with
    // attacker-chosen cid / anchor / publisher. The brand check fires first.
    const forged = {
      cid: cidFor('forged'),
      publisherDid: 'did:plc:evil',
      trustAnchor: { kind: 'repo_proof' },
    } as unknown as VerifiedReleaseAttestation;
    const r = beginInstallVerified({ manifest: runnerManifest(), attestation: forged, nowMs: T0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('authenticity_failed');
  });

  it('round-14 #5: a branded attestation with a MALFORMED trust anchor is refused before persistence', () => {
    // attestVerifiedRelease brands whatever anchor it is handed, so the brand
    // check passes — but finishBegin re-validates the anchor before createPending.
    // An org_key missing its orgDid is malformed and must not persist (it would
    // quarantine on the next read anyway).
    const badAnchor = attestVerifiedRelease({
      cid: cidFor('p5bad'),
      publisherDid: PUBLISHER,
      trustAnchor: { kind: 'org_key' } as unknown as PluginTrustAnchor, // missing orgDid
      manifest: runnerManifest(),
    });
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: badAnchor,
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('authenticity_failed');
  });

  it('P2-5: an rkey carried by the attestation must satisfy the content address', () => {
    // WHEN the attestation carries an rkey, the immutability invariant
    // (rkey == f(cid)) is re-proved here — a mismatched pair is rejected even
    // though the caller "verified" out of band.
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p25b'), { rkey: 'not-the-content-address' }),
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('integrity_failed');
  });

  it('round-9 #4 / round-10 #10: refuses a manifest differing from the verified snapshot', () => {
    // Verify release A but try to install manifest B — the attestation carries
    // an immutable canonical snapshot of the bytes the verifier checked, so a
    // divergent manifest is refused (closes "verify A, install B").
    const tampered = { ...runnerManifest(), display_name: 'Totally Different Plugin' };
    const bad = beginInstallVerified({
      manifest: tampered,
      attestation: attest(runnerManifest(), cidFor('p4')),
      nowMs: T0,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('authenticity_failed');

    // Round-10 #10: mutating the ORIGINAL manifest after attesting must NOT
    // sneak past the check (normalize shares nested refs; the snapshot is a
    // frozen string, so the attested bytes can't drift).
    const original = runnerManifest();
    const attestation = attest(original, cidFor('p4mut'));
    (original as { display_name: string }).display_name = 'Mutated After Attest';
    const mutated = beginInstallVerified({ manifest: original, attestation, nowMs: T0 + 1 });
    expect(mutated.ok).toBe(false);
    if (mutated.ok) return;
    expect(mutated.code).toBe('authenticity_failed');

    // The SAME manifest the verifier attested installs fine.
    const good = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p4b')),
      nowMs: T0 + 2,
    });
    expect(good.ok).toBe(true);
  });

  it('P2-7: confirmConsent refuses a device other than the one bound during pairing', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest(), 'p27');
    setRepoProofVerifier(verifier);
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!r.ok) throw new Error('expected pending');
    getPluginInstallRepository()!.bindPendingDevice(r.installId, 'did:key:zbound', T0);
    // A DIFFERENT device cannot hijack activation…
    expect(confirmConsent(r.installId, 'did:key:zhijack', T0 + 1)).toBe(false);
    // …but the bound device activates fine.
    expect(confirmConsent(r.installId, 'did:key:zbound', T0 + 1)).toBe(true);
  });

  it('round-5 #1: the package barrel does NOT export the verified-install door or the attestation constructor', () => {
    // Provenance is only real if the module that mints an attestation is the one
    // that verified. Exporting the constructor to `@dina/core` consumers would
    // let any caller forge a repo_proof attestation. The public install door is
    // `beginInstall` (runs the injected verifier); the "already-verified" entry
    // + its constructor stay internal to the package.
    const barrel = pluginsBarrel as unknown as Record<string, unknown>;
    expect(typeof barrel.beginInstall).toBe('function'); // the real verifier path IS public
    expect(barrel.beginInstallVerified).toBeUndefined();
    expect(barrel.attestVerifiedRelease).toBeUndefined();
  });

  it('PLG-27 #3: no src file OUTSIDE install_service.ts references the verified-install door / attestation minter', () => {
    // The barrel hides these (round-5 #1 above), but the minter is still
    // package-INTERNALLY reachable: any core module could
    // `import { attestVerifiedRelease } from './install_service'` and forge a
    // repo_proof attestation with NO verification. The correct end-state relocates
    // the minter INTO the concrete repo-proof verifier (producer-time, once a real
    // verified-install caller ships). Until then, guard that nothing but its home
    // module even names these symbols — an accidental in-package caller fails CI
    // here. (Comment lines are skipped so docs can still discuss them.)
    const srcRoot = path.join(__dirname, '..', '..', 'src');
    const homeModule = path.join('plugins', 'install_service.ts');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith('.ts') || p.endsWith(homeModule)) continue;
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // skip comments
          if (/\b(attestVerifiedRelease|beginInstallVerified)\b/.test(line)) {
            offenders.push(`${p}: ${trimmed}`);
            break;
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe('P2-10 — late reports surface as an owner-facing decision', () => {
  it('a plugin late report writes a late_report_received decision', () => {
    const wf = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: wf }));
    const installId = 'pli_p10';
    wf.create({
      id: 'task-late',
      kind: 'delegation',
      status: 'running',
      priority: 'normal',
      description: 'booking',
      payload: JSON.stringify({
        type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
        install_id: installId,
        capability_id: 'com.acme.flightwatch.watch',
        params: {},
        context: [],
        manifest_cid: 'c',
        approved_scope_hash: 'a'.repeat(64),
        schema_snapshot: null,
        config_revision: 1,
        execution_id: 'x',
        idempotency_key: 'i',
        action_class: 'booking',
        effects_idempotency: 'supported',
      }),
      result_summary: '',
      policy: '',
      requested_runner: pluginLane(installId),
      created_at: T0,
      updated_at: T0,
      claim_id: 'realclaim',
    });
    // A stale-claim completion loses the CAS → late report → decision surfaced.
    wf.completeWithDetails(
      'task-late',
      'did:key:zr',
      'summ',
      '{"booking_id":"BK1"}',
      '{}',
      T0 + 1,
      'wrongclaim',
    );
    const decisions = getPluginDecisionRepository()!.listByInstall(installId, 10);
    expect(decisions.some((d) => d.decision === 'late_report_received')).toBe(true);
  });
});

describe('round-19 (PLG-29) hardening', () => {
  it('#15: the verified-install boundary rejects a NON-did publisher DID', () => {
    // The finishBegin authority gate used to accept any nonempty publisher. The
    // attestation binds publisherDid, but a garbage value there is now refused
    // before it can persist into the authoritative publisher_did column.
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p29-baddid'), {
        publisherDid: 'acme', // no did: prefix
        kind: 'repo_proof',
      }),
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('authenticity_failed');
  });

  it('#15: the verified-install boundary rejects an OVERSIZED publisher DID', () => {
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p29-longdid'), {
        publisherDid: `did:plc:${'z'.repeat(300)}`,
        kind: 'repo_proof',
      }),
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('authenticity_failed');
  });

  it('#15: a well-formed did: publisher + real CID still installs (no false positive)', () => {
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attest(runnerManifest(), cidFor('p29-ok'), {
        publisherDid: 'did:plc:acme',
        kind: 'repo_proof',
      }),
      nowMs: T0,
    });
    expect(r.ok).toBe(true);
  });
});

describe('round-20 (PLG-30) hardening', () => {
  afterEach(() => jest.restoreAllMocks());

  it('#2: declineConsent honors the removeIfStatus CAS — a raced-to-active row is not reported removed', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begin = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!begin.ok) throw new Error('setup: beginInstall failed');
    const id = begin.installId;
    const installs = getPluginInstallRepository()!;
    // Simulate the race: rawStatus still reads 'pending', but the row activated
    // before the conditional delete, so removeIfStatus refuses (returns false).
    jest.spyOn(installs, 'removeIfStatus').mockReturnValue(false);
    const res = await declineConsent(id, T0 + 1);
    expect(res?.removed).toBe(false);
    // A still-live plugin must NOT get a false consent_declined in the audit log.
    const decisions = getPluginDecisionRepository()!.listByInstall(id, 10);
    expect(decisions.some((d) => d.decision === 'consent_declined')).toBe(false);
  });

  it('#15: a createPending persistence throw returns a typed transient failure, not an escape', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    jest.spyOn(getPluginInstallRepository()!, 'createPending').mockImplementation(() => {
      throw new Error('disk full');
    });
    const r = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('verifier_unavailable');
    expect(r.transient).toBe(true);
  });

  it('#19: a malformed publisher DID is rejected BEFORE the verifier runs', async () => {
    let called = false;
    setRepoProofVerifier(async () => {
      called = true;
      return { ok: true, cid: 'x', rev: 'r', record: runnerManifest() } as RepoProofResult;
    });
    const r = await beginInstall({
      publisherDid: 'not-a-did',
      rkey: 'anything',
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('authenticity_failed');
    expect(called).toBe(false); // never reached the expensive verifier
  });

  it('#20: verifier internals are not leaked into the caller-facing message', async () => {
    // A throwing verifier — the raw error text must not appear in `message`.
    setRepoProofVerifier(async () => {
      throw new Error('https://secret.internal/path?token=abc123');
    });
    const thrown = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: 'r'.repeat(40),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.message).not.toContain('secret.internal');
    // A typed not-ok result — the provider message must not pass through verbatim.
    setRepoProofVerifier(
      async () =>
        ({
          ok: false,
          code: 'not_found',
          transient: false,
          message: 'internal detail xyz',
        }) as unknown as RepoProofResult,
    );
    const rejected = await beginInstall({
      publisherDid: PUBLISHER,
      rkey: 'r'.repeat(40),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).not.toContain('internal detail xyz');
  });
});

describe('round-21 (PLG-31) hardening', () => {
  it('#18: a CORRUPT-but-present install reports removed + records the decision on uninstall', async () => {
    const { rkey, verifier } = fakeVerifier(runnerManifest());
    setRepoProofVerifier(verifier);
    const begin = await beginInstall({
      publisherDid: PUBLISHER,
      rkey,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    if (!begin.ok) throw new Error('setup: beginInstall failed');
    const id = begin.installId;
    const installs = getPluginInstallRepository();
    if (!installs) throw new Error('setup: install repository missing');
    expect(installs.bindPendingDevice(id, 'did:key:zcorrupt', T0)).toBe(true);
    expect(confirmConsent(id, 'did:key:zcorrupt', T0 + 1)).toBe(true);

    // Corrupt the row so the PROJECTION (getById, and remove()'s return value) is
    // null even though the raw row is present + deletable.
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      '{bad json',
      id,
    ]);
    expect(installs.getById(id)).toBeNull(); // projection null...
    expect(installs.rawStatus(id)).not.toBeNull(); // ...but the raw row is present

    const result = await uninstall(id, T0 + 2, async () => ({ durable: true }));
    // Success is determined from RAW existence AFTER the delete, not the null
    // projection — the old `remove() === null` gate misreported this corrupt
    // install's successful teardown as failure AND skipped its decision record.
    expect(result?.removed).toBe(true);
    expect(installs.rawStatus(id)).toBeNull(); // genuinely gone
    expect(
      getPluginDecisionRepository()
        ?.listByInstall(id, 10)
        .some((d) => d.decision === 'uninstalled'),
    ).toBe(true);
  });
});

describe('round-22 (PLG-32) hardening', () => {
  it('#24: a publisher DID with a bidi-override char is rejected BEFORE the verifier runs', async () => {
    let called = false;
    setRepoProofVerifier(async () => {
      called = true;
      return { ok: true, cid: 'x', rev: 'r', record: runnerManifest() } as RepoProofResult;
    });
    const r = await beginInstall({
      // U+202E RIGHT-TO-LEFT OVERRIDE smuggled into the publisher identity.
      publisherDid: `did:plc:${String.fromCharCode(0x202e)}acme`,
      rkey: 'r'.repeat(40),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('authenticity_failed');
    expect(called).toBe(false); // never reached the verifier
  });

  it('#24: a zero-width char in the publisher DID is rejected', async () => {
    setRepoProofVerifier(async () => {
      throw new Error('verifier should not run');
    });
    const r = await beginInstall({
      publisherDid: `did:plc:ac${String.fromCharCode(0x200b)}me`, // zero-width space
      rkey: 'r'.repeat(40),
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('authenticity_failed');
  });
});
