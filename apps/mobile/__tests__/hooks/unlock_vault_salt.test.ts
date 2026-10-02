/**
 * Unlock after a passphrase change (30 Sep 2026 data-loss bug).
 *
 *   - The vault keys are derived with the record's vault salt, not the new
 *     wrap salt, so the databases made before the change still open.
 *   - If a database still will not open with the derived key, nothing is
 *     deleted: the files are renamed aside, the owner is warned, and Dina
 *     starts on fresh files. The old "self-heal" deleted every vault here.
 *
 * SQLCipher itself is not available under Jest, so `storage/init` is a stub
 * that records the salt it was given and can fail the way op-sqlite does.
 */

import { changePassphrase, generateMnemonic, mnemonicToSeed, wrapSeed } from '@dina/core';

import {
  __getDeletedEntries,
  __getEntries,
  __getRenamedEntries,
  __resetFileSystemMock,
  __setEntries,
} from '../../__mocks__/expo-file-system';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { resetUnlockState, unlock } from '../../src/hooks/useUnlock';
import {
  getRuntimeWarnings,
  resetRuntimeWarningsForTest,
} from '../../src/services/runtime_warnings';
import { saveWrappedSeed } from '../../src/services/wrapped_seed_store';
import { initializePersistence } from '../../src/storage/init';

jest.mock('../../src/storage/init', () => {
  let ready = false;
  return {
    initializePersistence: jest.fn(async () => {
      ready = true;
    }),
    isPersistenceReady: () => ready,
    openPersonaDB: jest.fn(async () => undefined),
    shutdownAllPersistence: jest.fn(async () => {
      ready = false;
    }),
    __setReady: (v: boolean) => {
      ready = v;
    },
  };
});

const init = initializePersistence as jest.MockedFunction<typeof initializePersistence>;
const setReady = (
  jest.requireMock('../../src/storage/init') as { __setReady: (v: boolean) => void }
).__setReady;

const OLD = 'OldPass123!';
const NEW = 'NewPass456!';

beforeEach(() => {
  resetUnlockState();
  resetKeychainMock();
  __resetFileSystemMock();
  resetRuntimeWarningsForTest();
  init.mockReset();
  init.mockImplementation(async () => {
    setReady(true);
  });
  setReady(false);
});

it('after a passphrase change, the vaults are opened with the salt they were made with', async () => {
  const seed = mnemonicToSeed(generateMnemonic());
  const first = await wrapSeed(OLD, seed);
  await saveWrappedSeed(first);
  // Day one: unlock creates the vaults (and pins their salt).
  await unlock(OLD, first);
  expect(init.mock.calls[0]?.[1]).toEqual(first.salt);

  // The owner changes the passphrase: a re-wrap with a new salt.
  const rewrapped = await changePassphrase(OLD, NEW, first);
  await saveWrappedSeed(rewrapped);
  expect(rewrapped.salt).not.toEqual(first.salt);

  // Next start: the vaults are opened with the salt they were made with.
  resetUnlockState();
  setReady(false);
  await unlock(NEW, rewrapped);
  expect(init).toHaveBeenCalledTimes(2);
  expect(init.mock.calls[1]?.[1]).toEqual(first.salt);
});

it('a database that will not open is set aside and kept, never deleted, and the owner is told', async () => {
  const seed = mnemonicToSeed(generateMnemonic());
  const wrapped = await wrapSeed(OLD, seed);
  await saveWrappedSeed(wrapped);
  __setEntries(['identity.sqlite', 'identity.sqlite-wal', 'general.sqlite', '.dina_install']);
  init
    .mockImplementationOnce(async () => {
      throw new Error('sqlite query error: file is not a database');
    })
    .mockImplementationOnce(async () => {
      setReady(true);
    });

  await unlock(OLD, wrapped);

  expect(__getDeletedEntries()).toEqual([]);
  expect(__getRenamedEntries().map((r) => r.from)).toEqual([
    'identity.sqlite',
    'identity.sqlite-wal',
    'general.sqlite',
  ]);
  expect(__getEntries().filter((n) => n.endsWith('.sqlite'))).toEqual([]);
  expect(__getEntries()).toContain('.dina_install');
  expect(__getRenamedEntries()[0]?.to).toMatch(/^identity\.sqlite\.unreadable-\d+$/);
  // Retried on fresh files, with the same vault salt.
  expect(init).toHaveBeenCalledTimes(2);
  expect(init.mock.calls[1]?.[1]).toEqual(wrapped.salt);
  expect(getRuntimeWarnings().map((w) => w.code)).toContain('vault.unreadable_set_aside');
});
