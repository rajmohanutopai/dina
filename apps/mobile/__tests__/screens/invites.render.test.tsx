/**
 * The Invites screen (TRADE_FIRST §8, WEB_OWNER_SURFACE_PLAN §3.8): minting,
 * redeeming a pasted code and accepting a held introduction each create a
 * trading relationship with standing access, so Core asks for a person
 * present. The sheet asks, the same action runs again, and a failure of
 * another kind is said under that action's own title.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerCommerceHttpError } from '@dina/core';

import InvitesScreen from '../../app/invites';

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
const mockCommerce = {
  listInvites: jest.fn(),
  mintInvite: jest.fn(),
  redeemInvite: jest.fn(),
  acceptHeldInvite: jest.fn(),
  provePresence: jest.fn(),
};
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockCommerce,
}));

const presence = (): OwnerCommerceHttpError =>
  new OwnerCommerceHttpError('403', 403, 'no_user_presence');

const HELD = {
  role: 'redeemer' as const,
  state: 'held' as const,
  direction: 'you_supply_me' as const,
  counterparty_did: 'did:plc:coldbuyer1234',
  activation_proven: false,
  expires_at: 2_000_000_000,
  created_at: 1_900_000_000,
  nonce: 'nonce-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCommerce.listInvites.mockResolvedValue({ invites: [] });
  mockCommerce.provePresence.mockResolvedValue({ ok: true });
});

async function prove(screen: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
  fireEvent.press(screen.getByTestId('presence-submit'));
}

it('redeeming a code asks for presence, then redeems the same code', async () => {
  mockCommerce.redeemInvite.mockRejectedValueOnce(presence()).mockResolvedValue({ ok: true });
  const screen = render(<InvitesScreen />);
  fireEvent.changeText(screen.getByTestId('invite-code-input'), ' dina-invite-code ');
  fireEvent.press(screen.getByTestId('invite-redeem'));
  await prove(screen);
  await waitFor(() => expect(mockCommerce.redeemInvite).toHaveBeenCalledTimes(2));
  expect(mockCommerce.redeemInvite.mock.calls[1]?.[0]).toEqual({
    code: 'dina-invite-code',
    serviceRkeys: ['self'],
  });
  expect(mockCommerce.provePresence).toHaveBeenCalledWith('correct horse');
  await waitFor(() =>
    expect(mockShowMessage).toHaveBeenCalledWith('Invite accepted', expect.any(String)),
  );
});

it('accepting a held introduction asks first, then for presence, then accepts', async () => {
  mockCommerce.listInvites.mockResolvedValue({ invites: [HELD] });
  mockCommerce.acceptHeldInvite.mockRejectedValueOnce(presence()).mockResolvedValue({ ok: true });
  const screen = render(<InvitesScreen />);
  await waitFor(() => expect(screen.getByTestId('invite-row-0')).toBeTruthy());
  fireEvent.press(screen.getByTestId('invite-row-0'));
  await prove(screen);
  await waitFor(() => expect(mockCommerce.acceptHeldInvite).toHaveBeenCalledTimes(2));
  expect(mockConfirm).toHaveBeenCalledTimes(1);
  expect(mockCommerce.acceptHeldInvite.mock.calls[1]?.[0]).toEqual({
    nonce: 'nonce-1',
    serviceRkeys: ['self'],
  });
  expect(mockShowMessage).not.toHaveBeenCalled();
});

it('another refusal is said under the action’s own title, with no sheet', async () => {
  mockCommerce.redeemInvite.mockRejectedValue(
    new OwnerCommerceHttpError(
      'OwnerCommerceClient: redeemInvite failed 409',
      409,
      'invite_expired',
    ),
  );
  const screen = render(<InvitesScreen />);
  fireEvent.changeText(screen.getByTestId('invite-code-input'), 'dina-invite-code');
  fireEvent.press(screen.getByTestId('invite-redeem'));
  await waitFor(() =>
    expect(mockShowMessage).toHaveBeenCalledWith('Could not redeem', expect.any(String)),
  );
  expect(screen.queryByTestId('presence-sheet')).toBeNull();
  expect(mockCommerce.redeemInvite).toHaveBeenCalledTimes(1);
});
