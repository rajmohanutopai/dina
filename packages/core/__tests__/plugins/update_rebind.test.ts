/**
 * Update-rebind coordinator (§9.13 / §16.5, WS-3.7).
 *
 * The claim under test is atomicity: prior-contract authorizations, the
 * install's new CID, and every listing pinned to the old CID all land
 * together, or none of them do. Each of the three is separately checked after
 * a forced rollback, because "we wrapped it in a transaction" is a statement
 * about intent and this is a statement about behaviour.
 *
 * Driven against a real SQLite Tier-0 database rather than fakes: the whole
 * point is that `plugin_installs` and `service_configs` share one transaction,
 * which a pair of in-memory maps would let us claim without earning.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLiteDrainAuthorizationRepository,
  setDrainAuthorizationRepository,
} from '../../src/plugins/drain_authorizations';
import {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
} from '../../src/plugins/registry';
import { UpdateRebindCoordinator } from '../../src/plugins/update_rebind';
import { tier0TxRunner } from '../../src/run/tx';
import { rebindListingsForUpdate } from '../../src/service/listing_rebind';
import { getServiceConfig, hydrateServiceConfig } from '../../src/service/service_config';
import {
  SQLiteServiceConfigRepository,
  setServiceConfigRepository,
} from '../../src/service/service_config_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { PluginManifest, ServiceConfig } from '@dina/protocol';

const CAP = 'com.acme.commerce.order_status';
const CAP2 = 'com.acme.commerce.request_quote';
const PRIOR_CID = 'bafyreiprior';
const NEXT_CID = 'bafyreinext';
const PLUGIN_DID = 'did:plc:plugindevice';
const T0 = 1_700_000_000_000;

/** The PRIOR manifest — its schemas are what the authorizations must carry. */
const priorManifest = {
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
      params_schema: { type: 'object', properties: { purchaseOrderId: { type: 'string' } } },
      result_schema: { type: 'object', properties: { state: { type: 'string' } } },
      data_scope: { max_context_items: 5 },
    },
    {
      id: CAP2,
      display_name: 'Request quote',
      interaction: 'query',
      action_class: 'write',
      privacy_class: 'personal',
      kinds: ['provider'],
      // `effects.idempotency`, the VALIDATED shape. The fixture used to carry
      // a top-level `effects_idempotency` that the manifest model has never
      // had, which hid a production bug: `update_rebind` read the invalid
      // top-level field, so every `supported` capability was reauthorized as
      // `unsupported` during an update and the claim guard terminalized work
      // that should have drained.
      effects: { idempotency: 'supported' },
      params_schema: { type: 'object' },
      result_schema: { type: 'object' },
    },
  ],
} as unknown as PluginManifest;

/**
 * The NEW manifest deliberately DIFFERS in both schemas, so a test that reads
 * the current manifest instead of the prior one shows up as a difference.
 *
 * The difference is ADDITIVE — the old properties stay and new optional ones
 * appear. It used to be a rename (`purchaseOrderId` -> `poId`), which is a
 * different data contract and now correctly refuses the whole rebind with
 * `requires_reconsent`. That would have made every test in this file about
 * consent rather than about rebind mechanics, which is not what they check.
 * The non-additive case has its own test at the bottom, where it belongs.
 */
const nextManifest = {
  ...(priorManifest as unknown as Record<string, unknown>),
  version: '0.2.0',
  capabilities: [
    {
      id: CAP,
      display_name: 'Order status',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['provider'],
      params_schema: {
        type: 'object',
        properties: { purchaseOrderId: { type: 'string' }, poId: { type: 'string' } },
      },
      result_schema: {
        type: 'object',
        properties: { state: { type: 'string' }, phase: { type: 'string' } },
      },
    },
  ],
} as unknown as PluginManifest;

function listing(caps: Record<string, Record<string, unknown>>): ServiceConfig {
  // `name` and a per-capability `responsePolicy` are required by
  // `validateServiceConfig`, and hydration silently SKIPS a row that fails it
  // — so an under-specified fixture would leave the cache empty and quietly
  // weaken every cache assertion below.
  return {
    isDiscoverable: true,
    name: 'ChairMaker supply',
    capabilities: Object.fromEntries(
      Object.entries(caps).map(([name, cap]) => [name, { responsePolicy: 'auto', ...cap }]),
    ),
  } as unknown as ServiceConfig;
}

describe('update-rebind coordinator (§9.13)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let installs: SQLitePluginInstallRepository;
  let drains: SQLiteDrainAuthorizationRepository;
  let coordinator: UpdateRebindCoordinator;
  let installId: string;

  /** Write a listing row straight to the table, bypassing the in-memory cache,
   *  so `hydrateServiceConfig` is what puts it there — the same path a real
   *  boot takes. */
  function seedListing(rkey: string, config: ServiceConfig): void {
    adapter.execute(
      `INSERT INTO service_configs (rkey, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [rkey, JSON.stringify(config), T0, T0],
    );
  }

  function storedListing(rkey: string): ServiceConfig {
    const rows = adapter.query<{ config_json: string }>(
      'SELECT config_json FROM service_configs WHERE rkey = ?',
      [rkey],
    );
    return JSON.parse(rows[0].config_json) as ServiceConfig;
  }

  function boundCid(config: ServiceConfig, name: string): unknown {
    const caps = (config.capabilities ?? {}) as Record<string, { pluginManifestCid?: string }>;
    return caps[name]?.pluginManifestCid;
  }

  function makeCoordinator(overrides: { failRebind?: boolean } = {}): UpdateRebindCoordinator {
    return new UpdateRebindCoordinator({
      installs: () => installs,
      drains: () => drains,
      rebindListings: (args) => {
        if (overrides.failRebind === true) throw new Error('rebind exploded');
        return rebindListingsForUpdate(adapter, args);
      },
      tx: tier0TxRunner(adapter),
      now: () => T0,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rebind-'));
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
    setServiceConfigRepository(new SQLiteServiceConfigRepository(adapter));

    installId = installs.createPending({
      publisherDid: 'did:plc:acme',
      pluginId: 'com.acme.commerce.supplier',
      label: '',
      executionMode: 'runner',
      currentCid: PRIOR_CID,
      currentVersion: '0.1.0',
      manifest: priorManifest,
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { [CAP]: 'h'.repeat(64), [CAP2]: 'i'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(T0 / 1000) + 900,
      nowMs: T0,
    });
    installs.activate(installId, PLUGIN_DID, T0);

    // Three listings: one bound to the install at the prior CID, one bound to
    // the SAME install at a different CID, one with no plugin binding at all.
    seedListing(
      'self',
      listing({
        order_status: {
          pluginInstallId: installId,
          pluginManifestCid: PRIOR_CID,
          pluginCapabilityId: CAP,
        },
      }),
    );
    seedListing(
      'other-cid',
      listing({
        order_status: {
          pluginInstallId: installId,
          pluginManifestCid: 'bafyreisomethingelse',
          pluginCapabilityId: CAP,
        },
      }),
    );
    seedListing('plain', listing({ availability: {} }));
    await hydrateServiceConfig();

    coordinator = makeCoordinator();
  });

  afterEach(() => {
    setPluginInstallRepository(null);
    setDrainAuthorizationRepository(null);
    setServiceConfigRepository(null);
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * SAME MAJOR (0.1.0 -> 0.2.0), the ordinary compatible release. §9.13 gives
   * it a bounded DRAIN and no lifecycle continuity: tasks already created
   * finish against their pinned schemas, and anything new belongs to the
   * current runtime. The major case has its own test at the end of the file.
   */
  const update = {
    cid: NEXT_CID,
    version: '0.2.0',
    manifest: nextManifest,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [CAP]: 'h'.repeat(64) },
    behaviorHash: 'b2'.repeat(32),
    presentationHash: 'p2'.repeat(32),
  };

  it('moves the install, its matching listings, and creates both authorization kinds', () => {
    const result = coordinator.apply({ installId, ...update });

    expect(result).toEqual({ ok: true, rebound: ['self'], authorizations: 2 });

    // Install adopted the new CID.
    expect(installs.getById(installId)?.currentCid).toBe(NEXT_CID);

    // Only the listing that pinned the prior CID moved.
    expect(boundCid(storedListing('self'), 'order_status')).toBe(NEXT_CID);
    expect(boundCid(storedListing('other-cid'), 'order_status')).toBe('bafyreisomethingelse');
    expect(boundCid(storedListing('plain'), 'availability')).toBeUndefined();

    // DRAIN ONLY, for both prior capabilities. This asserted
    // `['drain','lifecycle_continuity']` and that encoded the defect:
    // `authorize` created a non-expiring lifecycle row for every capability on
    // EVERY update without comparing majors. A compatible release therefore
    // left the superseded CID holding open-ended authority over continuations
    // the new runtime should serve, and kept quoting authority a drained major
    // must never retain.
    for (const capability of [CAP, CAP2]) {
      const live = drains
        .listLive(installId, PRIOR_CID, capability, T0 + 1)
        .map((e) => e.kind)
        .sort();
      expect(live).toEqual(['drain']);
    }
  });

  it('publishes the rebound listing to the in-memory cache', () => {
    expect(boundCid(getServiceConfig('self') as ServiceConfig, 'order_status')).toBe(PRIOR_CID);

    coordinator.apply({ installId, ...update });

    // Without this the process keeps answering from the pre-update binding
    // until it restarts — ingress would refuse every query against a listing
    // the database has already rebound.
    expect(boundCid(getServiceConfig('self') as ServiceConfig, 'order_status')).toBe(NEXT_CID);
  });

  it('carries the PRIOR schemas, not the new ones', () => {
    coordinator.apply({ installId, ...update });

    const [entry] = drains.listLive(installId, PRIOR_CID, CAP, T0 + 1);
    // The new manifest renamed both fields. An authorization built from the
    // current manifest would judge an in-flight task against a contract it was
    // never created under.
    expect(JSON.parse(entry.paramsSchemaJson)).toEqual({
      type: 'object',
      properties: { purchaseOrderId: { type: 'string' } },
    });
    expect(JSON.parse(entry.resultSchemaJson)).toEqual({
      type: 'object',
      properties: { state: { type: 'string' } },
    });
    expect(entry.maxContextItems).toBe(5);
    expect(entry.approvedScopeHash).toBe('h'.repeat(64));
  });

  it("carries the capability's DECLARED idempotency into the drain authorization", () => {
    // The claim guard terminalizes a task whose envelope disagrees with its
    // authorization, so a `supported` capability reauthorized as
    // `unsupported` kills work queued before the update instead of draining
    // it. The bug was a field-name mismatch — `cap.effects_idempotency` where
    // the validated manifest stores `cap.effects.idempotency` — and it was
    // invisible because the fixture carried the invalid shape too.
    coordinator.apply({ installId, ...update });

    const supported = drains
      .listLive(installId, PRIOR_CID, CAP2, T0 + 1)
      .find((e) => e.kind === 'drain');
    expect(supported?.effectsIdempotency).toBe('supported');

    // And the capability that declares nothing still reads `unsupported`, so
    // this is not a constant in disguise.
    const unsupported = drains
      .listLive(installId, PRIOR_CID, CAP, T0 + 1)
      .find((e) => e.kind === 'drain');
    expect(unsupported?.effectsIdempotency).toBe('unsupported');
  });

  /**
   * §9.13 grants lifecycle continuity ONLY across a major. These three tests
   * are about that lane, so they drive a major bump; the same-major tests
   * above assert it is absent.
   */
  const majorUpdate = { ...update, version: '1.0.0' };

  it('gives the continuity entry no expiry and the drain entry one', () => {
    coordinator.apply({ installId, ...majorUpdate });

    const live = drains.listLive(installId, PRIOR_CID, CAP, T0 + 1);
    const continuity = live.find((e) => e.kind === 'lifecycle_continuity');
    const drain = live.find((e) => e.kind === 'drain');
    // §9.13 serves prior-major lifecycle until the orders are TERMINAL, and no
    // clock knows when that is.
    expect(continuity?.expiresAt).toBeNull();
    expect(drain?.expiresAt).toBeGreaterThan(T0);
  });

  it('grants continuity ONLY to the three lifecycle handlers across a major', () => {
    // §9.13's major rule, stated positively. `order_status` is a lifecycle
    // handler and keeps serving the orders the old major took;
    // `request_quote` is not, and a superseded major that could still quote
    // would be taking new business rather than draining.
    coordinator.apply({ installId, ...majorUpdate });

    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1).map((e) => e.kind).sort()).toEqual([
      'drain',
      'lifecycle_continuity',
    ]);
    expect(drains.listLive(installId, PRIOR_CID, CAP2, T0 + 1).map((e) => e.kind)).toEqual([
      'drain',
    ]);
  });

  it('records WHICH CONTRACT a continuity row speaks, not just which CID', () => {
    // §9.13's dispatch half. The row said which CID was authorized and nothing
    // about the version it speaks, so a prior major's continuation reached the
    // current adapter and the runner could not tell it was answering for an
    // older major. The version comes from the INSTALL — the manifest about to
    // stop running — never from the update being applied.
    coordinator.apply({ installId, ...majorUpdate });

    const [continuity] = drains
      .listLive(installId, PRIOR_CID, CAP, T0 + 1)
      .filter((e) => e.kind === 'lifecycle_continuity');
    expect(continuity.priorVersion).toBe('0.1.0');
    // And the drain row carries it too: a drained task is judged against the
    // contract it was created under, of which the version is part.
    const [drain] = drains
      .listLive(installId, PRIOR_CID, CAP, T0 + 1)
      .filter((e) => e.kind === 'drain');
    expect(drain.priorVersion).toBe('0.1.0');
  });

  it('rolls back the CID, the listings, and the authorizations together when the update CAS is lost', () => {
    // Someone else advanced the install between our read and our write.
    const racy = new UpdateRebindCoordinator({
      installs: () =>
        ({
          ...installs,
          getById: (id: string) => installs.getById(id),
          applyUpdate: () => false, // CAS loser
        }) as unknown as SQLitePluginInstallRepository,
      drains: () => drains,
      rebindListings: (args) => rebindListingsForUpdate(adapter, args),
      tx: tier0TxRunner(adapter),
      now: () => T0,
    });

    const result = racy.apply({ installId, ...update });

    expect(result).toEqual({ ok: false, refusal: 'update_cas_lost' });
    expect(installs.getById(installId)?.currentCid).toBe(PRIOR_CID);
    expect(boundCid(storedListing('self'), 'order_status')).toBe(PRIOR_CID);
    expect(boundCid(getServiceConfig('self') as ServiceConfig, 'order_status')).toBe(PRIOR_CID);
    // The authorizations described a transition that did not happen.
    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1)).toEqual([]);
  });

  it('rolls the CID back when the listing rebind itself fails', () => {
    const broken = makeCoordinator({ failRebind: true });

    expect(() => broken.apply({ installId, ...update })).toThrow('rebind exploded');

    // The install must NOT have moved: a CID that advanced without its
    // listings is the silently-off-the-market failure.
    expect(installs.getById(installId)?.currentCid).toBe(PRIOR_CID);
    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1)).toEqual([]);
  });

  it('leaves the cache untouched when the transaction fails AFTER the rebind', () => {
    // The CAS-loss path aborts before the rebind runs, so it cannot show this.
    // Here the rebind completes and the transaction then fails, which is the
    // only ordering where publishing early would be observable — and it is the
    // ordering a commit failure actually produces.
    const failsOnCommit = new UpdateRebindCoordinator({
      installs: () => installs,
      drains: () => drains,
      rebindListings: (a) => rebindListingsForUpdate(adapter, a),
      tx: (fn) => {
        tier0TxRunner(adapter)(() => {
          fn();
          throw new Error('commit failed');
        });
      },
      now: () => T0,
    });

    expect(() => failsOnCommit.apply({ installId, ...update })).toThrow('commit failed');

    expect(boundCid(storedListing('self'), 'order_status')).toBe(PRIOR_CID);
    // Nothing may have adopted the rewritten binding: the database rolled back.
    expect(boundCid(getServiceConfig('self') as ServiceConfig, 'order_status')).toBe(PRIOR_CID);
    expect(installs.getById(installId)?.currentCid).toBe(PRIOR_CID);
    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1)).toEqual([]);
  });

  /**
   * §16.5 (WS-4.5) — "an update cannot SILENTLY widen from catalog read to
   * order submission". The check is a pure comparison; these two prove it is
   * REACHED, and that it is reached before anything moves.
   */
  describe('a widening update is refused before the transaction', () => {
    it('refuses a version that adds a payment capability, and moves nothing', () => {
      const widened = {
        ...(priorManifest as unknown as Record<string, unknown>),
        version: '0.2.0',
        capabilities: [
          ...(priorManifest as unknown as { capabilities: unknown[] }).capabilities,
          {
            id: 'com.acme.commerce.submit_order',
            display_name: 'Submit order',
            interaction: 'query',
            action_class: 'payment',
            privacy_class: 'personal',
            kinds: ['provider'],
            params_schema: { type: 'object' },
            result_schema: { type: 'object' },
          },
        ],
      } as unknown as PluginManifest;

      const result = coordinator.apply({ installId, ...update, manifest: widened });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.refusal).toBe('requires_reconsent');
      expect(!result.ok && result.widening?.[0]?.kind).toBe('new_capability');

      // Nothing moved: not the CID, not the listings, not the authorizations.
      // A widening update is a different agreement, not a partial one.
      expect(installs.getById(installId)?.currentCid).toBe(PRIOR_CID);
      expect(boundCid(storedListing('self'), 'order_status')).toBe(PRIOR_CID);
      expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1)).toEqual([]);
    });

    it('still applies a narrowing update', () => {
      // The fixture manifest DROPS a capability and narrows both schemas.
      // Nobody is surprised by a plugin doing less, so it needs no re-consent
      // — and a check that refused this would make every update impossible.
      expect(coordinator.apply({ installId, ...update }).ok).toBe(true);
    });
  });

  it('refuses an unknown install, an unchanged CID, and a non-active install', () => {
    expect(coordinator.apply({ installId: 'nope', ...update })).toEqual({
      ok: false,
      refusal: 'install_unknown',
    });

    expect(coordinator.apply({ installId, ...update, cid: PRIOR_CID })).toEqual({
      ok: false,
      refusal: 'cid_unchanged',
    });

    installs.pause(installId, T0, 'manual');
    expect(coordinator.apply({ installId, ...update })).toEqual({
      ok: false,
      refusal: 'install_not_active',
      detail: 'paused',
    });
    // Nothing was written on any refusal.
    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1)).toEqual([]);
    expect(boundCid(storedListing('self'), 'order_status')).toBe(PRIOR_CID);
  });

  it('fails closed when either store is unwired', () => {
    // The two stores are wired at different points of different boots. A
    // coordinator that ran with one missing could advance the CID and lose the
    // authorizations, so neither half may proceed alone.
    for (const deps of [
      { installs: () => null, drains: () => drains },
      { installs: () => installs, drains: () => null },
    ]) {
      const partial = new UpdateRebindCoordinator({
        ...deps,
        rebindListings: (a) => rebindListingsForUpdate(adapter, a),
        tx: tier0TxRunner(adapter),
        now: () => T0,
      });
      expect(partial.apply({ installId, ...update })).toEqual({
        ok: false,
        refusal: 'stores_unavailable',
      });
    }
    expect(installs.getById(installId)?.currentCid).toBe(PRIOR_CID);
    expect(boundCid(storedListing('self'), 'order_status')).toBe(PRIOR_CID);
  });

  it('releases the continuity lane without touching the drain lane', () => {
    coordinator.apply({ installId, ...majorUpdate });

    expect(coordinator.releaseContinuity(installId, PRIOR_CID, CAP)).toEqual({
      released: true,
      openOrders: 0,
    });

    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1).map((e) => e.kind)).toEqual([
      'drain',
    ]);
    // The other capability is unaffected — release is per capability. It has
    // only its DRAIN row: `request_quote` is not one of the three lifecycle
    // handlers §9.13 keeps alive across a major, and a superseded major that
    // could still quote would be taking new business rather than draining.
    expect(
      drains.listLive(installId, PRIOR_CID, CAP2, T0 + 1).map((e) => e.kind),
    ).toEqual(['drain']);
  });

  it('refuses to release while an order the prior manifest served is still open', () => {
    // §9.13 releases per manifest once its LAST order is terminal. Releasing
    // early strands that buyer: their next order_status is refused for an order
    // the supplier is still obliged to.
    let open = 2;
    const withOrders = new UpdateRebindCoordinator({
      installs: () => installs,
      drains: () => drains,
      countOpenOrders: (cid) => (cid === PRIOR_CID ? open : 0),
      rebindListings: (a) => rebindListingsForUpdate(adapter, a),
      tx: tier0TxRunner(adapter),
      now: () => T0,
    });
    withOrders.apply({ installId, ...majorUpdate });

    expect(withOrders.releaseContinuity(installId, PRIOR_CID, CAP)).toEqual({
      released: false,
      openOrders: 2,
    });
    // Still live, so the buyer is still answerable.
    expect(
      drains
        .listLive(installId, PRIOR_CID, CAP, T0 + 1)
        .some((e) => e.kind === 'lifecycle_continuity'),
    ).toBe(true);

    // The last one settles; now the lane may close.
    open = 0;
    expect(withOrders.releaseContinuity(installId, PRIOR_CID, CAP)).toEqual({
      released: true,
      openOrders: 0,
    });
    expect(drains.listLive(installId, PRIOR_CID, CAP, T0 + 1).map((e) => e.kind)).toEqual([
      'drain',
    ]);
  });

  it('skips a listing row whose JSON will not parse instead of rewriting it', () => {
    adapter.execute(
      `INSERT INTO service_configs (rkey, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ['corrupt', '{not json', T0, T0],
    );

    const result = coordinator.apply({ installId, ...update });

    expect(result).toEqual({ ok: true, rebound: ['self'], authorizations: 2 });
    // Left exactly as found: rebuilding it here would invent a listing the
    // owner never authored.
    const rows = adapter.query<{ config_json: string }>(
      'SELECT config_json FROM service_configs WHERE rkey = ?',
      ['corrupt'],
    );
    expect(rows[0].config_json).toBe('{not json');
  });

  it('REFUSES the whole rebind when a schema change is not additive', () => {
    // §16.5 / §8.1 — `params_schema` and `result_schema` are inside the
    // per-capability scope hash, so a change to them changes what the install
    // may be asked to do and what it may answer. They used to be excluded from
    // widening detection entirely, on the reasoning that §9.13 DRAINS schema
    // changes; the drain governs tasks already created against their pinned
    // schemas, and says nothing about the next ones.
    //
    // A RENAME is the clearest case: every previously valid call becomes
    // invalid, and the owner approved the old shape.
    const renamed = {
      ...(nextManifest as unknown as Record<string, unknown>),
      capabilities: [
        {
          id: CAP,
          display_name: 'Order status',
          interaction: 'query',
          action_class: 'read',
          privacy_class: 'personal',
          kinds: ['provider'],
          params_schema: { type: 'object', properties: { poId: { type: 'string' } } },
          result_schema: { type: 'object', properties: { state: { type: 'string' } } },
        },
      ],
    } as unknown as PluginManifest;

    const result = coordinator.apply({ installId, ...update, manifest: renamed });

    expect(result).toMatchObject({ ok: false, refusal: 'requires_reconsent' });
    // NOTHING MOVED. A refusal that had already rebound the install would
    // leave it running new code under an approval nobody gave.
    expect(installs.getById(installId)?.currentCid).toBe(PRIOR_CID);
  });
});
