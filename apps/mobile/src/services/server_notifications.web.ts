/**
 * Server-notification installer — WEB (R4-03).
 *
 * The `/web` SPA runs Brain's inbox in the browser, but the durable notification
 * log lives on the split server (Core's identity.sqlite). This wires a
 * repository that proxies to `/api/v1/notifications` so:
 *   - `hydrateNotifications()` loads the server's durable inbox on boot;
 *   - marking a notification read persists to the server;
 *   - an SSE subscription folds newly-appended server notifications into the
 *     browser inbox live (the Activity badge updates without polling).
 *
 * The browser never ORIGINATES notifications (watch/push results arrive at the
 * server), so `append`/`purge`/`reset` are no-ops here — the server is the
 * source of truth. That also stops an SSE-delivered item from being echoed back
 * to the server.
 */

import {
  appendNotification,
  hydrateNotifications,
  mergeNotifications,
} from '@dina/brain/notifications';
import {
  setNotificationLogRepository,
  wireToStoredNotification,
  type NotificationLogRepository,
  type StoredNotificationItem,
} from '@dina/core';

class WebNotificationLogRepository implements NotificationLogRepository {
  async append(): Promise<void> {
    // Server is the source of truth; the browser never originates notifications.
  }

  async markRead(id: string): Promise<boolean> {
    try {
      const res = await fetch('/api/v1/notifications/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { changed?: boolean };
      return Boolean(body.changed);
    } catch {
      return false;
    }
  }

  async listAll(limit?: number): Promise<StoredNotificationItem[]> {
    try {
      const url = limit !== undefined ? `/api/v1/notifications?limit=${limit}` : '/api/v1/notifications';
      const res = await fetch(url);
      if (!res.ok) return [];
      // R5-08 — the server returns snake_case wire rows.
      const body = (await res.json()) as { notifications?: unknown[] };
      if (!Array.isArray(body.notifications)) return [];
      return body.notifications
        .map((r) => wireToStoredNotification(r))
        .filter((r): r is StoredNotificationItem => r !== null);
    } catch {
      return [];
    }
  }

  async purgeBefore(): Promise<number> {
    return 0;
  }

  async purgeByScopePrefix(): Promise<number> {
    return 0;
  }

  async reset(): Promise<void> {
    // Server owns retention + identity reset.
  }
}

function foldAppended(ev: MessageEvent): void {
  try {
    // R5-08 — SSE frames carry the snake_case wire DTO.
    const stored = wireToStoredNotification(JSON.parse(ev.data));
    if (stored === null) return;
    appendNotification({
      kind: stored.kind,
      title: stored.title,
      body: stored.body,
      id: stored.id,
      sourceId: stored.sourceId !== '' ? stored.sourceId : stored.id,
      ...(stored.deepLink !== null ? { deepLink: stored.deepLink } : {}),
      ...(stored.expiresAt !== null ? { expiresAt: stored.expiresAt } : {}),
    });
  } catch {
    /* ignore a malformed frame */
  }
}

/** Wire the server-backed notification repository, hydrate the browser inbox from
 *  the server, and subscribe to the SSE stream for live updates. Returns a
 *  disposer that closes the stream. */
export function installServerNotifications(): () => void {
  const repo = new WebNotificationLogRepository();
  setNotificationLogRepository(repo);

  let source: EventSource | null = null;
  let disposed = false;

  // R5-09 — hydrate the durable snapshot FIRST, THEN subscribe. Opening the
  // stream before the initial GET completes lets an SSE frame race the hydrate
  // and be clobbered by it. `force:true` re-reads the full server list (the
  // authoritative snapshot), so nothing is lost.
  void (async () => {
    try {
      await hydrateNotifications({ force: true });
    } catch {
      /* offline — SSE + reconnect reconciliation below still catch up */
    }
    if (disposed) return;
    try {
      source = new EventSource('/api/v1/notifications/stream');
      source.addEventListener('appended', foldAppended);
      // R5-09 — reconcile from the durable snapshot on every (re)connect. The
      // stream carries only FUTURE frames, so an item created during a
      // disconnect would otherwise be missed until a manual reload. MERGE (not
      // force-replace): a wholesale replace could clobber a frame folded while
      // the snapshot fetch was in flight, and merging preserves readAt.
      source.addEventListener('open', () => {
        void (async () => {
          try {
            mergeNotifications(await repo.listAll());
          } catch {
            /* offline blip — the next reconnect reconciles */
          }
        })();
      });
    } catch {
      /* EventSource unavailable — the initial hydrate still delivered the backlog */
    }
  })();

  return () => {
    disposed = true;
    source?.close();
    source = null;
  };
}
