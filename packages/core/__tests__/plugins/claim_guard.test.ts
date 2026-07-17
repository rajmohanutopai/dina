/**
 * PLG-6 — the six claim-time checks + exact-match plugin lanes
 * (PLUGIN_ARCHITECTURE.md §9.0/§9.1), driven through the REAL workflow
 * routes: this is the launch gate ("no third-party runner pairs until
 * it ships server-side"), so the tests speak raw route requests the
 * way a malicious runner would.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { PLUGIN_NSIDS, pluginLane, type PluginManifest } from '@dina/protocol';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../src/plugins/grants';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../src/server/router';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { PLUGIN_INVOCATION_PAYLOAD_TYPE } from '../../src/workflow/plugin_envelope';
import {
  WorkflowService,
  setWorkflowService,
  getWorkflowService,
} from '../../src/workflow/service';

import type { WorkflowTask } from '../../src/workflow/domain';

const T0 = 1_750_000_000_000;
const PLUGIN_DID = 'did:key:zplugininstance';
const SCOPE_HASH = 'c'.repeat(64);
const CAP = 'com.acme.flightwatch.watch';

const manifest: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.acme.flightwatch',
  version: '1.2.0',
  display_name: 'Flight Watch',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: CAP,
      display_name: 'Watch a flight',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'unsupported' },
      // The pinned result schema is a MANIFEST fact; the claim guard now
      // re-derives the envelope's schema_snapshot from here (F6), so the
      // default envelope's snapshot must match this.
      result_schema: { type: 'object' },
    },
  ],
};

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let workflowRepo: InMemoryWorkflowRepository;
let router: CoreRouter;
let installId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plg6-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);

  workflowRepo = new InMemoryWorkflowRepository();
  setWorkflowService(new WorkflowService({ repository: workflowRepo }));

  router = new CoreRouter();
  registerWorkflowRoutes(router);

  installId = installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: 'com.acme.flightwatch',
    label: '',
    executionMode: 'runner',
    currentCid: 'bafyreicid1',
    currentVersion: '1.2.0',
    manifest,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [CAP]: SCOPE_HASH },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
    nowMs: T0,
  });
  installs.activate(installId, PLUGIN_DID, T0);
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setWorkflowService(null);
  try {
    adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let seq = 0;

/** The result schema currently pinned by the install's manifest — the
 * source the claim guard re-derives schema_snapshot from (F6). */
function currentResultSchema(): unknown {
  const inst = installs.getById(installId);
  const cap = inst?.manifest.capabilities.find((c) => c.id === CAP);
  return cap?.result_schema ?? null;
}

/** Rebuild the bound install so its capability pins `resultSchema` — used
 * by the result-validation tests, which now flow the pinned schema through
 * the manifest (F6) rather than asserting it independently on the envelope. */
function reinstallWithResultSchema(resultSchema: unknown): void {
  installs.remove(installId);
  const m = {
    ...manifest,
    capabilities: [{ ...manifest.capabilities[0], result_schema: resultSchema }],
  } as PluginManifest;
  installId = installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: 'com.acme.flightwatch',
    label: '',
    executionMode: 'runner',
    currentCid: 'bafyreicid1',
    currentVersion: '1.2.0',
    manifest: m,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [CAP]: SCOPE_HASH },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
    nowMs: T0,
  });
  installs.activate(installId, PLUGIN_DID, T0);
}

function enqueue(overrides: Partial<Record<string, unknown>> = {}, lane?: string): string {
  seq += 1;
  const id = `task_${seq}`;
  const payload = JSON.stringify({
    type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
    install_id: installId,
    capability_id: CAP,
    params: { flight: 'BA117' },
    context: [],
    manifest_cid: 'bafyreicid1',
    approved_scope_hash: SCOPE_HASH,
    // Derived from the install manifest by default so the F6 cross-check
    // passes on the happy path; a test may still override to prove
    // divergence terminalizes.
    schema_snapshot: currentResultSchema(),
    config_revision: 1,
    execution_id: `exec_${seq}`,
    idempotency_key: `idem_${seq}`,
    action_class: 'read',
    effects_idempotency: 'unsupported',
    ...overrides,
  });
  const task: WorkflowTask = {
    id,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: 'plugin invocation',
    payload,
    result_summary: '',
    policy: '',
    requested_runner: lane ?? pluginLane(installId),
    // Round-7 #6: a plugin task MUST carry the SAME idempotency key in its
    // column as the envelope. Mirror the envelope's default (or an override).
    idempotency_key: (overrides.idempotency_key as string | undefined) ?? `idem_${seq}`,
    created_at: T0 + seq,
    updated_at: T0 + seq,
  };
  workflowRepo.create(task);
  return id;
}

function pluginReq(
  reqPath: string,
  body: Record<string, unknown> = {},
  callerType = 'plugin',
  callerDID = PLUGIN_DID,
): CoreRequest {
  return {
    method: 'POST',
    path: reqPath,
    query: {},
    headers: { 'x-did': callerDID },
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType,
    callerDID,
  };
}

async function claim(body: Record<string, unknown> = {}): Promise<CoreResponse> {
  return router.handle(pluginReq('/v1/workflow/tasks/claim', body));
}

// ---------------------------------------------------------------------------

describe('plugin claim — the forced lane (§9.1 check 1)', () => {
  it('claims its own lane task; client-sent runner_filter is ignored', async () => {
    const id = enqueue();
    const res = await claim({ runner_filter: 'plugin:someone-else' });
    expect(res.status).toBe(200);
    const task = res.body as { id: string; claim_id?: string; attempt?: number };
    expect(task.id).toBe(id);
    expect(task.claim_id).toMatch(/^[0-9a-f]{32}$/);
    expect(task.attempt).toBe(1);
  });

  it('403s a plugin device with no bound install', async () => {
    const res = await router.handle(
      pluginReq('/v1/workflow/tasks/claim', {}, 'plugin', 'did:key:zunbound'),
    );
    expect(res.status).toBe(403);
  });

  it('a generic agent (empty filter) can NEVER take plugin-lane tasks', async () => {
    enqueue();
    const res = await router.handle(
      pluginReq('/v1/workflow/tasks/claim', {}, 'agent', 'did:key:zagent'),
    );
    expect(res.status).toBe(204);
  });

  it('AUDIT D4 CRITICAL: a generic agent NAMING the plugin lane in runner_filter is REJECTED (403), not routed to the generic path', async () => {
    const id = enqueue();
    const res = await router.handle(
      pluginReq(
        '/v1/workflow/tasks/claim',
        { runner_filter: pluginLane(installId) },
        'agent',
        'did:key:zagent',
      ),
    );
    expect(res.status).toBe(403);
    expect((res.body as { reason?: string }).reason).toMatch(/paired plugin instance/);
    // The task is untouched — still claimable by the legitimate instance.
    expect(workflowRepo.getById(id)?.status).toBe('queued');
    expect((await claim()).status).toBe(200);
  });

  it('a named runner cannot take plugin-lane tasks via the back-compat clause', () => {
    enqueue();
    const got = workflowRepo.claimDelegationTask('did:key:zagent', T0 + 100, 30_000, 'eta_runner');
    expect(got).toBeNull();
  });
});

describe('claim check 2 — install active (pause = queued tasks wait)', () => {
  it('paused install: 204, task stays queued', async () => {
    const id = enqueue();
    installs.pause(installId, T0 + 1);
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.status).toBe('queued');
    installs.resume(installId, T0 + 2);
    expect((await claim()).status).toBe(200);
  });
});

describe('claim checks 3/5/6 — stale authority TERMINALIZES (§9.1)', () => {
  it('scope-hash drift: stale task fails with stale_authority; a valid task behind it still claims', async () => {
    const stale = enqueue({ approved_scope_hash: 'old'.padEnd(64, 'x') });
    const valid = enqueue();
    const res = await claim();
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(valid);
    const staleTask = workflowRepo.getById(stale);
    expect(staleTask?.status).toBe('failed');
    expect(staleTask?.error).toContain('stale_authority');
  });

  it('config-revision drift (approve-then-reconfigure) terminalizes', async () => {
    const id = enqueue(); // pinned config_revision: 1
    installs.bumpConfigRevision(installId, T0 + 1); // now 2
    const res = await claim();
    expect(res.status).toBe(204);
    const task = workflowRepo.getById(id);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('settings changed');
  });

  it('capability no longer consented terminalizes', async () => {
    const id = enqueue({ capability_id: 'com.acme.flightwatch.removed' });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('no longer consented');
  });

  it('AUDIT F7: a capability NOT consented as a tool cannot serve a tool-lane task', async () => {
    // Reinstall so the capability is provider-only (present in the hash
    // map, so check 3 passes) but NOT a tool. A tool task on the lane
    // must still terminalize — presence in the consent map is not
    // consent to serve as a tool.
    installs.remove(installId);
    const providerOnly = {
      ...manifest,
      capabilities: [{ ...manifest.capabilities[0], kinds: ['provider'] }],
    } as PluginManifest;
    installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.flightwatch',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreicid1',
      currentVersion: '1.2.0',
      manifest: providerOnly,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: SCOPE_HASH },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(installId, PLUGIN_DID, T0);
    const id = enqueue();
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('not consented as a tool');
  });

  it('AUDIT F6: an envelope whose action_class diverges from the manifest terminalizes', async () => {
    const id = enqueue({ action_class: 'booking' }); // manifest says 'read'
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('action_class diverged');
  });

  it('AUDIT F6: an envelope pinning a DIFFERENT result schema than the manifest terminalizes (permissive-schema smuggle)', async () => {
    // A stale/incorrect producer tries to pin a wide-open schema.
    const id = enqueue({ schema_snapshot: { type: 'object', additionalProperties: true } });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('result schema diverged');
  });

  it('AUDIT F6: an envelope pointing at a different manifest CID terminalizes', async () => {
    const id = enqueue({ manifest_cid: 'bafyreiOTHER' });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('manifest CID diverged');
  });

  it('round-6 #8: an envelope idempotency key that diverges from the task column terminalizes', async () => {
    seq += 1;
    const id = `task_${seq}`;
    const payload = JSON.stringify({
      type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
      install_id: installId,
      capability_id: CAP,
      params: { flight: 'BA117' },
      context: [],
      manifest_cid: 'bafyreicid1',
      approved_scope_hash: SCOPE_HASH,
      schema_snapshot: currentResultSchema(),
      config_revision: 1,
      execution_id: `exec_${seq}`,
      idempotency_key: 'envelope-key',
      action_class: 'read',
      effects_idempotency: 'unsupported',
    });
    workflowRepo.create({
      id,
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'plugin invocation',
      payload,
      result_summary: '',
      policy: '',
      requested_runner: pluginLane(installId),
      idempotency_key: 'task-column-key-DIFFERENT', // diverges from the envelope
      created_at: T0,
      updated_at: T0,
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('idempotency key diverged');
  });

  it('round-7 #6: a plugin task with a MISSING idempotency column terminalizes (must match exactly)', async () => {
    seq += 1;
    const id = `task_${seq}`;
    const payload = JSON.stringify({
      type: PLUGIN_INVOCATION_PAYLOAD_TYPE,
      install_id: installId,
      capability_id: CAP,
      params: { flight: 'BA117' },
      context: [],
      manifest_cid: 'bafyreicid1',
      approved_scope_hash: SCOPE_HASH,
      schema_snapshot: currentResultSchema(),
      config_revision: 1,
      execution_id: `exec_${seq}`,
      idempotency_key: 'envelope-key',
      action_class: 'read',
      effects_idempotency: 'unsupported',
    });
    // No idempotency_key column on the task — Core and the runner would then
    // deduplicate differently. Exact equality is required, so this terminalizes.
    workflowRepo.create({
      id,
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'plugin invocation',
      payload,
      result_summary: '',
      policy: '',
      requested_runner: pluginLane(installId),
      created_at: T0,
      updated_at: T0,
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('idempotency key diverged');
  });

  it('P1-2: an envelope whose context exceeds the consented data_scope terminalizes at the claim gate', async () => {
    // The default manifest capability declares NO data_scope → no context is
    // permitted. A producer that skipped buildPluginEnvelope's bound and
    // smuggled raw context onto the lane is caught by the non-bypassable claim
    // guard (defence-in-depth), never dispatched to the runner.
    const id = enqueue({ context: [{ raw: 'vault row' }] });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('context violates the consented data_scope');
    // A non-array context (unmeasurable) is likewise terminalized.
    const id2 = enqueue({ context: { raw: 'blob' } });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id2)?.error).toContain('context violates the consented data_scope');
  });

  it('round-11 #4: an envelope with params too DEEP to fully inspect terminalizes at the claim gate', async () => {
    // A producer that skipped buildPluginEnvelope's depth bound smuggled params
    // nested past the inspection ceiling (MAX_PARAM_DEPTH=12) — the owner would
    // approve deep values they never saw. The non-bypassable claim gate refuses.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 14; i++) deep = { n: deep };
    const id = enqueue({ params: deep });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('cannot be fully inspected');
  });

  it('malformed envelope on a plugin lane is an integrity failure, never dispatched', async () => {
    seq += 1;
    workflowRepo.create({
      id: `task_${seq}`,
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'smuggled',
      payload: JSON.stringify({ type: 'free_form_task', text: 'no envelope' }),
      result_summary: '',
      policy: '',
      requested_runner: pluginLane(installId),
      created_at: T0,
      updated_at: T0,
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(`task_${seq}`)?.error).toContain('malformed plugin envelope');
  });
});

describe('claim check 7 — the EXACT authorizing grant must still be live (round-12 #2/#3/#6)', () => {
  function makeGrant(grants: SQLitePluginGrantRepository): string {
    grants.create(
      {
        installId,
        capability: CAP,
        approvedScopeHash: SCOPE_HASH,
        grantType: 'standing',
        constraints: { version: 1, max_count: 5 },
      },
      'read',
      T0,
    );
    return grants.listByInstall(installId)[0]!.grantId;
  }

  it('a grant-authorized task whose EXACT grant was revoked terminalizes as stale_authority', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    const id = enqueue({ authorization_kind: 'grant', grant_id: grantId });
    // Owner revokes the exact authorizing grant after the task was queued.
    grants.revoke(grantId, Math.floor(T0 / 1000) + 1);
    expect((await claim()).status).toBe(204);
    const task = workflowRepo.getById(id);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('stale_authority');
    expect(task?.error).toContain('authorizing grant is missing, revoked');
  });

  it('a grant-authorized task with a CONSUMED grant + matching digest claims through check 7', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    // Round-13 #3/#4: the producer CONSUMES the grant (writes the use row +
    // digest) then stamps the same grant_id + execution_id + digest on the
    // envelope. The claim guard requires all three to line up.
    // PLG-29 #4: the consume MUST bind the SAME invocation the envelope carries
    // (params { flight: 'BA117' }, context []) — check 7b now RECOMPUTES the
    // digest from the envelope's own fields and requires it to equal the consumed
    // one. A consume that omitted these would hash a different (empty) invocation
    // and the recompute would (correctly) reject the dispatched one.
    const execId = 'exec-grant-1';
    grants.authorizeAndConsume({
      installId,
      capability: CAP,
      approvedScopeHash: SCOPE_HASH,
      executionId: execId,
      params: { flight: 'BA117' },
      context: [],
      nowSec: Math.floor(T0 / 1000),
    });
    const digest = grants.getUse(grantId, execId)!.invocationDigest!;
    const id = enqueue({
      authorization_kind: 'grant',
      grant_id: grantId,
      execution_id: execId,
      invocation_digest: digest,
    });
    const res = await claim();
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(id);
  });

  it('#3: a grant-authorized task that NAMES a live grant but never CONSUMED it terminalizes', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    // Live grant, but no authorizeAndConsume call → no use row. A producer that
    // skipped the consume would bypass once/max_count/resource/value.
    const id = enqueue({
      authorization_kind: 'grant',
      grant_id: grantId,
      execution_id: 'never-consumed',
      invocation_digest: 'anything',
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('grant was never consumed');
  });

  it('#4: a grant-authorized task whose pinned digest disagrees with the consumed use terminalizes', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    const execId = 'exec-digest-x';
    grants.authorizeAndConsume({
      installId,
      capability: CAP,
      approvedScopeHash: SCOPE_HASH,
      executionId: execId,
      nowSec: Math.floor(T0 / 1000),
    });
    // The use row exists, but the envelope pins a DIFFERENT digest than the one
    // consumed — the dispatched invocation isn't the one charged to the grant.
    const id = enqueue({
      authorization_kind: 'grant',
      grant_id: grantId,
      execution_id: execId,
      invocation_digest: 'f'.repeat(64),
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('invocation digest');
  });

  it('PLG-29 #4: consume invocation A, dispatch invocation B carrying A digest — recompute rejects', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    const execId = 'exec-swap';
    // The producer CONSUMES invocation A (params { flight: 'BA117' }) → use row
    // pins A's digest. It then stamps that SAME (valid, use-row-matching) digest
    // on an envelope whose params are SWAPPED to B. The old check compared the
    // stamped digest to the use row (both A) and would have passed; the PLG-29
    // recompute hashes the ENVELOPE's own params (B) and rejects the mismatch.
    grants.authorizeAndConsume({
      installId,
      capability: CAP,
      approvedScopeHash: SCOPE_HASH,
      executionId: execId,
      params: { flight: 'BA117' },
      context: [],
      nowSec: Math.floor(T0 / 1000),
    });
    const digestA = grants.getUse(grantId, execId)!.invocationDigest!;
    const id = enqueue({
      authorization_kind: 'grant',
      grant_id: grantId,
      execution_id: execId,
      params: { flight: 'HACKED-BA999' }, // invocation B, not what was consumed
      invocation_digest: digestA, // A's digest — matches the use row, but not B
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('invocation digest');
  });

  it('#2: a task authorized by grant A does NOT ride a later live grant B for the same scope', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantA = makeGrant(grants);
    const id = enqueue({ authorization_kind: 'grant', grant_id: grantA });
    // A new consent for the SAME scope creates grant B and (Round-11 #15)
    // tombstones grant A. B is live, but the task rode A — it must NOT claim.
    makeGrant(grants); // grant B (A is now revoked)
    expect(grants.getById(grantA)?.revokedAt).toBeGreaterThan(0);
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('authorizing grant is missing, revoked');
  });

  it('#3: a grant-authorized task fails CLOSED when the grant repo is unavailable', async () => {
    // No grant repo wired, but the envelope declares grant authorization —
    // liveness cannot be verified, so the claim must terminalize, not dispatch.
    setPluginGrantRepository(null);
    const id = enqueue({ authorization_kind: 'grant', grant_id: 'plg_whatever' });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('grant repository unavailable');
  });

  it('#6: a CARD-authorized task is not terminalized by a tombstoned grant row for its scope', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    // A grant for this scope exists but is revoked (tombstoned). A separately
    // card-approved task for the same scope must still claim — provenance, not
    // scope-existence, decides.
    const grantId = makeGrant(grants);
    grants.revoke(grantId, Math.floor(T0 / 1000) + 1);
    const id = enqueue({ authorization_kind: 'card' });
    const res = await claim();
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(id);
  });

  it('an envelope with NO authorization provenance applies no grant check', async () => {
    // Legacy / not-yet-stamped envelope + a wired grant repo with a tombstoned
    // grant for the scope: still claims (no provenance → no grant requirement).
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    grants.revoke(makeGrant(grants), Math.floor(T0 / 1000) + 1);
    const id = enqueue(); // no authorization_kind
    const res = await claim();
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(id);
  });

  it('round-14 #8: a task whose authorizing grant has CORRUPT constraints terminalizes at claim', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    // Consume the grant legitimately FIRST (check 7b needs the use row + digest),
    // so the failure below is check 7's corruption gate, not a missing consume.
    const execId = 'exec-corrupt-1';
    grants.authorizeAndConsume({
      installId,
      capability: CAP,
      approvedScopeHash: SCOPE_HASH,
      executionId: execId,
      nowSec: Math.floor(T0 / 1000),
    });
    const digest = grants.getUse(grantId, execId)!.invocationDigest!;
    // A divergent-node restore leaves an unparseable constraints blob on the grant.
    adapter.run('UPDATE plugin_grants SET constraints_json = ? WHERE grant_id = ?', [
      '{not valid json',
      grantId,
    ]);
    expect(grants.getById(grantId)?.constraintsCorrupt).toBe(true);
    const id = enqueue({
      authorization_kind: 'grant',
      grant_id: grantId,
      execution_id: execId,
      invocation_digest: digest,
    });
    expect((await claim()).status).toBe(204);
    expect(workflowRepo.getById(id)?.error).toContain('corrupt');
  });

  it('round-14 #9: a STRING-typed revoked_at reads REVOKED (fail closed), not live', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    // A divergent-node restore / type-affinity edge leaves revoked_at as TEXT — a
    // bare `typeof === 'number'` would DROP it and read the grant as live.
    adapter.run('UPDATE plugin_grants SET revoked_at = ? WHERE grant_id = ?', [
      'revoked-marker',
      grantId,
    ]);
    // Projection sets revokedAt (not undefined) so claim-guard's `=== undefined`
    // live check reads dead.
    expect(grants.getById(grantId)?.revokedAt).not.toBeUndefined();
    const res = grants.authorizeAndConsume({
      installId,
      capability: CAP,
      approvedScopeHash: SCOPE_HASH,
      executionId: 'exec-str-rev',
      nowSec: Math.floor(T0 / 1000),
    });
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('revoked');
  });

  it('round-14 #9: a non-finite STRING expires_at reads EXPIRED (unenforceable bound)', async () => {
    const grants = new SQLitePluginGrantRepository(adapter);
    setPluginGrantRepository(grants);
    const grantId = makeGrant(grants);
    adapter.run('UPDATE plugin_grants SET expires_at = ? WHERE grant_id = ?', [
      'not-a-number',
      grantId,
    ]);
    // Projection lands as already-expired (epoch 0 ≤ any nowSec).
    expect(grants.getById(grantId)?.expiresAt).toBe(0);
    const res = grants.authorizeAndConsume({
      installId,
      capability: CAP,
      approvedScopeHash: SCOPE_HASH,
      executionId: 'exec-str-exp',
      nowSec: Math.floor(T0 / 1000),
    });
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('expired');
  });
});

describe('claim tokens on the four verbs (§9.1)', () => {
  it('plugin heartbeat/complete without claim_id → 400', async () => {
    enqueue();
    const claimed = (await claim()).body as { id: string; claim_id: string };
    const hb = await router.handle(
      pluginReq(`/v1/workflow/tasks/${claimed.id}/heartbeat`, { lease_seconds: 30 }),
    );
    expect(hb.status).toBe(400);
    const done = await router.handle(
      pluginReq(`/v1/workflow/tasks/${claimed.id}/complete`, { result: '{}' }),
    );
    expect(done.status).toBe(400);
  });

  it('wrong claim_id loses the CAS (409); right claim_id completes (200)', async () => {
    enqueue();
    const claimed = (await claim()).body as { id: string; claim_id: string };
    const stale = await router.handle(
      pluginReq(`/v1/workflow/tasks/${claimed.id}/complete`, {
        result: '{"zombie":true}',
        claim_id: 'f'.repeat(32),
      }),
    );
    expect(stale.status).toBe(409);
    expect(workflowRepo.getById(claimed.id)?.status).toBe('running'); // untouched

    const live = await router.handle(
      pluginReq(`/v1/workflow/tasks/${claimed.id}/complete`, {
        result: '{"ok":true}',
        claim_id: claimed.claim_id,
      }),
    );
    expect(live.status).toBe(200);
    expect(workflowRepo.getById(claimed.id)?.status).toBe('completed');
  });

  it('a plugin can never complete a task another instance holds (ownership gate)', async () => {
    enqueue();
    const claimed = (await claim()).body as { id: string; claim_id: string };
    const res = await router.handle(
      pluginReq(
        `/v1/workflow/tasks/${claimed.id}/complete`,
        { result: '{}', claim_id: claimed.claim_id },
        'plugin',
        'did:key:zotherinstance',
      ),
    );
    expect(res.status).toBe(403);
  });

  it('plugin callers cannot approve or cancel tasks (owner decisions)', async () => {
    enqueue();
    const claimed = (await claim()).body as { id: string };
    for (const verb of ['approve', 'cancel']) {
      const res = await router.handle(pluginReq(`/v1/workflow/tasks/${claimed.id}/${verb}`, {}));
      expect(res.status).toBe(403);
    }
  });
});

describe('pinned-schema result validation on completion (§9.1)', () => {
  it('a nonconforming result FAILS the task instead of applying (result rejected)', async () => {
    // The manifest pins {status:string}; the runner returns junk. The
    // pinned schema flows through the manifest (F6), not an envelope
    // assertion, so it survives the claim-guard cross-check.
    reinstallWithResultSchema({
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string' } },
      additionalProperties: false,
    });
    enqueue();
    const claimed = (await claim()).body as { id: string; claim_id: string };
    const res = await router.handle(
      pluginReq(`/v1/workflow/tasks/${claimed.id}/complete`, {
        result: '{"leaked":"tracking-pixel"}',
        claim_id: claimed.claim_id,
      }),
    );
    // The task action returns a `failed` task (200 envelope), not completed.
    expect(res.status).toBe(200);
    const task = workflowRepo.getById(claimed.id);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('result rejected');
  });

  it('a conforming result completes normally', async () => {
    reinstallWithResultSchema({
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string' } },
    });
    enqueue();
    const claimed = (await claim()).body as { id: string; claim_id: string };
    const res = await router.handle(
      pluginReq(`/v1/workflow/tasks/${claimed.id}/complete`, {
        result: '{"status":"watching"}',
        claim_id: claimed.claim_id,
      }),
    );
    expect(res.status).toBe(200);
    expect(workflowRepo.getById(claimed.id)?.status).toBe('completed');
  });
});

describe('service-level claim CAS message', () => {
  it('a stale-claim completion surfaces as a CAS loss, not a generic terminal error', async () => {
    enqueue();
    const claimed = (await claim()).body as { id: string };
    const service = getWorkflowService();
    expect(() =>
      service!.complete(claimed.id, '{}', 'summary', PLUGIN_DID, '0'.repeat(32)),
    ).toThrow(/claim CAS/);
  });
});

describe('round-14 workflow lane + read hardening', () => {
  it('#2: a plugin-LANE task with a stripped type field still hits the pinned-envelope gate on complete', async () => {
    seq += 1;
    const id = `task_${seq}`;
    const claimId = 'a'.repeat(32);
    // A plugin-lane task whose payload lost its `type` field (so
    // payloadDeclaresPluginType=false AND parsePluginEnvelope=null), seeded
    // directly in running state as if it slipped past the claim gate. Completed
    // by a NON-plugin (admin) caller, so ONLY the lane co-trigger can force the
    // pinned-envelope path. Old code would apply the arbitrary result unvalidated.
    workflowRepo.create({
      id,
      kind: 'delegation',
      status: 'running',
      priority: 'normal',
      description: 'stripped',
      payload: JSON.stringify({ install_id: installId, capability_id: CAP, params: {} }),
      result_summary: '',
      policy: '',
      requested_runner: pluginLane(installId),
      agent_did: 'did:key:zsomeplugin',
      claim_id: claimId,
      created_at: T0,
      updated_at: T0,
    } as unknown as WorkflowTask);
    await router.handle(
      pluginReq(
        `/v1/workflow/tasks/${id}/complete`,
        { result: '{"anything":true}', claim_id: claimId },
        'admin',
        'did:key:zadmin',
      ),
    );
    const task = workflowRepo.getById(id);
    expect(task?.status).toBe('failed'); // fail-closed, arbitrary result never applied
    expect(task?.error).toContain('plugin envelope missing');
  });

  it('#10: an agent may read its OWN running task but not once it is TERMINAL', async () => {
    const agentDID = 'did:key:zownagent';
    const mkGet = (taskId: string): CoreRequest => ({
      method: 'GET',
      path: `/v1/workflow/tasks/${taskId}`,
      query: {},
      headers: { 'x-did': agentDID },
      body: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: agentDID,
    });
    const base = {
      kind: 'delegation',
      priority: 'normal',
      description: 'own',
      payload: JSON.stringify({ type: 'free_form_task', text: 'x' }),
      result_summary: '',
      policy: '',
      agent_did: agentDID,
      created_at: T0,
      updated_at: T0,
    };
    seq += 1;
    const runningId = `task_${seq}`;
    workflowRepo.create({ ...base, id: runningId, status: 'running' } as unknown as WorkflowTask);
    seq += 1;
    const doneId = `task_${seq}`;
    workflowRepo.create({ ...base, id: doneId, status: 'completed' } as unknown as WorkflowTask);

    expect((await router.handle(mkGet(runningId))).status).toBe(200);
    // Terminal → 403: the runner has no live business re-fetching its projected
    // params/context once the task is done.
    expect((await router.handle(mkGet(doneId))).status).toBe(403);
  });
});
