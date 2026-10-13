/**
 * REAL_LIFE_FIXES_2 §0 — guard modes and the owner's time zone live in Core:
 * Brain reads them, only the owner writes them, and a bad value is refused.
 */

import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerSettingsRoutes } from '../../../src/server/routes/settings';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { resetKVStore } from '../../../src/kv/store';

const CAP = 'cap-for-settings-tests';

function req(method: CoreRequest['method'], path: string, caller: 'brain' | 'owner' | 'agent', body: unknown = null) {
  return {
    method,
    path,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: caller,
    callerDID: caller === 'owner' ? 'did:plc:owner' : 'did:key:other',
    ...(caller === 'owner' ? { ownerCapability: CAP } : {}),
  } as CoreRequest;
}

let router: CoreRouter;
beforeEach(async () => {
  setNodeDID('did:plc:owner');
  resetKVStore();
  router = new CoreRouter();
  registerSettingsRoutes(router, CAP);
});

describe('guard modes', () => {
  it('start in report mode', async () => {
    const r = await router.handle(req('GET', '/v1/settings/guard-modes', 'brain'));
    expect(r.body).toEqual({ action_claims: 'report', regulated: 'report' });
  });

  it('the owner can enforce one; Brain cannot', async () => {
    const owner = await router.handle(req('PUT', '/v1/settings/guard-modes', 'owner', { regulated: 'enforce' }));
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ action_claims: 'report', regulated: 'enforce' });
    const brain = await router.handle(req('PUT', '/v1/settings/guard-modes', 'brain', { action_claims: 'enforce' }));
    expect(brain.status).toBe(403);
  });

  it('refuses an unknown guard or mode', async () => {
    expect((await router.handle(req('PUT', '/v1/settings/guard-modes', 'owner', { anti_her: 'enforce' }))).status).toBe(400);
    expect((await router.handle(req('PUT', '/v1/settings/guard-modes', 'owner', { regulated: 'off' }))).status).toBe(400);
  });
});

describe("the owner's time zone", () => {
  it("falls back to the host's zone", async () => {
    const r = await router.handle(req('GET', '/v1/settings/owner-timezone', 'brain'));
    expect((r.body as { source: string }).source).toBe('host');
  });

  it('the owner sets it; an agent cannot; a made-up zone is refused', async () => {
    const set = await router.handle(req('PUT', '/v1/settings/owner-timezone', 'owner', { timezone: 'Asia/Kolkata' }));
    expect(set.body).toEqual({ timezone: 'Asia/Kolkata', source: 'owner' });
    expect((await router.handle(req('PUT', '/v1/settings/owner-timezone', 'agent', { timezone: 'UTC' }))).status).toBe(403);
    expect((await router.handle(req('PUT', '/v1/settings/owner-timezone', 'owner', { timezone: 'Mars/Olympus' }))).status).toBe(400);
    const read = await router.handle(req('GET', '/v1/settings/owner-timezone', 'brain'));
    expect(read.body).toEqual({ timezone: 'Asia/Kolkata', source: 'owner' });
  });
});
