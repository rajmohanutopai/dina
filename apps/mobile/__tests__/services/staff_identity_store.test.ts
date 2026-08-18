/**
 * Staff identity persistence (§6.3). A staff phone reloads this record
 * every launch to rebuild its relay transport, so a round trip must be
 * lossless and a corrupt record must read as `null` (run the join flow)
 * rather than trapping the clerk on a dead screen.
 */

import * as Keychain from 'react-native-keychain';

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import {
  clearStaffIdentity,
  loadStaffIdentity,
  saveStaffIdentity,
} from '../../src/services/staff_identity_store';

import type { StaffIdentity } from '@dina/core';

const IDENTITY: StaffIdentity = {
  deviceDid: 'did:key:z6MkStaffPhoneTest',
  devicePrivateKeyHex: 'a'.repeat(64),
  homenodeDid: 'did:plc:businessnode0000000000000',
  homenodeSigningPubHex: 'b'.repeat(64),
  msgboxUrl: 'wss://test-mailbox.dinakernel.com/ws',
  deviceName: 'clerk-phone',
};

beforeEach(() => {
  resetKeychainMock();
});

describe('staff_identity_store', () => {
  it('round-trips a staff identity byte for byte', async () => {
    await saveStaffIdentity(IDENTITY);
    expect(await loadStaffIdentity()).toEqual(IDENTITY);
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadStaffIdentity()).toBeNull();
  });

  it('clearStaffIdentity leaves the join flow', async () => {
    await saveStaffIdentity(IDENTITY);
    await clearStaffIdentity();
    expect(await loadStaffIdentity()).toBeNull();
  });

  it('a corrupt record reads as null, never throws', async () => {
    await Keychain.setGenericPassword('staff', 'not json at all', {
      service: 'com.dina.staff-identity',
    });
    expect(await loadStaffIdentity()).toBeNull();
  });

  it('a record with a bad key length is rejected — a half-identity cannot seal', async () => {
    await Keychain.setGenericPassword(
      'staff',
      JSON.stringify({ ...IDENTITY, v: 1, devicePrivateKeyHex: 'short' }),
      { service: 'com.dina.staff-identity' },
    );
    expect(await loadStaffIdentity()).toBeNull();
  });

  it('a future version is rejected rather than half-read', async () => {
    await Keychain.setGenericPassword('staff', JSON.stringify({ ...IDENTITY, v: 2 }), {
      service: 'com.dina.staff-identity',
    });
    expect(await loadStaffIdentity()).toBeNull();
  });
});
