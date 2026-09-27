/**
 * WEB_OWNER_SURFACE_PLAN §3.8 — a yes on a money card needs a person present.
 *
 * Core refuses the approve with `no_user_presence` (here as the phone's
 * in-process client raises it: a `CoreHttpError` carrying Core's answer). The
 * inbox opens the "confirm it's you" sheet; a wrong passphrase is said inside
 * the sheet and nothing is retried; the right one is proven and the SAME
 * decision is sent again. A refusal of another kind stays on the card.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { CoreHttpError } from '@dina/core';

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
jest.mock('../../src/services/confirm_decision', () => ({
  confirmDecision: async () => true,
}));
const mockProve = jest.fn();
jest.mock('../../src/services/owner_commerce_client', () => ({
  getOwnerCommerceClient: () => ({ provePresence: mockProve }),
}));

const CALLS_PER_LOAD = 16;

const PAYMENT: WorkflowTask = {
  id: 'payment-evidence-def',
  kind: 'approval',
  status: 'pending_approval',
  priority: 'normal',
  description: 'Record INR 500.00 as paid for order po-1? clover reports it captured.',
  payload: JSON.stringify({
    type: 'payment_evidence_record',
    attachment_digest: 'b'.repeat(64),
    purchase_order_id: 'po-1',
    supplier_did: 'did:plc:supplier5678',
    provider: 'clover',
    provider_ref: 'ch_1',
    amount: { currency: 'INR', minor_units: '50000' },
  }),
  result_summary: '',
  policy: '',
  created_at: 1_000,
  updated_at: 1_000,
};

function refusal(error: string, status = 403): CoreHttpError {
  return new CoreHttpError(
    `InProcessTransport: approve failed ${String(status)} — ${error}`,
    status,
    {
      error,
    },
  );
}

async function openInbox(approve: jest.Mock) {
  let listCalls = 0;
  const client: InboxCoreClient = {
    async listWorkflowTasks(query) {
      listCalls++;
      return query?.state === 'pending_approval' ? [PAYMENT] : [];
    },
    approveWorkflowTask: approve,
    cancelWorkflowTask: jest.fn(),
    getWorkflowTask: jest.fn(async () => PAYMENT),
    sendServiceRespond: jest.fn(),
  };
  setInboxCoreClient(client);
  const screen = render(<NotificationsScreen />);
  await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD));
  fireEvent.press(screen.getByTestId('filter-needs_action'));
  await waitFor(() =>
    expect(screen.getByTestId('approvals-approve-payment-evidence-def')).toBeTruthy(),
  );
  return screen;
}

beforeEach(() => {
  resetInboxCoreClient();
  resetNotifications();
  mockProve.mockReset();
});

it('asks for the passphrase, then sends the same yes again', async () => {
  const approve = jest
    .fn()
    .mockRejectedValueOnce(refusal('no_user_presence'))
    .mockResolvedValueOnce({ ...PAYMENT, status: 'completed' });
  mockProve.mockImplementation(async (passphrase: string) => {
    if (passphrase !== 'correct horse')
      throw Object.assign(new Error('401'), { errorKey: 'not_proven' });
    return { ok: true };
  });
  const screen = await openInbox(approve);

  fireEvent.press(screen.getByTestId('approvals-approve-payment-evidence-def'));
  await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
  expect(approve).toHaveBeenCalledTimes(1);
  // No error on the card: the refusal went to the sheet.
  expect(screen.queryByTestId('approvals-error-payment-evidence-def')).toBeNull();

  fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'wrong');
  fireEvent.press(screen.getByTestId('presence-submit'));
  await waitFor(() =>
    expect(screen.getByTestId('presence-error').props.children).toBe(
      'That passphrase did not verify.',
    ),
  );
  expect(approve).toHaveBeenCalledTimes(1);

  fireEvent.changeText(screen.getByTestId('presence-passphrase'), 'correct horse');
  fireEvent.press(screen.getByTestId('presence-submit'));
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
  expect(approve.mock.calls[1]?.[0]).toBe('payment-evidence-def');
  await waitFor(() =>
    expect(screen.queryByTestId('approvals-approve-payment-evidence-def')).toBeNull(),
  );
  expect(screen.queryByTestId('presence-sheet')).toBeNull();
});

it('cancelling the sheet sends nothing more and leaves the card', async () => {
  const approve = jest.fn().mockRejectedValue(refusal('no_user_presence'));
  const screen = await openInbox(approve);
  fireEvent.press(screen.getByTestId('approvals-approve-payment-evidence-def'));
  await waitFor(() => expect(screen.getByTestId('presence-sheet')).toBeTruthy());
  fireEvent.press(screen.getByTestId('presence-cancel'));
  await waitFor(() => expect(screen.queryByTestId('presence-sheet')).toBeNull());
  expect(mockProve).not.toHaveBeenCalled();
  expect(approve).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('approvals-approve-payment-evidence-def')).toBeTruthy();
});

it('any other refusal stays on the card, in Core’s words', async () => {
  const approve = jest.fn().mockRejectedValue(refusal('task not found', 404));
  const screen = await openInbox(approve);
  fireEvent.press(screen.getByTestId('approvals-approve-payment-evidence-def'));
  await waitFor(() =>
    expect(screen.getByTestId('approvals-error-payment-evidence-def')).toBeTruthy(),
  );
  expect(screen.queryByTestId('presence-sheet')).toBeNull();
});
