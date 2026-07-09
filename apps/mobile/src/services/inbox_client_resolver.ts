/**
 * Inbox Core-client resolver — NATIVE / default.
 *
 * On mobile the app runs Core in-process, so the in-process client already
 * backs the approval inbox — return it unchanged. The web variant
 * (`inbox_client_resolver.web.ts`) overrides this to back the inbox with an
 * HTTP client to the brain's `/api/v1/workflow/tasks` proxy, because in the
 * web thin-client the in-process Core store is empty (F4).
 */

import type { InboxCoreClient } from '../hooks/useServiceInbox';

export function resolveInboxCoreClient(inProcess: InboxCoreClient): InboxCoreClient {
  return inProcess;
}
