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

/**
 * Whether a decision made on this surface reaches Core AS THE OWNER. On the
 * phone the in-process transport is the owner's own, so every approval kind
 * can be decided here. The web peer answers false: its decisions travel
 * through Brain, and Core refuses a Brain caller the kinds only the owner may
 * settle (a household disclosure, an agent-raised task, a plugin invocation).
 */
export const OWNER_DECIDES_ON_THIS_SURFACE = true;
