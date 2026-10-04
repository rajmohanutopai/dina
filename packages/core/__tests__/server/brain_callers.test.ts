/**
 * Who may call Brain (A2A design §4.1, plan §3.18): Core's service DID and
 * the owner's active devices, readable by Brain alone.
 */

import { isAuthorized } from '../../src/auth/authz';
import { registerDevice, resetDeviceRegistry, revokeDevice } from '../../src/devices/registry';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { installCoreServiceDid, registerBrainCallerRoutes } from '../../src/server/routes/brain_callers';

const router = new CoreRouter();
registerBrainCallerRoutes(router);

const get = (callerType: string) =>
  router.handle({
    method: 'GET',
    path: '/v1/brain/callers',
    query: {},
    headers: {},
    body: undefined,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType,
  } as CoreRequest);

afterEach(() => {
  installCoreServiceDid(null);
  resetDeviceRegistry();
});

it('tells Brain Core’s service DID and the owner’s active devices, nothing else', async () => {
  installCoreServiceDid('did:key:z6MkCoreService');
  const browser = registerDevice('Laptop', 'z6MkOwnerLaptop', 'owner');
  const old = registerDevice('Old laptop', 'z6MkOwnerOld', 'owner');
  registerDevice('Runner', 'z6MkRunner', 'agent', 'runner');
  revokeDevice(old.deviceId);
  const res = await get('brain');
  expect(res).toEqual({ status: 200, body: { core: 'did:key:z6MkCoreService', owner_devices: [browser.did] } });
});

it('answers no one but Brain', async () => {
  for (const caller of ['agent', 'device', 'gateway', 'owner_device', 'admin']) {
    expect((await get(caller)).status).toBe(403);
    expect(isAuthorized(caller as never, 'GET', '/v1/brain/callers')).toBe(false);
  }
  expect(isAuthorized('brain', 'GET', '/v1/brain/callers')).toBe(true);
  expect(isAuthorized('brain', 'POST', '/v1/brain/callers')).toBe(false);
});
