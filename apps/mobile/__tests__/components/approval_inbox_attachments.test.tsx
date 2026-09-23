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
    expect(screen.getByText('order po-1\nINR 500.00')).toBeTruthy();
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
