/**
 * Notifications screen render test (5.67 / 5.70 layer 4).
 *
 * Uses `@testing-library/react-native` against the lightweight RN
 * mock in `__mocks__/react-native.ts`. Mocks `expo-router`'s
 * `useRouter` so we can assert deep-link routing without spinning up
 * a real router.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import {
  appendNotification,
  resetNotifications,
} from '../../../../packages/brain/src/notifications/inbox';
import NotificationsScreen from '../../app/notifications';

const pushed: string[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (path: string): void => void pushed.push(path) }),
  useLocalSearchParams: () => ({}),
}));

// The approval inbox (merged into Activity) reads workflow tasks through
// `useServiceInbox`. This render test only exercises the notification-row
// surface + filter chips, so stub the inbox reads to empty/resolved so the
// hook settles deterministically (no unconfigured-client error churn).
jest.mock('../../src/hooks/useServiceInbox', () => ({
  ...jest.requireActual('../../src/hooks/useServiceInbox'),
  listPendingApprovals: jest.fn(async () => []),
  listResolvedApprovals: jest.fn(async () => []),
}));

// `storage/init` touches native side effects (op-sqlite / expo-file-system)
// via the approval card's staging-approve branch; stub to no-ops.
jest.mock('../../src/storage/init', () => ({
  openPersonaDB: jest.fn(),
  isPersistenceReady: (): boolean => true,
}));

beforeEach(() => {
  pushed.length = 0;
  resetNotifications();
});

describe('Notifications screen — render (5.67)', () => {
  it('shows empty state when inbox is empty', () => {
    const { getByText } = render(<NotificationsScreen />);
    expect(getByText(/No notifications/i)).toBeTruthy();
  });

  it('renders one row per kind with the right testID', () => {
    appendNotification({ kind: 'reminder', title: 'A', body: 'a', sourceId: '1' });
    appendNotification({ kind: 'approval', title: 'B', body: 'b', sourceId: '2' });
    appendNotification({ kind: 'nudge', title: 'C', body: 'c', sourceId: '3' });
    appendNotification({ kind: 'briefing', title: 'D', body: 'd', sourceId: '4' });

    const { getAllByTestId } = render(<NotificationsScreen />);
    const rows = getAllByTestId(/^notif-row-/);
    expect(rows).toHaveLength(4);
  });

  it('shows unread count on the Unread filter chip when there are unread items', () => {
    appendNotification({ kind: 'reminder', title: 'unread', body: '', sourceId: '1' });
    const { getByText } = render(<NotificationsScreen />);
    // Redesigned chip layout — "Unread · 1" instead of the old "1 unread" badge.
    expect(getByText(/Unread · 1/)).toBeTruthy();
  });

  it('Unread filter hides read items', () => {
    appendNotification({ id: 'r1', kind: 'reminder', title: 'still-unread', body: '', sourceId: '1' });
    appendNotification({ id: 'r2', kind: 'reminder', title: 'already-read', body: '', sourceId: '2' });

    const { getByTestId, queryByText } = render(<NotificationsScreen />);
    // Mark one read via a tap.
    fireEvent.press(getByTestId('notif-row-r2'));
    // Switch to unread filter.
    fireEvent.press(getByTestId('filter-unread'));

    expect(queryByText('still-unread')).toBeTruthy();
    // already-read should no longer be visible under unread filter.
    expect(queryByText('already-read')).toBeNull();
  });

  it('tapping a row with a deepLink routes via expo-router', () => {
    appendNotification({
      id: 'r1',
      kind: 'approval',
      title: 'Tap me',
      body: '',
      sourceId: 'appr-1',
      deepLink: 'dina://approvals/appr-1',
    });
    const { getByTestId } = render(<NotificationsScreen />);
    fireEvent.press(getByTestId('notif-row-r1'));
    // The screen normalises Brain-emitted `dina://approvals/<id>` deep
    // links to the Activity tab's Needs-action filter (the standalone
    // Approvals screen merged in; actionable cards live under
    // needs_action). See normaliseDeepLink.
    expect(pushed).toEqual(['/notifications?filter=needs_action']);
  });

  it('tapping a row WITHOUT a deepLink stays put but marks it read', () => {
    appendNotification({ id: 'r1', kind: 'nudge', title: 'no-link', body: '', sourceId: '1' });
    const { getByTestId, queryByText } = render(<NotificationsScreen />);
    fireEvent.press(getByTestId('notif-row-r1'));
    expect(pushed).toEqual([]);
    // Switching to unread filter should show "All caught up." (zero unread).
    fireEvent.press(getByTestId('filter-unread'));
    expect(queryByText(/All caught up/i)).toBeTruthy();
  });

  it('Reminders filter shows only reminder-kind items', () => {
    appendNotification({ kind: 'reminder', title: 'rem', body: '', sourceId: '1' });
    appendNotification({ kind: 'approval', title: 'app', body: '', sourceId: '2' });
    const { getByTestId, queryByText } = render(<NotificationsScreen />);
    fireEvent.press(getByTestId('filter-reminder'));
    expect(queryByText('rem')).toBeTruthy();
    expect(queryByText('app')).toBeNull();
  });

  it('Needs action filter renders the actionable approval inbox, not notification rows', () => {
    // The Approvals screen merged into Activity: "Needs action" now renders
    // the ACTIONABLE pending-approval cards (Deny / Approve Once / Approve)
    // from `useApprovalInbox`, NOT plain notification rows. With no Core
    // client wired in this render test the pending list is empty, so the
    // approval empty-state shows and none of the appended approval-kind
    // *notification* rows leak through this filter. (The actionable-card
    // rendering + action wiring is covered in
    // __tests__/components/approval_inbox.test.tsx.)
    appendNotification({ kind: 'approval', title: 'service-app', body: '', sourceId: '1' });
    appendNotification({ kind: 'ask_approval', title: 'ask-app', body: '', sourceId: '2' });
    appendNotification({ kind: 'nudge', title: 'should-hide', body: '', sourceId: '3' });
    const { getByTestId, queryByText } = render(<NotificationsScreen />);
    fireEvent.press(getByTestId('filter-needs_action'));
    // Notification rows are not the Needs-action surface anymore.
    expect(queryByText('service-app')).toBeNull();
    expect(queryByText('ask-app')).toBeNull();
    expect(queryByText('should-hide')).toBeNull();
    // The approval empty-state copy is shown instead.
    expect(queryByText(/All caught up/i)).toBeTruthy();
  });
});
