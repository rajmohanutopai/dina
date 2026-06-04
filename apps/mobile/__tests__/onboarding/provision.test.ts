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

import { mnemonicToEntropy, deriveRotationKey, secp256k1ToDidKeyMultibase } from '@dina/core';

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { generateNewMnemonic } from '../../src/hooks/useOnboarding';
import { isUnlocked, resetUnlockState } from '../../src/hooks/useUnlock';
import {
  hasCompletedOnboarding,
  provisionIdentity,
  provisionExternalAtprotoIdentity,
  recoverIdentity,
  deriveHandle,
} from '../../src/onboarding/provision';
import { loadPersistedDid } from '../../src/services/identity_record';
import { loadIdentitySeeds } from '../../src/services/identity_store';
import { loadInfraPreferences } from '../../src/services/infra_preferences';
import { loadLinkedAtprotoIdentity } from '../../src/services/linked_identity_record';
import { loadWrappedSeed } from '../../src/services/wrapped_seed_store';

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
  /** Make createAccount return HandleNotAvailable (prior attempt) so the
   *  resume path logs in via createSession and continues. */
  simulateHandleTaken?: boolean;
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
      if (opts.simulateHandleTaken === true) {
        // A prior attempt already created this account → handle taken.
        return new Response(
          JSON.stringify({ error: 'HandleNotAvailable', message: 'Handle already taken' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
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
    if (url.includes('com.atproto.server.createSession')) {
      // Resume path: we own the account (seed-derived password), so login
      // succeeds and returns the same DID for the PLC update to continue.
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

  it('RESUME: a taken handle from a prior attempt logs back in (createSession) and finishes — handle not burned', async () => {
    const mnemonic = generateNewMnemonic();
    const handle = `${deriveHandle(TEST_OWNER, TEST_PDS_URL)}`;
    // createAccount returns HandleNotAvailable — a prior attempt already
    // created this account but failed before the PLC update / local persist.
    // The seed-derived PDS password lets createSession recover the existing
    // DID, and provisioning resumes the PLC update + persist instead of
    // forcing the user to pick a new handle.
    const stub = makeFetchStub({
      mnemonic,
      did: STUB_DID,
      handle,
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
      simulateHandleTaken: true,
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

    // Same DID recovered + full state persisted — the chosen handle is reused.
    expect(result.did).toBe(STUB_DID);
    expect(result.handle).toBe(handle);
    expect(await loadPersistedDid()).toBe(STUB_DID);
    expect(isUnlocked()).toBe(true);

    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('com.atproto.server.createAccount'))).toBe(true);
    expect(urls.some((u) => u.includes('com.atproto.server.createSession'))).toBe(true);
    // PLC update ran against the recovered DID (resume completed).
    expect(urls).toContain(`${TEST_PLC_URL}/${STUB_DID}`);
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
    // Order reflects the atomic flow: derive + wrap in memory, both
    // network steps (createAccount + PLC update), THEN persist (keys +
    // did). Nothing durable is written before the network steps succeed.
    expect(stages).toEqual([
      'deriving_seed',
      'deriving_keys',
      'wrapping_seed',
      'creating_pds_account',
      'publishing_plc_update',
      'persisting_keys',
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
    // Atomicity: a createAccount failure must leave NO durable state, so
    // the next boot starts fresh instead of unlocking a vault with no
    // did:plc (which boot would back-fill with a did:key fallback — the
    // bug this guards against).
    expect(await loadWrappedSeed()).toBeNull();
    expect(await loadIdentitySeeds()).toBeNull();
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
    // Same atomicity guarantee for the second network step: a PLC-update
    // failure (after createAccount succeeded) must also persist nothing.
    expect(await loadWrappedSeed()).toBeNull();
    expect(await loadIdentitySeeds()).toBeNull();
  });
});

describe('provisionExternalAtprotoIdentity (link, do not take over)', () => {
  const LINKED_DID = 'did:plc:linkedbsky9876';
  const LINKED_HANDLE = 'alice.bsky.social';
  const DINA_OWN_DID = 'did:plc:dinaown555';

  it('links the Bluesky identity read-only, mints Dina\'s OWN did:plc, stores the link, and NEVER touches the linked account', async () => {
    const mnemonic = generateNewMnemonic();
    // makeFetchStub serves only Dina's OWN provisioning (createAccount +
    // audit log + PLC update POST) for DINA_OWN_DID. Anything touching the
    // linked account would hit an unmocked URL and throw.
    const stub = makeFetchStub({
      mnemonic,
      did: DINA_OWN_DID,
      handle: 'alice.pds.test',
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });

    // Inject a read-only resolver so no network call reaches the linked
    // account at all.
    const resolveLinked = jest.fn(async () => ({
      did: LINKED_DID,
      handle: LINKED_HANDLE,
      pdsUrl: 'https://bsky.social',
      rotationKeys: [],
      alsoKnownAs: [`at://${LINKED_HANDLE}`],
      verificationMethods: {},
      services: {},
    }));

    const result = await provisionExternalAtprotoIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      identifier: LINKED_HANDLE,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
      pdsURL: TEST_PDS_URL,
      resolveLinked: resolveLinked as never,
      nowIso: '2026-06-03T00:00:00.000Z',
    });

    // Node identity is Dina's OWN did:plc — NOT the linked Bluesky did.
    expect(result.did).toBe(DINA_OWN_DID);
    expect(await loadPersistedDid()).toBe(DINA_OWN_DID);
    expect(isUnlocked()).toBe(true);

    // The Bluesky identity is stored as a linked reference only — and
    // unverified (resolve-only, no OAuth proof of control).
    expect(resolveLinked).toHaveBeenCalledTimes(1);
    expect(await loadLinkedAtprotoIdentity()).toEqual({
      did: LINKED_DID,
      handle: LINKED_HANDLE,
      pdsUrl: 'https://bsky.social',
      linkedAt: '2026-06-03T00:00:00.000Z',
      verified: false,
    });

    // NEVER authenticate to or mutate the linked account: no session, no
    // PLC sign/submit, and nothing addressed to the linked DID.
    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('createSession'))).toBe(false);
    expect(urls.some((u) => u.includes('signPlcOperation'))).toBe(false);
    expect(urls.some((u) => u.includes('submitPlcOperation'))).toBe(false);
    expect(urls.some((u) => u.includes(LINKED_DID))).toBe(false);

    // Dina's own PDS creds were saved (seed-derived, not an app password).
    const infra = await loadInfraPreferences();
    expect(infra.pdsUrl).toBe(TEST_PDS_URL);
    expect(infra.pdsPassword).not.toBe('');
  });

  it('with an OAuth verifiedLink: skips the resolve, mints Dina\'s own did, stores a VERIFIED link', async () => {
    const mnemonic = generateNewMnemonic();
    makeFetchStub({
      mnemonic,
      did: DINA_OWN_DID,
      handle: 'alice.pds.test',
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    const resolveLinked = jest.fn(); // must NOT be called when verifiedLink is supplied

    const result = await provisionExternalAtprotoIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      identifier: LINKED_HANDLE,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
      pdsURL: TEST_PDS_URL,
      resolveLinked: resolveLinked as never,
      nowIso: '2026-06-03T00:00:00.000Z',
      verifiedLink: { did: LINKED_DID, handle: LINKED_HANDLE, pdsUrl: 'https://bsky.social' },
    });

    expect(resolveLinked).not.toHaveBeenCalled();
    expect(result.did).toBe(DINA_OWN_DID);
    expect(await loadLinkedAtprotoIdentity()).toEqual({
      did: LINKED_DID,
      handle: LINKED_HANDLE,
      pdsUrl: 'https://bsky.social',
      linkedAt: '2026-06-03T00:00:00.000Z',
      verified: true,
    });
  });

  it('resolves a did:plc identifier read-only via the real resolver (only a GET to the PLC /data endpoint reaches the linked account)', async () => {
    const mnemonic = generateNewMnemonic();
    const linkedDataUrl = `${TEST_PLC_URL}/${LINKED_DID}/data`;
    const ownStub = makeFetchStub({
      mnemonic,
      did: DINA_OWN_DID,
      handle: 'alice.pds.test',
      pdsURL: TEST_PDS_URL,
      plcURL: TEST_PLC_URL,
    });
    // Wrap the own-stub so the linked /data GET is also served, and record
    // every URL + method to assert the linked account is only ever read.
    const seen: { url: string; method: string }[] = [];
    const combined = jest.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      seen.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
      if (url === linkedDataUrl) {
        return new Response(
          JSON.stringify({
            rotationKeys: ['did:key:zQ3linkedRotation'],
            alsoKnownAs: [`at://${LINKED_HANDLE}`],
            verificationMethods: { atproto: 'did:key:zQ3atproto' },
            services: {
              atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://bsky.social' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return (ownStub as unknown as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>)(
        input,
        init,
      );
    }) as unknown as jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
      combined as unknown as typeof globalThis.fetch;

    const result = await provisionExternalAtprotoIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      identifier: LINKED_DID,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
      pdsURL: TEST_PDS_URL,
    });

    expect(result.did).toBe(DINA_OWN_DID);
    expect((await loadLinkedAtprotoIdentity())?.did).toBe(LINKED_DID);

    // The ONLY request that touched the linked account was a GET of its
    // public PLC /data — no writes, no session, no PLC mutation.
    const linkedTouches = seen.filter((s) => s.url.includes(LINKED_DID));
    expect(linkedTouches).toEqual([{ url: linkedDataUrl, method: 'GET' }]);
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
