/**
 * The approval inbox on a surface that decides through Brain (the web page).
 *
 * A household disclosure review (GROUP_COORDINATION §6) is the owner's to
 * release; Core refuses a Brain caller. On the web the card therefore says
 * where to decide instead of offering Approve/Deny that cannot land — the
 * same posture as the plan card's decisions. Every other kind keeps its
 * buttons: those decisions do land through Brain.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { resetNotifications } from '../../../../packages/brain/src/notifications/inbox';
import NotificationsScreen from '../../app/notifications';
import { resetInboxCoreClient, setInboxCoreClient, type InboxCoreClient } from '../../src/hooks/useServiceInbox';

import type { WorkflowTask } from '@dina/core';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));
// The web peer of the resolver: decisions travel through Brain, never as the owner.
jest.mock('../../src/services/inbox_client_resolver', () => ({
  ...jest.requireActual('../../src/services/inbox_client_resolver'),
  OWNER_DECIDES_ON_THIS_SURFACE: false,
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

const REVIEW = task(
  'disclosure-review-exec-1',
  {
    type: 'disclosure_review',
    execution_task_id: 'exec-1',
    context: { taskId: 'exec-1', fromDID: 'did:plc:mike', queryId: 'q-1', capability: 'availability_coordination', ttlSeconds: 120, serviceName: '' },
    disclosures: [{ kind: 'dietary', text: 'someone in the household is gluten-free', about: 'household' }],
  },
  'Tell Mike about a household dietary need?',
);
const INTENT = task(
  'intent-1',
  { type: 'intent_validation', action: 'send_email', target: 'HR', agent_did: 'did:key:zAgentTest', risk_level: 'MODERATE' },
  'intent intent-1',
);

function stubClient(pending: WorkflowTask[]): { client: InboxCoreClient; listCalls: { value: number } } {
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

describe('approval inbox on the web page (decides through Brain)', () => {
  it('a disclosure review shows what would leave and where to decide — no Approve, no Deny; other kinds keep their buttons', async () => {
    const stub = stubClient([REVIEW, INTENT]);
    setInboxCoreClient(stub.client);
    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    await waitFor(() => expect(screen.getByTestId('approvals-owner-surface-disclosure-review-exec-1')).toBeTruthy());
    expect(screen.getByText('Share a household need?')).toBeTruthy();
    expect(screen.getByText('dietary: someone in the household is gluten-free')).toBeTruthy();
    expect(screen.getByTestId('approvals-owner-surface-disclosure-review-exec-1').props.children).toBe(
      "Approve or deny from your phone or Core's owner console.",
    );
    expect(screen.queryByTestId('approvals-approve-disclosure-review-exec-1')).toBeNull();
    expect(screen.queryByTestId('approvals-deny-disclosure-review-exec-1')).toBeNull();
    // An ordinary approval still decides from here.
    expect(screen.getByTestId('approvals-approve-intent-1')).toBeTruthy();
    expect(screen.getByTestId('approvals-deny-intent-1')).toBeTruthy();
  });
});
