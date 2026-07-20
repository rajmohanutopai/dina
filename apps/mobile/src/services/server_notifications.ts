/**
 * Server-notification installer — NATIVE stub (R4-03).
 *
 * On mobile the notification inbox is backed directly by the in-process SQLite
 * log (wired in `storage/init.ts`), so there is nothing to install from a
 * server. The web build overrides this with `server_notifications.web.ts`, which
 * wires a `/api/v1/notifications`-backed repository + SSE so the browser SPA
 * sees the split server's durable inbox.
 */

/** No-op on native. Returns a disposer for call-site symmetry. */
export function installServerNotifications(): () => void {
  return () => {
    /* nothing to tear down on native */
  };
}
