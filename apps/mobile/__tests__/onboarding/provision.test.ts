/**
 * Provisioning integration tests.
 *
 * Covers the PDS-first onboarding flow: PDS createAccount → resolve
 * PLC audit log → submit PLC update adding `dina_signing` VM +
 * `dina-messaging` service. Stubs route by URL so a single
 * `fetch` mock handles all three external endpoints (`createAccount`,
 * `/log/audit`, PLC update POST).
 *
 * The K256 rotation key the test stub publishes in the fake genesis
 * op MUST match the one the provision code derives from the same
 * mnemonic — otherwise `updateDIDPLC` rejects with "signer key not
 * in rotationKeys" before even hitting fetch. The setup helper
 * pre-derives it from the mnemonic and bakes it into the audit-log
 * response.
 */

import {
  hasCompletedOnboarding,
  provisionIdentity,
  provisionExternalAtprotoIdentity,
  recoverIdentity,
  deriveHandle,
} from '../../src/onboarding/provision';
import { generateNewMnemonic } from '../../src/hooks/useOnboarding';
import { loadWrappedSeed } from '../../src/services/wrapped_seed_store';
import { loadPersistedDid } from '../../src/services/identity_record';
import { loadIdentitySeeds } from '../../src/services/identity_store';
import { loadInfraPreferences } from '../../src/services/infra_preferences';
import { isUnlocked, resetUnlockState } from '../../src/hooks/useUnlock';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { mnemonicToEntropy } from '@dina/core';
import { deriveRotationKey } from '@dina/core';
import { secp256k1ToDidKeyMultibase } from '@dina/core';

const TEST_PASSPHRASE = 'test-passphrase-1234';
const TEST_OWNER = 'Raj';
const TEST_PLC_URL = 'https://plc.test';
const TEST_PDS_URL = 'https://pds.test';
const TEST_MSGBOX = 'wss://mailbox.test';
const STUB_DID = 'did:plc:stub123abc';

beforeEach(() => {
  resetKeychainMock();
  resetUnlockState();
});

/**
 * Build a fetch stub that simulates:
 *   1. PDS createAccount → returns the canned DID + handle + JWTs.
 *   2. PLC audit log → returns a fake genesis op whose `rotationKeys`
 *      list includes the K256 we pre-derive from the same mnemonic.
 *   3. PLC update POST → 200 OK.
 *
 * The fetchStub records all calls and dispatches by URL substring.
 * Anything unmocked throws so a wiring regression fails loudly.
 */
function makeFetchStub(opts: {
  mnemonic: string[];
  did: string;
  handle: string;
  pdsURL: string;
  plcURL: string;
}) {
  const masterSeed = mnemonicToEntropy(opts.mnemonic.join(' '));
  const rotation = deriveRotationKey(masterSeed, 0);
  const recoveryKey = `did:key:${secp256k1ToDidKeyMultibase(rotation.publicKey)}`;
  // Fake "PDS rotation key" — content doesn't matter, only that it's
  // a valid did:key string and present alongside ours so the merge
  // logic preserves it on update.
  const fakePdsRotationKey =
    'did:key:zQ3shFakePdsRotationKeyForTesting1234567890abcdefXY';

  const genesisOp: Record<string, unknown> = {
    type: 'plc_operation',
    rotationKeys: [fakePdsRotationKey, recoveryKey],
    verificationMethods: {
      atproto: 'did:key:zFakeAtprotoSigningKey',
    },
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: opts.pdsURL,
      },
    },
    alsoKnownAs: [`at://${opts.handle}`],
    prev: null,
    sig: 'fake-sig-base64url',
  };

  const stub = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('com.atproto.server.createAccount')) {
      return new Response(
        JSON.stringify({
          did: opts.did,
          handle: opts.handle,
          accessJwt: 'access-jwt',
          refreshJwt: 'refresh-jwt',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === `${opts.plcURL}/${opts.did}/log/audit`) {
      return new Response(
        JSON.stringify([
          {
            operation: genesisOp,
            cid: 'bafy-genesis-cid-stub',
            nullified: false,
            createdAt: '2025-01-01T00:00:00Z',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === `${opts.plcURL}/${opts.did}`) {
      // PLC update POST.
      return new Response(null, { status: 200 });
    }
    throw new Error(`makeFetchStub: unmocked URL ${url}`);
  }) as unknown as jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
  (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
    stub as unknown as typeof globalThis.fetch;
  return stub;
}

describe('provisionIdentity (PDS-first)', () => {
  it('persists wrapped seed, keys, DID and leaves the node unlocked', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = `${deriveHandle(TEST_OWNER, TEST_PDS_URL)}`;
    const stub = makeFetchStub({
      mnemonic,
      did: STUB_DID,
      handle,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });

    const result = await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      handle,
      msgboxEndpoint: TEST_MSGBOX,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });

    expect(result.did).toBe(STUB_DID);
    expect(result.didKey.startsWith('did:key:')).toBe(true);
    expect(result.handle).toBe(handle);

    expect(await loadWrappedSeed()).not.toBeNull();
    expect(await loadIdentitySeeds()).not.toBeNull();
    expect(await loadPersistedDid()).toBe(STUB_DID);
    expect(isUnlocked()).toBe(true);

    // Both PDS createAccount and PLC update were called.
    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('com.atproto.server.createAccount'))).toBe(true);
    expect(urls).toContain(`${TEST_PLC_URL}/${STUB_DID}/log/audit`);
    expect(urls).toContain(`${TEST_PLC_URL}/${STUB_DID}`);

    // PDS credentials persisted so boot can re-auth.
    const infra = await loadInfraPreferences();
    expect(infra.pdsHandle).toBe(handle);
    expect(infra.pdsPassword).not.toBeNull();
    expect(infra.pdsUrl).toBe(TEST_PDS_URL);
  });

  it('invokes progress callback for each stage in order', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = `${deriveHandle(TEST_OWNER, TEST_PDS_URL)}`;
    makeFetchStub({
      mnemonic,
      did: STUB_DID,
      handle,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    const stages: string[] = [];
    await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      handle,
      msgboxEndpoint: TEST_MSGBOX,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
      onProgress: (p) => {
        stages.push(p.stage);
      },
    });
    expect(stages).toEqual([
      'deriving_seed',
      'deriving_keys',
      'persisting_keys',
      'wrapping_seed',
      'creating_pds_account',
      'publishing_plc_update',
      'persisting_did',
      'opening_vault',
      'done',
    ]);
  });

  it('uses the explicit handle when provided, skipping the silent suffix derivation', async () => {
    const mnemonic = generateNewMnemonic();
    const explicit = 'raju.test-pds.dinakernel.com';
    makeFetchStub({
      mnemonic,
      did: STUB_DID,
      handle: explicit,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    const result = await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: 'someone-else',
      handle: explicit,
      msgboxEndpoint: TEST_MSGBOX,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    expect(result.handle).toBe(explicit);
  });

  it('surfaces PDS account creation failure as a tagged error and leaves vault sealed', async () => {
    const mnemonic = generateNewMnemonic();
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async () => new Response('handle taken', { status: 400 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      provisionIdentity({
        mnemonic,
        passphrase: TEST_PASSPHRASE,
        ownerName: TEST_OWNER,
        msgboxEndpoint: TEST_MSGBOX,
        pdsURL: TEST_PDS_URL,
        plcURL: TEST_PLC_URL,
      }),
    ).rejects.toThrow(/PDS account creation failed/);
    expect(isUnlocked()).toBe(false);
    expect(await loadPersistedDid()).toBeNull();
  });

  it('surfaces PLC update failure with a tagged error', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = deriveHandle(TEST_OWNER, TEST_PDS_URL);
    const masterSeed = mnemonicToEntropy(mnemonic.join(' '));
    const rotation = deriveRotationKey(masterSeed, 0);
    const recoveryKey = `did:key:${secp256k1ToDidKeyMultibase(rotation.publicKey)}`;
    const fakePdsRotation = 'did:key:zQ3shFakePdsRotationKeyForTesting1234567890abcdefXY';
    const genesisOp = {
      type: 'plc_operation',
      rotationKeys: [fakePdsRotation, recoveryKey],
      verificationMethods: { atproto: 'did:key:zFake' },
      services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: TEST_PDS_URL } },
      alsoKnownAs: [`at://${handle}`],
      prev: null,
      sig: 'fake',
    };
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('com.atproto.server.createAccount')) {
          return new Response(
            JSON.stringify({
              did: STUB_DID,
              handle,
              accessJwt: 'a',
              refreshJwt: 'r',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/log/audit')) {
          return new Response(
            JSON.stringify([{ operation: genesisOp, cid: 'bafy-x', nullified: false }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // PLC update — make it fail.
        return new Response('rejected', { status: 400 });
      },
    ) as unknown as typeof globalThis.fetch;

    await expect(
      provisionIdentity({
        mnemonic,
        passphrase: TEST_PASSPHRASE,
        ownerName: TEST_OWNER,
        handle,
        msgboxEndpoint: TEST_MSGBOX,
        pdsURL: TEST_PDS_URL,
        plcURL: TEST_PLC_URL,
      }),
    ).rejects.toThrow(/PLC update.*failed/);
    expect(isUnlocked()).toBe(false);
    expect(await loadPersistedDid()).toBeNull();
  });
});

describe('provisionExternalAtprotoIdentity', () => {
  it('connects an existing did:plc, asks the PDS to sign Dina PLC fields, and unlocks', async () => {
    const mnemonic = generateNewMnemonic();
    const externalPassword = 'external-app-password';
    const handle = 'alice.bsky.social';
    const signedOperation = {
      type: 'plc_operation',
      sig: 'pds-signed',
      verificationMethods: {
        atproto: 'did:key:zQ3atproto',
        dina_signing: 'did:key:z6dina',
      },
    };
    const stub = jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${TEST_PLC_URL}/${STUB_DID}/data`) {
        return new Response(
          JSON.stringify({
            rotationKeys: ['did:key:zQ3existingRotation'],
            alsoKnownAs: [`at://${handle}`],
            verificationMethods: { atproto: 'did:key:zQ3atproto' },
            services: {
              atproto_pds: {
                type: 'AtprotoPersonalDataServer',
                endpoint: TEST_PDS_URL,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('com.atproto.server.createSession')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ identifier: handle, password: externalPassword });
        return new Response(
          JSON.stringify({
            did: STUB_DID,
            handle,
            accessJwt: 'existing-access',
            refreshJwt: 'existing-refresh',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('com.atproto.identity.signPlcOperation')) {
        const body = JSON.parse(String(init?.body));
        expect(body.rotationKeys).toEqual(['did:key:zQ3existingRotation']);
        expect(body.alsoKnownAs).toEqual([`at://${handle}`]);
        expect(body.verificationMethods.dina_signing).toMatch(/^did:key:/);
        expect(body.services['dina-messaging']).toEqual({
          type: 'DinaMsgBox',
          endpoint: TEST_MSGBOX,
        });
        return new Response(JSON.stringify({ operation: signedOperation }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('com.atproto.identity.submitPlcOperation')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ operation: signedOperation });
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unmocked URL ${url}`);
    }) as unknown as jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
      stub as unknown as typeof globalThis.fetch;

    const result = await provisionExternalAtprotoIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      identifier: STUB_DID,
      appPassword: externalPassword,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
    });

    expect(result.did).toBe(STUB_DID);
    expect(result.handle).toBe(handle);
    expect(await loadPersistedDid()).toBe(STUB_DID);
    expect(isUnlocked()).toBe(true);

    const infra = await loadInfraPreferences();
    expect(infra.pdsUrl).toBe(TEST_PDS_URL);
    expect(infra.pdsHandle).toBe(handle);
    expect(infra.pdsPassword).toBe(externalPassword);
  });

  it('fails loudly when the PDS refuses the PLC update', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = 'alice.bsky.social';
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url === `${TEST_PLC_URL}/${STUB_DID}/data`) {
          return new Response(
            JSON.stringify({
              rotationKeys: ['did:key:zQ3existingRotation'],
              alsoKnownAs: [`at://${handle}`],
              verificationMethods: { atproto: 'did:key:zQ3atproto' },
              services: {
                atproto_pds: {
                  type: 'AtprotoPersonalDataServer',
                  endpoint: TEST_PDS_URL,
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('com.atproto.server.createSession')) {
          return new Response(
            JSON.stringify({
              did: STUB_DID,
              handle,
              accessJwt: 'existing-access',
              refreshJwt: 'existing-refresh',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('com.atproto.identity.signPlcOperation')) {
          return new Response(
            JSON.stringify({ error: 'TokenRequired', message: 'PLC token required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unmocked URL ${url}`);
      },
    ) as unknown as typeof globalThis.fetch;

    await expect(
      provisionExternalAtprotoIdentity({
        mnemonic,
        passphrase: TEST_PASSPHRASE,
        identifier: STUB_DID,
        appPassword: 'external-app-password',
        msgboxEndpoint: TEST_MSGBOX,
        plcURL: TEST_PLC_URL,
      }),
    ).rejects.toThrow(/PDS PLC update failed/);
    expect(await loadPersistedDid()).toBeNull();
    expect(isUnlocked()).toBe(false);
  });
});

describe('recoverIdentity', () => {
  it('re-derives keys + unlocks without re-publishing to PLC', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = deriveHandle(TEST_OWNER, TEST_PDS_URL);
    const stub = makeFetchStub({
      mnemonic,
      did: STUB_DID,
      handle,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });

    const created = await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      handle,
      msgboxEndpoint: TEST_MSGBOX,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });

    // Wipe local state as if on a new device, then recover.
    resetKeychainMock();
    resetUnlockState();
    stub.mockClear();

    const recovered = await recoverIdentity({
      mnemonic,
      passphrase: 'new-device-passphrase-9999',
      expectedDid: created.did,
      handle,
    });

    expect(recovered.did).toBe(created.did);
    expect(recovered.handle).toBe(handle);
    // Recovery does NOT hit PDS or PLC — just re-derives + unlocks.
    expect(stub).not.toHaveBeenCalled();
    expect(isUnlocked()).toBe(true);
    expect(await loadPersistedDid()).toBe(created.did);
  });

  it('rejects a did:key as expectedDid (must be a verified did:plc)', async () => {
    const mnemonic = generateNewMnemonic();
    await expect(
      recoverIdentity({
        mnemonic,
        passphrase: TEST_PASSPHRASE,
        expectedDid: 'did:key:z6MkExample',
        handle: 'someone.test-pds.dinakernel.com',
      }),
    ).rejects.toThrow(/recoverIdentity: expectedDid must be a did:plc/);
  });

  it('rejects an empty handle', async () => {
    const mnemonic = generateNewMnemonic();
    await expect(
      recoverIdentity({
        mnemonic,
        passphrase: TEST_PASSPHRASE,
        expectedDid: STUB_DID,
        handle: '   ',
      }),
    ).rejects.toThrow(/recoverIdentity: handle is required/);
  });
});

describe('hasCompletedOnboarding', () => {
  it('is false on fresh install', async () => {
    expect(await hasCompletedOnboarding()).toBe(false);
  });

  it('is true after a did:plc lands in identity_record', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = deriveHandle(TEST_OWNER, TEST_PDS_URL);
    makeFetchStub({
      mnemonic,
      did: STUB_DID,
      handle,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      handle,
      msgboxEndpoint: TEST_MSGBOX,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    expect(await hasCompletedOnboarding()).toBe(true);
  });
});

describe('deriveHandle', () => {
  it('sanitises + clamps owner names to 12 chars', () => {
    const h = deriveHandle('  Raj_Mohan!!!', 'test-pds.dinakernel.com');
    expect(h.startsWith('rajmohan')).toBe(true);
    expect(h).toContain('.test-pds.dinakernel.com');
  });

  it('falls back to "dina" for empty / too-short names', () => {
    const h = deriveHandle('r', 'test-pds.dinakernel.com');
    expect(h.startsWith('dina')).toBe(true);
  });

  it('uses the selected PDS host directly', () => {
    const h = deriveHandle('Test', 'pds.dinakernel.com');
    expect(h).toContain('.pds.dinakernel.com');
    expect(h).not.toContain('test-pds');
  });
});
