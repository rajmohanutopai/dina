/**
 * Notifications-screen filter (task 5.67 / 5.70 layer 4).
 */

import { applyNotificationFilter } from '../../src/notifications/screen_filter';
import type { NotificationItem } from '@dina/brain/src/notifications/inbox';

function mk(
  partial: Partial<NotificationItem> & Pick<NotificationItem, 'id' | 'kind'>,
): NotificationItem {
  return {
    title: '',
    body: '',
    firedAt: 0,
    readAt: null,
    sourceId: '',
    ...partial,
  } as NotificationItem;
}

describe('applyNotificationFilter (5.67)', () => {
  const items: NotificationItem[] = [
    mk({ id: 'r1', kind: 'reminder' }),
    mk({ id: 'r2', kind: 'reminder', readAt: 1 }),
    mk({ id: 'a1', kind: 'approval' }),
    mk({ id: 'aa1', kind: 'ask_approval' }),
    mk({ id: 'n1', kind: 'nudge' }),
    mk({ id: 'b1', kind: 'briefing', readAt: 2 }),
  ];

  it('"all" returns every item', () => {
    expect(applyNotificationFilter(items, 'all')).toHaveLength(items.length);
  });

  it('"unread" returns only items where readAt === null', () => {
    expect(applyNotificationFilter(items, 'unread').map((i) => i.id).sort()).toEqual(
      ['a1', 'aa1', 'n1', 'r1'].sort(),
    );
  });

  it('"reminder" returns only reminder-kind items (read or unread)', () => {
    expect(applyNotificationFilter(items, 'reminder').map((i) => i.id).sort()).toEqual(
      ['r1', 'r2'].sort(),
    );
  });

  it('"approval" includes BOTH approval and ask_approval kinds', () => {
    expect(applyNotificationFilter(items, 'approval').map((i) => i.id).sort()).toEqual(
      ['a1', 'aa1'].sort(),
    );
  });

  it('preserves input order', () => {
    const ordered = items.slice(); // already in deterministic order
    expect(applyNotificationFilter(ordered, 'all')).toEqual(ordered);
  });
});
