/**
 * Ask for quotes (ASK_FOR_QUOTES_PLAN §2). The owner describes what they
 * want, searches and picks suppliers, and sends; Core's tender is created
 * with exactly what the screen showed, and the Tender screen opens. A chat
 * draft prefills the form without sending anything. A broken rule is said in
 * words and nothing is sent; Core's refusal is said in words too.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { OwnerCommerceHttpError } from '@dina/core';

import AskQuotesScreen from '../../app/ask-quotes';

let mockParams: Record<string, string> = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
const mockShowMessage = jest.fn((_t: string, _m?: string, onClose?: () => void) => onClose?.());
jest.mock('../../src/services/show_message', () => ({
  showMessage: (t: string, m?: string, onClose?: () => void) => mockShowMessage(t, m, onClose),
}));
const mockCommerce = { buyerSettings: jest.fn(), createTender: jest.fn() };
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => mockCommerce,
}));
const mockFind = jest.fn();
jest.mock('../../src/services/supplier_finder', () => ({
  findSuppliersHere: (input: unknown) => mockFind(input),
}));

const BAKERY = 'did:plc:bakeryaaaa';
const PATISSERIE = 'did:plc:patisseriebb';

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockCommerce.buyerSettings.mockResolvedValue({
    configured: true,
    settings: {
      locations: [{ scheme: 'postal_area', value: '560001' }],
      currency: 'INR',
      preferredSuppliers: [],
      blockedSuppliers: [PATISSERIE],
    },
  });
  mockCommerce.createTender.mockResolvedValue({
    tenderId: 'tnd_1',
    members: [{ supplierDid: BAKERY, requestId: 'r1', sent: true }],
    negotiating: true,
  });
  mockFind.mockResolvedValue({
    words: ['cake'],
    suppliers: [
      {
        supplierDid: BAKERY,
        serviceRkey: 'shop',
        name: 'Sweet Crumb Bakery',
        trustScore: 0.8,
        wordsMatched: 1,
        itemsMatched: 2,
        indicativeFrom: { currency: 'INR', minorUnits: '90000' },
        preferred: false,
      },
    ],
  });
});

async function describeAndPick(screen: ReturnType<typeof render>): Promise<void> {
  fireEvent.changeText(
    screen.getByTestId('ask-line-text-0'),
    'Floral celebration cake, 20 servings',
  );
  await waitFor(() => expect(screen.getByTestId('ask-postal').props.value).toBe('560001'));
  fireEvent.changeText(screen.getByTestId('supplier-search'), 'cakes');
  fireEvent.press(screen.getByTestId('supplier-search-go'));
  await waitFor(() => expect(screen.getByTestId(`supplier-result-${BAKERY}`)).toBeTruthy());
  fireEvent.press(screen.getByTestId(`supplier-result-${BAKERY}`));
  await waitFor(() => expect(screen.getByTestId(`supplier-chip-${BAKERY}`)).toBeTruthy());
}

it('searches in the saved region without the blocked supplier, sends, and opens the Tender screen', async () => {
  const screen = render(<AskQuotesScreen />);
  await describeAndPick(screen);
  expect(mockFind).toHaveBeenCalledWith({
    text: 'cakes',
    region: 'postal_area:560001',
    preferredSuppliers: [],
    blockedSuppliers: [PATISSERIE],
  });
  expect(screen.getByText(/Well trusted · 2 matching items · from INR 900.00/)).toBeTruthy();

  fireEvent.changeText(screen.getByTestId('ask-target'), '2500');
  fireEvent.changeText(screen.getByTestId('ask-ceiling'), '3000');
  fireEvent.press(screen.getByTestId('ask-deadline-3600'));
  fireEvent.press(screen.getByTestId('ask-send'));

  await waitFor(() => expect(mockCommerce.createTender).toHaveBeenCalledTimes(1));
  expect(mockCommerce.createTender).toHaveBeenCalledWith({
    suppliers: [{ supplierDid: BAKERY, serviceRkey: 'shop' }],
    lines: [
      {
        lineId: 'l1',
        text: 'Floral celebration cake, 20 servings',
        quantity: '1',
        unitCode: 'each',
      },
    ],
    region: { scheme: 'postal_area', value: '560001' },
    currency: 'INR',
    limits: { targetMinorUnits: '250000', ceilingMinorUnits: '300000', deadlineSeconds: 3600 },
  });
  await waitFor(() =>
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/tender',
      params: { tender_id: 'tnd_1' },
    }),
  );
});

it('a form missing a supplier says so in words and sends nothing', async () => {
  const screen = render(<AskQuotesScreen />);
  fireEvent.changeText(screen.getByTestId('ask-line-text-0'), 'Cake');
  fireEvent.press(screen.getByTestId('ask-send'));
  await waitFor(() => expect(screen.getByText('Pick at least one supplier to ask.')).toBeTruthy());
  expect(mockCommerce.createTender).not.toHaveBeenCalled();
});

it('Core’s refusal is said in words and the owner stays on the form', async () => {
  mockCommerce.createTender.mockRejectedValue(
    new OwnerCommerceHttpError(
      'createTender failed 409 — commerce_not_active',
      409,
      'commerce_not_active',
    ),
  );
  const screen = render(<AskQuotesScreen />);
  await describeAndPick(screen);
  fireEvent.press(screen.getByTestId('ask-send'));
  await waitFor(() =>
    expect(screen.getByText('Dina could not do that (commerce not active).')).toBeTruthy(),
  );
  expect(mockReplace).not.toHaveBeenCalled();
});

it('a supplier the request did not reach is named before the Tender screen opens', async () => {
  mockCommerce.createTender.mockResolvedValue({
    tenderId: 'tnd_2',
    members: [{ supplierDid: BAKERY, requestId: 'r1', sent: false, reason: 'no_dispatch' }],
    negotiating: false,
  });
  const screen = render(<AskQuotesScreen />);
  await describeAndPick(screen);
  fireEvent.press(screen.getByTestId('ask-send'));
  await waitFor(() =>
    expect(mockShowMessage).toHaveBeenCalledWith(
      'Not every request went out',
      'Dina could not reach Sweet Crumb Bakery. The others were asked.',
      expect.any(Function),
    ),
  );
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/tender', params: { tender_id: 'tnd_2' } });
});

it('a chat draft prefills the form and sends nothing by itself', async () => {
  mockParams = {
    draft: JSON.stringify({
      lines: [{ text: 'Floral celebration cake, 20 servings', quantity: '2', unit_code: 'each' }],
      supplier_query: 'cakes',
      limits: { target_minor: '250000', ceiling_minor: '300050', max_rounds: 2 },
    }),
  };
  const screen = render(<AskQuotesScreen />);
  expect(screen.getByTestId('ask-line-text-0').props.value).toBe(
    'Floral celebration cake, 20 servings',
  );
  expect(screen.getByTestId('ask-line-quantity-0').props.value).toBe('2');
  expect(screen.getByTestId('supplier-search').props.value).toBe('cakes');
  expect(screen.getByTestId('ask-target').props.value).toBe('2500');
  expect(screen.getByTestId('ask-ceiling').props.value).toBe('3000.50');
  expect(screen.getByTestId('ask-rounds').props.value).toBe('2');
  await waitFor(() => expect(mockCommerce.buyerSettings).toHaveBeenCalled());
  expect(mockCommerce.createTender).not.toHaveBeenCalled();
});
