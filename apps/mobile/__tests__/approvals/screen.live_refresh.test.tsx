/**
 * Approvals screen — live refresh on inbox events (R-M6-I2).
 *
 * Before the fix, the screen only fetched on `useFocusEffect` (tab
 * change) + pull-to-refresh. A `dina validate` minted on the agent
 * surface created the workflow task (and bumped the tab-bar badge via
 * `useUnreadCount('approval')`), but the visible list stayed at the
 * snapshot taken on the last focus — the user had to tab-cycle to see
 * the new card.
 *
 * The fix subscribes the screen to the same `subscribeNotifications`
 * event the badge uses; an `'appended'` event whose `item.kind ===
 * 'approval'` triggers a coalesced re-fetch. This test pins:
 *
 *   1. Fresh focus runs one `listPendingApprovals` (baseline).
 *   2. A subsequent `appendNotification({kind:'approval'})` triggers a
 *      second fetch (the live-refresh path).
 *   3. A non-approval append (`kind:'reminder'`) does NOT trigger a
 *      refetch (filter).
 *   4. Two events back-to-back coalesce to ONE in-flight refetch (the
 *      `reloadInFlight` ref).
 */

import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';

import {
  appendNotification,
  resetNotifications,
} from '../../../../packages/brain/src/notifications/inbox';
import ApprovalsScreen from '../../app/approvals';
import {
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
} from '../../src/hooks/useServiceInbox';

import type { WorkflowTask } from '@dina/core';

const CALLS_PER_SCREEN_LOAD = 7; // pending + six resolved-history states

// Routes the screen uses for the menu / confirm flows.
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(() => {
      cb();
    }, []);
  },
}));

// The storage init module touches native side effects (op-sqlite); stub
// to a no-op so the render doesn't try to open a real DB.
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));

function task(id: string, createdAt: number, payloadType = 'intent_validation'): WorkflowTask {
  return {
    id,
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description: `intent ${id}`,
    payload: JSON.stringify({
      type: payloadType,
      action: 'send_email',
      target: 'HR',
      agent_did: 'did:key:zAgentTest',
      risk_level: 'MODERATE',
    }),
    result_summary: '',
    policy: '',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function stubClient(initial: WorkflowTask[]): {
  client: InboxCoreClient;
  setList: (next: WorkflowTask[]) => void;
  listCalls: { value: number };
} {
  let current = initial;
  const listCalls = { value: 0 };
  const client: InboxCoreClient = {
    async listWorkflowTasks() {
      listCalls.value++;
      return current;
    },
    approveWorkflowTask: jest.fn(),
    cancelWorkflowTask: jest.fn(),
    getWorkflowTask: jest.fn(),
    sendServiceRespond: jest.fn(),
  };
  return {
    client,
    setList: (next) => {
      current = next;
    },
    listCalls,
  };
}

beforeEach(() => {
  resetInboxCoreClient();
  resetNotifications();
});

describe('Approvals screen — live refresh on appendNotification (R-M6-I2)', () => {
  it('initial focus fetches the list once', async () => {
    const { client, listCalls } = stubClient([task('t-1', 1_000)]);
    setInboxCoreClient(client);
    render(<ApprovalsScreen />);
    await waitFor(() => expect(listCalls.value).toBe(CALLS_PER_SCREEN_LOAD));
  });

  it('refetches when an approval-kind notification is appended', async () => {
    const stub = stubClient([task('t-1', 1_000)]);
    setInboxCoreClient(stub.client);
    render(<ApprovalsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_SCREEN_LOAD));

    // Simulate an agent's `dina validate` minting a new approval card,
    // which fires `appendNotification({kind:'approval', ...})` via the
    // workflow→inbox bridge installed in bootstrap.ts.
    stub.setList([task('t-1', 1_000), task('t-2', 2_000)]);
    await act(async () => {
      appendNotification({
        kind: 'approval',
        title: 'Agent action approval',
        body: 'transfer_money',
        sourceId: 't-2',
      });
    });

    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_SCREEN_LOAD * 2));
  });

  it('does NOT refetch when a non-approval kind is appended', async () => {
    const stub = stubClient([]);
    setInboxCoreClient(stub.client);
    render(<ApprovalsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_SCREEN_LOAD));

    await act(async () => {
      appendNotification({
        kind: 'reminder',
        title: 'Take meds',
        body: '',
        sourceId: 'rm-1',
      });
      appendNotification({
        kind: 'nudge',
        title: 'Briefing ready',
        body: '',
        sourceId: 'nd-1',
      });
    });

    // No additional fetches — kinds were filtered out.
    expect(stub.listCalls.value).toBe(CALLS_PER_SCREEN_LOAD);
  });

  it('coalesces overlapping events while a refetch is in flight', async () => {
    // Make the list call slow so we can fire two events into the
    // middle of one in-flight fetch and assert only one extra call lands.
    let release: (() => void) | null = null;
    const slowFetch = new Promise<void>((r) => {
      release = r;
    });
    let listCalls = 0;
    const client: InboxCoreClient = {
      async listWorkflowTasks() {
        listCalls++;
        if (listCalls <= CALLS_PER_SCREEN_LOAD) return [];
        await slowFetch; // notification-triggered reload blocks until released
        return [];
      },
      approveWorkflowTask: jest.fn(),
      cancelWorkflowTask: jest.fn(),
      getWorkflowTask: jest.fn(),
      sendServiceRespond: jest.fn(),
    };
    setInboxCoreClient(client);
    render(<ApprovalsScreen />);
    await waitFor(() => expect(listCalls).toBe(CALLS_PER_SCREEN_LOAD));

    // First event → second screen load starts but blocks on slowFetch.
    await act(async () => {
      appendNotification({ kind: 'approval', title: 'a', body: '', sourceId: 's1' });
    });
    // Two more events while the fetch is still in flight — these MUST
    // coalesce (the `reloadInFlight` ref short-circuits them).
    await act(async () => {
      appendNotification({ kind: 'approval', title: 'b', body: '', sourceId: 's2' });
      appendNotification({ kind: 'approval', title: 'c', body: '', sourceId: 's3' });
    });

    // Release the in-flight fetch.
    await act(async () => {
      release?.();
    });

    // Two total screen loads: initial focus + one coalesced refetch.
    // (Without the ref guard this would be four full loads.)
    await waitFor(() => expect(listCalls).toBe(CALLS_PER_SCREEN_LOAD * 2));
  });
});
