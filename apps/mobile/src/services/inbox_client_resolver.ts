/**
 * Inbox Core-client resolver — NATIVE / default.
 *
 * On mobile the app runs Core in-process, so the in-process client already
 * backs the approval inbox — return it unchanged. The web variant
 * (`inbox_client_resolver.web.ts`) backs it with the Home Node's Core,
 * reached as the owner through this browser's owner device.
 */

import type { InboxCoreClient } from '../hooks/useServiceInbox';

export function resolveInboxCoreClient(inProcess: InboxCoreClient): InboxCoreClient {
  return inProcess;
}

/**
 * Whether a decision made on this surface reaches Core AS THE OWNER. On the
 * phone the in-process transport is the owner's own, so every approval kind
 * can be decided here. The web peer is true as well: it decides as the owner
 * device. A surface that decided through Brain would be false, because Core
 * refuses Brain the kinds only the owner may settle (a household disclosure,
 * an agent-raised task, a plugin invocation).
 */
export const OWNER_DECIDES_ON_THIS_SURFACE = true;
