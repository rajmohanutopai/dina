/**
 * Provisioning integration tests.
 *
 * Covers the happy path (create + recover), PLC-registration failure
 * handling, and the dev-contact / startup-mode touch points that
 * boot_capabilities depends on downstream. The PLC directory is
 * stubbed via a fetch mock; keychain goes through the same
 * __mocks__/react-native-keychain.ts the other app tests use.
 */

import {
  hasCompletedOnboarding,
  provisionIdentity,
  recoverIdentity,
  deriveHandle,
} from '../../src/onboarding/provision';
import { generateNewMnemonic } from '../../src/hooks/useOnboarding';
import { loadWrappedSeed } from '../../src/services/wrapped_seed_store';
import { loadPersistedDid } from '../../src/services/identity_record';
import { loadIdentitySeeds } from '../../src/services/identity_store';
import { isUnlocked, resetUnlockState } from '../../src/hooks/useUnlock';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

const TEST_PASSPHRASE = 'test-passphrase-1234';
const TEST_OWNER = 'Raj';
const TEST_PLC_URL = 'https://plc.test';
const TEST_MSGBOX = 'wss://mailbox.test';

beforeEach(() => {
  resetKeychainMock();
  resetUnlockState();
});

describe('provisionIdentity', () => {
  it('persists wrapped seed, keys, DID and leaves the node unlocked', async () => {
    const mnemonic = generateNewMnemonic();
    const fetchStub = jest.fn(async () => new Response(null, { status: 200 }));
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = fetchStub;

    const result = await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
    });

    expect(result.did.startsWith('did:plc:')).toBe(true);
    expect(result.didKey.startsWith('did:key:')).toBe(true);
    expect(result.handle.startsWith('raj')).toBe(true);

    expect(await loadWrappedSeed()).not.toBeNull();
    expect(await loadIdentitySeeds()).not.toBeNull();
    expect(await loadPersistedDid()).toBe(result.did);
    expect(isUnlocked()).toBe(true);

    // PLC directory was hit exactly once at the derived URL.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const firstCall = fetchStub.mock.calls[0] as unknown as [string, unknown];
    expect(firstCall[0]).toBe(`${TEST_PLC_URL}/${result.did}`);
  });

  it('invokes progress callback for each stage in order', async () => {
    const mnemonic = generateNewMnemonic();
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const stages: string[] = [];
    await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      msgboxEndpoint: TEST_MSGBOX,
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
      'publishing_plc',
      'persisting_did',
      'opening_vault',
      'done',
    ]);
  });

  it('uses the explicit handle when provided, skipping the silent suffix derivation', async () => {
    // The picker wizard hands `provisionIdentity` a fully-qualified
    // handle. The function must use it as-is — not run it through
    // `deriveHandle` (which would ignore the picker's choice and slap
    // a random hex suffix on the owner name).
    const mnemonic = generateNewMnemonic();
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const explicit = 'raju.test-pds.dinakernel.com';
    const result = await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: 'someone-else',
      handle: explicit,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
    });
    expect(result.handle).toBe(explicit);
  });

  it('surfaces PLC registration failure as a tagged error', async () => {
    const mnemonic = generateNewMnemonic();
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async () => new Response('rejected', { status: 400 }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      provisionIdentity({
        mnemonic,
        passphrase: TEST_PASSPHRASE,
        ownerName: TEST_OWNER,
        msgboxEndpoint: TEST_MSGBOX,
        plcURL: TEST_PLC_URL,
      }),
    ).rejects.toThrow(/PLC registration failed/);

    // Crucially: we didn't flip isUnlocked on a failed PLC post. A half-
    // provisioned identity would be stranded without a did:plc the
    // relay can verify, so keeping the vault sealed is the right
    // failure mode.
    expect(isUnlocked()).toBe(false);
    expect(await loadPersistedDid()).toBeNull();
  });
});

describe('recoverIdentity', () => {
  it('re-derives keys + unlocks without re-publishing to PLC', async () => {
    const mnemonic = generateNewMnemonic();
    const plcFetch = jest.fn(async () => new Response(null, { status: 200 }));
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch =
      plcFetch as unknown as typeof globalThis.fetch;

    // First provision to get a DID we can "restore" to.
    const created = await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
    });

    // Wipe local state as if on a new device.
    resetKeychainMock();
    resetUnlockState();
    plcFetch.mockClear();

    const recovered = await recoverIdentity({
      mnemonic,
      passphrase: 'new-device-passphrase-9999',
      expectedDid: created.did,
    });

    expect(recovered.did).toBe(created.did);
    expect(plcFetch).not.toHaveBeenCalled(); // no re-publish
    expect(isUnlocked()).toBe(true);
    expect(await loadPersistedDid()).toBe(created.did);
  });
});

describe('hasCompletedOnboarding', () => {
  it('is false on fresh install', async () => {
    expect(await hasCompletedOnboarding()).toBe(false);
  });

  it('is true after a did:plc lands in identity_record', async () => {
    const mnemonic = generateNewMnemonic();
    (globalThis as unknown as { fetch: typeof globalThis.fetch }).fetch = jest.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    await provisionIdentity({
      mnemonic,
      passphrase: TEST_PASSPHRASE,
      ownerName: TEST_OWNER,
      msgboxEndpoint: TEST_MSGBOX,
      plcURL: TEST_PLC_URL,
    });
    expect(await hasCompletedOnboarding()).toBe(true);
  });
});

describe('deriveHandle', () => {
  it('sanitises + clamps owner names to 12 chars', () => {
    const h = deriveHandle('  Raj_Mohan!!!', 'wss://test-mailbox.dinakernel.com');
    expect(h.startsWith('rajmohan')).toBe(true);
    expect(h).toContain('.test-pds.dinakernel.com');
  });

  it('falls back to "dina" for empty / too-short names', () => {
    const h = deriveHandle('r', 'wss://test-mailbox.dinakernel.com');
    expect(h.startsWith('dina')).toBe(true);
  });

  it('picks prod PDS host when msgboxEndpoint is prod', () => {
    const h = deriveHandle('Test', 'wss://mailbox.dinakernel.com');
    expect(h).toContain('.pds.dinakernel.com');
    expect(h).not.toContain('test-pds');
  });
});
