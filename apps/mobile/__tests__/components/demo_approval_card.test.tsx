/**
 * InlineDemoApprovalCard — the guided demo's actionable approve/deny card,
 * backed directly by the real ApprovalManager (no gateway / workflow / grant).
 */

import { render, screen, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { getApprovalManager, resetApprovalManager } from '@dina/core';

import { InlineDemoApprovalCard } from '../../src/components/InlineDemoApprovalCard';

import type { ChatMessage } from '@dina/brain/chat';


const APPROVAL_ID = 'guided-demo-approval-42';

function seedRequest(): void {
  getApprovalManager().requestApproval({
    id: APPROVAL_ID,
    action: 'read_vault',
    requester_did: 'did:plc:demoshoppingagent',
    persona: 'health',
    reason: 'compare ergonomic fit',
    preview: 'Demo Shopping Agent requests health access (read, this task only).',
    created_at: 1,
  });
}

function cardMessage(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: 'm1',
    threadId: 'main',
    type: 'approval',
    content: 'Demo Shopping Agent requests health access (read, this task only).',
    metadata,
    timestamp: 1,
  } as ChatMessage;
}

beforeEach(() => resetApprovalManager());

describe('InlineDemoApprovalCard', () => {
  it('renders nothing for a non-demo approval message', () => {
    render(<InlineDemoApprovalCard message={cardMessage({ kind: 'ask_approval' })} />);
    expect(screen.queryByTestId(`demo-approval-approve-${APPROVAL_ID}`)).toBeNull();
  });

  it('renders Approve/Deny and APPROVES via the ApprovalManager', () => {
    seedRequest();
    render(
      <InlineDemoApprovalCard
        message={cardMessage({ kind: 'demo_approval', approvalId: APPROVAL_ID, persona: 'health' })}
      />,
    );
    expect(screen.getByTestId(`demo-approval-approve-${APPROVAL_ID}`)).toBeTruthy();
    fireEvent.press(screen.getByTestId(`demo-approval-approve-${APPROVAL_ID}`));
    expect(getApprovalManager().getRequest(APPROVAL_ID)?.status).toBe('approved');
    expect(screen.getByText('Approved.')).toBeTruthy();
    // Buttons gone once resolved.
    expect(screen.queryByTestId(`demo-approval-approve-${APPROVAL_ID}`)).toBeNull();
  });

  it('DENIES via the ApprovalManager', () => {
    seedRequest();
    render(
      <InlineDemoApprovalCard
        message={cardMessage({ kind: 'demo_approval', approvalId: APPROVAL_ID, persona: 'health' })}
      />,
    );
    fireEvent.press(screen.getByTestId(`demo-approval-deny-${APPROVAL_ID}`));
    expect(getApprovalManager().getRequest(APPROVAL_ID)?.status).toBe('denied');
    expect(screen.getByText('Denied.')).toBeTruthy();
  });

  it('reflects a request already resolved elsewhere (teardown deny) on mount', () => {
    seedRequest();
    getApprovalManager().denyRequest(APPROVAL_ID);
    render(
      <InlineDemoApprovalCard
        message={cardMessage({ kind: 'demo_approval', approvalId: APPROVAL_ID })}
      />,
    );
    // No buttons — it initialises from the live (denied) status.
    expect(screen.queryByTestId(`demo-approval-deny-${APPROVAL_ID}`)).toBeNull();
    expect(screen.getByText('Denied.')).toBeTruthy();
  });
});
