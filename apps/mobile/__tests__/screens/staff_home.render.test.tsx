/**
 * The clerk's home screen (TRADE_FIRST §6). A wrong staff PIN answers
 * `403 access_denied` (one bit out, by design). The screen once showed the
 * transport's log line ("POST /v1/commerce/trade/staff-presence failed 403 —
 * access_denied"); it now says it in words, as the presence sheet does, and
 * a right PIN opens the inbox.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import StaffHomeScreen from '../../app/staff-home';

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
    Stack: { Screen: () => null },
  };
});
const mockShowMessage = jest.fn();
jest.mock('../../src/services/show_message', () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
}));
jest.mock('../../src/services/confirm_decision', () => ({ confirmDecision: jest.fn() }));
jest.mock('../../src/services/staff_transport_rn', () => ({ makeStaffWebSocket: () => null }));
jest.mock('../../src/services/staff_identity_store', () => ({
  loadStaffIdentity: async () => ({ deviceName: 'Tender clerk' }),
  clearStaffIdentity: jest.fn(),
}));
const mockProve = jest.fn();
const mockInbox = jest.fn();
jest.mock('@dina/core', () => {
  const actual = jest.requireActual<typeof import('@dina/core')>('@dina/core');
  return {
    ...actual,
    staffTransportFor: () => ({}),
    StaffCoreClient: class {
      provePresence = (pin: string) => mockProve(pin);
      inbox = () => mockInbox();
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockInbox.mockResolvedValue({ items: [] });
});

async function enterPin(pin: string) {
  const screen = render(<StaffHomeScreen />);
  await waitFor(() => expect(screen.getByTestId('staff-pin-input')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('staff-pin-input'), pin);
  fireEvent.press(screen.getByTestId('staff-prove'));
  return screen;
}

it('a wrong PIN is said in words, never as the transport’s log line', async () => {
  const { StaffClientError } = jest.requireActual<typeof import('@dina/core')>('@dina/core');
  mockProve.mockRejectedValue(
    new StaffClientError(
      'POST /v1/commerce/trade/staff-presence failed 403 — access_denied',
      403,
      'access_denied',
    ),
  );
  await enterPin('1234');
  await waitFor(() =>
    expect(mockShowMessage).toHaveBeenCalledWith('Not verified', 'That PIN did not verify.'),
  );
});

it('the right PIN opens the inbox', async () => {
  mockProve.mockResolvedValue({ ok: true });
  const screen = await enterPin('4821');
  await waitFor(() => expect(screen.getByTestId('staff-inbox-empty')).toBeTruthy());
  expect(mockProve).toHaveBeenCalledWith('4821');
  expect(mockShowMessage).not.toHaveBeenCalled();
});
