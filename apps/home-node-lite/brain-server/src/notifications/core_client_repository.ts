/**
 * `CoreClientNotificationLogRepository` (R4-03) — the split-server backing for
 * Brain's notification inbox.
 *
 * Brain never touches SQLite, so on the split server the inbox dual-writes
 * THROUGH Core's `/v1/notifications` routes (signed HTTP) into identity.sqlite.
 * This adapts the `NotificationLogRepository` interface the inbox expects onto
 * the `CoreClient` notification methods.
 *
 * `purgeByScopePrefix` is a local no-op: the guided demo (the only producer of
 * `guided_demo:` scoped notifications) runs solely on the mobile in-memory store
 * — the split server never creates demo-scoped rows, so there is nothing to
 * purge and no Core route for it.
 */

import type {
  CoreClient,
  NotificationLogRepository,
  StoredNotificationItem,
} from '@dina/core';

export class CoreClientNotificationLogRepository implements NotificationLogRepository {
  constructor(private readonly core: CoreClient) {}

  async append(item: StoredNotificationItem): Promise<void> {
    await this.core.notificationAppend(item);
  }

  async markRead(id: string, readAt: number): Promise<boolean> {
    return this.core.notificationMarkRead(id, readAt);
  }

  async listAll(limit?: number): Promise<StoredNotificationItem[]> {
    return this.core.notificationList(limit);
  }

  async purgeBefore(cutoff: number): Promise<number> {
    return this.core.notificationPurgeBefore(cutoff);
  }

  async purgeByScopePrefix(_prefix: string): Promise<number> {
    // The split server never creates guided-demo-scoped notifications.
    return 0;
  }

  async reset(): Promise<void> {
    await this.core.notificationReset();
  }
}
