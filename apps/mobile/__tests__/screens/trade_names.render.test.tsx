/**
 * The Trade screen names its counterparties. Reported: the list read
 * "Payment to acknowledge · Buying · did:plc:u6r2…c4xv". The inbox knows
 * DIDs only; the screen shows the name it resolves (the owner's contact,
 * else the counterparty's listing), and words where no name is known.
 */

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

import TradeScreen from '../../app/trade';

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    Stack: { Screen: () => null },
  };
});
jest.mock('../../src/services/show_message', () => ({ showMessage: jest.fn() }));

const NAMED = 'did:plc:u6r2tdxhgfa4s7umwbelc4xv';
const UNNAMED = 'did:plc:pdzsfea6fk4pgy6hkuoukqmk';
jest.mock('../../src/services/supplier_names', () => ({
  ...jest.requireActual<object>('../../src/services/supplier_names'),
  supplierNamesHere: async (refs: { supplierDid: string }[]) =>
    new Map(
      refs.map((r) => [r.supplierDid, r.supplierDid === NAMED ? 'ChairMaker Workshop' : null]),
    ),
}));
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => ({
    tradeInbox: async () => ({
      items: [
        {
          kind: 'unacknowledged_payment',
          role: 'buyer',
          subject: 's1',
          counterparty_did: NAMED,
          created_at: 1,
        },
        {
          kind: 'unreceipted_delivery',
          role: 'buyer',
          subject: 's2',
          counterparty_did: UNNAMED,
          created_at: 2,
        },
      ],
    }),
  }),
}));

it('rows and the khata list name the counterparty; an unknown one is named in words, never by DID', async () => {
  const view = render(<TradeScreen />);
  await waitFor(() => expect(view.getAllByText(/ChairMaker Workshop/).length).toBeGreaterThan(0));
  expect(view.getByText(/Buying · ChairMaker Workshop/)).toBeTruthy();
  expect(view.queryByText(/u6r2/)).toBeNull();
  expect(view.getByText(/Buying · Unnamed contact/)).toBeTruthy();
  expect(view.queryByText(/did:plc:/)).toBeNull();
  expect(view.getByTestId(`trade-khata-${NAMED}`)).toBeTruthy();
});
