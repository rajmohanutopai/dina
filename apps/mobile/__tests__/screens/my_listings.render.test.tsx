/**
 * My listings (Network → Publish a service). The live web run found Delete
 * doing nothing in a browser: its confirm was an `Alert.alert`, which React
 * Native Web never shows. The screen now asks through `confirmDecision`
 * (a browser confirm on the web), so a yes deletes and a no leaves the
 * listing, on both surfaces.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import MyListingsScreen from '../../app/my-listings';

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    Stack: { Screen: () => null },
  };
});
jest.mock('../../src/hooks/useNodeBootstrap', () => ({ getBootedNode: () => null }));
jest.mock('../../src/services/reload_app', () => ({ reloadApp: jest.fn() }));
jest.mock('../../src/services/role_preference', () => ({ saveRolePreference: jest.fn() }));
const mockConfirm = jest.fn();
jest.mock('../../src/services/confirm_decision', () => ({
  confirmDecision: (...args: unknown[]) => mockConfirm(...args),
}));
const mockShowMessage = jest.fn();
jest.mock('../../src/services/show_message', () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
}));
const mockList = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../src/hooks/useServiceConfigForm', () => ({
  ServiceConfigNotConfiguredError: class extends Error {},
  listServiceListings: () => mockList(),
  deleteServiceListing: (rkey: string) => mockDelete(rkey),
  saveServiceConfig: jest.fn(),
}));

const LISTING = {
  rkey: 'shop',
  config: {
    name: 'ChairMaker Workshop',
    status: 'active',
    discoverability: 'unlisted',
    capabilities: {},
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([LISTING]);
  mockDelete.mockResolvedValue(undefined);
});

it('Delete asks first; a yes deletes and re-reads the list', async () => {
  mockConfirm.mockResolvedValue(true);
  const screen = render(<MyListingsScreen />);
  await waitFor(() => expect(screen.getByTestId('listing-delete-shop')).toBeTruthy());
  fireEvent.press(screen.getByTestId('listing-delete-shop'));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('shop'));
  expect(mockConfirm.mock.calls[0]?.[0]).toBe('Delete listing');
  await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
});

it('a no on the question deletes nothing', async () => {
  mockConfirm.mockResolvedValue(false);
  const screen = render(<MyListingsScreen />);
  await waitFor(() => expect(screen.getByTestId('listing-delete-shop')).toBeTruthy());
  fireEvent.press(screen.getByTestId('listing-delete-shop'));
  await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
  expect(mockDelete).not.toHaveBeenCalled();
});

it('a failed delete is said, not swallowed', async () => {
  mockConfirm.mockResolvedValue(true);
  mockDelete.mockRejectedValue(new Error('PDS unreachable'));
  const screen = render(<MyListingsScreen />);
  await waitFor(() => expect(screen.getByTestId('listing-delete-shop')).toBeTruthy());
  fireEvent.press(screen.getByTestId('listing-delete-shop'));
  await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('Error', 'PDS unreachable'));
});
