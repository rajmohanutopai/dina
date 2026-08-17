/**
 * PC-9a — the owner install step for the FIRST-PARTY commerce packs.
 *
 * `beginInstallVerified` had no production caller: the whole plugin
 * machinery was built and no route could create an install, so a live
 * supplier refused every quote request with `install_unavailable`. These
 * routes drive the EXISTING machinery — pending row, device binding,
 * consent — and this suite drives the routes over a real registry on real
 * SQLite, because "built and nothing calls it" is exactly the defect the
 * live run found.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  SQLitePluginInstallRepository,
  setPluginDeviceVerifier,
  setPluginInstallRepository,
} from '../../../src/plugins';
import { referenceManifestCid } from '../../../src/commerce/reference_install';
import { SUPPLIER_REFERENCE_MANIFEST } from '../../../src/commerce/reference_manifests';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';
const RUNNER_DEVICE = 'did:key:zSupplierRunnerDevice';

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
  dir = mkdtempSync(path.join(tmpdir(), 'commerce-install-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setPluginInstallRepository(new SQLitePluginInstallRepository(adapter));
  // The boot-wired registry check: only the runner device this suite pairs.
  setPluginDeviceVerifier((did) => did === RUNNER_DEVICE);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  setNodeDID(SUPPLIER);
});

afterEach(() => {
  clearPairingState();
  setPluginDeviceVerifier(null);
  setPluginInstallRepository(null);
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the boundary', () => {
  it('refuses every non-owner caller on all three routes', async () => {
    for (const routePath of [
      '/v1/commerce/install/begin',
      '/v1/commerce/install/bind_device',
      '/v1/commerce/install/confirm',
    ]) {
      for (const caller of ['device', 'agent', 'service', 'plugin']) {
        const resp = await router.handle(post(routePath, { role: 'supplier' }, caller));
        expect(resp.status).toBe(403);
      }
    }
  });

  it('refuses a role that is not buyer|supplier', async () => {
    const resp = await router.handle(post('/v1/commerce/install/begin', { role: 'both' }));
    expect(resp.status).toBe(400);
  });
});

describe('the ceremony', () => {
  async function begin(role: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const resp = await router.handle(post('/v1/commerce/install/begin', { role }));
    return { status: resp.status, body: resp.body as Record<string, unknown> };
  }

  it('begin mints a PENDING install with the real content-derived cid', async () => {
    const { status, body } = await begin('supplier');
    expect(status).toBe(200);
    expect(body.status).toBe('pending');
    const installId = body.install_id as string;
    const install = new SQLitePluginInstallRepository(adapter).getById(installId);
    expect(install?.status).toBe('pending');
    expect(install?.pluginId).toBe(SUPPLIER_REFERENCE_MANIFEST.plugin_id);
    // The stored content address is re-provable from the manifest alone —
    // the §5 invariant, held by a first-party install too.
    expect(install?.currentCid).toBe(referenceManifestCid(SUPPLIER_REFERENCE_MANIFEST));
    expect(install?.trustAnchor).toEqual({
      kind: 'local_publisher_key',
      keyId: 'dina-kernel-reference',
    });
  });

  it('confirm REFUSES a runner install with no bound device', async () => {
    const { body } = await begin('supplier');
    const resp = await router.handle(
      post('/v1/commerce/install/confirm', {
        install_id: body.install_id,
        device_did: RUNNER_DEVICE,
      }),
    );
    expect(resp.status).toBe(409);
  });

  it('begin → bind_device → confirm → ACTIVE, then begin is idempotent', async () => {
    const { body } = await begin('supplier');
    const installId = body.install_id as string;

    const bound = await router.handle(
      post('/v1/commerce/install/bind_device', {
        install_id: installId,
        device_did: RUNNER_DEVICE,
      }),
    );
    expect(bound.status).toBe(200);

    const confirmed = await router.handle(
      post('/v1/commerce/install/confirm', {
        install_id: installId,
        device_did: RUNNER_DEVICE,
      }),
    );
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { status: string }).status).toBe('active');

    // A second begin answers with the ACTIVE install instead of stacking a
    // second consent for authority the owner already granted.
    const again = await begin('supplier');
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('active');
    expect(again.body.install_id).toBe(installId);
  });

  it('confirm refuses a device the registry does not vouch for', async () => {
    const { body } = await begin('supplier');
    const installId = body.install_id as string;
    await router.handle(
      post('/v1/commerce/install/bind_device', {
        install_id: installId,
        device_did: 'did:key:zSomeOtherDevice',
      }),
    );
    const resp = await router.handle(
      post('/v1/commerce/install/confirm', {
        install_id: installId,
        device_did: 'did:key:zSomeOtherDevice',
      }),
    );
    expect(resp.status).toBe(409);
  });

  it('retire tears the install down and a fresh begin mints a NEW pending', async () => {
    // The day the compiled reference manifest changes, the active install
    // pins the old bytes — replace = retire + fresh ceremony.
    const { body } = await begin('supplier');
    const installId = body.install_id as string;
    await router.handle(
      post('/v1/commerce/install/bind_device', { install_id: installId, device_did: RUNNER_DEVICE }),
    );
    await router.handle(
      post('/v1/commerce/install/confirm', { install_id: installId, device_did: RUNNER_DEVICE }),
    );
    const retired = await router.handle(
      post('/v1/commerce/install/retire', { install_id: installId }),
    );
    expect(retired.status).toBe(200);
    const again = await begin('supplier');
    expect(again.body.status).toBe('pending');
    expect(again.body.install_id).not.toBe(installId);
  });

  it('buyer and supplier are two separate installs (§18.1)', async () => {
    const buyer = await begin('buyer');
    const supplier = await begin('supplier');
    expect(buyer.body.install_id).not.toBe(supplier.body.install_id);
    expect(buyer.body.plugin_id).not.toBe(supplier.body.plugin_id);
  });
});
