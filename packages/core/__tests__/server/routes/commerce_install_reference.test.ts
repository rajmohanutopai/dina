/**
 * Review items 5 and 6 at the owner's doors: the reference runner is paired
 * to a PENDING supplier install by the owner, consent stays its own step,
 * and consent writes the listing binding every buyer query routes through —
 * without ever demoting a public listing.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetCallerTypeState } from '../../../src/auth/caller_type';
import {
  KERNEL_REFERENCE_KEY_ID,
  referenceManifestCid,
} from '../../../src/commerce/reference_install';
import { SUPPLIER_REFERENCE_MANIFEST } from '../../../src/commerce/reference_manifests';
import {
  getCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../../src/commerce/runtime';
import { InMemoryCommerceSettingsRepository } from '../../../src/commerce/settings_store';
import {
  PLACEHOLDER_LISTING_NAME,
  SUPPLIER_LISTING_BINDINGS,
  bindSupplierListing,
  syncSupplierListingName,
} from '../../../src/commerce/supplier_listing';
import { referenceRunnerDevice } from '../../../src/commerce/supplier_runner';
import { getDeviceByDID, resetDeviceRegistry } from '../../../src/devices/registry';
import { SQLiteDeviceRepository, setDeviceRepository } from '../../../src/devices/repository';
import { resetKVStore } from '../../../src/kv/store';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import {
  SQLitePluginGrantRepository,
  SQLitePluginInstallRepository,
  getPluginInstallRepository,
  setPluginDeviceVerifier,
  setPluginGrantRepository,
  setPluginInstallRepository,
} from '../../../src/plugins';
import {
  SQLiteDrainAuthorizationRepository,
  setDrainAuthorizationRepository,
} from '../../../src/plugins/drain_authorizations';
import { UpdateRebindCoordinator } from '../../../src/plugins/update_rebind';
import {
  clearPreparedUpdates,
  setUpdateRebindCoordinator,
} from '../../../src/plugins/update_service';
import { tier0TxRunner } from '../../../src/run/tx';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { rebindListingsForUpdate } from '../../../src/service/listing_rebind';
import {
  getServiceConfig,
  resetServiceConfigState,
  setServiceConfig,
  setServiceConfigDurable,
} from '../../../src/service/service_config';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;

function post(routePath: string, body: Record<string, unknown>, caller = 'owner'): CoreRequest {
  return {
    method: 'POST',
    path: routePath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: caller,
    callerDID: 'did:key:caller',
    ...(caller === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

beforeEach(() => {
  resetKVStore();
  resetServiceConfigState();
  dir = mkdtempSync(path.join(tmpdir(), 'commerce-install-ref-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  setPluginGrantRepository(new SQLitePluginGrantRepository(adapter));
  setDeviceRepository(new SQLiteDeviceRepository(adapter));
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  setNodeDID(SUPPLIER);
});

afterEach(() => {
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  resetKVStore();
  resetServiceConfigState();
  setDeviceRepository(null);
  setPluginDeviceVerifier(null);
  setPluginGrantRepository(null);
  setPluginInstallRepository(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function begin(): Promise<{ installId: string; body: Record<string, unknown> }> {
  const res = await router.handle(post('/v1/commerce/install/begin', { role: 'supplier' }));
  expect(res.status).toBe(200);
  const body = res.body as Record<string, unknown>;
  return { installId: String(body.install_id), body };
}

describe('the reference runner and the listing, at the owner’s doors', () => {
  it('begin names the listing; the owner pairs the reference runner; consent activates and binds every commerce lane to the install', async () => {
    const { installId, body } = await begin();
    expect(body.listing).toEqual({
      rkey: 'self',
      visibility: 'unlisted',
      capabilities: SUPPLIER_LISTING_BINDINGS.map((b) => b.wire),
    });
    const paired = await router.handle(
      post('/v1/commerce/install/bind_reference_runner', { install_id: installId }),
    );
    expect(paired.status).toBe(200);
    const deviceDid = (paired.body as { device_did: string }).device_did;
    expect(getDeviceByDID(deviceDid)).toMatchObject({
      role: 'plugin',
      scope: 'runner',
      revoked: false,
    });
    expect(await referenceRunnerDevice()).toBe(deviceDid);
    // Pairing is not consent: the install is still pending, the listing unwritten.
    expect(getPluginInstallRepository()?.getById(installId)?.status).toBe('pending');
    expect(getServiceConfig('self')).toBeNull();
    const confirmed = await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: deviceDid }),
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({
      ok: true,
      status: 'active',
      listing: { ok: true, rkey: 'self', discoverability: 'unlisted' },
    });
    const install = getPluginInstallRepository()?.getById(installId);
    expect(install?.status).toBe('active');
    expect(install?.deviceDid).toBe(deviceDid);
    const listing = getServiceConfig('self');
    expect(listing).toMatchObject({
      name: 'Commerce',
      isDiscoverable: false,
      discoverability: 'unlisted',
    });
    for (const binding of SUPPLIER_LISTING_BINDINGS) {
      expect(listing?.capabilities?.[binding.wire]).toEqual({
        responsePolicy: 'auto',
        category: 'commerce',
        pluginInstallId: installId,
        pluginManifestCid: referenceManifestCid(SUPPLIER_REFERENCE_MANIFEST),
        pluginCapabilityId: binding.capabilityId,
      });
    }
  });

  it('merges into an existing unlisted listing without touching its other services or its visibility', async () => {
    setServiceConfig(
      {
        name: 'Albert’s Bakery',
        status: 'active',
        isDiscoverable: false,
        discoverability: 'known_only',
        capabilities: {
          appointment_availability: {
            responsePolicy: 'auto',
            category: 'appointments',
            instruction: 'Tastings on Saturday afternoons.',
          },
        },
      } as never,
      'self',
    );
    const { installId } = await begin();
    const paired = await router.handle(
      post('/v1/commerce/install/bind_reference_runner', { install_id: installId }),
    );
    const deviceDid = (paired.body as { device_did: string }).device_did;
    const confirmed = await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: deviceDid }),
    );
    expect((confirmed.body as { listing: unknown }).listing).toEqual({
      ok: true,
      rkey: 'self',
      discoverability: 'known_only',
    });
    const listing = getServiceConfig('self');
    expect(listing?.name).toBe('Albert’s Bakery');
    expect(listing?.capabilities?.appointment_availability).toEqual({
      responsePolicy: 'auto',
      category: 'appointments',
      instruction: 'Tastings on Saturday afternoons.',
    });
    expect(listing?.capabilities?.['com.dinakernel.commerce.submit_order']).toMatchObject({
      pluginInstallId: installId,
    });
  });

  it('refuses consent while the self listing is public, rather than demoting it, and consents once it moves', async () => {
    setServiceConfig(
      {
        name: 'Public bakery',
        status: 'active',
        isDiscoverable: true,
        discoverability: 'public',
        capabilities: {},
      } as never,
      'self',
    );
    const { installId, body } = await begin();
    expect((body.listing as { visibility: string }).visibility).toBe('public');
    const paired = await router.handle(
      post('/v1/commerce/install/bind_reference_runner', { install_id: installId }),
    );
    const deviceDid = (paired.body as { device_did: string }).device_did;
    const refused = await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: deviceDid }),
    );
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toBe('self_listing_public');
    expect(getPluginInstallRepository()?.getById(installId)?.status).toBe('pending');
    expect(getServiceConfig('self')?.discoverability).toBe('public');
    resetServiceConfigState();
    const confirmed = await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: deviceDid }),
    );
    expect(confirmed.status).toBe(200);
  });

  it('refuses the reference runner for anything but a pending supplier install, and the bind_listing door for anything but an active one', async () => {
    expect(
      (
        await router.handle(
          post('/v1/commerce/install/bind_reference_runner', { install_id: 'nope' }),
        )
      ).status,
    ).toBe(404);
    // The buyer pack completes the same way on a server node; its device serves nothing.
    const buyer = await router.handle(post('/v1/commerce/install/begin', { role: 'buyer' }));
    const buyerId = String((buyer.body as { install_id: string }).install_id);
    const buyerPaired = await router.handle(
      post('/v1/commerce/install/bind_reference_runner', { install_id: buyerId }),
    );
    expect(buyerPaired.status).toBe(200);
    expect(await referenceRunnerDevice()).toBeNull();
    const buyerDevice = (buyerPaired.body as { device_did: string }).device_did;
    expect(
      (
        await router.handle(
          post('/v1/commerce/install/confirm', { install_id: buyerId, device_did: buyerDevice }),
        )
      ).body,
    ).toEqual({ ok: true, status: 'active' });
    const { installId } = await begin();
    expect(
      (await router.handle(post('/v1/commerce/install/bind_listing', { install_id: installId })))
        .body,
    ).toMatchObject({ error: 'not_an_active_supplier_install' });
    const paired = await router.handle(
      post('/v1/commerce/install/bind_reference_runner', { install_id: installId }),
    );
    const deviceDid = (paired.body as { device_did: string }).device_did;
    await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: deviceDid }),
    );
    expect(
      (
        await router.handle(
          post('/v1/commerce/install/bind_reference_runner', { install_id: installId }),
        )
      ).body,
    ).toMatchObject({ error: 'install_not_pending' });
    resetServiceConfigState();
    const rebound = await router.handle(
      post('/v1/commerce/install/bind_listing', { install_id: installId }),
    );
    expect(rebound.status).toBe(200);
    expect(
      getServiceConfig('self')?.capabilities?.['com.dinakernel.commerce.request_quote'],
    ).toMatchObject({ pluginInstallId: installId });
    // Owner-only, like every install door.
    expect(
      (
        await router.handle(
          post('/v1/commerce/install/bind_reference_runner', { install_id: installId }, 'brain'),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await router.handle(
          post('/v1/commerce/install/bind_listing', { install_id: installId }, 'staff'),
        )
      ).status,
    ).toBe(403);
  });
});

describe('the listing follows the manifest the install runs (NEGOTIATION_PLAN §4.3)', () => {
  it('an install on pack 1.0.0 is pinned to its own manifest and offers no counter lane', async () => {
    const older = {
      ...SUPPLIER_REFERENCE_MANIFEST,
      version: '1.0.0',
      capabilities: SUPPLIER_REFERENCE_MANIFEST.capabilities.filter(
        (c) => c.id !== 'com.dinakernel.commerce.negotiate-quote',
      ),
    };
    const installs = getPluginInstallRepository();
    if (installs === null) throw new Error('no install repository');
    const installId = installs.createPending({
      publisherDid: SUPPLIER,
      pluginId: SUPPLIER_REFERENCE_MANIFEST.plugin_id,
      label: 'Supplier',
      executionMode: 'runner',
      currentCid: 'bafy-pack-1-0-0',
      currentVersion: '1.0.0',
      manifest: older,
      installScopeHash: 'a'.repeat(64),
      capabilityHashes: {},
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'c'.repeat(64),
      trustAnchor: { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(Date.now() / 1000) + 600,
      nowMs: Date.now(),
    });
    expect(installs.bindPendingDevice(installId, 'did:key:zRunner', Date.now())).toBe(true);
    expect(installs.activate(installId, 'did:key:zRunner', Date.now())).toBe(true);
    const outcome = await bindSupplierListing({ installId, name: 'Old pack' });
    expect(outcome).toMatchObject({ ok: true });
    const capabilities = getServiceConfig('self')?.capabilities ?? {};
    expect(capabilities['com.dinakernel.commerce.counter_offer']).toBeUndefined();
    expect(capabilities['com.dinakernel.commerce.request_quote']).toMatchObject({
      pluginInstallId: installId,
      pluginManifestCid: 'bafy-pack-1-0-0',
    });
    // The not-awarded notice routes through a lane 1.0.0 already has.
    expect(capabilities['com.dinakernel.commerce.quote_outcome']).toMatchObject({
      pluginManifestCid: 'bafy-pack-1-0-0',
      pluginCapabilityId: 'com.dinakernel.commerce.request-quote',
    });
  });
});

describe('item 1 — a first-party pack updates in place, with the build', () => {
  const older = {
    ...SUPPLIER_REFERENCE_MANIFEST,
    version: '1.0.0',
    capabilities: SUPPLIER_REFERENCE_MANIFEST.capabilities.filter(
      (c) => c.id !== 'com.dinakernel.commerce.negotiate-quote',
    ),
  };
  const get = (routePath: string): CoreRequest => ({ ...post(routePath, {}), method: 'GET' });

  function installOlder(anchor: 'first_party' | 'repo_proof'): string {
    const installs = getPluginInstallRepository();
    if (installs === null) throw new Error('no install repository');
    const installId = installs.createPending({
      publisherDid: SUPPLIER,
      pluginId: SUPPLIER_REFERENCE_MANIFEST.plugin_id,
      label: 'Supplier',
      executionMode: 'runner',
      currentCid: referenceManifestCid(older),
      currentVersion: '1.0.0',
      manifest: older,
      installScopeHash: 'a'.repeat(64),
      capabilityHashes: {},
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'c'.repeat(64),
      trustAnchor:
        anchor === 'first_party'
          ? { kind: 'local_publisher_key', keyId: KERNEL_REFERENCE_KEY_ID }
          : { kind: 'repo_proof' },
      pendingExpiresAtSec: Math.floor(Date.now() / 1000) + 600,
      nowMs: Date.now(),
    });
    expect(installs.bindPendingDevice(installId, 'did:key:zRunner', Date.now())).toBe(true);
    expect(installs.activate(installId, 'did:key:zRunner', Date.now())).toBe(true);
    return installId;
  }

  beforeEach(() => {
    setDrainAuthorizationRepository(new SQLiteDrainAuthorizationRepository(adapter));
    setUpdateRebindCoordinator(
      new UpdateRebindCoordinator({
        installs: () => getPluginInstallRepository(),
        drains: () => new SQLiteDrainAuthorizationRepository(adapter),
        rebindListings: (args) => rebindListingsForUpdate(adapter, args),
        countOpenOrders: () => 1, // an order is open: the install must survive it
        tx: tier0TxRunner(adapter),
        now: () => Date.now(),
      }),
    );
  });
  afterEach(() => {
    setUpdateRebindCoordinator(null);
    setDrainAuthorizationRepository(null);
    clearPreparedUpdates();
  });

  it('lists the update, reviews it, and applies it on the SAME install; the new counter lane is bound', async () => {
    const installId = installOlder('first_party');
    expect(await bindSupplierListing({ installId, name: 'Old pack' })).toMatchObject({ ok: true });
    expect(
      getServiceConfig('self')?.capabilities['com.dinakernel.commerce.counter_offer'],
    ).toBeUndefined();

    const listed = await router.handle(get('/v1/commerce/install/updates'));
    expect(listed.body).toMatchObject({
      updates: [
        {
          install_id: installId,
          from_version: '1.0.0',
          to_version: SUPPLIER_REFERENCE_MANIFEST.version,
        },
      ],
    });
    const prepared = await router.handle(
      post('/v1/commerce/install/update/prepare', { install_id: installId }),
    );
    expect(prepared.status).toBe(200);
    const review = (prepared.body as { review: Record<string, unknown> }).review;
    expect(review).toMatchObject({
      fromVersion: '1.0.0',
      toVersion: SUPPLIER_REFERENCE_MANIFEST.version,
    });

    // Confirming without echoing the review is refused (the owner must have seen it).
    const blind = await router.handle(
      post('/v1/commerce/install/update/confirm', { install_id: installId, to_cid: review.toCid }),
    );
    expect(blind.status).toBe(409);
    const confirmed = await router.handle(
      post('/v1/commerce/install/update/confirm', {
        install_id: installId,
        to_cid: review.toCid,
        accepted_widening: review.widening,
        accepted_behavior_hash: review.toBehaviorHash,
      }),
    );
    expect(confirmed.status).toBe(200);
    const install = getPluginInstallRepository()?.getById(installId);
    expect(install).toMatchObject({
      installId,
      status: 'active',
      currentVersion: SUPPLIER_REFERENCE_MANIFEST.version,
      currentCid: referenceManifestCid(SUPPLIER_REFERENCE_MANIFEST),
    });
    expect(
      getServiceConfig('self')?.capabilities['com.dinakernel.commerce.counter_offer'],
    ).toMatchObject({
      pluginInstallId: installId,
      pluginManifestCid: referenceManifestCid(SUPPLIER_REFERENCE_MANIFEST),
      pluginCapabilityId: 'com.dinakernel.commerce.negotiate-quote',
    });
    // Nothing more to offer once it runs the build's manifest.
    expect((await router.handle(get('/v1/commerce/install/updates'))).body).toEqual({
      updates: [],
    });
  });

  it("a pack that arrived by repo proof is not offered the build's bytes", async () => {
    const installId = installOlder('repo_proof');
    expect((await router.handle(get('/v1/commerce/install/updates'))).body).toEqual({
      updates: [],
    });
    const prepared = await router.handle(
      post('/v1/commerce/install/update/prepare', { install_id: installId }),
    );
    expect(prepared.status).toBe(409);
    expect(prepared.body).toMatchObject({ ok: false, code: 'cid_unchanged' });
  });
});

describe('the listing follows the business’s legal name', () => {
  // A supplier who enabled selling before filling in Business identity was
  // published as "Commerce" for good: every bakery in search read
  // "Commerce · did:plc:…". Saving the legal name now renames that listing and
  // a later change follows; a name the owner chose for the listing stays.
  beforeEach(() => {
    installCommerceRuntime({
      settings: new InMemoryCommerceSettingsRepository(),
    } as unknown as CommerceRuntime);
  });
  afterEach(() => installCommerceRuntime(null));

  async function activate(): Promise<void> {
    const { installId } = await begin();
    const paired = await router.handle(
      post('/v1/commerce/install/bind_reference_runner', { install_id: installId }),
    );
    const deviceDid = (paired.body as { device_did: string }).device_did;
    const confirmed = await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: deviceDid }),
    );
    expect(confirmed.status).toBe(200);
  }

  function saveBusiness(legalName: string): ReturnType<CoreRouter['handle']> {
    return router.handle({
      ...post('/v1/commerce/settings/business', {
        legalName,
        registrations: [],
        address: {
          line1: '3 Market Road',
          city: 'Bengaluru',
          region: 'Karnataka',
          postalCode: '560001',
          country: 'IN',
        },
      }),
      method: 'PUT',
    });
  }

  it('a listing made before the legal name takes it when Business identity is saved, and follows a change', async () => {
    await activate();
    expect(getServiceConfig('self')?.name).toBe(PLACEHOLDER_LISTING_NAME);
    const saved = await saveBusiness('Sancho Bakery');
    expect(saved).toEqual({ status: 200, body: { ok: true, listing: 'renamed' } });
    expect(getServiceConfig('self')?.name).toBe('Sancho Bakery');
    await saveBusiness('Sancho & Sons Bakery');
    expect(getServiceConfig('self')?.name).toBe('Sancho & Sons Bakery');
  });

  it('a name the owner chose for the listing stays theirs', async () => {
    await activate();
    const listing = getServiceConfig('self');
    if (listing === null) throw new Error('listing not written');
    await setServiceConfigDurable({ ...listing, name: 'Sancho’s Cakes' }, 'self');
    const saved = await saveBusiness('Sancho Bakery Pvt Ltd');
    expect(saved.body).toEqual({ ok: true, listing: 'unchanged' });
    expect(getServiceConfig('self')?.name).toBe('Sancho’s Cakes');
  });

  it('a node already stuck on the placeholder heals with no owner action: the sync boot runs renames it', async () => {
    await activate();
    // The legal name was saved by a build that did not rename the listing.
    getCommerceRuntime()?.settings.writeBusiness({
      legalName: 'Sancho Bakery',
      registrations: [],
      address: {
        line1: '3 Market Road',
        city: 'Bengaluru',
        region: 'Karnataka',
        postalCode: '560001',
        country: 'IN',
      },
    });
    expect(getServiceConfig('self')?.name).toBe(PLACEHOLDER_LISTING_NAME);
    expect(await syncSupplierListingName({ legalName: 'Sancho Bakery' })).toBe('renamed');
    expect(getServiceConfig('self')?.name).toBe('Sancho Bakery');
  });

  it('a self listing that is not a commerce listing is never renamed', async () => {
    await setServiceConfigDurable(
      {
        name: PLACEHOLDER_LISTING_NAME,
        status: 'active',
        isDiscoverable: false,
        capabilities: {},
      } as never,
      'self',
    );
    expect(await syncSupplierListingName({ legalName: 'Sancho Bakery' })).toBe('unchanged');
    expect(getServiceConfig('self')?.name).toBe(PLACEHOLDER_LISTING_NAME);
  });
});
