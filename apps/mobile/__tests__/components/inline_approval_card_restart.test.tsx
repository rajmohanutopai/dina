/**
 * PH-06: the approval card's state lives on its row. After a remount or a
 * restart the buttons must not return for a decided ask, and an approve the
 * gateway accepted must close them even though the manager's request is gone.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import {
  resetAskApprovalGateway,
  setAskApprovalGateway,
} from '../../../brain/src/composition/ask_gateway_registry';
import { InlineApprovalCard } from '../../src/components/InlineApprovalCard';

import type { ChatMessage } from '@dina/brain/chat';

function row(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: 'm1',
    threadId: 'main',
    type: 'approval',
    content: 'needs approval',
    timestamp: 1,
    sources: [],
    metadata: {
      kind: 'ask_approval',
      askId: 'ask-1',
      approvalId: 'appr-1',
      requesterDid: 'did:plc:x',
      persona: 'health',
      ...metadata,
    },
  } as ChatMessage;
}

afterEach(() => resetAskApprovalGateway());

it('an open ask offers the buttons', () => {
  render(<InlineApprovalCard message={row({})} approverDID="did:plc:o" />);
  expect(screen.getByTestId('approval-approve-appr-1')).toBeTruthy();
});

it('a resumed ask shows approved, with no buttons', () => {
  render(<InlineApprovalCard message={row({ askStatus: 'in_flight' })} approverDID="did:plc:o" />);
  expect(screen.queryByTestId('approval-approve-appr-1')).toBeNull();
  expect(screen.getByText('Approved. Fetching answer…')).toBeTruthy();
});

it.each([
  ['complete', 'Approved.'],
  ['failed', 'This request has ended.'],
  ['expired', 'This request has ended.'],
])('an ask that ended as %s has no buttons', (askStatus, text) => {
  render(<InlineApprovalCard message={row({ askStatus })} approverDID="did:plc:o" />);
  expect(screen.queryByTestId('approval-approve-appr-1')).toBeNull();
  expect(screen.getByText(text)).toBeTruthy();
});

it('after a restart, a gateway approve closes the buttons with no manager request', async () => {
  setAskApprovalGateway({ approve: async () => ({ ok: true }) } as never);
  render(<InlineApprovalCard message={row({})} approverDID="did:plc:o" />);
  fireEvent.press(screen.getByTestId('approval-approve-appr-1'));
  await waitFor(() => expect(screen.queryByTestId('approval-approve-appr-1')).toBeNull());
  expect(screen.getByText('Approved. Fetching answer…')).toBeTruthy();
});
