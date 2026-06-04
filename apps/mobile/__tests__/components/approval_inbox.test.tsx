/**
 * Approval inbox — shared hook + actionable cards, rendered INLINE in the
 * Activity tab.
 *
 * The standalone Approvals screen merged into Activity
 * (`app/notifications.tsx`): the "Needs action" filter renders the
 * ACTIONABLE pending-approval cards (Deny / Approve Once / Approve right
 * there), and "All" shows the read-only resolved cards alongside
 * notifications. This suite pins the behaviours that moved out of the old
 * standalone screen + its live-refresh test:
 *
 *   1. Needs-action renders the actionable cards (correct testIDs).
 *   2. Approve / Approve-Once fire the right hook calls (scope semantics).
 *   3. Deny fires the deny hook (through the confirm dialog).
 *   4. Live-refresh: an `appended` approval event re-fetches; a
 *      non-approval append does NOT; back-to-back events coalesce.
 *   5. Resolved cards render under the "All" filter.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

import {
  appendNotification,
  resetNotifications,
} from '../../../../packages/brain/src/notifications/inbox';
import NotificationsScreen from '../../app/notifications';
import {
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
} from '../../src/hooks/useServiceInbox';

import type { WorkflowTask } from '@dina/core';

// Activity uses `useRouter` (notification-row taps) + `useLocalSearchParams`
// (the `?filter=` deep-link tab); stub both so rendering doesn't crash.
const pushed: string[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (path: string): void => void pushed.push(path) }),
  useLocalSearchParams: () => ({}),
}));

// `storage/init` touches native side effects (op-sqlite); stub to no-ops so
// the staging-approve branch doesn't try to open a real DB.
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));

// pending + six resolved-history states = 7 listWorkflowTasks calls per load.
const CALLS_PER_LOAD = 7;

function pendingTask(
  id: string,
  createdAt: number,
  overrides: Partial<{ payloadType: string; riskLevel: string }> = {},
): WorkflowTask {
  const { payloadType = 'intent_validation', riskLevel = 'MODERATE' } = overrides;
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
      risk_level: riskLevel,
    }),
    result_summary: '',
    policy: '',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function resolvedTask(id: string, updatedAt: number): WorkflowTask {
  return {
    id,
    kind: 'approval',
    status: 'completed',
    priority: 'normal',
    description: `intent ${id}`,
    payload: JSON.stringify({
      type: 'intent_validation',
      action: 'send_email',
      target: 'HR',
      agent_did: 'did:key:zAgentTest',
      risk_level: 'MODERATE',
    }),
    result_summary: '',
    policy: '',
    created_at: updatedAt - 10,
    updated_at: updatedAt,
  };
}

/**
 * Stub Core client. `listWorkflowTasks` returns `pending` for the
 * pending-state query and `resolved` for `state==='completed'` (one of the
 * six resolved-history states); every other resolved state returns [].
 */
function stubClient(opts: {
  pending?: WorkflowTask[];
  resolvedCompleted?: WorkflowTask[];
}): {
  client: InboxCoreClient;
  setPending: (next: WorkflowTask[]) => void;
  listCalls: { value: number };
  approve: jest.Mock;
  cancel: jest.Mock;
} {
  let pending = opts.pending ?? [];
  const resolvedCompleted = opts.resolvedCompleted ?? [];
  const listCalls = { value: 0 };
  const approve = jest.fn(async () => pending[0] ?? resolvedCompleted[0]);
  const cancel = jest.fn(async () => pending[0] ?? resolvedCompleted[0]);
  const client: InboxCoreClient = {
    async listWorkflowTasks(query) {
      listCalls.value++;
      if (query?.state === 'pending_approval') return pending;
      if (query?.state === 'completed') return resolvedCompleted;
      return [];
    },
    approveWorkflowTask: approve,
    cancelWorkflowTask: cancel,
    getWorkflowTask: jest.fn(async () => null),
    sendServiceRespond: jest.fn(),
  };
  return {
    client,
    setPending: (next) => {
      pending = next;
    },
    listCalls,
    approve,
    cancel,
  };
}

beforeEach(() => {
  pushed.length = 0;
  resetInboxCoreClient();
  resetNotifications();
});

describe('Approval inbox inline in Activity — fail-soft when not ready', () => {
  it('does NOT blanket Activity with an error banner when the inbox client is unavailable', async () => {
    // No inbox client wired (beforeEach reset it) → listPendingApprovals
    // throws InboxNotConfiguredError. Regression: the merged Activity tab
    // used to render a screen-wide "Couldn't load approvals" banner in that
    // case, blocking notifications/reminders. It must now degrade soft.
    appendNotification({
      id: 'n-soft-1',
      kind: 'reminder',
      title: 'Dentist appointment',
      body: 'Tomorrow 9am',
    });

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(screen.getByTestId('filter-unread')).toBeTruthy());

    // No blocking error banner on the default (Unread) view…
    expect(screen.queryByText(/load approvals/i)).toBeNull();
    // …and the notification still renders (Activity isn't broken).
    expect(screen.getByText('Dentist appointment')).toBeTruthy();

    // Even on the Needs action filter it shows the empty state, not a banner.
    fireEvent.press(screen.getByTestId('filter-needs_action'));
    expect(screen.queryByText(/load approvals/i)).toBeNull();
  });
});

describe('Approval inbox inline in Activity — Needs action', () => {
  it('renders the actionable approval cards (Deny / Approve Once / Approve)', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    expect(screen.getByTestId('approvals-deny-t-1')).toBeTruthy();
    // MODERATE intent supports session scope → the 3-button shape.
    expect(screen.getByTestId('approvals-approve-once-t-1')).toBeTruthy();
    expect(screen.getByTestId('approvals-approve-t-1')).toBeTruthy();
  });

  it('Approve grants session scope; Approve Once grants single', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-approve-t-1'));
    });
    expect(stub.approve).toHaveBeenCalledWith('t-1', { scope: 'session' });

    // Re-add the card (the approve optimistically removed it) and Approve Once.
    stub.setPending([pendingTask('t-2', 2_000)]);
    appendApprovalRefresh();
    await waitFor(() => expect(screen.queryByTestId('approvals-approve-once-t-2')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-approve-once-t-2'));
    });
    expect(stub.approve).toHaveBeenCalledWith('t-2', { scope: 'single' });
  });

  it('Deny routes through the confirm dialog then fires the deny hook', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);

    // Intercept Alert.alert and immediately invoke the destructive
    // "Deny" button's onPress so the deny actually executes.
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const deny = (buttons ?? []).find((b) => b.text === 'Deny');
      void deny?.onPress?.();
    });

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-needs_action'));

    await act(async () => {
      fireEvent.press(screen.getByTestId('approvals-deny-t-1'));
    });
    // intent_validation deny → plain cancel (no service.respond peer).
    expect(stub.cancel).toHaveBeenCalledWith('t-1', 'denied_by_operator');
    alertSpy.mockRestore();
  });
});

describe('Approval inbox inline in Activity — live refresh (R-M6-I2)', () => {
  it('refetches when an approval-kind notification is appended', async () => {
    const stub = stubClient({ pending: [pendingTask('t-1', 1_000)] });
    setInboxCoreClient(stub.client);
    render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));

    stub.setPending([pendingTask('t-1', 1_000), pendingTask('t-2', 2_000)]);
    await act(async () => {
      appendNotification({
        kind: 'approval',
        title: 'Agent action approval',
        body: 'transfer_money',
        sourceId: 't-2',
      });
    });
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD * 2));
  });

  it('does NOT refetch when a non-approval kind is appended', async () => {
    const stub = stubClient({ pending: [] });
    setInboxCoreClient(stub.client);
    render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));

    await act(async () => {
      appendNotification({ kind: 'reminder', title: 'Take meds', body: '', sourceId: 'rm-1' });
      appendNotification({ kind: 'nudge', title: 'Briefing', body: '', sourceId: 'nd-1' });
    });
    expect(stub.listCalls.value).toBe(CALLS_PER_LOAD);
  });

  it('coalesces overlapping events while a refetch is in flight', async () => {
    let release: (() => void) | null = null;
    const slowFetch = new Promise<void>((r) => {
      release = r;
    });
    let listCalls = 0;
    const client: InboxCoreClient = {
      async listWorkflowTasks() {
        listCalls++;
        if (listCalls <= CALLS_PER_LOAD) return [];
        await slowFetch;
        return [];
      },
      approveWorkflowTask: jest.fn(),
      cancelWorkflowTask: jest.fn(),
      getWorkflowTask: jest.fn(),
      sendServiceRespond: jest.fn(),
    };
    setInboxCoreClient(client);
    render(<NotificationsScreen />);
    await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD));

    await act(async () => {
      appendNotification({ kind: 'approval', title: 'a', body: '', sourceId: 's1' });
    });
    await act(async () => {
      appendNotification({ kind: 'approval', title: 'b', body: '', sourceId: 's2' });
      appendNotification({ kind: 'approval', title: 'c', body: '', sourceId: 's3' });
    });
    await act(async () => {
      release?.();
    });
    // initial load + one coalesced refetch (without the ref guard: four loads).
    await waitFor(() => expect(listCalls).toBe(CALLS_PER_LOAD * 2));
  });
});

describe('Approval inbox inline in Activity — All filter shows resolved cards', () => {
  it('renders the read-only resolved card under the All filter', async () => {
    const stub = stubClient({
      pending: [],
      resolvedCompleted: [resolvedTask('done-1', 5_000)],
    });
    setInboxCoreClient(stub.client);

    const screen = render(<NotificationsScreen />);
    await waitFor(() => expect(stub.listCalls.value).toBe(CALLS_PER_LOAD));
    fireEvent.press(screen.getByTestId('filter-all'));

    // Resolved intent card shows the outcome badge + headline. Read-only:
    // no action buttons on a resolved card.
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Agent action approval')).toBeTruthy();
    expect(screen.queryByTestId('approvals-approve-done-1')).toBeNull();
  });
});

/**
 * Fire an approval-kind notification to nudge the inbox live-refresh — used
 * to re-pull the pending list after an optimistic remove in a test.
 */
function appendApprovalRefresh(): void {
  act(() => {
    appendNotification({ kind: 'approval', title: 'refresh', body: '', sourceId: 'refresh' });
  });
}
