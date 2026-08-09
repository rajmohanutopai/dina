/**
 * §25.2 plugin security, on the COMMERCE lane (WS-11.2).
 *
 * The substrate's own suites already prove these rules in the abstract, over
 * fixture manifests. This one proves them where they will actually be relied
 * on: two REFERENCE packs — Buyer and Supplier — installed side by side on one
 * node, which is the shape §18.1 says a business runs ("two installs, not one
 * superset"). That shape is the whole reason the rules exist, and a rule
 * proven only against a fixture is a rule nobody has tried to break with the
 * real thing.
 *
 * The claims here are §25.2's own, in its words:
 *
 *   - "Buyer cannot claim Supplier lane or capability."
 *   - "Two installs of the same plugin remain isolated."
 *   - "Revoked install cannot claim, complete, notify, or publish."
 *   - "Reference Buyer cannot call AppView or send D2D except through the
 *      typed Core host operation."
 *   - "An extension operation not declared in the invoking capability's
 *      `host_operations` list is denied before validation."
 *   - "Widening `host_operations` changes the scope hash and forces
 *      re-consent."
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { pluginLane, scopeHashInput, canonicalJson } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  BUYER_REFERENCE_MANIFEST,
  SUPPLIER_REFERENCE_MANIFEST,
} from '../../src/commerce/reference_manifests';
import { claimPluginTask } from '../../src/plugins/claim_guard';
import { registerCommerceHostOperations } from '../../src/plugins/commerce_host_operations';
import { buildPluginEnvelope } from '../../src/plugins/dispatch';
import {
  ExtensionOperationRegistry,
  checkHostOperationInvocation,
} from '../../src/plugins/extension_ops';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

import type { PluginCapabilityDecl, PluginManifest } from '@dina/protocol';

const T0 = Date.parse('2026-08-09T09:00:00.000Z');
const SUPPLIER_RUNNER = 'did:plc:chairmakerrunner1';
const BUYER_RUNNER = 'did:plc:sanchorunner001';
const SECOND_BUYER_RUNNER = 'did:plc:sanchorunner002';
/** The buyer pack's own tool capability — the tool lane's dispatch path. */
const TRACK_ORDER = 'com.dinakernel.commerce.track-order';
/** A supplier capability: `provider` only, so it may NOT ride the tool lane. */
const ORDER_STATUS = 'com.dinakernel.commerce.order-status';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const scopeHash = (manifest: PluginManifest, cap: PluginCapabilityDecl): string =>
  hex(sha256(new TextEncoder().encode(canonicalJson(scopeHashInput(manifest, cap)))));

describe('§25.2 on the commerce lane: Buyer and Supplier installed side by side', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let workflowRepo: InMemoryWorkflowRepository;
  let workflow: WorkflowService;
  let supplierInstall: string;
  let buyerInstall: string;
  /** A second install of the SAME buyer pack — §25.2's isolation claim. */
  let secondBuyerInstall: string;

  function install(
    manifest: PluginManifest,
    label: string,
    runnerDid: string,
    cid: string,
  ): string {
    const id = installs.createPending({
      publisherDid: 'did:plc:dinakernelpub000',
      pluginId: manifest.plugin_id,
      label,
      executionMode: 'runner',
      currentCid: cid,
      currentVersion: manifest.version,
      manifest,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: Object.fromEntries(
        manifest.capabilities.map((c) => [c.id, scopeHash(manifest, c)]),
      ),
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(id, runnerDid, T0);
    return id;
  }

  /** Put one task on an install's own lane, exactly as dispatch would. */
  function enqueueFor(installId: string, capabilityId: string, executionId: string): void {
    // Valid params for the reference pack's order-scoped schema. Real params,
    // not a stub: `buildPluginEnvelope` validates against the CONSENTED
    // schema before enqueue, so a fixture with empty params would never make
    // it onto a lane and the lane-isolation claims would test nothing.
    const record = installs.getById(installId);
    if (record === null) throw new Error('install missing');
    workflow.create({
      id: executionId,
      kind: 'delegation',
      description: `work for ${installId}`,
      payload: JSON.stringify(
        buildPluginEnvelope({
          install: record,
          capabilityId,
          params: { purchase_order_id: executionId },
          context: [],
          executionId,
          idempotencyKey: executionId,
        }),
      ),
      expiresAtSec: Math.floor(T0 / 1000) + 600,
      idempotencyKey: executionId,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(installId),
    } as never);
  }

  const claimAs = (installId: string, deviceDid: string) => {
    const record = installs.getById(installId);
    if (record === null) throw new Error(`install ${installId} is missing`);
    return claimPluginTask({
      repo: workflowRepo,
      install: record,
      deviceDid,
      nowMs: T0,
      leaseMs: 60_000,
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'commerce-sec-'));
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
    workflow = new WorkflowService({ repository: workflowRepo, nowMsFn: () => T0 });

    supplierInstall = install(
      SUPPLIER_REFERENCE_MANIFEST,
      'ChairMaker',
      SUPPLIER_RUNNER,
      'bafy-supplier-1',
    );
    buyerInstall = install(BUYER_REFERENCE_MANIFEST, 'Sancho', BUYER_RUNNER, 'bafy-buyer-1');
    secondBuyerInstall = install(
      BUYER_REFERENCE_MANIFEST,
      'Sancho (second shop)',
      SECOND_BUYER_RUNNER,
      'bafy-buyer-1',
    );
  });

  afterEach(() => {
    setPluginInstallRepository(null);
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs both reference packs as SEPARATE installs (§18.1)', () => {
    // "Two installs, not one superset" is a safety rule, not packaging
    // taste: a single pack holding both roles would let a runner that
    // legitimately places orders also answer them.
    expect(supplierInstall).not.toBe(buyerInstall);
    expect(installs.getById(supplierInstall)?.pluginId).not.toBe(
      installs.getById(buyerInstall)?.pluginId,
    );
    expect(pluginLane(supplierInstall)).not.toBe(pluginLane(buyerInstall));
  });

  it('the Supplier cannot claim the Buyer’s lane', () => {
    // The buyer's own work sits on the buyer's lane, and the supplier's
    // runner asking for work gets NOTHING — not an error it could probe, and
    // not somebody else's task.
    enqueueFor(buyerInstall, TRACK_ORDER, 'buy-1');

    expect(claimAs(supplierInstall, SUPPLIER_RUNNER).task).toBeNull();
    // And the buyer's own runner still gets it, so the refusal above is the
    // lane binding rather than an empty queue.
    expect(claimAs(buyerInstall, BUYER_RUNNER).task?.id).toBe('buy-1');
  });

  it('a runner cannot claim its OWN install’s lane from another device', () => {
    // Claim check 4: the lane binding belongs to one device. Without it a
    // leaked install id would be enough to drain a competitor's queue.
    enqueueFor(buyerInstall, TRACK_ORDER, 'buy-1');
    expect(claimAs(buyerInstall, SUPPLIER_RUNNER).task).toBeNull();
    expect(claimAs(buyerInstall, BUYER_RUNNER).task?.id).toBe('buy-1');
  });

  it('a PROVIDER-only capability cannot ride the tool lane', () => {
    // Found by writing this suite. The supplier pack's capabilities are all
    // `kinds: ['provider']`, so they are answerable by a PEER through
    // provider ingress and never by the owner's own tool dispatch. A
    // hand-built tool-lane task naming one is terminalized `stale_authority`
    // rather than served — the consented KIND is authority, not a label, and
    // the two lanes carry different context (a provider task carries no owner
    // projection at all).
    enqueueFor(supplierInstall, ORDER_STATUS, 'sup-1');
    const claimed = claimAs(supplierInstall, SUPPLIER_RUNNER);
    expect(claimed.task).toBeNull();
    expect(claimed.terminalized).toEqual(['sup-1']);
    expect(workflowRepo.getById('sup-1')?.error).toContain('not consented as a tool');
  });

  it('two installs of the SAME plugin remain isolated', () => {
    // Same pack, same CID, same capabilities — and still two separate lanes.
    // A business running two shops must not have one answer the other's work,
    // and the only thing separating them is the install id.
    expect(installs.getById(buyerInstall)?.currentCid).toBe(
      installs.getById(secondBuyerInstall)?.currentCid,
    );
    enqueueFor(buyerInstall, TRACK_ORDER, 'first-1');
    enqueueFor(secondBuyerInstall, TRACK_ORDER, 'second-1');

    expect(claimAs(buyerInstall, BUYER_RUNNER).task?.id).toBe('first-1');
    expect(claimAs(secondBuyerInstall, SECOND_BUYER_RUNNER).task?.id).toBe('second-1');
    // Neither can reach the other's remaining work.
    enqueueFor(buyerInstall, TRACK_ORDER, 'first-2');
    expect(claimAs(secondBuyerInstall, SECOND_BUYER_RUNNER).task).toBeNull();
  });

  it('a PAUSED install cannot claim, and its work waits for the resume', () => {
    // §25.2's "revoked install cannot claim" and §16.3's pause on the same
    // queued task — the pair is what makes them different facts rather than
    // two words for stopping. (The full uninstall path, including the device
    // fence, is exercised in `procurement_lane_scenario`.)
    enqueueFor(buyerInstall, TRACK_ORDER, 'buy-1');

    installs.pause(buyerInstall, T0, 'manual');
    expect(claimAs(buyerInstall, BUYER_RUNNER).task).toBeNull();
    installs.resume(buyerInstall, T0);
    expect(claimAs(buyerInstall, BUYER_RUNNER).task?.id).toBe('buy-1');
  });

  it('the reference Buyer declares NO host operation at all, which is stronger', () => {
    // §25.2: "Reference Buyer cannot call AppView or send D2D except through
    // the typed Core host operation." The manifest half of that claim: every
    // brokered operation the pack may reach is named in a capability's
    // `host_operations`, so the consent screen showed it and the scope hash
    // covers it. A pack that reached AppView another way would not need the
    // field at all.
    // The REAL registrations both boots ship, not a stub. A stub here would
    // let the manifest and the registry drift apart — which is exactly the
    // gap this suite found: the registry was built EMPTY at both boots, so
    // every declared operation was refused `operation_unregistered`.
    const registry = new ExtensionOperationRegistry();
    registerCommerceHostOperations(registry);
    // §25.2 asks that the reference Buyer reach AppView and D2D ONLY through
    // a typed host operation. This build satisfies that more strongly: the
    // pack reaches neither. Its quote fan-out and order submission go through
    // Core's own service-query egress, where the four gates and signing
    // already apply — so the pack asks for no brokered authority and there is
    // none to abuse. I briefly "fixed" the manifest to declare `d2d_send`
    // before noticing that `reference_manifests.test.ts` pins the opposite as
    // a decision; changing a deliberate design to make a new test pass is the
    // wrong direction, so the test moved instead.
    const declared = BUYER_REFERENCE_MANIFEST.capabilities.flatMap((c) => c.host_operations ?? []);
    expect(declared).toEqual([]);

    // Every registered operation is therefore denied on every one of its
    // capabilities, and denied for the DECLARATION reason.
    for (const cap of BUYER_REFERENCE_MANIFEST.capabilities) {
      for (const op of ['d2d_send', 'connector_broker', 'commerce.wire_money']) {
        const gate = checkHostOperationInvocation(cap, op, registry);
        expect(gate.allowed).toBe(false);
        expect(!gate.allowed && gate.code).toBe('operation_not_declared');
      }
    }
  });

  it('an undeclared operation is denied BEFORE the registry is consulted', () => {
    // The ORDER is the conformance requirement (§25.2), not just the
    // outcome: an undeclared operation's params are not input Core should be
    // parsing, so the refusal must not depend on the operation existing.
    const empty = new ExtensionOperationRegistry();
    const cap = SUPPLIER_REFERENCE_MANIFEST.capabilities[0];
    const gate = checkHostOperationInvocation(cap, 'commerce.appview_search', empty);
    expect(gate.allowed).toBe(false);
    // `operation_not_declared`, NOT `operation_unregistered` — with an empty
    // registry both are true, and reporting the registry one would mean the
    // declaration check had not run first.
    expect(!gate.allowed && gate.code).toBe('operation_not_declared');
  });

  it('widening host_operations CHANGES the capability scope hash', () => {
    // §25.2: widening forces re-consent, and the mechanism is the hash. If
    // `host_operations` were outside it, a pack update could hand itself a
    // new brokered operation under the consent the owner already gave.
    // Taken from a REFERENCE capability and widened here rather than in the
    // manifest: the packs deliberately declare none, and the claim under test
    // is what happens to the hash when an UPDATE adds one.
    const cap = BUYER_REFERENCE_MANIFEST.capabilities[0];
    expect(cap.host_operations ?? []).toEqual([]);

    const widened = {
      ...cap,
      host_operations: ['d2d_send'],
    };
    expect(scopeHash(BUYER_REFERENCE_MANIFEST, widened)).not.toBe(
      scopeHash(BUYER_REFERENCE_MANIFEST, cap),
    );

    // An EMPTY list hashes the same as no list at all, and that is
    // deliberate rather than an oversight: `host_operations` enters the hash
    // only when non-empty, so every pre-commerce manifest — and one that
    // declares an empty list, which grants nothing either way — keeps its
    // existing scope hash and its frozen vector.
    const emptied = { ...cap, host_operations: [] };
    expect(scopeHash(BUYER_REFERENCE_MANIFEST, emptied)).toBe(
      scopeHash(BUYER_REFERENCE_MANIFEST, cap),
    );
  });

  it('the install records the hash of what it consented to, per capability', () => {
    // The stored hash is what a later update is diffed against; if it were
    // recomputed from the CURRENT manifest at compare time, every update
    // would look consented.
    const record = installs.getById(supplierInstall);
    if (record === null) throw new Error('install missing');
    for (const cap of SUPPLIER_REFERENCE_MANIFEST.capabilities) {
      expect(record.capabilityHashes[cap.id]).toBe(scopeHash(SUPPLIER_REFERENCE_MANIFEST, cap));
    }
  });
});

/**
 * §17.4 — a VENDOR-HOSTED runner multiplexing many businesses.
 *
 * The managed runtime is not defined by commerce (§17 opens by saying so), but
 * one of its constraints is enforceable right here and is a commerce-lane
 * safety property: "A vendor-hosted Buyer or Supplier runner may multiplex
 * many installations only if every claim is bound to tenant, install ID,
 * paired plugin instance identity, exact plugin lane, capability and manifest
 * CID, claim token, and authority snapshot. A vendor-wide identity alone
 * cannot claim any tenant's task."
 *
 * WHY TWO DATABASES AND NOT TWO ROWS. §17.1 keeps the single-writer Home Node
 * model authoritative PER TENANT, so a tenant boundary is a whole Core with
 * its own encrypted store — there is no tenant column to get wrong. Testing it
 * with two installs in one database would be testing install isolation, which
 * the suite above already covers, and would say nothing about the property
 * §17.4 is actually about. Two adapters, two install repositories, two
 * workflow stores: the shape a hosted runner really faces.
 *
 * The claim it must not be possible to make: one vendor identity, paired into
 * ChairMaker's tenant, reaching into a competitor's.
 */
describe('§17.4: a hosted runner multiplexing tenants', () => {
  /** One tenant: its own encrypted store, installs and workflow queue. */
  interface Tenant {
    dir: string;
    adapter: NodeSQLiteAdapter;
    installs: SQLitePluginInstallRepository;
    workflowRepo: InMemoryWorkflowRepository;
    workflow: WorkflowService;
    installId: string;
  }

  /** The SAME device identity in both tenants — a vendor runs one process. */
  const VENDOR_RUNNER = 'did:key:zVendorHostedRunner';
  const tenants: Tenant[] = [];

  function openTenant(label: string, runnerDid: string): Tenant {
    const dir = mkdtempSync(path.join(tmpdir(), `tenant-${label}-`));
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    const installRepo = new SQLitePluginInstallRepository(adapter);
    const repo = new InMemoryWorkflowRepository();
    const svc = new WorkflowService({ repository: repo, nowMsFn: () => T0 });

    // The install repository is a module global, so "which tenant is acting"
    // has to be stated before anything that reads it. Naming the switch is the
    // point: a test that left the wrong tenant installed would be asserting
    // one tenant's rule against another's store and would probably pass.
    setPluginInstallRepository(installRepo);
    const id = installRepo.createPending({
      publisherDid: 'did:plc:commercepub',
      pluginId: BUYER_REFERENCE_MANIFEST.plugin_id,
      label,
      executionMode: 'runner',
      currentCid: `bafy-${label}`,
      currentVersion: BUYER_REFERENCE_MANIFEST.version,
      manifest: BUYER_REFERENCE_MANIFEST,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: Object.fromEntries(
        BUYER_REFERENCE_MANIFEST.capabilities.map((c) => [
          c.id,
          scopeHash(BUYER_REFERENCE_MANIFEST, c),
        ]),
      ),
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installRepo.activate(id, runnerDid, T0);

    const tenant: Tenant = {
      dir,
      adapter,
      installs: installRepo,
      workflowRepo: repo,
      workflow: svc,
      installId: id,
    };
    tenants.push(tenant);
    return tenant;
  }

  function enqueueIn(tenant: Tenant, executionId: string): void {
    setPluginInstallRepository(tenant.installs);
    const record = tenant.installs.getById(tenant.installId);
    if (record === null) throw new Error('install missing');
    tenant.workflow.create({
      id: executionId,
      kind: 'delegation',
      description: `work for ${tenant.installId}`,
      payload: JSON.stringify(
        buildPluginEnvelope({
          install: record,
          // A TOOL capability. The supplier pack declares its lot as
      // `provider`-only, and a task with no `service_ingress` requires `tool`
      // consent — so a supplier fixture here would terminalize on the kind
      // check and prove nothing about tenants. §17.4 names a hosted Buyer
      // runner in the same breath, which is what this is.
      capabilityId: 'com.dinakernel.commerce.track-order',
          params: { purchase_order_id: executionId },
          context: [],
          executionId,
          idempotencyKey: executionId,
        }),
      ),
      expiresAtSec: Math.floor(T0 / 1000) + 600,
      idempotencyKey: executionId,
      initialState: 'queued' as never,
      requestedRunner: pluginLane(tenant.installId),
    } as never);
  }

  /** Claim in `where`, presenting `deviceDid` and `install`'s authority. */
  function claimIn(
    where: Tenant,
    install: { installId: string; from: Tenant },
    deviceDid: string,
  ): ReturnType<typeof claimPluginTask> {
    const record = install.from.installs.getById(install.installId);
    if (record === null) throw new Error('install missing');
    return claimPluginTask({
      repo: where.workflowRepo,
      install: record,
      deviceDid,
      nowMs: T0,
      leaseMs: 60_000,
    });
  }

  afterEach(() => {
    setPluginInstallRepository(null);
    while (tenants.length > 0) {
      const tenant = tenants.pop();
      if (tenant === undefined) continue;
      try {
        tenant.adapter.close();
      } finally {
        rmSync(tenant.dir, { recursive: true, force: true });
      }
    }
  });

  it('MULTIPLEXES: one vendor identity serves both tenants it is paired into', () => {
    // §17.4 permits this — it is the whole point of a hosted runner. What it
    // requires is that each claim carry that tenant's own binding.
    const chairmaker = openTenant('chairmaker', VENDOR_RUNNER);
    const rival = openTenant('rival', VENDOR_RUNNER);
    enqueueIn(chairmaker, 'po-chairmaker-1');
    enqueueIn(rival, 'po-rival-1');

    expect(claimIn(chairmaker, { installId: chairmaker.installId, from: chairmaker }, VENDOR_RUNNER)
      .task?.id).toBe('po-chairmaker-1');
    expect(claimIn(rival, { installId: rival.installId, from: rival }, VENDOR_RUNNER)
      .task?.id).toBe('po-rival-1');
  });

  it('a vendor identity CANNOT claim a tenant it holds no install in', () => {
    // The threat sentence, exactly. The vendor is paired into ChairMaker and
    // presents ChairMaker's install authority against the rival's queue.
    const chairmaker = openTenant('chairmaker', VENDOR_RUNNER);
    const rival = openTenant('rival', 'did:key:zRivalOwnRunner');
    enqueueIn(rival, 'po-rival-1');

    const stolen = claimIn(
      rival,
      { installId: chairmaker.installId, from: chairmaker },
      VENDOR_RUNNER,
    );
    // Nothing claimed, and nothing terminalized — the rival's task is
    // untouched and still there for its own runner.
    expect(stolen.task).toBeNull();
    expect(stolen.terminalized).toEqual([]);
    expect(
      claimIn(rival, { installId: rival.installId, from: rival }, 'did:key:zRivalOwnRunner').task
        ?.id,
    ).toBe('po-rival-1');
  });

  it('the vendor identity ALONE is not enough — the install must name it', () => {
    // The same vendor DID, against a tenant whose install is paired to a
    // DIFFERENT device. This is the "vendor-wide identity alone" case: the
    // identity is real and the tenant is real, and the pairing is what is
    // missing.
    const rival = openTenant('rival', 'did:key:zRivalOwnRunner');
    enqueueIn(rival, 'po-rival-1');
    const claimed = claimIn(
      rival,
      { installId: rival.installId, from: rival },
      VENDOR_RUNNER,
    );
    expect(claimed.task).toBeNull();
  });

  it('a task never crosses tenants even when both lanes share an install id', () => {
    // The pathological case a shared control plane could actually produce:
    // two tenants whose install ids collide, so `pluginLane` is identical.
    // The queues are still separate stores, and a claim reads only its own.
    const chairmaker = openTenant('chairmaker', VENDOR_RUNNER);
    const rival = openTenant('rival', VENDOR_RUNNER);
    enqueueIn(chairmaker, 'po-only-in-chairmaker');

    // Claim in the RIVAL's store while presenting the rival's own valid
    // authority: the queue is empty there, and ChairMaker's task is not
    // reachable from it however the lane happens to be named.
    expect(claimIn(rival, { installId: rival.installId, from: rival }, VENDOR_RUNNER).task).toBeNull();
    expect(
      claimIn(chairmaker, { installId: chairmaker.installId, from: chairmaker }, VENDOR_RUNNER).task
        ?.id,
    ).toBe('po-only-in-chairmaker');
  });
});
