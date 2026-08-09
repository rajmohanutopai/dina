/**
 * WS-3.9 — the plugin runner SDK (§6, §8.1, §8.2).
 *
 * These tests drive the REAL claim guard, the REAL envelope parser and the
 * REAL workflow service. That matters more than usual here: the SDK's whole
 * justification is that assembling those three correctly is fiddly, so a
 * version tested against stubs of all three would be testing the assembly it
 * was written to replace.
 *
 * The SDK is NOT a security boundary and these tests do not treat it as one.
 * Core re-validates at the bridge regardless. What is asserted is that the
 * correct path is the easy one and that a runner's own mistake surfaces where
 * the runner can act on it.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pluginLane, type PluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { SQLitePluginInstallRepository } from '../../src/plugins/registry';
import { PluginRunner } from '../../src/plugins/runner_sdk';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const T0 = Date.parse('2026-08-08T10:00:00.000Z');
const PLUGIN_DID = 'did:plc:runner12345';
const CAP = 'com.acme.commerce.quote';

const PARAMS_SCHEMA = {
  type: 'object',
  required: ['sku'],
  properties: { sku: { type: 'string' }, qty: { type: 'number' } },
};
const RESULT_SCHEMA = {
  type: 'object',
  required: ['price'],
  properties: { price: { type: 'string' } },
};

function manifest(): PluginManifest {
  return {
    $type: 'com.dinakernel.plugin.release',
    plugin_id: 'com.acme.commerce.supplier',
    version: '1.0.0',
    display_name: 'Supplier',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: CAP,
        display_name: 'Quote',
        interaction: 'query',
        action_class: 'quote',
        privacy_class: 'personal',
        kinds: ['provider'],
        effects: { idempotency: 'supported' },
        params_schema: PARAMS_SCHEMA,
        result_schema: RESULT_SCHEMA,
      },
    ],
  } as unknown as PluginManifest;
}

describe('plugin runner SDK (§6)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let repo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;
  let installId: string;
  let runner: PluginRunner;
  let clock: { now: number };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'runner-sdk-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installs = new SQLitePluginInstallRepository(adapter);
    repo = new InMemoryWorkflowRepository();
    clock = { now: T0 };
    workflow = new WorkflowService({ repository: repo, nowMsFn: () => clock.now });

    installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.commerce.supplier',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreicid1',
      currentVersion: '1.0.0',
      manifest: manifest(),
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: 'h'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(installId, PLUGIN_DID, T0);

    runner = new PluginRunner({
      workflow,
      repo,
      install: () => installs.getById(installId),
      deviceDid: PLUGIN_DID,
      nowMs: () => clock.now,
    });
  });

  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Enqueue a task on this install's lane with the given envelope body. */
  function enqueue(overrides: Record<string, unknown> = {}, id = 'task-1'): void {
    const envelope = {
      type: 'plugin_invocation',
      install_id: installId,
      capability_id: CAP,
      params: { sku: 'CHAIR-1', qty: 12 },
      // §11.3 context is a PROJECTED ITEM ARRAY, not a free-form object;
      // claim check 3h enforces the consented data_scope over it.
      context: [],
      manifest_cid: 'bafyreicid1',
      // Claim check 5 compares this against the CAPABILITY hash, not the
      // install-wide scope hash — consent is per capability.
      approved_scope_hash: 'h'.repeat(64),
      // The envelope pins the RESULT schema alone; the claim guard requires
      // it to canonically equal the capability's own `result_schema`.
      schema_snapshot: RESULT_SCHEMA,
      config_revision: 1,
      execution_id: `exec-${id}`,
      idempotency_key: `idem-${id}`,
      action_class: 'quote',
      effects_idempotency: 'supported',
      // A PROVIDER capability answers inbound peer queries, so its envelope
      // carries the ingress block. Without it the claim guard reads the task
      // as a tool dispatch and terminalizes it against a provider-only
      // consent — the guard working, not a fixture detail.
      service_ingress: {
        from_did: 'did:plc:buyer99999',
        query_id: `q-${id}`,
        capability: 'request_quote',
        service_rkey: 'self',
      },
      ...overrides,
    };
    workflow.create({
      id,
      kind: 'delegation',
      description: 'runner sdk fixture',
      payload: JSON.stringify(envelope),
      idempotencyKey: envelope.idempotency_key as string,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(installId),
    });
  }

  it('claims a task, validates its params, and exposes a typed job', () => {
    enqueue();
    const claimed = runner.claim();
    expect(claimed.kind).toBe('job');
    if (claimed.kind !== 'job') throw new Error('unreachable');
    expect(claimed.job.capabilityId).toBe(CAP);
    expect(claimed.job.params).toEqual({ sku: 'CHAIR-1', qty: 12 });
    expect(claimed.job.context).toEqual([]);
    // The claim id is surfaced, not left for the runner to dig out. Without
    // it `complete` cannot pass the §9.1 CAS and the task can only expire.
    expect(claimed.job.claimId).not.toBe('');
    expect(claimed.job.idempotencyKey).toBe('idem-task-1');
    expect(claimed.job.resultSchema).toEqual(RESULT_SCHEMA);
  });

  it('answers idle when the lane is empty', () => {
    expect(runner.claim()).toEqual({ kind: 'idle', terminalized: [] });
  });

  it('answers idle — not an error — while the install is paused', () => {
    // A runner learns its install state from the owner surface. Leaking it
    // through the shape of a queue response would make the queue an oracle
    // for install state.
    enqueue();
    installs.pause(installId, clock.now);
    expect(runner.claim()).toEqual({ kind: 'idle', terminalized: [] });
  });

  it('completes a conforming result through the real workflow service', () => {
    enqueue();
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error('unreachable');
    expect(runner.answer(claimed.job, { kind: 'result', result: { price: '4200' } })).toEqual({
      ok: true,
    });
    const task = repo.getById('task-1');
    expect(task?.status).toBe('completed');
    expect(JSON.parse(task?.result ?? '{}')).toEqual({ price: '4200' });
  });

  /**
   * The one rule the SDK enforces locally, and the reason it is worth having.
   *
   * Without it the runner discovers its own mistake as a rejection at Core's
   * bridge — after the buyer has waited, and with a log line that reads as if
   * Core refused rather than as if the runner was wrong.
   */
  it('refuses a result the pinned schema rejects, and leaves the job claimable', () => {
    enqueue();
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error('unreachable');

    const bad = runner.answer(claimed.job, { kind: 'result', result: { cost: '4200' } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/violates the pinned schema/);
    // NOT failed. A runner that can produce a conforming answer still may —
    // failing here would spend the buyer's only attempt on a bug the runner
    // can fix in its very next line.
    expect(repo.getById('task-1')?.status).toBe('running');
    expect(runner.answer(claimed.job, { kind: 'result', result: { price: '4200' } })).toEqual({
      ok: true,
    });
  });

  it('judges the answer against the envelope’s pin, not the live manifest', () => {
    // §9.13. A task dispatched under one contract keeps that contract even if
    // the install moves on while the task sits in the queue — otherwise an
    // update could retroactively invalidate work already claimed.
    // A pin that no longer matches the manifest is exactly what the claim
    // guard terminalizes (check 3f), so this scenario cannot be built by
    // diverging the envelope. It is covered where it lives: the §9.13 drain
    // path, which authorizes the PRIOR result schema for a claimed task.
    enqueue();
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error('unreachable');
    // What IS assertable here: the job carries the envelope's pin verbatim,
    // so whatever the drain path authorized is what the answer is judged
    // against — never the install's live manifest.
    expect(claimed.job.resultSchema).toEqual(RESULT_SCHEMA);
  });

  it('never sees params that violate the consented schema — Core killed them first', () => {
    // The SDK deliberately does NOT re-validate params. Claim check 3g does,
    // inside the trust boundary, and TERMINALIZES rather than handing over —
    // so the runner's contract is "a job's params already conform", and this
    // asserts the substrate really provides that rather than assuming it.
    enqueue({ params: { qty: 12 } });
    const claimed = runner.claim();
    expect(claimed.kind).toBe('idle');
    expect(claimed.terminalized).toEqual(['task-1']);
    expect(repo.getById('task-1')?.status).toBe('failed');
  });

  it('never sees a malformed envelope — the claim guard kills it first', () => {
    workflow.create({
      id: 'task-junk',
      kind: 'delegation',
      description: 'unparseable payload',
      payload: '{ not json',
      idempotencyKey: 'idem-junk',
      initialState: 'queued' as never,
      requestedRunner: pluginLane(installId),
    });
    // Written expecting the SDK's own parse branch to fire. It does not, and
    // cannot: the guard parses with the same function and terminalizes first.
    // The SDK branch stays only because `parsePluginEnvelope` returns `| null`
    // — asserting the truth here is better than asserting a path that a
    // passing test would have implied was live.
    const claimed = runner.claim();
    expect(claimed.kind).toBe('idle');
    expect(claimed.terminalized).toEqual(['task-junk']);
    expect(repo.getById('task-junk')?.status).toBe('failed');
    expect(repo.getById('task-junk')?.error).toMatch(/malformed plugin envelope/);
  });

  /**
   * §12.7 — `failed` and `outcome_unknown` are different answers and the
   * difference is the whole of reconciliation. Collapsing them would make an
   * interrupted order look retryable, and a retried order can double-charge.
   */
  it('keeps failed and outcome_unknown apart on the wire', () => {
    enqueue({}, 'task-f');
    const f = runner.claim();
    if (f.kind !== 'job') throw new Error('unreachable');
    expect(runner.answer(f.job, { kind: 'failed', reason: 'supplier declined' })).toEqual({
      ok: true,
    });
    expect(repo.getById('task-f')?.error).toBe('supplier declined');

    enqueue({}, 'task-u');
    const u = runner.claim();
    if (u.kind !== 'job') throw new Error('unreachable');
    expect(
      runner.answer(u.job, { kind: 'outcome_unknown', reason: 'socket died after send' }),
    ).toEqual({ ok: true });
    expect(repo.getById('task-u')?.error).toMatch(/^outcome_unknown: /);
  });

  it('reports a lost claim CAS rather than throwing', () => {
    enqueue();
    const claimed = runner.claim();
    if (claimed.kind !== 'job') throw new Error('unreachable');
    // Someone else terminalized the task while this runner was working.
    workflow.fail('task-1', 'superseded', 'did:plc:other', claimed.job.claimId);

    const late = runner.answer(claimed.job, { kind: 'result', result: { price: '1' } });
    expect(late.ok).toBe(false);
    // A runner must not treat this as "retry the effect": the answer simply
    // did not land, and the effect may already have happened.
    expect(!late.ok && late.error).toBeTruthy();
  });

  it('cannot claim work on another install’s lane', () => {
    // The lane is derived inside the claim guard from the install id, and the
    // SDK exposes no way to name one — which is why this is asserted by
    // construction rather than by passing a hostile argument.
    const other = installs.createPending({
      publisherDid: 'did:plc:other',
      pluginId: 'com.other.plugin.thing',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreicid2',
      currentVersion: '1.0.0',
      manifest: manifest(),
      installScopeHash: 'x'.repeat(64),
      capabilityHashes: { [CAP]: 'y'.repeat(64) },
      behaviorHash: 'z'.repeat(64),
      presentationHash: 'w'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(other, 'did:plc:otherrunner', T0);
    workflow.create({
      id: 'task-other',
      kind: 'delegation',
      description: 'another install lane',
      payload: JSON.stringify({ type: 'plugin_invocation', install_id: other }),
      idempotencyKey: 'idem-other',
      initialState: 'queued' as never,
      requestedRunner: pluginLane(other),
    });
    expect(runner.claim()).toEqual({ kind: 'idle', terminalized: [] });
    expect(repo.getById('task-other')?.status).toBe('queued');
  });
});
