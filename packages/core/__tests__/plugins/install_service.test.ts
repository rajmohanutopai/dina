/**
 * PLG-7 — install flow: repo-proof verifier seam, install-by-AT-URI,
 * consent/activation lifecycle, uninstall, abandoned sweep
 * (PLUGIN_ARCHITECTURE.md §5, §14, §20). Real SQLite engine + an
 * injected fake verifier.
 */

import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import {
  PLUGIN_NSIDS,
  base32Encode,
  releaseRkeyFromCid,
  type PluginManifest,
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
  terminateInstallInFlight,
} from '../../src/plugins/install_service';
import { pluginLane } from '@dina/protocol';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';
import { PLUGIN_INVOCATION_PAYLOAD_TYPE } from '../../src/workflow/plugin_envelope';

const T0 = 1_750_000_000_000;
const T0_SEC = Math.floor(T0 / 1000);
const PUBLISHER = 'did:plc:acme';

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
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  setRepoProofVerifier(null);
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

  it('declineConsent unwinds the pending install and reports the paired device to revoke', async () => {
    const id = await pending();
    // A device paired during the ceremony — bound through the real seam.
    expect(getPluginInstallRepository()!.bindPendingDevice(id, 'did:key:zorphan', T0 + 1)).toBe(
      true,
    );
    const result = await declineConsent(id, T0 + 3);
    expect(result).toEqual({ removed: true, deviceDid: 'did:key:zorphan' });
    expect(getPluginInstallRepository()!.getById(id)).toBeNull();
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

  it('uninstall revokes grants, removes the row, and returns the device to revoke', async () => {
    const id = await pending();
    expect(getPluginInstallRepository()!.bindPendingDevice(id, 'did:key:zinstance', T0)).toBe(true);
    confirmConsent(id, 'did:key:zinstance', T0 + 1);
    const result = await uninstall(id, T0 + 2);
    expect(result).toEqual({ removed: true, deviceDid: 'did:key:zinstance' });
    expect(getPluginInstallRepository()!.getById(id)).toBeNull();
    // Decision log survives (records of the past).
    const recent = getPluginDecisionRepository()!.listByInstall(id, 10);
    expect(recent.some((d) => d.decision === 'uninstalled')).toBe(true);
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
      attestation: attestVerifiedRelease({ cid: cidFor('malformed'), verifierKind: 'repo_proof' }),
      publisherDid: PUBLISHER,
      trustAnchor: { kind: 'repo_proof' },
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
      attestation: attestVerifiedRelease({ cid, verifierKind: 'repo_proof' }),
      publisherDid: PUBLISHER,
      trustAnchor: { kind: 'repo_proof' },
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
  it('P2-5: beginInstallVerified binds the attestation verifier kind to the trust anchor', () => {
    // A boolean is not provenance: authority now flows from a verifier-minted
    // attestation whose kind must MATCH the anchor being recorded. An
    // org_key-minted token cannot be used to persist a repo_proof anchor.
    const r = beginInstallVerified({
      manifest: runnerManifest(),
      attestation: attestVerifiedRelease({ cid: cidFor('p25'), verifierKind: 'org_key' }),
      publisherDid: PUBLISHER,
      trustAnchor: { kind: 'repo_proof' },
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
      attestation: attestVerifiedRelease({
        cid: cidFor('p25b'),
        rkey: 'not-the-content-address',
        verifierKind: 'repo_proof',
      }),
      publisherDid: PUBLISHER,
      trustAnchor: { kind: 'repo_proof' },
      nowMs: T0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('integrity_failed');
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
