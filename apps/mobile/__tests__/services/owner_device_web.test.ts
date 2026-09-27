/**
 * WEB_OWNER_SURFACE_PLAN §3.3 — connecting a browser as the owner's device.
 *
 * Driven against fake IndexedDB and Node's real WebCrypto (the browser API),
 * with `fetch` answering as Core's owner-setup and pairing routes do. The
 * rules pinned here:
 *   - only a Core-served page may connect, and it sends nothing otherwise;
 *   - the owner key reaches only the two owner routes and is never stored;
 *   - the key is NON-EXTRACTABLE, and what it signs verifies against the public
 *     key Core registered;
 *   - refusals come back by name, so the screen can say what to fix;
 *   - disconnecting forgets the key even when the revoke cannot be confirmed;
 *   - the stored device is read fresh on each use, so every tab of the origin
 *     sees one state (no per-tab copy keeps signing after a disconnect).
 */

import 'fake-indexeddb/auto';

import { multibaseToPublicKey, verify } from '@dina/core';

let mockConfig: WebRuntimeConfig = { servedByCore: true, brainUrl: 'http://127.0.0.1:8200' };
jest.mock('../../src/services/web_runtime', () => ({
  loadWebRuntimeConfig: async () => mockConfig,
}));

import {
  OwnerDeviceError,
  connectOwnerDevice,
  disconnectOwnerDevice,
  loadOwnerSigner,
  forgetOwnerDeviceCoreDropped,
  ownerAccessState,
  subscribeOwnerAccess,
} from '../../src/services/owner_device.web';

import type { WebRuntimeConfig } from '../../src/services/web_runtime';

const OWNER_KEY = 'owner-capability-for-web-tests-0123456789';
const PASSPHRASE = 'correct horse';

interface Sent {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Core's answers, as the routes give them. Tweak per test. */
let core: {
  presence: 'check' | 'unavailable';
  gatesPairing: boolean;
  registeredKey: string | null;
  sent: Sent[];
};

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mockConfig = { servedByCore: true, brainUrl: 'http://127.0.0.1:8200' };
  core = { presence: 'check', gatesPairing: true, registeredKey: null, sent: [] };
  let present = false;
  globalThis.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    core.sent.push({ path, headers, body });
    const owner = headers['x-dina-owner-capability'] === OWNER_KEY;
    // Answers copied from a running Core. The owner-setup routes refuse a
    // wrong key with 403; a router route treats it as an unsigned request.
    const unsigned = answer(401, {
      error: 'Missing required auth headers (X-DID, X-Timestamp, X-Nonce, X-Signature)',
      rejected_at: 'headers',
    });
    switch (path) {
      case '/v1/owner/setup/status':
        if (!owner) return answer(403, { error: 'access_denied' });
        return answer(200, { owner_devices: [], coding_agents: [], staff_devices: [] });
      case '/v1/commerce/catalog/drafts/presence':
        if (!owner) return unsigned;
        if (core.presence === 'unavailable') return answer(409, { error: 'presence_unavailable' });
        if (body.passphrase !== PASSPHRASE) return answer(401, { error: 'not_proven' });
        present = true;
        return answer(200, { ok: true });
      case '/v1/owner/setup/owner-device':
        if (!owner) return answer(403, { error: 'access_denied' });
        if (core.gatesPairing && core.presence === 'check' && !present) {
          return answer(403, { error: 'no_user_presence', detail: 'x' });
        }
        return answer(201, { code: 'PAIRCODE', device_name: body.device_name, expires_at: 1 });
      case '/v1/pair/complete':
        if (body.code !== 'PAIRCODE') return answer(400, { error: 'invalid code' });
        core.registeredKey = String(body.public_key_multibase);
        return answer(201, { device_id: 'dev-1' });
      default:
        return answer(404, { error: 'no route' });
    }
  }) as typeof fetch;
});

afterEach(async () => {
  await disconnectOwnerDevice(async () => undefined);
});

/** Delete the stored row directly, as another tab's disconnect does. */
async function dropRowBehindTheTab(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('dina-owner-device', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('device', 'readwrite');
      tx.objectStore('device').delete('owner');
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe('where the owner may connect', () => {
  it('a page Core did not serve cannot connect, and sends nothing', async () => {
    mockConfig = { servedByCore: false, brainUrl: '' };
    expect((await ownerAccessState()).kind).toBe('unavailable');
    await expect(
      connectOwnerDevice({ ownerKey: OWNER_KEY, passphrase: PASSPHRASE, deviceName: 'Laptop' }),
    ).rejects.toMatchObject({ errorKey: 'not_served_by_core' });
    expect(core.sent).toEqual([]);
  });
});

describe('connecting', () => {
  it('proves presence, mints an owner code, pairs a non-extractable key, and signs verifiably', async () => {
    const heard: string[] = [];
    const stop = subscribeOwnerAccess(() => heard.push('changed'));
    const device = await connectOwnerDevice({
      ownerKey: ` ${OWNER_KEY} `,
      passphrase: PASSPHRASE,
      deviceName: ' Office laptop ',
    });
    stop();
    expect(core.sent.map((s) => s.path)).toEqual([
      '/v1/owner/setup/status',
      '/v1/commerce/catalog/drafts/presence',
      '/v1/owner/setup/owner-device',
      '/v1/pair/complete',
    ]);
    // The owner key reaches only the owner routes, trimmed; never pairing.
    for (const sent of core.sent.slice(0, 3)) {
      expect(sent.headers['x-dina-owner-capability']).toBe(OWNER_KEY);
    }
    expect(core.sent[3].headers['x-dina-owner-capability']).toBeUndefined();
    expect(device.deviceName).toBe('Office laptop');
    expect(heard).toEqual(['changed']);
    expect(await ownerAccessState()).toEqual({ kind: 'connected', device });

    const signer = await loadOwnerSigner();
    if (signer === null) throw new Error('not connected');
    expect(signer.did).toBe(device.did);
    const message = new TextEncoder().encode(
      'GET\n/v1/run/list\n\n2026-09-27T00:00:00Z\nabc\ne3b0',
    );
    const signature = await signer.sign(message);
    const registered = multibaseToPublicKey(core.registeredKey ?? '');
    expect(verify(registered, message, signature)).toBe(true);
  });

  it('the key cannot be read out, and the owner key is not stored anywhere', async () => {
    await connectOwnerDevice({ ownerKey: OWNER_KEY, passphrase: PASSPHRASE, deviceName: 'Laptop' });
    const row = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const open = indexedDB.open('dina-owner-device', 1);
      open.onsuccess = () => {
        const get = open.result.transaction('device').objectStore('device').get('owner');
        get.onsuccess = () => {
          open.result.close();
          resolve(get.result as Record<string, unknown>);
        };
        get.onerror = () => reject(get.error);
      };
      open.onerror = () => reject(open.error);
    });
    const key = row.privateKey as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', key)).rejects.toBeTruthy();
    expect(JSON.stringify(Object.keys(row))).not.toContain('capability');
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toContain(OWNER_KEY);
    }
  });

  it('survives a reload: the stored device signs again', async () => {
    const device = await connectOwnerDevice({
      ownerKey: OWNER_KEY,
      passphrase: PASSPHRASE,
      deviceName: 'Laptop',
    });
    expect((await loadOwnerSigner())?.did).toBe(device.did);
  });

  it('a disconnect in another tab stops this tab signing at once', async () => {
    await connectOwnerDevice({ ownerKey: OWNER_KEY, passphrase: PASSPHRASE, deviceName: 'Laptop' });
    expect(await loadOwnerSigner()).not.toBeNull();
    await dropRowBehindTheTab();
    expect(await loadOwnerSigner()).toBeNull();
    expect((await ownerAccessState()).kind).toBe('disconnected');
  });

  it('a browser another tab already connected refuses a second pairing, and sends nothing', async () => {
    await connectOwnerDevice({ ownerKey: OWNER_KEY, passphrase: PASSPHRASE, deviceName: 'Laptop' });
    core.sent = [];
    await expect(
      connectOwnerDevice({ ownerKey: OWNER_KEY, passphrase: PASSPHRASE, deviceName: 'Again' }),
    ).rejects.toMatchObject({ errorKey: 'already_connected' });
    expect(core.sent).toEqual([]);
  });

  it('a node that cannot check a passphrase does not block connecting', async () => {
    core.presence = 'unavailable';
    const device = await connectOwnerDevice({
      ownerKey: OWNER_KEY,
      passphrase: 'anything',
      deviceName: 'Laptop',
    });
    expect(device.did).toMatch(/^did:key:/);
  });
});

describe('refusals, by name', () => {
  it.each([
    ['a wrong owner key', { ownerKey: 'wrong', passphrase: PASSPHRASE }, 'owner_key_rejected'],
    ['a wrong passphrase', { ownerKey: OWNER_KEY, passphrase: 'nope' }, 'passphrase_rejected'],
    [
      'no passphrase where the node needs presence',
      { ownerKey: OWNER_KEY, passphrase: '' },
      'presence_required',
    ],
  ] as const)('%s', async (_label, input, errorKey) => {
    const failure = connectOwnerDevice({ ...input, deviceName: 'Laptop' });
    await expect(failure).rejects.toBeInstanceOf(OwnerDeviceError);
    await expect(failure).rejects.toMatchObject({ errorKey });
    expect(core.registeredKey).toBeNull();
    expect((await ownerAccessState()).kind).toBe('disconnected');
  });

  it('a wrong owner key is caught before the passphrase is sent anywhere', async () => {
    await expect(
      connectOwnerDevice({ ownerKey: 'wrong', passphrase: PASSPHRASE, deviceName: 'Laptop' }),
    ).rejects.toMatchObject({ errorKey: 'owner_key_rejected' });
    expect(core.sent.map((s) => s.path)).toEqual(['/v1/owner/setup/status']);
    expect(JSON.stringify(core.sent)).not.toContain(PASSPHRASE);
  });
});

describe('disconnecting', () => {
  it('revokes this device at Core and forgets the key', async () => {
    const device = await connectOwnerDevice({
      ownerKey: OWNER_KEY,
      passphrase: PASSPHRASE,
      deviceName: 'Laptop',
    });
    const revoked: string[] = [];
    expect(await disconnectOwnerDevice(async (did) => void revoked.push(did))).toEqual({
      revoked: true,
    });
    expect(revoked).toEqual([device.did]);
    expect(await loadOwnerSigner()).toBeNull();
  });

  it('forgets the key even when the revoke cannot be confirmed', async () => {
    await connectOwnerDevice({ ownerKey: OWNER_KEY, passphrase: PASSPHRASE, deviceName: 'Laptop' });
    const outcome = await disconnectOwnerDevice(async () => {
      throw new Error('node unreachable');
    });
    expect(outcome).toEqual({ revoked: false });
    expect(await loadOwnerSigner()).toBeNull();
  });

  it('a device Core had already dropped reads as revoked, not as unconfirmed', async () => {
    const device = await connectOwnerDevice({
      ownerKey: OWNER_KEY,
      passphrase: PASSPHRASE,
      deviceName: 'Laptop',
    });
    // The dispatcher found Core no longer knows the device and forgot it
    // while the revoke was being asked for.
    const outcome = await disconnectOwnerDevice(async (did) => {
      await forgetOwnerDeviceCoreDropped(did);
      throw new Error('owner_device_not_connected');
    });
    expect(outcome).toEqual({ revoked: true });
    expect(device.did).toMatch(/^did:key:/);
  });
});

describe('a device Core no longer knows', () => {
  it('is forgotten, and the screens are told', async () => {
    const device = await connectOwnerDevice({
      ownerKey: OWNER_KEY,
      passphrase: PASSPHRASE,
      deviceName: 'Laptop',
    });
    const heard = jest.fn();
    const unsubscribe = subscribeOwnerAccess(heard);
    await forgetOwnerDeviceCoreDropped(device.did);
    unsubscribe();
    expect(heard).toHaveBeenCalled();
    expect((await ownerAccessState()).kind).toBe('disconnected');
  });

  it('only the device that signed: one connected since is left alone', async () => {
    const device = await connectOwnerDevice({
      ownerKey: OWNER_KEY,
      passphrase: PASSPHRASE,
      deviceName: 'Laptop',
    });
    await forgetOwnerDeviceCoreDropped('did:key:z6MkSomeOlderDevice');
    expect((await loadOwnerSigner())?.did).toBe(device.did);
  });
});
