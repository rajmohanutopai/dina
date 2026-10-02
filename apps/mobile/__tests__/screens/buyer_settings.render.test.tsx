/**
 * Buying preferences: the buyer's saved currency and delivery postal codes,
 * which Ask for quotes starts from. Core takes the buyer settings back whole,
 * so the screen must change only these two and return the rest untouched.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import BuyerSettingsScreen from '../../app/buyer-settings';

jest.mock('expo-router', () => ({ Stack: { Screen: () => null } }));
jest.mock('../../src/services/supplier_finder', () => ({
  ownerDidHere: async () => 'did:plc:owner',
}));
const mockClient = {
  buyerSettingsToEdit: jest.fn(),
  saveBuyerSettings: jest.fn(async () => ({ ok: true })),
  provePresence: jest.fn(),
};
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockClient,
}));

const SAVED = {
  actingIdentityDid: 'did:plc:owner',
  locations: [
    { scheme: 'postal_area', value: '560001' },
    { scheme: 'admin_area', value: 'IN-KA' },
  ],
  preferredSuppliers: ['did:plc:favourite'],
  blockedSuppliers: [],
  allowedCategoryIds: ['bakery'],
  quoteFanoutCeiling: 4,
  approvalPolicySummary: 'Ask me above INR 5,000',
  currency: 'INR',
  preferredUnitCodes: ['each'],
  publishReviews: true,
};

beforeEach(() => jest.clearAllMocks());

it('saves the currency and postal codes, and returns every other setting as it was', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: SAVED,
    findings: [],
  });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-currency').props.value).toBe('INR'));
  expect(view.getByTestId('buyer-postal-560001')).toBeTruthy();

  fireEvent.changeText(view.getByTestId('buyer-currency'), 'usd');
  fireEvent.press(view.getByTestId('buyer-postal-560001')); // remove
  fireEvent.changeText(view.getByTestId('buyer-postal-input'), '94103');
  fireEvent.press(view.getByTestId('buyer-postal-add'));
  fireEvent.press(view.getByTestId('buyer-settings-save'));

  await waitFor(() => expect(mockClient.saveBuyerSettings).toHaveBeenCalledTimes(1));
  expect(mockClient.saveBuyerSettings).toHaveBeenCalledWith({
    ...SAVED,
    currency: 'USD',
    // The non-postal area is kept; the postal ones are what the screen shows.
    locations: [
      { scheme: 'admin_area', value: 'IN-KA' },
      { scheme: 'postal_area', value: '94103' },
    ],
  });
  await waitFor(() => expect(view.getByTestId('buyer-settings-saved')).toBeTruthy());
});

it('a buyer with nothing saved starts from empty settings under their own identity', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({ configured: false });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-postal-none')).toBeTruthy());
  fireEvent.changeText(view.getByTestId('buyer-currency'), 'EUR');
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  await waitFor(() => expect(mockClient.saveBuyerSettings).toHaveBeenCalled());
  expect(mockClient.saveBuyerSettings.mock.calls[0]?.[0]).toMatchObject({
    actingIdentityDid: 'did:plc:owner',
    currency: 'EUR',
    locations: [],
    quoteFanoutCeiling: 5,
  });
});

it('a currency that is not three letters is said, and nothing is saved', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: SAVED,
    findings: [],
  });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-currency')).toBeTruthy());
  fireEvent.changeText(view.getByTestId('buyer-currency'), 'US');
  expect(view.getByText('A currency is a three-letter code, like INR or USD.')).toBeTruthy();
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  expect(mockClient.saveBuyerSettings).not.toHaveBeenCalled();
});

it('a setting Core refuses is shown, not swallowed', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: SAVED,
    findings: [],
  });
  mockClient.saveBuyerSettings.mockResolvedValueOnce({
    ok: false,
    findings: [
      {
        refusal: 'invalid_region',
        field: 'locations',
        detail: 'locations[1]: region: value is required',
      },
    ],
  } as never);
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-currency')).toBeTruthy());
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  await waitFor(() =>
    expect(view.getByTestId('buyer-finding').props.children).toBe(
      'locations[1]: region: value is required',
    ),
  );
});

it('stored preferences Core refuses open anyway, with what is wrong; saving puts them right', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: { ...SAVED, currency: 'inr' },
    findings: [
      {
        refusal: 'unknown_buyer_currency',
        field: 'currency',
        detail: 'expected a three-letter uppercase ISO 4217 code, found inr',
      },
    ],
  });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-stored-problem')).toBeTruthy());
  expect(view.getByTestId('buyer-finding').props.children).toMatch(/found inr/);
  expect(view.getByTestId('buyer-postal-560001')).toBeTruthy();

  fireEvent.changeText(view.getByTestId('buyer-currency'), 'INR');
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  await waitFor(() => expect(mockClient.saveBuyerSettings).toHaveBeenCalledTimes(1));
  // Everything stored goes back; only the fixed currency changed.
  expect(mockClient.saveBuyerSettings).toHaveBeenCalledWith({
    ...SAVED,
    locations: [
      { scheme: 'admin_area', value: 'IN-KA' },
      { scheme: 'postal_area', value: '560001' },
    ],
  });
  await waitFor(() => expect(view.queryByTestId('buyer-stored-problem')).toBeNull());
});

it('stored preferences Core cannot hand back offer a fresh start, said plainly', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: null,
    findings: [
      { refusal: 'wrong_field_shape', field: '', detail: 'settings must be a JSON object' },
    ],
  });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() =>
    expect(view.getByTestId('buyer-stored-problem').props.children).toMatch(/starts them over/),
  );
  fireEvent.changeText(view.getByTestId('buyer-currency'), 'INR');
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  await waitFor(() => expect(mockClient.saveBuyerSettings).toHaveBeenCalledTimes(1));
  expect(mockClient.saveBuyerSettings.mock.calls[0]?.[0]).toMatchObject({
    actingIdentityDid: 'did:plc:owner',
    currency: 'INR',
    locations: [],
  });
});

it('a refused record keeps every field the screen does not edit exactly as stored, even a malformed one', async () => {
  const stored = {
    ...SAVED,
    currency: 'inr',
    blockedSuppliers: 'did:plc:x',
    quoteFanoutCeiling: 'four',
  };
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: stored,
    findings: [
      {
        refusal: 'wrong_field_shape',
        field: 'blockedSuppliers',
        detail: 'blockedSuppliers must be a array',
      },
    ],
  });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-stored-problem')).toBeTruthy());
  fireEvent.changeText(view.getByTestId('buyer-currency'), 'INR');
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  await waitFor(() => expect(mockClient.saveBuyerSettings).toHaveBeenCalledTimes(1));
  const sent = mockClient.saveBuyerSettings.mock.calls[0]?.[0] as Record<string, unknown>;
  // Not replaced by defaults: Core judges them, and its findings stay in view.
  expect(sent.blockedSuppliers).toBe('did:plc:x');
  expect(sent.quoteFanoutCeiling).toBe('four');
  expect(sent.currency).toBe('INR');
});

it('a delivery area Core refuses that is not a postal code can be removed, and the save sends the rest', async () => {
  mockClient.buyerSettingsToEdit.mockResolvedValue({
    configured: true,
    settings: {
      ...SAVED,
      locations: [
        { scheme: 'postcode', value: '94103' },
        { scheme: 'postal_area', value: '560001' },
      ],
    },
    findings: [
      { refusal: 'invalid_region', field: 'locations', detail: 'locations[0]: unknown scheme' },
    ],
  });
  const view = render(<BuyerSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('buyer-area-0')).toBeTruthy());
  expect(view.getByText('postcode: 94103 ✕')).toBeTruthy();
  fireEvent.press(view.getByTestId('buyer-area-0'));
  expect(view.queryByTestId('buyer-area-0')).toBeNull();
  fireEvent.press(view.getByTestId('buyer-settings-save'));
  await waitFor(() => expect(mockClient.saveBuyerSettings).toHaveBeenCalledTimes(1));
  expect(
    (mockClient.saveBuyerSettings.mock.calls[0]?.[0] as { locations: unknown }).locations,
  ).toEqual([{ scheme: 'postal_area', value: '560001' }]);
});
