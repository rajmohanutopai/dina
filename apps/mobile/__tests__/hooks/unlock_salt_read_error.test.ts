/** docs/STATE_MACHINES.md PH-S3. A failed salt read fails the unlock, and moves no file. */

import { changePassphrase, generateMnemonic, mnemonicToSeed, wrapSeed } from '@dina/core';

import {
  __getRenamedEntries,
  __resetFileSystemMock,
  __setEntries,
} from '../../__mocks__/expo-file-system';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { getUnlockState, resetUnlockState, unlock } from '../../src/hooks/useUnlock';
import { saveWrappedSeed } from '../../src/services/wrapped_seed_store';

const Keychain = require('react-native-keychain');

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

const init = require('../../src/storage/init');

it('never keys the databases from the wrong salt, and sets nothing aside', async () => {
  resetKeychainMock();
  __resetFileSystemMock();
  resetUnlockState();
  const seed = mnemonicToSeed(generateMnemonic());
  const first = await wrapSeed('OldPass123!', seed);
  await saveWrappedSeed(first);
  await unlock('OldPass123!', first); // pins the vault salt
  const second = await changePassphrase('OldPass123!', 'NewPass456!', first);
  await saveWrappedSeed(second);
  init.__setReady(false);
  init.initializePersistence.mockClear();
  resetUnlockState();
  __setEntries(['identity.sqlite', 'general.sqlite']);

  const real = Keychain.getGenericPassword;
  const spy = jest
    .spyOn(Keychain, 'getGenericPassword')
    .mockImplementation(async (o: { service?: string }) => {
      if (o?.service === 'dina.vault.salt') throw new Error('errSecInteractionNotAllowed');
      return real(o);
    });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(unlock('NewPass456!', second)).rejects.toThrow(/errSecInteractionNotAllowed/);
  spy.mockRestore();
  warn.mockRestore();

  expect(getUnlockState().step).toBe('failed');
  expect(init.initializePersistence).not.toHaveBeenCalled();
  expect(__getRenamedEntries()).toEqual([]);
});
