/**
 * The owner-side dispatch producer, end to end through the REAL routes
 * (PLUGIN_ARCHITECTURE §9.1 / §15.5; RESEARCHER_KERNEL §5.D). A country pack
 * is installed through its first-party door, its runner pairs, the owner
 * invokes a rail, and what happens next is what a real node does: the task
 * sits `pending_approval` on the plugin lane where NO claim can reach it; the
 * owner's approve moves the same task to `queued`; the runner claims it under
 * the six checks, completes it, and the result lands only if it fits the
 * pinned schema. Deny cancels; a grant lets the next ask run silent; every
 * owner decision lands in the decision log.
 *
 * Nothing here is faked below the router: SQLite install/grant/decision
 * repositories, the in-memory workflow store, real pairing, real claim guard.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { pluginLane } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetCallerTypeState } from '../../../src/auth/caller_type';
import { COUNTRY_PACK_IDS } from '../../../src/commerce/country_packs';
import { getDeviceByDID, resetDeviceRegistry } from '../../../src/devices/registry';
import { SQLiteDeviceRepository, setDeviceRepository } from '../../../src/devices/repository';
import { PLUGIN_FIRST_N } from '../../../src/gatekeeper/intent';
import { publicKeyToMultibase } from '../../../src/identity/did';
import { clearPairingState, completePairing, getPairingIntent, setNodeDID } from '../../../src/pairing/ceremony';
import { SQLitePluginDecisionRepository, setPluginDecisionRepository } from '../../../src/plugins/decisions';
import { SQLitePluginGrantRepository, setPluginGrantRepository } from '../../../src/plugins/grants';
import { setPluginDeviceVerifier } from '../../../src/plugins/install_service';
import { readInvocationCardPolicy } from '../../../src/plugins/invoke';
import { SQLitePluginInstallRepository, setPluginInstallRepository } from '../../../src/plugins/registry';
import { buildPluginResultCard } from '../../../src/plugins/result_card';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../../src/server/router';
import { registerPluginInstallRoutes } from '../../../src/server/routes/plugin_install';
import { registerPluginInvokeRoutes } from '../../../src/server/routes/plugin_invoke';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { parsePluginEnvelope } from '../../../src/workflow/plugin_envelope';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { getWorkflowService, setWorkflowService, WorkflowService } from '../../../src/workflow/service';

const OWNER_CAP = 'test-owner-capability-secret';
const NODE_DID = 'did:key:z6MkTestNodeDID';
const IN = COUNTRY_PACK_IDS.in;
const UPI_STATUS = `${IN}.upi-payment-status`;
const GSTIN = `${IN}.gstin-validate`;

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;
let workflowRepo: InMemoryWorkflowRepository;
let decisions: SQLitePluginDecisionRepository;
let grants: SQLitePluginGrantRepository;

function req(
  method: 'GET' | 'POST',
  routePath: string,
  body: Record<string, unknown> = {},
  caller: { type: string; did: string } = { type: 'owner', did: 'did:key:owner' },
): CoreRequest {
  return {
    method,
    path: routePath,
    query: {},
    headers: { 'x-did': caller.did },
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: caller.type,
    callerDID: caller.did,
    ...(caller.type === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  } as CoreRequest;
}
const post = (p: string, body: Record<string, unknown> = {}): Promise<CoreResponse> => router.handle(req('POST', p, body));

/** The runner side of §15.3: pair with ITS OWN key on the issued code. */
function runnerPairs(code: string): string {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const publicKey = ed25519.getPublicKey(seed);
  const intent = getPairingIntent(code);
  completePairing(code, 'rails-runner', publicKeyToMultibase(publicKey), intent?.role, intent?.scope);
  return `did:key:${publicKeyToMultibase(publicKey)}`;
}

/** Install the India pack the way the owner does: door → setup code → runner pairs → consent. */
async function installIndiaPack(): Promise<{ installId: string; runnerDid: string }> {
  const begun = await post('/v1/plugins/install/country_pack', { pack: 'in' });
  if (begun.status !== 200) throw new Error(`begin: ${JSON.stringify(begun.body)}`);
  const installId = (begun.body as { installId: string }).installId;
  const issued = await post('/v1/plugins/install/setup_code', { install_id: installId });
  const runnerDid = runnerPairs((issued.body as { code: string }).code);
  const confirmed = await post('/v1/plugins/install/confirm', { install_id: installId });
  if (confirmed.status !== 200) throw new Error(`confirm: ${JSON.stringify(confirmed.body)}`);
  return { installId, runnerDid };
}

const asRunner = (runnerDid: string, p: string, body: Record<string, unknown> = {}): Promise<CoreResponse> =>
  router.handle(req('POST', p, body, { type: 'plugin', did: runnerDid }));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-invoke-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  grants = new SQLitePluginGrantRepository(adapter);
  setPluginGrantRepository(grants);
  decisions = new SQLitePluginDecisionRepository(adapter);
  setPluginDecisionRepository(decisions);
  setDeviceRepository(new SQLiteDeviceRepository(adapter));
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });
  setNodeDID(NODE_DID);
  workflowRepo = new InMemoryWorkflowRepository();
  setWorkflowService(new WorkflowService({ repository: workflowRepo }));
  router = new CoreRouter();
  registerPluginInstallRoutes(router, OWNER_CAP);
  registerPluginInvokeRoutes(router, OWNER_CAP);
  registerWorkflowRoutes(router);
});

afterEach(() => {
  setWorkflowService(null);
  setPluginInstallRepository(null);
  setPluginGrantRepository(null);
  setPluginDecisionRepository(null);
  setPluginDeviceVerifier(null);
  setDeviceRepository(null);
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const UTR_PARAMS = { utr: '3141592653', expected_amount: { currency: 'INR', minor_units: '250000' } };

describe('POST /v1/plugins/invoke — a rail through the gate (§9.1)', () => {
  it('a regulated status lookup cards: the task waits pending_approval on the plugin lane where no claim reaches it', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const res = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    });
    expect(res.status).toBe(202);
    const body = res.body as {
      mode: string;
      task_id: string;
      card: { risk_level: string; reasons: string[]; params_text: string };
    };
    expect(body.mode).toBe('approval_required');
    expect(body.card.risk_level).toBe('HIGH');
    // The owner sees the LITERAL outbound params (§11.5) and why they are asked.
    expect(body.card.params_text).toContain('3141592653');
    // Regulated privacy class → HIGH floor → explicit approval, every time.
    expect(body.card.reasons.join(' ')).toMatch(/high-risk|approval/i);

    const task = workflowRepo.getById(body.task_id);
    expect(task?.status).toBe('pending_approval');
    expect(task?.kind).toBe('delegation');
    expect(task?.requested_runner).toBe(pluginLane(installId));
    const envelope = parsePluginEnvelope(task?.payload ?? '');
    expect(envelope?.authorization_kind).toBe('card');
    expect(envelope?.capability_id).toBe(UPI_STATUS);
    expect(envelope?.params).toEqual(UTR_PARAMS);

    // The runner is paired and polling — and gets NOTHING until the owner decides.
    const claim = await asRunner(runnerDid, '/v1/workflow/tasks/claim');
    expect(claim.status).toBe(204);
  });

  it('approve moves the SAME task to queued; the runner claims it, completes with a conforming result, and the result lands', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };

    const approved = await post(`/v1/workflow/tasks/${invoked.task_id}/approve`);
    expect(approved.status).toBe(200);
    expect(workflowRepo.getById(invoked.task_id)?.status).toBe('queued');
    expect(decisions.listByInstall(installId, 10).map((d) => d.decision)).toContain('invocation_approved');
    // Approve ONCE: no standing authority was minted.
    expect(grants.listByInstall(installId)).toEqual([]);
    // Approving again with a grant block — the task is queued, not pending —
    // is refused (a grant applies only to a PENDING plugin invocation) and
    // mints nothing, logs nothing; a bare re-approve is the transition's 409.
    const again = await post(`/v1/workflow/tasks/${invoked.task_id}/approve`, { plugin_grant: { type: 'window' } });
    expect(again.status).toBe(400);
    expect((await post(`/v1/workflow/tasks/${invoked.task_id}/approve`)).status).toBe(409);
    expect(grants.listByInstall(installId)).toEqual([]);
    expect(decisions.listByInstall(installId, 10).filter((d) => d.decision === 'invocation_approved')).toHaveLength(1);

    const claim = await asRunner(runnerDid, '/v1/workflow/tasks/claim');
    expect(claim.status).toBe(200);
    const claimed = claim.body as { id: string; claim_id: string; payload: string };
    expect(claimed.id).toBe(invoked.task_id);
    // The runner receives the envelope the owner approved — the same bytes.
    expect(parsePluginEnvelope(claimed.payload)?.params).toEqual(UTR_PARAMS);

    const result = { status: 'settled', settled_at: '2026-09-13T10:00:00Z', provider_ref: 'psp-77' };
    const completed = await asRunner(runnerDid, `/v1/workflow/tasks/${invoked.task_id}/complete`, {
      claim_id: claimed.claim_id,
      result: JSON.stringify(result),
    });
    expect(completed.status).toBe(200);
    const done = workflowRepo.getById(invoked.task_id);
    expect(done?.status).toBe('completed');
    expect(JSON.parse(done?.result ?? '{}')).toEqual(result);

    // The owner reads the answer off the task — the rail informs, the owner still acks the khata.
    const read = await router.handle(req('GET', `/v1/workflow/tasks/${invoked.task_id}`));
    expect(read.status).toBe(200);
    expect((read.body as { task: { status: string; result?: string } }).task.status).toBe('completed');
    expect(JSON.parse((read.body as { task: { result?: string } }).task.result ?? '{}')).toEqual(result);
  });

  it('§15.6 — the completed task renders through the pack’s own card template, end to end', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };
    await post(`/v1/workflow/tasks/${invoked.task_id}/approve`);
    const claimed = (await asRunner(runnerDid, '/v1/workflow/tasks/claim')).body as { claim_id: string };
    await asRunner(runnerDid, `/v1/workflow/tasks/${invoked.task_id}/complete`, {
      claim_id: claimed.claim_id,
      result: JSON.stringify({ status: 'settled', settled_at: '2026-09-13T10:00:00Z', provider_ref: 'psp-77' }),
    });

    const done = workflowRepo.getById(invoked.task_id);
    if (done === null) throw new Error('unreachable');
    const card = buildPluginResultCard({
      status: done.status,
      payload: done.payload,
      ...(done.result !== undefined ? { result: done.result } : {}),
    });
    // The India pack's own template, filled from the pinned-schema-validated
    // answer. Dina's words are the labels; the runner supplied only values.
    expect(card?.blocks).toEqual([
      { kind: 'title', text: 'Payment status', icon: 'price' },
      { kind: 'stat', value: 'settled', caption: 'as the rail reports it' },
      { kind: 'keyValue', label: 'Settled at', value: '2026-09-13T10:00:00Z' },
      { kind: 'keyValue', label: 'Provider reference', value: 'psp-77' },
    ]);
  });

  it("a result outside the pinned schema never lands — the task fails, the runner's word is not a fact", async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };
    await post(`/v1/workflow/tasks/${invoked.task_id}/approve`);
    const claimed = (await asRunner(runnerDid, '/v1/workflow/tasks/claim')).body as { claim_id: string };

    const completed = await asRunner(runnerDid, `/v1/workflow/tasks/${invoked.task_id}/complete`, {
      claim_id: claimed.claim_id,
      // `status` must be one of settled|pending|failed|unknown.
      result: JSON.stringify({ status: 'probably' }),
    });
    expect(completed.status).toBe(200);
    const task = workflowRepo.getById(invoked.task_id);
    expect(task?.status).toBe('failed');
    expect(task?.result ?? '').not.toContain('probably');
  });

  it('deny cancels the task, records the decision, and the runner still gets nothing', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };

    const denied = await post(`/v1/workflow/tasks/${invoked.task_id}/cancel`, { reason: 'not this one' });
    expect(denied.status).toBe(200);
    expect(workflowRepo.getById(invoked.task_id)?.status).toMatch(/cancel/);
    const log = decisions.listByInstall(installId, 10);
    expect(log.map((d) => d.decision)).toContain('invocation_denied');
    expect(log.find((d) => d.decision === 'invocation_denied')?.reason).toBe('not this one');
    expect((await asRunner(runnerDid, '/v1/workflow/tasks/claim')).status).toBe(204);
  });

  it('Brain cannot decide a plugin card: approve and cancel are 403, nothing moves, no grant, no decision', async () => {
    const { installId } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };
    const brain = { type: 'brain', did: 'did:key:brain' };
    const approve = await router.handle(
      req('POST', `/v1/workflow/tasks/${invoked.task_id}/approve`, { plugin_grant: { type: 'window' } }, brain),
    );
    expect(approve.status).toBe(403);
    const cancel = await router.handle(req('POST', `/v1/workflow/tasks/${invoked.task_id}/cancel`, {}, brain));
    expect(cancel.status).toBe(403);
    expect(workflowRepo.getById(invoked.task_id)?.status).toBe('pending_approval');
    expect(grants.listByInstall(installId)).toEqual([]);
    expect(decisions.listByInstall(installId, 10).map((d) => d.decision)).not.toEqual(
      expect.arrayContaining(['invocation_approved', 'invocation_denied', 'grant_created']),
    );
  });

  it('a deny with a long, multi-line reason still lands: 200, cancelled, and one clean line in the decision log', async () => {
    const { installId } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };
    const reason = `not now\nask again tomorrow\n${'x'.repeat(600)}`;
    const denied = await post(`/v1/workflow/tasks/${invoked.task_id}/cancel`, { reason });
    expect(denied.status).toBe(200);
    expect(workflowRepo.getById(invoked.task_id)?.status).toMatch(/cancel/);
    const logged = decisions.listByInstall(installId, 10).find((d) => d.decision === 'invocation_denied');
    expect(logged).toBeDefined();
    expect(logged?.reason).not.toMatch(/\n/);
    expect(logged?.reason.length).toBeLessThanOrEqual(200);
    expect(logged?.reason.startsWith('not now ask again tomorrow')).toBe(true);
  });

  it('a regulated rail cards EVERY time — a live window grant, past first-N, never silences it', async () => {
    const { installId } = await installIndiaPack();
    const first = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };
    expect(
      (await post(`/v1/workflow/tasks/${first.task_id}/approve`, { plugin_grant: { type: 'window', hours: 24 } })).status,
    ).toBe(200);
    // The grant is LIVE for this exact scope — the only thing that could silence.
    const scopeHash = parsePluginEnvelope(workflowRepo.getById(first.task_id)?.payload ?? '')?.approved_scope_hash ?? '';
    expect(grants.hasLiveGrant(installId, UPI_STATUS, scopeHash, Math.floor(Date.now() / 1000))).toBe(true);
    // And the owner is past §8's first-N, so first-N cannot be what cards.
    for (let i = 0; i < PLUGIN_FIRST_N; i++) {
      decisions.record({ installId, capability: UPI_STATUS, decision: 'invocation_approved', nowSec: Math.floor(Date.now() / 1000) });
    }
    const second = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: { ...UTR_PARAMS, utr: '2718281828' },
      param_categories: ['payment'],
    });
    const body = second.body as { mode: string; task_id: string };
    expect(body.mode).toBe('approval_required');
    expect(parsePluginEnvelope(workflowRepo.getById(body.task_id)?.payload ?? '')?.authorization_kind).toBe('card');
    // The card names Core's decided risk in Core-owned facts, not the plugin's words.
    const policy = readInvocationCardPolicy(workflowRepo.getById(body.task_id) ?? { policy: '' });
    expect(policy?.risk_level).toBe('HIGH');
    expect(workflowRepo.getById(body.task_id)?.description).toBe(`plugin invocation ${UPI_STATUS}`);
  });
});

const GSTIN_PARAMS = { gstin: '27AAPFU0939F1ZV' };

/**
 * §11 — the owner's route may name WHO and WHAT the task is about. It may not
 * name the context itself: Core projects that, which is the whole point of the
 * projector. These pin the seam rather than the projection (which
 * `context_projection.test.ts` and the rails own): a bad subject is refused,
 * a good one reaches the projector, and the card reports the result.
 */
describe('the subject (§11): identities in, context projected', () => {
  it('refuses a subject that is not an object of strings, rather than ignoring it', async () => {
    const { installId } = await installIndiaPack();
    for (const subject of [7, 'did:plc:someone', [], { contact_did: 5 }, { document_digest: {} }]) {
      const res = await post('/v1/plugins/invoke', {
        install_id: installId,
        capability_id: UPI_STATUS,
        params: UTR_PARAMS,
        param_categories: ['payment'],
        subject,
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a subject identity that is not a bounded, plain string', async () => {
    const { installId } = await installIndiaPack();
    const res = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
      subject: { contact_did: `did:plc:x${'y'.repeat(4000)}` },
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('params_invalid');
  });

  it('a body that tries to push its OWN context is simply not a field — Core projects, callers do not', async () => {
    const { installId } = await installIndiaPack();
    const res = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
      context: [{ category: 'payment', fields: { card: '4111111111111111' } }],
    });
    expect(res.status).toBe(202);
    const task = workflowRepo.getById((res.body as { task_id: string }).task_id);
    const envelope = parsePluginEnvelope(task?.payload ?? '');
    expect(envelope?.context).toEqual([]);
    expect(task?.payload).not.toContain('4111111111111111');
  });

  it('the card reports what the projection added, as counts and category names', async () => {
    const { installId } = await installIndiaPack();
    const res = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: { gstin: '27AAPFU0939F1ZV' },
      param_categories: ['business_registry'],
    });
    expect(res.status).toBe(202);
    const card = (res.body as { card: { context: { categories: string[]; item_count: number } } }).card;
    // No commerce runtime on this rig, so no source is registered and the
    // honest answer is nothing — reported, never omitted.
    expect(card.context).toEqual({ categories: [], item_count: 0 });
  });
});

describe('the grant path (§8, §15.5 "Allow for 24 hours")', () => {

  it('a public read cards once; approved with a window grant, the next ask runs silent, queued under that grant, and the runner claims it', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const first = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    });
    // A custom id floors at MODERATE (§8 rule 5): the first ask cards.
    expect((first.body as { mode: string; card: { risk_level: string } }).mode).toBe('approval_required');
    expect((first.body as { card: { risk_level: string } }).card.risk_level).toBe('MODERATE');
    const firstId = (first.body as { task_id: string }).task_id;

    const approved = await post(`/v1/workflow/tasks/${firstId}/approve`, { plugin_grant: { type: 'window', hours: 24 } });
    expect(approved.status).toBe(200);
    const live = grants.listByInstall(installId).filter((g) => g.revokedAt === undefined);
    expect(live).toHaveLength(1);
    expect(live[0]?.grantType).toBe('window');
    expect(live[0]?.capability).toBe(GSTIN);
    expect(decisions.listByInstall(installId, 10).map((d) => d.decision)).toEqual(
      expect.arrayContaining(['invocation_approved', 'grant_created']),
    );
    // Drain the approved first task so the lane holds only what the grant dispatches next.
    const c1 = (await asRunner(runnerDid, '/v1/workflow/tasks/claim')).body as { id: string; claim_id: string };
    expect(c1.id).toBe(firstId);
    await asRunner(runnerDid, `/v1/workflow/tasks/${firstId}/complete`, {
      claim_id: c1.claim_id,
      result: JSON.stringify({ valid: true }),
    });

    const second = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: { gstin: '29AAACG1234A1Z5' },
      param_categories: ['business_registry'],
    });
    expect(second.status).toBe(202);
    const body = second.body as { mode: string; task_id: string; grant_id?: string };
    expect(body.mode).toBe('dispatched');
    expect(body.grant_id).toBe(live[0]?.grantId);
    const task = workflowRepo.getById(body.task_id);
    expect(task?.status).toBe('queued');
    const envelope = parsePluginEnvelope(task?.payload ?? '');
    expect(envelope?.authorization_kind).toBe('grant');
    expect(envelope?.grant_id).toBe(live[0]?.grantId);
    // The grant was CHARGED for this execution — the claim guard's check 7b.
    expect(grants.getUse(live[0]?.grantId ?? '', envelope?.execution_id ?? '')).not.toBeNull();

    // Check 7 (live grant + consumed use + digest) passes and the runner gets the task.
    const c2 = (await asRunner(runnerDid, '/v1/workflow/tasks/claim')).body as { id: string };
    expect(c2.id).toBe(body.task_id);
  });

  it('a revoked grant does not carry a queued task past the claim guard', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    const first = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { task_id: string };
    await post(`/v1/workflow/tasks/${first.task_id}/approve`, { plugin_grant: { type: 'window' } });
    const c1 = (await asRunner(runnerDid, '/v1/workflow/tasks/claim')).body as { claim_id: string };
    await asRunner(runnerDid, `/v1/workflow/tasks/${first.task_id}/complete`, {
      claim_id: c1.claim_id,
      result: JSON.stringify({ valid: true }),
    });
    const second = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { mode: string; task_id: string; grant_id: string };
    expect(second.mode).toBe('dispatched');

    grants.revoke(second.grant_id, Math.floor(Date.now() / 1000));
    const claim = await asRunner(runnerDid, '/v1/workflow/tasks/claim');
    expect(claim.status).toBe(204);
    expect(workflowRepo.getById(second.task_id)?.status).toBe('failed');
  });

  it('an unbounded standing grant on a write rail is refused with the approval untouched', async () => {
    const { installId } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: `${IN}.eway-bill`,
      params: {
        delivery_note_digest: 'a'.repeat(64),
        consignor_gstin: '27AAPFU0939F1ZV',
        consignee_gstin: '29AAACG1234A1Z5',
        value: { currency: 'INR', minor_units: '1000000' },
      },
      param_categories: ['tax_filing'],
    })).body as { task_id: string };
    const res = await post(`/v1/workflow/tasks/${invoked.task_id}/approve`, { plugin_grant: { type: 'standing' } });
    expect(res.status).toBe(400);
    expect(workflowRepo.getById(invoked.task_id)?.status).toBe('pending_approval');
    expect(grants.listByInstall(installId)).toEqual([]);
    // Consent itself is logged at install; no invocation decision was.
    expect(decisions.listByInstall(installId, 10).map((d) => d.decision)).not.toEqual(
      expect.arrayContaining(['invocation_approved', 'grant_created']),
    );
  });

  it('an unbounded standing grant is refused on a custom READ too — every installable id is custom today', async () => {
    const { installId } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { task_id: string };
    const res = await post(`/v1/workflow/tasks/${invoked.task_id}/approve`, { plugin_grant: { type: 'standing' } });
    expect(res.status).toBe(400);
    expect(workflowRepo.getById(invoked.task_id)?.status).toBe('pending_approval');
    expect(grants.listByInstall(installId)).toEqual([]);
    // Bounded (an expiry) is accepted.
    const bounded = await post(`/v1/workflow/tasks/${invoked.task_id}/approve`, {
      plugin_grant: { type: 'standing', expires_in_hours: 72, constraints: { version: 1, max_count: 10 } },
    });
    expect(bounded.status).toBe(200);
    expect(grants.listByInstall(installId).map((g) => g.grantType)).toEqual(['standing']);
  });

  it('a plugin_grant on a pending task that is NOT a plugin invocation is refused, not dropped — whatever branch would otherwise approve it', async () => {
    const service = getWorkflowService();
    if (service === null) throw new Error('unreachable');
    const payloads: Record<string, unknown>[] = [
      { type: 'intent_validation', action: 'send_email' },
      // The agent persona-access and coding-gate branches run BEFORE the
      // generic approve; the refusal must sit ahead of all of them.
      { type: 'agent_persona_access', agent_did: 'did:key:agent', persona: 'health', mode: 'read', scope: 'ask' },
      { type: 'remote_coding_gate_v1', action: 'run', tool_name: 'bash', source_device_did: 'did:key:dev' },
    ];
    for (const [i, payload] of payloads.entries()) {
      const id = `non-plugin-${i}`;
      service.create({
        id,
        kind: 'approval',
        description: `pending ${String(payload.type)}`,
        payload: JSON.stringify(payload),
        initialState: 'pending_approval' as never,
      });
      const res = await post(`/v1/workflow/tasks/${id}/approve`, { plugin_grant: { type: 'window' } });
      expect(res.status).toBe(400);
      expect(workflowRepo.getById(id)?.status).toBe('pending_approval');
    }
    // Without the block the intent approve goes through as before.
    expect((await post('/v1/workflow/tasks/non-plugin-0/approve')).status).toBe(200);
  });

  it("Core says whether a grant could ever silence the card: no for a regulated rail, yes for a public read (§8) — the phone's Allow-24h reads this", async () => {
    const { installId } = await installIndiaPack();
    const regulated = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
    })).body as { task_id: string };
    expect(readInvocationCardPolicy(workflowRepo.getById(regulated.task_id) ?? { policy: '' })?.grant_can_silence).toBe(false);
    const publicRead = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { task_id: string };
    expect(readInvocationCardPolicy(workflowRepo.getById(publicRead.task_id) ?? { policy: '' })?.grant_can_silence).toBe(true);
    // A write rail with a `regulated` class cannot be silenced either; a `personal` one can.
    const eway = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: `${IN}.eway-bill`,
      params: {
        delivery_note_digest: 'a'.repeat(64),
        consignor_gstin: '27AAPFU0939F1ZV',
        consignee_gstin: '29AAACG1234A1Z5',
        value: { currency: 'INR', minor_units: '1000000' },
      },
      param_categories: ['tax_filing'],
    })).body as { task_id: string };
    expect(readInvocationCardPolicy(workflowRepo.getById(eway.task_id) ?? { policy: '' })?.grant_can_silence).toBe(false);
  });

  it('a malformed plugin_grant is a 400, not a guess', async () => {
    const { installId } = await installIndiaPack();
    const invoked = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { task_id: string };
    for (const bad of [{ type: 'window', hours: 48 }, { type: 'forever' }, 'window']) {
      const res = await post(`/v1/workflow/tasks/${invoked.task_id}/approve`, { plugin_grant: bad });
      expect(res.status).toBe(400);
    }
    expect(workflowRepo.getById(invoked.task_id)?.status).toBe('pending_approval');
  });
});

describe('refusals and dedup', () => {
  it('owner-only; unknown install 404; missing required param 400; unclassified params still card', async () => {
    const { installId } = await installIndiaPack();
    const device = await router.handle(
      req('POST', '/v1/plugins/invoke', { install_id: installId, capability_id: GSTIN, params: {} }, { type: 'device', did: 'did:key:dev' }),
    );
    expect(device.status).toBe(403);
    expect((await post('/v1/plugins/invoke', { install_id: 'nope', capability_id: GSTIN, params: {} })).status).toBe(404);
    const invalid = await post('/v1/plugins/invoke', { install_id: installId, capability_id: UPI_STATUS, params: {} });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { code: string }).code).toBe('params_invalid');
    const unclassified = await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: { gstin: '27AAPFU0939F1ZV' },
    });
    expect((unclassified.body as { mode: string; card: { reasons: string[] } }).mode).toBe('approval_required');
    expect((unclassified.body as { card: { reasons: string[] } }).card.reasons.join(' ')).toMatch(/classified/);
  });

  it('a capability outside the install is refused; a pending (unconsented) install is refused', async () => {
    const { installId } = await installIndiaPack();
    const foreign = await post('/v1/plugins/invoke', { install_id: installId, capability_id: 'com.acme.other', params: {} });
    expect(foreign.status).toBe(409);
    expect((foreign.body as { code: string }).code).toBe('capability_not_consented');
    const pending = (await post('/v1/plugins/install/country_pack', { pack: 'us' })).body as { installId: string };
    const notActive = await post('/v1/plugins/invoke', {
      install_id: pending.installId,
      capability_id: `${COUNTRY_PACK_IDS.us}.sales-tax-rate`,
      params: { postal_code: '94105', state: 'CA' },
    });
    expect((notActive.body as { code: string }).code).toBe('install_not_active');
  });

  it('an idempotency_key, resource or value the envelope parser would quarantine is refused up front, and no grant use is charged', async () => {
    const { installId } = await installIndiaPack();
    // A live grant on the GSTIN read, so a silent dispatch WOULD charge a use.
    const first = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { task_id: string };
    await post(`/v1/workflow/tasks/${first.task_id}/approve`, { plugin_grant: { type: 'window' } });
    const grantId = grants.listByInstall(installId)[0]?.grantId ?? '';
    const before = workflowRepo.listNonTerminalByRunner(pluginLane(installId)).length;
    for (const bad of [
      { idempotency_key: '' },
      { idempotency_key: 'k'.repeat(300) },
      { idempotency_key: 'evil\u202e' },
      { resource: '' },
      { resource: 'r\u200b' },
      { value: Number.POSITIVE_INFINITY },
    ]) {
      const res = await post('/v1/plugins/invoke', {
        install_id: installId,
        capability_id: GSTIN,
        params: GSTIN_PARAMS,
        param_categories: ['business_registry'],
        ...bad,
      });
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('params_invalid');
    }
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(before);
    // The grant has a use for the FIRST task only — none for the refused asks.
    expect(grants.getById(grantId)).not.toBeNull();
    const uses = workflowRepo
      .listNonTerminalByRunner(pluginLane(installId))
      .map((t) => parsePluginEnvelope(t.payload)?.execution_id ?? '')
      .filter((e) => grants.getUse(grantId, e) !== null);
    expect(uses).toHaveLength(0);
  });

  it('the same logical ask under one idempotency key answers with the live task instead of a second card', async () => {
    const { installId } = await installIndiaPack();
    const ask = {
      install_id: installId,
      capability_id: UPI_STATUS,
      params: UTR_PARAMS,
      param_categories: ['payment'],
      idempotency_key: 'khata:payment-note:abc',
    };
    const first = (await post('/v1/plugins/invoke', ask)).body as { task_id: string };
    const second = (await post('/v1/plugins/invoke', ask)).body as { task_id: string; mode: string };
    expect(second.task_id).toBe(first.task_id);
    expect(second.mode).toBe('approval_required');
    expect(workflowRepo.listNonTerminalByRunner(pluginLane(installId))).toHaveLength(1);
  });
});

describe("the Brain-facing verbs (§6): list what `/ask` may route to, ask with a narrow body", () => {
  const brain = { type: 'brain', did: 'did:key:brain' };

  it('lists every consented tool capability on an active install, with its schema and data scope; a pending install lists nothing', async () => {
    const { installId } = await installIndiaPack();
    await post('/v1/plugins/install/country_pack', { pack: 'us' }); // pending, not consented
    const res = await router.handle(req('GET', '/v1/plugins/tool-capabilities', {}, brain));
    expect(res.status).toBe(200);
    const caps = (res.body as { capabilities: { install_id: string; capability_id: string; data_scope_categories: string[]; params_schema: unknown }[] }).capabilities;
    expect(caps.every((c) => c.install_id === installId)).toBe(true);
    expect(caps.map((c) => c.capability_id).sort()).toEqual(
      [UPI_STATUS, GSTIN, `${IN}.eway-bill`, `${IN}.whatsapp-reminder`].sort(),
    );
    const upi = caps.find((c) => c.capability_id === UPI_STATUS);
    expect(upi?.data_scope_categories).toEqual(['payment']);
    expect((upi?.params_schema as { required: string[] }).required).toContain('utr');
    // The phone's own Brain calls arrive in-process with no caller type — the same door.
    const inProcess = await router.handle({ ...req('GET', '/v1/plugins/tool-capabilities'), callerType: undefined, ownerCapability: undefined } as never);
    expect(inProcess.status).toBe(200);
  });

  it('Brain asks through the same gate: the ask cards for the owner, and dispatch metadata in its body is ignored', async () => {
    const { installId, runnerDid } = await installIndiaPack();
    // A live grant on GSTIN with a resource constraint that only 'allowed' satisfies.
    const first = (await post('/v1/plugins/invoke', {
      install_id: installId,
      capability_id: GSTIN,
      params: GSTIN_PARAMS,
      param_categories: ['business_registry'],
    })).body as { task_id: string };
    await post(`/v1/workflow/tasks/${first.task_id}/approve`, {
      plugin_grant: { type: 'standing', expires_in_hours: 24, constraints: { version: 1, resources: ['allowed'] } },
    });
    const c1 = (await asRunner(runnerDid, '/v1/workflow/tasks/claim')).body as { claim_id: string };
    await asRunner(runnerDid, `/v1/workflow/tasks/${first.task_id}/complete`, { claim_id: c1.claim_id, result: JSON.stringify({ valid: true }) });

    // Brain names resource 'allowed' — the one value that would fit the grant. It is dropped.
    const res = await router.handle(
      req('POST', '/v1/plugins/tool-invoke', {
        install_id: installId,
        capability_id: GSTIN,
        params: GSTIN_PARAMS,
        param_categories: ['business_registry'],
        resource: 'allowed',
        value: 1,
        idempotency_key: 'brain-chosen',
      }, brain),
    );
    expect(res.status).toBe(202);
    const body = res.body as { mode: string; task_id: string };
    // With the grant's constraint unmet (no resource named by Core), the ask cards.
    expect(body.mode).toBe('approval_required');
    const task = workflowRepo.getById(body.task_id);
    expect(task?.status).toBe('pending_approval');
    expect(task?.origin).toBe('system');
    const envelope = parsePluginEnvelope(task?.payload ?? '');
    expect(envelope?.resource).toBeUndefined();
    expect(envelope?.idempotency_key).not.toBe('brain-chosen');
  });

  it('a device caller is refused on both verbs; a bad body is a 400', async () => {
    const { installId } = await installIndiaPack();
    const device = { type: 'device', did: 'did:key:dev' };
    expect((await router.handle(req('GET', '/v1/plugins/tool-capabilities', {}, device))).status).toBe(403);
    expect((await router.handle(req('POST', '/v1/plugins/tool-invoke', { install_id: installId, capability_id: GSTIN, params: {} }, device))).status).toBe(403);
    expect((await router.handle(req('POST', '/v1/plugins/tool-invoke', { install_id: installId, capability_id: GSTIN }, brain))).status).toBe(400);
    expect(
      (await router.handle(req('POST', '/v1/plugins/tool-invoke', { install_id: installId, capability_id: GSTIN, params: {}, param_categories: 'x' }, brain))).status,
    ).toBe(400);
  });
});
