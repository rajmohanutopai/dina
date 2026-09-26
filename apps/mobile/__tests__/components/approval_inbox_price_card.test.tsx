/**
 * The supplier owner's "lower price asked" card (NEGOTIATION_PLAN §4.3) on
 * the phone. A yes authorises every line the card names, so the card shows
 * every line — never the first few with the rest clipped.
 */

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { resetNotifications } from '../../../../packages/brain/src/notifications/inbox';
import NotificationsScreen from '../../app/notifications';
import {
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
} from '../../src/hooks/useServiceInbox';

import type { WorkflowTask } from '@dina/core';

const routerPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({}),
  router: { push: (...args: unknown[]) => routerPush(...args) },
}));
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));

const CALLS_PER_LOAD = 16;
const LINE_COUNT = 30;

const PRICE_CARD: WorkflowTask = {
  id: 'negotiation-price-many',
  kind: 'approval',
  status: 'pending_approval',
  priority: 'normal',
  description: `A buyer asks for a lower price on quote q:1 (${String(LINE_COUNT)} line(s)). Offer it?`,
  payload: JSON.stringify({
    type: 'negotiation_price_approval',
    quote_id: 'q:1',
    buyer_did: 'did:plc:buyer',
    currency: 'INR',
    lines: Array.from({ length: LINE_COUNT }, (_, i) => ({
      line_id: `l${String(i + 1)}`,
      asked_minor_units: '21000',
      signed_minor_units: '22000',
      quoted_minor_units: '24000',
    })),
  }),
  result_summary: '',
  policy: '',
  created_at: 1_000,
  updated_at: 1_000,
};

beforeEach(() => {
  resetInboxCoreClient();
  resetNotifications();
});

it('a price card with more lines than a preview holds shows every one, unclipped', async () => {
  let listCalls = 0;
  const client: InboxCoreClient = {
    async listWorkflowTasks(query) {
      listCalls++;
      if (query?.state === 'pending_approval' && query.kind === 'approval') return [PRICE_CARD];
      return [];
    },
    approveWorkflowTask: jest.fn(),
    cancelWorkflowTask: jest.fn(),
    getWorkflowTask: jest.fn(async () => null),
    sendServiceRespond: jest.fn(),
  };
  setInboxCoreClient(client);
  const screen = render(<NotificationsScreen />);
  await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD));
  fireEvent.press(screen.getByTestId('filter-needs_action'));
  const preview = await waitFor(() => screen.getByText(/^l1: asks INR 210\.00/));
  const text = String(preview.props.children);
  expect(text.split('\n')).toHaveLength(LINE_COUNT);
  expect(text).toContain(
    `l${String(LINE_COUNT)}: asks INR 210.00 (now INR 220.00, quoted INR 240.00)`,
  );
  expect(preview.props.numberOfLines).toBeUndefined();
});

it("a tender-ready card opens its tender: the award is the tender screen's act, not the card's", async () => {
  const TENDER_READY: WorkflowTask = {
    ...PRICE_CARD,
    id: 'tender-ready-tnd-7',
    description: 'Tender tnd-7 is ready.',
    payload: JSON.stringify({
      type: 'tender_ready',
      tender_id: 'tnd-7',
      reason: 'settled',
      offers: 2,
      best_total_minor: '43200',
      currency: 'INR',
    }),
  };
  let listCalls = 0;
  const client: InboxCoreClient = {
    async listWorkflowTasks(query) {
      listCalls++;
      if (query?.state === 'pending_approval' && query.kind === 'approval') return [TENDER_READY];
      return [];
    },
    approveWorkflowTask: jest.fn(),
    cancelWorkflowTask: jest.fn(),
    getWorkflowTask: jest.fn(async () => null),
    sendServiceRespond: jest.fn(),
  };
  setInboxCoreClient(client);
  const screen = render(<NotificationsScreen />);
  await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD));
  fireEvent.press(screen.getByTestId('filter-needs_action'));
  const open = await waitFor(() => screen.getByTestId('approvals-open-tender-tender-ready-tnd-7'));
  fireEvent.press(open);
  expect(routerPush).toHaveBeenCalledWith({ pathname: '/tender', params: { tender_id: 'tnd-7' } });
});
