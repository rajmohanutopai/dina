/**
 * Producer bridges for the unified notifications inbox (task 5.66).
 *
 * Each bridge subscribes to a producer (ApprovalManager, BriefingHistoryStore,
 * etc.) and fans events into `appendNotification`. Mobile boot calls
 * the relevant `installXxxBridge(...)` once at startup; the returned
 * disposer detaches the listener (used by tests + on log-out).
 *
 * **Why a separate bridges module rather than wiring inline at each
 * call site?** Two reasons:
 *   1. The four producers live in three different packages
 *      (`@dina/core`, `@dina/brain`, `apps/mobile`) — keeping the
 *      mappings here gives one file to read when you ask "what shows
 *      up in the inbox?".
 *   2. Easier to test — each bridge maps one event shape to one
 *      `appendNotification` call; a unit test pins the mapping
 *      without booting the full pipeline.
 *
 * **What this module does NOT do**: subscribe to the reminder service
 * or the mobile-side `useChatNudges` hook. Those producers are at the
 * UI edge already (the chat tab post-to-thread point) and call
 * `appendNotification` directly — wrapping them here would mean an
 * extra layer of indirection for no testability gain.
 */

import type { ApprovalManager, ApprovalRequest } from '../../../core/src/approval/manager';
import { appendNotification } from './inbox';

/**
 * Subscribe an inbox bridge to an ApprovalManager. Every
 * `requestApproval` call posts a `'approval'`-kind notification.
 *
 * The notification carries:
 *   - `id`: same as the approval id (idempotent — re-installing the
 *     bridge after a crash won't duplicate inbox entries for the same
 *     pending approval).
 *   - `title`: the action being requested (e.g. `"vault_search"`).
 *   - `body`: the human-readable reason from the request.
 *   - `sourceId`: the approval id (so the screen can deep-link back).
 *   - `deepLink`: `dina://approvals/<id>` — the Approvals tab handles
 *     this scheme. Resolution is the deep-link layer's responsibility
 *     (5.68); this bridge just shapes the URL.
 *
 * Returns a disposer that detaches the listener.
 */
export function installApprovalInboxBridge(approvalManager: ApprovalManager): () => void {
  return approvalManager.subscribeRequests((req: ApprovalRequest) => {
    const title = req.action !== '' ? req.action : 'Approval requested';
    const body =
      req.reason !== ''
        ? req.reason
        : req.preview !== ''
          ? req.preview
          : `Approval requested for ${title}`;
    appendNotification({
      id: req.id,
      kind: 'approval',
      title,
      body,
      sourceId: req.id,
      deepLink: `dina://approvals/${req.id}`,
      now: req.created_at !== 0 ? req.created_at : undefined,
    });
  });
}

/**
 * Type-erased shape of `BriefingHistoryStore.onEvent` events that we
 * need. Declared inline so this module doesn't depend on the
 * apps/home-node-lite package layout.
 */
interface BriefingRecordedEvent {
  kind: 'recorded';
  entry: {
    id: string;
    persona: string;
    sentAtMs: number;
    itemCount: number;
    headline?: string;
  };
}

interface BriefingHistoryEventLike {
  kind: string;
  entry?: BriefingRecordedEvent['entry'];
}

/**
 * Plug a listener into a BriefingHistoryStore via its `onEvent`
 * constructor option. The store doesn't expose a runtime subscribe
 * method, so wiring is constructor-time.
 *
 * Usage at boot:
 *   ```ts
 *   const briefingStore = new BriefingHistoryStore({
 *     adapter,
 *     onEvent: subscribeBriefingEvents(),  // forwards 'recorded' to inbox
 *   });
 *   ```
 *
 * Returns the listener function the caller passes to
 * `BriefingHistoryStore({ onEvent })`.
 */
export function subscribeBriefingEvents(): (event: BriefingHistoryEventLike) => void {
  return (event) => {
    if (event.kind !== 'recorded' || !event.entry) return;
    const entry = event.entry;
    const titleParts: string[] = [];
    if (entry.headline !== undefined && entry.headline !== '') titleParts.push(entry.headline);
    else titleParts.push('Daily briefing');
    const title = titleParts.join(' — ');
    const itemWord = entry.itemCount === 1 ? 'item' : 'items';
    appendNotification({
      id: entry.id,
      kind: 'briefing',
      title,
      body: `${entry.itemCount} ${itemWord} for /${entry.persona}`,
      sourceId: entry.id,
      deepLink: `dina://briefings/${entry.id}`,
      now: Number.isFinite(entry.sentAtMs) ? entry.sentAtMs : undefined,
    });
  };
}
