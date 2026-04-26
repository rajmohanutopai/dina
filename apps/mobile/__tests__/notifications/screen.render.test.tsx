/**
 * Notifications screen render test (5.67 / 5.70 layer 4).
 *
 * Uses `@testing-library/react-native` against the lightweight RN
 * mock in `__mocks__/react-native.ts`. Mocks `expo-router`'s
 * `useRouter` so we can assert deep-link routing without spinning up
 * a real router.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import NotificationsScreen from '../../app/notifications';
import {
  appendNotification,
  resetNotifications,
} from '../../../../packages/brain/src/notifications/inbox';

const pushed: string[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (path: string): void => void pushed.push(path) }),
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

  it('shows "N unread" header chip when there are unread items', () => {
    appendNotification({ kind: 'reminder', title: 'unread', body: '', sourceId: '1' });
    const { getByText } = render(<NotificationsScreen />);
    expect(getByText(/1 unread/)).toBeTruthy();
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
    expect(pushed).toEqual(['dina://approvals/appr-1']);
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

  it('Approvals filter shows BOTH approval and ask_approval kinds', () => {
    appendNotification({ kind: 'approval', title: 'service-app', body: '', sourceId: '1' });
    appendNotification({ kind: 'ask_approval', title: 'ask-app', body: '', sourceId: '2' });
    appendNotification({ kind: 'nudge', title: 'should-hide', body: '', sourceId: '3' });
    const { getByTestId, queryByText } = render(<NotificationsScreen />);
    fireEvent.press(getByTestId('filter-approval'));
    expect(queryByText('service-app')).toBeTruthy();
    expect(queryByText('ask-app')).toBeTruthy();
    expect(queryByText('should-hide')).toBeNull();
  });
});
