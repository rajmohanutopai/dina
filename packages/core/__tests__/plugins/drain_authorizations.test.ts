/**
 * Drain authorizations (§9.13, CMC-6): the claim guard admits a
 * prior-CID envelope ONLY through a live entry pinning the authorized
 * prior values; expiry and release end the lane; teardown drops
 * entries.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { pluginLane, type PluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { claimPluginTask } from '../../src/plugins/claim_guard';
import { buildPluginEnvelope } from '../../src/plugins/dispatch';
import {
  InMemoryDrainAuthorizationRepository,
  SQLiteDrainAuthorizationRepository,
  setDrainAuthorizationRepository,
  type DrainAuthorization,
  type DrainAuthorizationRepository,
} from '../../src/plugins/drain_authorizations';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
  type PluginInstall,
} from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const CAP = 'com.acme.commerce.order_status';
const PLUGIN_DID = 'did:plc:plugindevice';
const T0 = 1_700_000_000_000;

const manifest = {
  $type: 'com.dinakernel.plugin.release',
  plugin_id: 'com.acme.commerce.supplier',
  version: '0.1.0',
  display_name: 'Supplier',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: CAP,
      display_name: 'Order status',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['provider'],
      result_schema: null,
    },
  ],
} as unknown as PluginManifest;

describe('drain authorization store (dual harness)', () => {
  function cases(repo: DrainAuthorizationRepository, cleanup: () => void): void {
    const entry: DrainAuthorization = {
      installId: 'inst-1',
      previousCid: 'bafyreiprior',
      capabilityId: CAP,
      kind: 'lifecycle_continuity',
      authorizedKinds: ['provider'],
      approvedScopeHash: 'h'.repeat(64),
      configRevision: 3,
      actionClass: 'read',
      effectsIdempotency: 'supported',
      resultSchemaJson: 'null',
      paramsSchemaJson: 'null',
      maxContextItems: null,
      expiresAt: null,
      // §9.13 — which CONTRACT this row speaks, not just which CID.
      priorVersion: '0.1.0',
      createdAt: T0,
    };
    try {
      expect(repo.put(entry)).toBe(true);
      expect(repo.put(entry)).toBe(false);
      expect(repo.listLive('inst-1', 'bafyreiprior', CAP, T0 + 1).map((e) => e.kind)).toEqual([
        'lifecycle_continuity',
      ]);
      // Expiring drain entry.
      expect(repo.put({ ...entry, kind: 'drain', expiresAt: T0 + 100 })).toBe(true);
      // BOTH kinds live at once — the normal post-rebind state. listLive
      // must surface both so the claim guard can admit on either.
      expect(
        repo
          .listLive('inst-1', 'bafyreiprior', CAP, T0 + 50)
          .map((e) => e.kind)
          .sort(),
      ).toEqual(['drain', 'lifecycle_continuity']);
      expect(repo.listLive('inst-1', 'bafyreiprior', CAP, T0 + 200)).toHaveLength(1); // drain expired
      expect(repo.release('inst-1', 'bafyreiprior', CAP, 'lifecycle_continuity')).toBe(true);
      expect(repo.listLive('inst-1', 'bafyreiprior', CAP, T0 + 200)).toEqual([]);
      expect(repo.listLive('inst-1', 'bafyreiprior', CAP, T0 + 50)).toHaveLength(1); // drain still live
      expect(repo.removeByInstall('inst-1')).toBeGreaterThan(0);
      expect(repo.listLive('inst-1', 'bafyreiprior', CAP, T0 + 50)).toEqual([]);
    } finally {
      cleanup();
    }
  }

  it('in-memory', () => {
    cases(new InMemoryDrainAuthorizationRepository(), () => undefined);
  });

  it('sqlite', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'drain-'));
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    cases(new SQLiteDrainAuthorizationRepository(adapter), () => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

describe('claim guard drain lane (§9.13)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let drains: SQLiteDrainAuthorizationRepository;
  let workflowRepo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;
  let installId: string;
  let priorInstall: PluginInstall;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'draincg-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installs = new SQLitePluginInstallRepository(adapter);
    setPluginInstallRepository(installs);
    drains = new SQLiteDrainAuthorizationRepository(adapter);
    setDrainAuthorizationRepository(drains);

    workflowRepo = new InMemoryWorkflowRepository();
    workflow = new WorkflowService({ repository: workflowRepo, nowMsFn: () => T0 });

    installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.commerce.supplier',
      label: '',
      executionMode: 'runner',
      currentCid: 'bafyreiprior',
      currentVersion: '0.1.0',
      manifest,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: 'h'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(installId, PLUGIN_DID, T0);
    const install = installs.getById(installId);
    if (!install) throw new Error('install missing');
    priorInstall = install;
  });

  afterEach(() => {
    setPluginInstallRepository(null);
    setDrainAuthorizationRepository(null);
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Enqueue a task whose envelope was built under the PRIOR manifest.
   *
   * `asTool` drops `service_ingress`, which is what decides the kind the
   * claim guard requires: present means the envelope needs a `provider`
   * consent, absent means `tool`.
   */
  function enqueuePriorCidTask(taskId: string, asTool = false, priorVersion = '0.1.0'): void {
    const built = buildPluginEnvelope({
      install: priorInstall,
      capabilityId: CAP,
      params: { purchaseOrderId: 'po-1' },
      context: [],
      executionId: `exec:${taskId}`,
      idempotencyKey: `exec:${taskId}`,
      ...(asTool
        ? {}
        : {
            serviceIngress: {
              from_did: 'did:plc:buyer1234',
              query_id: taskId,
              capability: 'order_status',
              service_rkey: 'self',
            },
          }),
    });
    // Stamped the way `buildContinuityEnvelope` stamps it in production, so
    // the §9.13 major check has both sides to compare. `buildPluginEnvelope`
    // does not carry the field — a continuity task in production is never
    // built by it — so a fixture using it alone would exercise the drain
    // lane's rules while claiming to test continuity.
    const envelope = priorVersion === '' ? built : { ...built, prior_version: priorVersion };
    workflow.create({
      id: taskId,
      kind: 'delegation',
      description: 'prior-cid lifecycle task',
      payload: JSON.stringify(envelope),
      idempotencyKey: envelope.idempotency_key,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(installId),
    });
  }

  /** The install AFTER the atomic rebind: same row, new manifest CID. */
  function rebound(): PluginInstall {
    return { ...priorInstall, currentCid: 'bafyreicurrent' };
  }

  function claim(install: PluginInstall) {
    return claimPluginTask({
      repo: workflowRepo,
      install,
      deviceDid: PLUGIN_DID,
      nowMs: T0 + 1000,
      leaseMs: 60_000,
    });
  }

  function continuityEntry(overrides: Partial<DrainAuthorization> = {}): DrainAuthorization {
    return {
      installId,
      previousCid: 'bafyreiprior',
      capabilityId: CAP,
      kind: 'lifecycle_continuity',
      authorizedKinds: ['provider'],
      approvedScopeHash: 'h'.repeat(64),
      configRevision: priorInstall.configRevision,
      actionClass: 'read',
      effectsIdempotency: 'unsupported',
      resultSchemaJson: 'null',
      paramsSchemaJson: 'null',
      maxContextItems: null,
      expiresAt: null,
      // §9.13 — which CONTRACT this row speaks, not just which CID.
      priorVersion: '0.1.0',
      createdAt: T0 + 2000,
      ...overrides,
    };
  }

  it('without an entry, a prior-CID task terminalizes (the default stays closed)', () => {
    enqueuePriorCidTask('t-1');
    const result = claim(rebound());
    expect(result.task).toBeNull();
    expect(result.terminalized).toEqual(['t-1']);
  });

  it('a live lifecycle-continuity entry admits the prior-CID task', () => {
    enqueuePriorCidTask('t-2');
    drains.put(continuityEntry());
    const result = claim(rebound());
    expect(result.terminalized).toEqual([]);
    expect(result.task?.id).toBe('t-2');
  });

  it('a provider-only continuity lane does NOT admit a tool envelope (§11.2a)', () => {
    // THE HOLE THIS CLOSES. The claim guard skips its whole consent block for
    // a drained task, because the capability may have left the current
    // manifest and the entry IS the consent proof. The provider-vs-tool check
    // lived inside that block, so it was skipped too: a continuity lane
    // opened for a provider capability admitted a tool envelope on the same
    // capability id, and the reverse.
    enqueuePriorCidTask('t-kind-1', true);
    drains.put(continuityEntry({ authorizedKinds: ['provider'] }));
    const refused = claim(rebound());
    expect(refused.task).toBeNull();
    expect(refused.terminalized).toEqual(['t-kind-1']);
  });

  it('a tool-only continuity lane does NOT admit a provider envelope', () => {
    // The mirror, so the rule is a match and not a one-way filter.
    enqueuePriorCidTask('t-kind-2');
    drains.put(continuityEntry({ authorizedKinds: ['tool'] }));
    const refused = claim(rebound());
    expect(refused.task).toBeNull();
    expect(refused.terminalized).toEqual(['t-kind-2']);

    // And the matching lane admits, so the refusals above are the check
    // working rather than the lane being shut.
    enqueuePriorCidTask('t-kind-3', true);
    drains.release(installId, 'bafyreiprior', CAP, 'lifecycle_continuity');
    drains.put(continuityEntry({ authorizedKinds: ['tool'] }));
    expect(claim(rebound()).task?.id).toBe('t-kind-3');
  });

  it('a row that records NO kinds refuses, rather than admitting anything', () => {
    // Rows written before `authorized_kinds_json` existed default to empty.
    // Empty means "this row cannot say which kinds were consented", and
    // cannot-say is a refusal: the alternative is admitting an envelope onto
    // a consent no row can show covered it.
    enqueuePriorCidTask('t-kind-4');
    drains.put(continuityEntry({ authorizedKinds: [] }));
    const refused = claim(rebound());
    expect(refused.task).toBeNull();
    expect(refused.terminalized).toEqual(['t-kind-4']);
  });

  it('a continuity lane refuses an envelope claiming a DIFFERENT major (§9.13)', () => {
    // Both sides already carried the fact and nothing compared them. A lane
    // retained to serve major 0 admitted an envelope declaring major 2, and
    // the runner would answer the buyer under a contract their order was
    // never opened under.
    enqueuePriorCidTask('t-major-1', false, '2.0.0');
    drains.put(continuityEntry({ priorVersion: '0.1.0' }));
    const refused = claim(rebound());
    expect(refused.task).toBeNull();
    expect(refused.terminalized).toEqual(['t-major-1']);
  });

  it('a continuity lane accepts a different MINOR of the authorized major', () => {
    // §9.13 retains a lane per MAJOR and makes minors additive, so comparing
    // exact versions would refuse work the spec says must flow.
    enqueuePriorCidTask('t-major-2', false, '0.9.3');
    drains.put(continuityEntry({ priorVersion: '0.1.0' }));
    expect(claim(rebound()).task?.id).toBe('t-major-2');
  });

  it('a continuity lane refuses an envelope that declares no major at all', () => {
    // Silence from an envelope a builder always stamps is a disagreement,
    // not an absence.
    enqueuePriorCidTask('t-major-3', false, '');
    drains.put(continuityEntry({ priorVersion: '0.1.0' }));
    const refused = claim(rebound());
    expect(refused.task).toBeNull();
    expect(refused.terminalized).toEqual(['t-major-3']);
  });

  it('a DRAIN lane still admits an in-flight envelope with no major (the asymmetry)', () => {
    // The contrast that keeps the three above honest. A drain entry covers
    // work that existed BEFORE the rebind: those envelopes came from the
    // ordinary builder, which does not stamp `prior_version`. Requiring one
    // would terminalize exactly the in-flight tasks a drain exists to let
    // finish.
    enqueuePriorCidTask('t-major-4', false, '');
    drains.put(
      continuityEntry({
        kind: 'drain',
        priorVersion: '0.1.0',
        createdAt: T0 + 2000,
        expiresAt: T0 + 60_000,
      }),
    );
    expect(claim(rebound()).task?.id).toBe('t-major-4');
  });

  it('an expired drain entry no longer admits', () => {
    enqueuePriorCidTask('t-3');
    drains.put(continuityEntry({ kind: 'drain', expiresAt: T0 + 500 }));
    const result = claim(rebound());
    expect(result.task).toBeNull();
    expect(result.terminalized).toEqual(['t-3']);
  });

  it('the entry validates the envelope against the AUTHORIZED prior values', () => {
    enqueuePriorCidTask('t-4');
    // Entry claims a different prior scope hash than the envelope pinned:
    // the task must terminalize (consent-changed under the prior CID).
    drains.put(continuityEntry({ approvedScopeHash: 'x'.repeat(64) }));
    const result = claim(rebound());
    expect(result.task).toBeNull();
    expect(result.terminalized).toEqual(['t-4']);
  });

  it("a 'drain' entry admits only tasks created before the rebind (§9.13)", () => {
    enqueuePriorCidTask('t-6'); // created at T0 (workflow nowMsFn)
    // Entry created BEFORE the task -> post-rebind task refused.
    drains.put(continuityEntry({ kind: 'drain', createdAt: T0 - 5000, expiresAt: T0 + 60_000 }));
    const refused = claim(rebound());
    expect(refused.task).toBeNull();
    expect(refused.terminalized).toEqual(['t-6']);

    // Entry created AFTER the task (the real rebind ordering) -> admitted.
    enqueuePriorCidTask('t-7');
    drains.release(installId, 'bafyreiprior', CAP, 'drain');
    drains.put(continuityEntry({ kind: 'drain', createdAt: T0 + 2000, expiresAt: T0 + 60_000 }));
    const admitted = claim(rebound());
    expect(admitted.task?.id).toBe('t-7');
  });

  it('a live drain entry does NOT mask a live lifecycle_continuity entry (§9.13)', () => {
    // Post-rebind reality: both kinds live. The task is created AFTER
    // the rebind, so the drain entry alone would terminalize it; the
    // continuity entry must still admit it.
    enqueuePriorCidTask('t-8');
    drains.put(continuityEntry({ kind: 'drain', createdAt: T0 - 5000, expiresAt: T0 + 60_000 }));
    drains.put(continuityEntry({ kind: 'lifecycle_continuity', createdAt: T0 - 5000 }));
    const result = claim(rebound());
    expect(result.terminalized).toEqual([]);
    expect(result.task?.id).toBe('t-8');
  });

  it('current-CID tasks are untouched by the drain lane', () => {
    enqueuePriorCidTask('t-5');
    const result = claim(priorInstall);
    expect(result.task?.id).toBe('t-5');
  });
});
