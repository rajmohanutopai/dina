/**
 * The Staff screen (TRADE_FIRST §6, WEB_OWNER_SURFACE_PLAN §3.5, §3.8): the
 * staff devices are Core's (so a browser connected as the owner sees the
 * Home Node's, not the tab's own empty registry); a grant needs a person
 * present and is retried after the passphrase; revoking asks first.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerCommerceHttpError } from '@dina/core';

import StaffGrantsScreen from '../../app/staff-grants';

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    Stack: { Screen: () => null },
  };
});
const mockConfirm = jest.fn(async () => true);
jest.mock('../../src/services/confirm_decision', () => ({
  confirmDecision: (...args: unknown[]) => mockConfirm(...(args as [])),
}));
const mockShowMessage = jest.fn();
jest.mock('../../src/services/show_message', () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
}));
const mockSetup = { status: jest.fn() };
jest.mock('../../src/services/owner_setup_client', () => ({
  getOwnerSetupClient: () => mockSetup,
}));
const mockCommerce = {
  listStaffGrants: jest.fn(),
  createStaffGrant: jest.fn(),
  revokeStaffGrants: jest.fn(),
  provePresence: jest.fn(),
};
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockCommerce,
}));

const CLERK = {
  device_id: 'dev-1',
  did: 'did:key:z6MkClerk',
  name: 'Clerk phone',
  created_at: 1,
  last_seen: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSetup.status.mockResolvedValue({ staff_devices: [CLERK] });
  mockCommerce.listStaffGrants.mockResolvedValue({ grants: [] });
  mockCommerce.createStaffGrant.mockResolvedValue({ ok: true });
  mockCommerce.revokeStaffGrants.mockResolvedValue({ ok: true });
  mockCommerce.provePresence.mockResolvedValue({ ok: true });
});

it('lists the staff devices Core has paired', async () => {
  const screen = render(<StaffGrantsScreen />);
  await waitFor(() => expect(screen.getByTestId('staff-device-did:key:z6MkClerk')).toBeTruthy());
  expect(screen.getByText('Clerk phone')).toBeTruthy();
});

it('with none paired it says so', async () => {
  mockSetup.status.mockResolvedValue({ staff_devices: [] });
  const screen = render(<StaffGrantsScreen />);
  await waitFor(() => expect(screen.getByTestId('staff-none')).toBeTruthy());
});

it('a browser not connected as the owner is told to connect, not told none are paired', async () => {
  mockSetup.status.mockRejectedValue(
    Object.assign(new Error('401'), { errorKey: 'owner_device_not_connected' }),
  );
  const screen = render(<StaffGrantsScreen />);
  await waitFor(() =>
    expect(String(screen.getByTestId('staff-none').props.children)).toMatch(
      /Connect this browser as the owner/,
    ),
  );
});

it('a grant needs a person present: the sheet asks, then the same grant runs again', async () => {
  mockCommerce.createStaffGrant.mockRejectedValueOnce(
    new OwnerCommerceHttpError('403', 403, 'no_user_presence'),
  );
  const screen = render(<StaffGrantsScreen />);
  await waitFor(() => expect(screen.getByTestId('staff-device-did:key:z6MkClerk')).toBeTruthy());
  fireEvent.press(screen.getByTestId('staff-device-did:key:z6MkClerk'));
  fireEvent.changeText(screen.getByTestId('staff-pin-input'), '4321');
  fireEvent.press(screen.getByTestId('staff-grant'));
  await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
  fireEvent.press(screen.getByTestId('presence-submit'));
  await waitFor(() => expect(mockCommerce.createStaffGrant).toHaveBeenCalledTimes(2));
  expect(mockCommerce.provePresence).toHaveBeenCalledWith('correct horse');
  expect(mockCommerce.createStaffGrant.mock.calls[1]?.[0]).toMatchObject({
    deviceDid: 'did:key:z6MkClerk',
    scope: 'commerce_confirm',
    pin: '4321',
  });
  await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('Granted', expect.any(String)));
});

it('revoking asks first; a no revokes nothing', async () => {
  const screen = render(<StaffGrantsScreen />);
  await waitFor(() => expect(screen.getByTestId('staff-device-did:key:z6MkClerk')).toBeTruthy());
  fireEvent.press(screen.getByTestId('staff-device-did:key:z6MkClerk'));
  await waitFor(() => expect(screen.getByTestId('staff-revoke')).toBeTruthy());
  mockConfirm.mockResolvedValueOnce(false);
  fireEvent.press(screen.getByTestId('staff-revoke'));
  await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
  expect(mockCommerce.revokeStaffGrants).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('staff-revoke'));
  await waitFor(() =>
    expect(mockCommerce.revokeStaffGrants).toHaveBeenCalledWith('did:key:z6MkClerk'),
  );
});
