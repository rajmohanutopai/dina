/**
 * WEB_OWNER_SURFACE_PLAN §3.6 — a browser not connected as the owner is told
 * to connect, on every owner screen.
 *
 * In such a browser every owner request answers `401
 * owner_device_not_connected` without leaving the page. The live web run
 * found screens that showed the client's log line instead ("OwnerCommerce
 * Client: tradeInbox failed 401 — …"), an empty "none yet" list, or a spinner
 * that never stopped. Each screen here is opened with owner clients that
 * refuse that way, and must say the connect sentence.
 */

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

import BusinessIdentityScreen from '../../app/business-identity';
import CatalogScreen from '../../app/catalog';
import CatalogDraftScreen from '../../app/catalog-draft';
import InvitesScreen from '../../app/invites';
import OrderDraftScreen from '../../app/order-draft';
import OrdersScreen from '../../app/orders';
import RunsScreen from '../../app/runs';
import SubscriptionsScreen from '../../app/subscriptions';
import TradeScreen from '../../app/trade';
import { CONNECT_OWNER_DEVICE_MESSAGE } from '../../src/services/owner_errors';

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void) => ReactLib.useEffect(effect, [effect]),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({ draft_id: 'draft-1' }),
    Stack: { Screen: () => null },
  };
});
jest.mock('../../src/services/photo_pipeline', () => ({ normalizePickedPages: jest.fn() }));
jest.mock('../../src/services/show_message', () => ({ showMessage: jest.fn() }));
jest.mock('../../src/services/confirm_decision', () => ({ confirmDecision: jest.fn() }));

/** An owner client whose every method refuses as a browser not connected. */
function notConnected(): unknown {
  const refuse = async (): Promise<never> => {
    throw Object.assign(new Error('401 owner_device_not_connected'), {
      status: 401,
      errorKey: 'owner_device_not_connected',
    });
  };
  return new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : refuse) });
}
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => notConnected(),
}));
jest.mock('../../src/services/owner_run_client', () => ({
  getOwnerRunClient: () => notConnected(),
}));

it.each([
  ['Trade', TradeScreen],
  ['Orders', OrdersScreen],
  ['Catalog', CatalogScreen],
  ['Business identity', BusinessIdentityScreen],
  ['Runs', RunsScreen],
  ['Subscriptions', SubscriptionsScreen],
  ['Invites', InvitesScreen],
  ['Order draft', OrderDraftScreen],
  ['Catalog draft', CatalogDraftScreen],
] as [string, React.ComponentType][])('%s says to connect this browser', async (_name, Screen) => {
  const screen = render(<Screen />);
  await waitFor(() => expect(screen.getByText(CONNECT_OWNER_DEVICE_MESSAGE)).toBeTruthy());
  expect(
    screen.queryByText(/OwnerCommerceClient|OwnerRunClient|owner_device_not_connected/),
  ).toBeNull();
});
