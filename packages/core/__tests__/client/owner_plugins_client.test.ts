/**
 * WEB_OWNER_SURFACE_PLAN §3.5 — the owner plugins client reads Core's answers
 * the same on every surface: an answer the caller acts on comes back as data
 * (a staged or refused begin, a teardown that kept its row, a coordinator's
 * refusal); a route's own refusal — presence above all — is raised with Core's
 * key, so the screen's presence sheet can ask and retry.
 */

import { OwnerPluginsClient, OwnerPluginsHttpError } from '../../src/client/owner-plugins-client';

import type { OwnerDispatcher, OwnerRequest } from '../../src/client/owner-dispatch';
import type { CoreResponse } from '../../src/server/router';

function client(answer: (req: OwnerRequest) => CoreResponse): {
  plugins: OwnerPluginsClient;
  sent: OwnerRequest[];
} {
  const sent: OwnerRequest[] = [];
  const dispatcher: OwnerDispatcher = {
    dispatch: async (req) => {
      sent.push(req);
      return answer(req);
    },
  };
  return { plugins: new OwnerPluginsClient(dispatcher), sent };
}

const presence = { status: 403, body: { error: 'no_user_presence', detail: 'x' } };

describe('begin', () => {
  it('a staged, a permanently refused and a transient begin are all answers', async () => {
    for (const [status, body] of [
      [200, { ok: true, installId: 'i', consent: {} }],
      [409, { ok: false, code: 'authenticity_failed', message: 'm', transient: false }],
      [503, { ok: false, code: 'verifier_unavailable', message: 'm', transient: true }],
    ] as const) {
      const { plugins } = client(() => ({ status, body }));
      expect(await plugins.begin('did:plc:p', 'rk')).toEqual(body);
    }
  });

  it('a route refusal that is not a begin answer is raised with its key', async () => {
    const { plugins } = client(() => ({
      status: 503,
      body: { error: 'owner_identity_unavailable' },
    }));
    await expect(plugins.beginCountryPack('in')).rejects.toMatchObject({
      errorKey: 'owner_identity_unavailable',
      status: 503,
    });
  });

  it('sends only what it was given (no empty label)', async () => {
    const { plugins, sent } = client(() => ({ status: 200, body: { ok: true } }));
    await plugins.begin('did:plc:p', 'rk', '');
    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/v1/plugins/install/begin',
      body: { publisher_did: 'did:plc:p', rkey: 'rk' },
    });
  });
});

describe('teardown answers', () => {
  it.each([
    [200, {}, { ok: true }],
    [404, { error: 'install_unknown' }, { ok: false, error: 'install_unknown' }],
    [
      409,
      { error: 'install_not_pending', status: 'active' },
      { ok: false, error: 'install_not_pending' },
    ],
    [
      409,
      { error: 'obligations_open', detail: 'po-1' },
      { ok: false, error: 'obligations_open', detail: 'po-1' },
    ],
    [
      409,
      { error: 'teardown_incomplete', detail: 'kept' },
      { ok: false, error: 'teardown_incomplete', detail: 'kept' },
    ],
  ] as const)('%s %o → %o', async (status, body, expected) => {
    const { plugins } = client(() => ({ status, body }));
    expect(await plugins.uninstall('i')).toEqual(expected);
  });

  it('anything else is raised', async () => {
    const { plugins } = client(() => ({ status: 403, body: { error: 'access_denied' } }));
    await expect(plugins.decline('i')).rejects.toBeInstanceOf(OwnerPluginsHttpError);
  });
});

describe('the steps that need a person present raise the refusal', () => {
  it.each([
    ['runnerCode', (p: OwnerPluginsClient) => p.runnerCode('i')],
    ['confirm', (p: OwnerPluginsClient) => p.confirm('i')],
    ['bindReferenceRunner', (p: OwnerPluginsClient) => p.bindReferenceRunner('i')],
    ['confirmCommercePack', (p: OwnerPluginsClient) => p.confirmCommercePack('i', 'did:key:d')],
    [
      'confirmPackUpdate',
      (p: OwnerPluginsClient) =>
        p.confirmPackUpdate({
          installId: 'i',
          toCid: 'c',
          acceptedWidening: [],
          acceptedBehaviorHash: 'h',
        }),
    ],
  ] as const)('%s', async (_name, call) => {
    const { plugins } = client(() => presence);
    await expect(call(plugins)).rejects.toMatchObject({
      errorKey: 'no_user_presence',
      status: 403,
    });
  });

  it('a pack update the coordinator refused is an answer, not an error', async () => {
    const refused = { ok: true, outcome: { ok: false, refusal: 'requires_reconsent' } };
    const { plugins } = client(() => ({ status: 409, body: refused }));
    expect(
      await plugins.confirmPackUpdate({
        installId: 'i',
        toCid: 'c',
        acceptedWidening: [],
        acceptedBehaviorHash: 'h',
      }),
    ).toEqual(refused);
  });
});

describe('reads', () => {
  it('installs, pairing state and pack updates', async () => {
    const { plugins, sent } = client((req) => {
      if (req.path === '/v1/plugins/installs') {
        return {
          status: 200,
          body: { installs: [], registry_available: true, third_party_available: false },
        };
      }
      if (req.path === '/v1/plugins/install/pairing_state')
        return { status: 200, body: { state: 'waiting' } };
      return { status: 200, body: { updates: [{ install_id: 'i' }] } };
    });
    expect((await plugins.installs()).third_party_available).toBe(false);
    expect(await plugins.pairingState('i', 'CODE1234')).toEqual({ state: 'waiting' });
    expect(await plugins.packUpdates()).toEqual([{ install_id: 'i' }]);
    // The pairing code rides the body, never the URL.
    expect(sent[1]).toEqual({
      method: 'POST',
      path: '/v1/plugins/install/pairing_state',
      body: { install_id: 'i', code: 'CODE1234' },
    });
  });
});
