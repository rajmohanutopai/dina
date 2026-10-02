/**
 * The two order-attachment cards on the OWNER surface (the phone), per
 * JIFFY_MERCHANT_INTEGRATION_PLAN §3.3: "open the payment link?" opens the
 * processor's https page on an explicit tap and offers Dismiss / Done;
 * "record this payment?" offers Deny / Record as paid. A link that is not
 * https is never opened and the card says so.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { resetNotifications } from '../../../../packages/brain/src/notifications/inbox';
import NotificationsScreen from '../../app/notifications';
import {
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
} from '../../src/hooks/useServiceInbox';

import type { WorkflowTask } from '@dina/core';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));
/** Listing names by `did|rkey` — no AppView in tests. */
const mockListed = new Map<string, string>();
jest.mock('../../src/services/supplier_names', () => ({
  ...jest.requireActual<object>('../../src/services/supplier_names'),
  supplierNamesHere: async (refs: { supplierDid: string; serviceRkey?: string }[]) =>
    new Map(
      refs.map((r) => [
        r.supplierDid,
        mockListed.get(`${r.supplierDid}|${r.serviceRkey ?? 'self'}`) ?? null,
      ]),
    ),
}));
/** The confirm dialog: captured, and declined so nothing is decided. */
const mockConfirm = jest.fn(async (_headline: string, _subline: string) => false);
jest.mock('../../src/services/confirm_decision', () => ({
  confirmDecision: (headline: string, subline: string) => mockConfirm(headline, subline),
}));
/** The buyer's placed orders — where the payment cards find the supplier's name. */
let mockPlaced: { supplierDid: string; serviceRkey?: string; supplierName?: string }[] = [];
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => ({
    placedOrders: async () => ({ orders: mockPlaced, evidence: 'available' }),
  }),
}));

const CALLS_PER_LOAD = 16;

function task(id: string, payload: Record<string, unknown>, description: string): WorkflowTask {
  return {
    id,
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description,
    payload: JSON.stringify(payload),
    result_summary: '',
    policy: '',
    created_at: 1_000,
    updated_at: 1_000,
  };
}

const link = (id: string, url: string): WorkflowTask =>
  task(
    id,
    {
      type: 'order_checkout_link',
      attachment_digest: 'a'.repeat(64),
      purchase_order_id: 'po-1',
      supplier_did: 'did:plc:supplier5678',
      provider: 'clover',
      session_ref: 'cs_1',
      url,
      amount: { currency: 'INR', minor_units: '50000' },
    },
    'Pay INR 500.00 for order po-1 through clover?',
  );
const PAYMENT = task(
  'payment-evidence-def',
  {
    type: 'payment_evidence_record',
    attachment_digest: 'b'.repeat(64),
    purchase_order_id: 'po-1',
    supplier_did: 'did:plc:supplier5678',
    provider: 'clover',
    provider_ref: 'ch_1',
    amount: { currency: 'INR', minor_units: '50000' },
  },
  'Record INR 500.00 as paid for order po-1? clover reports it captured.',
);

function stubClient(pending: WorkflowTask[]): {
  client: InboxCoreClient;
  listCalls: { value: number };
} {
  const listCalls = { value: 0 };
  const client: InboxCoreClient = {
    async listWorkflowTasks(query) {
      listCalls.value++;
      if (query?.state === 'pending_approval') return pending.filter((t) => t.kind === query.kind);
      return [];
    },
    approveWorkflowTask: jest.fn(),
    cancelWorkflowTask: jest.fn(),
    getWorkflowTask: jest.fn(async () => null),
    sendServiceRespond: jest.fn(),
  };
  return { client, listCalls };
}

beforeEach(() => {
  resetInboxCoreClient();
  resetNotifications();
  mockPlaced = [];
  mockListed.clear();
  mockConfirm.mockClear();
});

describe('order-attachment cards on the owner surface', () => {
  it('the checkout card opens its https link on a tap and offers Dismiss / Done; the payment card offers Deny / Record as paid', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const stub = stubClient([
      link('order-checkout-abc', 'https://pay.example.com/s/cs_1'),
      PAYMENT,
    ]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() =>
      expect(screen.getByTestId('approvals-open-link-order-checkout-abc')).toBeTruthy(),
    );
    expect(screen.getByText('Open the payment link?')).toBeTruthy();
    expect(screen.getByTestId('approvals-attachment-why-order-checkout-abc').props.children).toBe(
      'Pay INR 500.00 for order po-1 through clover?',
    );
    expect(screen.getByText('INR 500.00')).toBeTruthy();
    fireEvent.press(screen.getByTestId('approvals-open-link-order-checkout-abc'));
    expect(open).toHaveBeenCalledWith('https://pay.example.com/s/cs_1');
    expect(screen.getByText('Dismiss')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Record this payment?')).toBeTruthy();
    expect(screen.getByText('Record as paid')).toBeTruthy();
    expect(screen.getByTestId('approvals-deny-payment-evidence-def')).toBeTruthy();
    expect(screen.queryByTestId('approvals-open-link-payment-evidence-def')).toBeNull();
    open.mockRestore();
  });

  it('a link that is not https is never offered, and the card says so', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const stub = stubClient([link('order-checkout-http', 'http://pay.example.com/s/cs_1')]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() =>
      expect(screen.getByTestId('approvals-link-refused-order-checkout-http')).toBeTruthy(),
    );
    expect(screen.queryByTestId('approvals-open-link-order-checkout-http')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe('the supplier on the order-attachment cards', () => {
  it("is named from the placed order's listing, with the DID beside it", async () => {
    mockPlaced = [{ supplierDid: 'did:plc:supplier5678', serviceRkey: 'self' }];
    mockListed.set('did:plc:supplier5678|self', 'ValueCrumb Bakery');
    const stub = stubClient([PAYMENT]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() => expect(screen.getByText(/ValueCrumb Bakery \(did:plc:/)).toBeTruthy());
  });

  it("the owner's contact name wins over the listing", async () => {
    mockPlaced = [
      { supplierDid: 'did:plc:supplier5678', serviceRkey: 'self', supplierName: 'Val (my baker)' },
    ];
    mockListed.set('did:plc:supplier5678|self', 'ValueCrumb Bakery');
    const stub = stubClient([PAYMENT]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() => expect(screen.getByText(/Val \(my baker\) \(did:plc:/)).toBeTruthy());
  });

  it('keeps the DID when no placed order names the supplier', async () => {
    const stub = stubClient([PAYMENT]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() => expect(screen.getByText('Record this payment?')).toBeTruthy());
    expect(screen.queryByText(/ValueCrumb/)).toBeNull();
    expect(screen.getByText(/did:plc:/)).toBeTruthy();
  });

  it('the approve confirmation leads with the name, not a shortened DID', async () => {
    mockPlaced = [{ supplierDid: 'did:plc:supplier5678', serviceRkey: 'self' }];
    mockListed.set('did:plc:supplier5678|self', 'ValueCrumb Bakery');
    const stub = stubClient([PAYMENT]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() => expect(screen.getByText(/ValueCrumb Bakery \(did:plc:/)).toBeTruthy());
    fireEvent.press(screen.getByTestId('approvals-approve-payment-evidence-def'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    const subline = mockConfirm.mock.calls[0]?.[1] ?? '';
    expect(subline.startsWith('ValueCrumb Bakery\n')).toBe(true);
    expect(subline).not.toContain('did:plc');
    // Nor Dina's own order key: the owner checks the amount.
    expect(subline).not.toMatch(/po[-_]/);
    expect(subline).toContain('INR 500.00');
  });

  it('with no name known, the confirmation says so in words, not with a DID', async () => {
    const stub = stubClient([PAYMENT]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() => expect(screen.getByText('Record this payment?')).toBeTruthy());
    fireEvent.press(screen.getByTestId('approvals-approve-payment-evidence-def'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    const subline = mockConfirm.mock.calls[0]?.[1] ?? '';
    expect(subline.startsWith('someone not in your contacts\n')).toBe(true);
    expect(subline).not.toContain('did:plc');
  });
});
