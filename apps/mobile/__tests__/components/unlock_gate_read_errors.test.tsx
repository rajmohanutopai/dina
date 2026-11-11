/**
 * docs/STATE_MACHINES.md PH-S1, PH-S2. A read that fails at launch means "don't
 * know". It must never send a phone with a vault to onboarding, and never wipe it.
 */

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import {
  __resetFileSystemMock,
  __setEntries,
  __setFileContents,
} from '../../__mocks__/expo-file-system';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { UnlockGate } from '../../src/components/unlock_gate';
import * as marker from '../../src/services/install_marker';

const Keychain = require('react-native-keychain');

const fsMock = require('../../__mocks__/expo-file-system');

jest.mock('expo-router', () => ({ usePathname: () => '/' }));
jest.mock('../../src/components/onboarding/onboarding_flow', () => {
  const R = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');
  return { OnboardingFlow: () => R.createElement(Text, { testID: 'ONBOARDING' }, 'onboarding') };
});
jest.mock('../../src/components/staff_shell_redirect', () => ({ StaffShellRedirect: () => null }));

const SERVICE = 'dina.vault.wrapped_seed';
const SEED_ROW = JSON.stringify({
  v: 1,
  saltHex: '00'.repeat(16),
  wrappedHex: 'ab'.repeat(40),
  params: { memory: 1, iterations: 1, parallelism: 1 },
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
};

describe('reads that fail at launch', () => {
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    resetKeychainMock();
    __resetFileSystemMock();
    __setFileContents('.dina_install', '{}');
    __setEntries(['identity.sqlite', 'general.sqlite']);
    await Keychain.setGenericPassword('dina_vault', SEED_ROW, { service: SERVICE });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    jest.restoreAllMocks();
  });

  it('a keychain error shows a retry, not onboarding, and the retry reaches the vault', async () => {
    const spy = jest.spyOn(Keychain, 'getGenericPassword').mockImplementationOnce(async () => {
      throw new Error('keychain locked');
    });
    const ui = render(<UnlockGate>{null}</UnlockGate>);
    await settle();
    expect(ui.queryByTestId('ONBOARDING')).toBeNull();
    expect(ui.getByTestId('unlock-read-failed')).toBeTruthy();
    spy.mockRestore();
    fireEvent.press(ui.getByTestId('unlock-read-retry'));
    await settle();
    expect(ui.queryByTestId('unlock-read-failed')).toBeNull();
    expect(ui.queryByTestId('ONBOARDING')).toBeNull();
    ui.unmount();
  });

  it('a stored record it cannot read is the same: no onboarding on its own', async () => {
    await Keychain.setGenericPassword('dina_vault', 'not json', { service: SERVICE });
    const ui = render(<UnlockGate>{null}</UnlockGate>);
    await settle();
    expect(ui.queryByTestId('ONBOARDING')).toBeNull();
    // The owner can still choose to recover with their phrase.
    fireEvent.press(ui.getByTestId('unlock-read-recover'));
    await settle();
    expect(ui.queryByTestId('ONBOARDING')).not.toBeNull();
    ui.unmount();
  });

  it('a failed marker read wipes nothing', async () => {
    fsMock.__throwOnFileExists(true);
    const ui = render(<UnlockGate>{null}</UnlockGate>);
    await settle();
    fsMock.__throwOnFileExists(false);
    expect(await Keychain.getGenericPassword({ service: SERVICE })).not.toBe(false);
    expect(fsMock.__getDeletedEntries?.() ?? []).toEqual([]);
    ui.unmount();
  });

  it('a marker lost while the vault files are there wipes nothing', async () => {
    __resetFileSystemMock();
    __setEntries(['identity.sqlite', 'general.sqlite']);
    const ui = render(<UnlockGate>{null}</UnlockGate>);
    await settle();
    expect(await Keychain.getGenericPassword({ service: SERVICE })).not.toBe(false);
    expect(marker.installMarkerExists()).toBe(true); // written again for next time
    ui.unmount();
  });

  it('a true reinstall still clears the old keychain: marker gone, no vault files', async () => {
    __resetFileSystemMock();
    const ui = render(<UnlockGate>{null}</UnlockGate>);
    await settle();
    expect(await Keychain.getGenericPassword({ service: SERVICE })).toBe(false);
    expect(ui.queryByTestId('ONBOARDING')).not.toBeNull();
    ui.unmount();
  });
});
