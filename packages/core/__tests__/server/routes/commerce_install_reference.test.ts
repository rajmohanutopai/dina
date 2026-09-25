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
import { referenceManifestCid } from '../../../src/commerce/reference_install';
import { SUPPLIER_REFERENCE_MANIFEST } from '../../../src/commerce/reference_manifests';
import { SUPPLIER_LISTING_BINDINGS } from '../../../src/commerce/supplier_listing';
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
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import {
  getServiceConfig,
  resetServiceConfigState,
  setServiceConfig,
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
