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

import { WorkflowTaskState } from '@dina/core';

import { addMessage, getThread } from '../chat/thread';

import { appendNotification } from './inbox';

import type {
  ApprovalManager,
  ApprovalRequest,
  WorkflowRepository,
  WorkflowTask,
} from '@dina/core';

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
 *   - `sourceId`: the approval id (idempotent dedup key for the inbox).
 *   - `deepLink`: `dina://approvals` — opens the Approvals list screen.
 *     The screen shows all pending approvals; no per-item detail route
 *     exists, so the ID is not part of the path.
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
      deepLink: 'dina://approvals',
      now: req.created_at !== 0 ? req.created_at : undefined,
    });
  });
}

/**
 * Subscribe an inbox bridge to a `WorkflowRepository`. Every newly
 * created `kind === 'approval'` workflow task posts an `'approval'`-kind
 * notification — covering the two surfaces that bypass `ApprovalManager`:
 *
 *   - `/v1/agent/validate` (intent_validation): MODERATE/HIGH actions
 *     create a `pending_approval` row directly in `workflow_tasks`.
 *   - `service_handler` review-policy approvals: D2D `service.query`
 *     callers whose responsePolicy is `'review'` land here too.
 *
 * Without this bridge the dedicated `/approvals` screen renders these
 * cards (it queries `workflow_tasks` directly) but the unified
 * Notifications screen's "Approvals" filter shows "No notifications yet"
 * — exactly the gap that surfaced when `dina validate` lit up
 * `/approvals` but not `/notifications`.
 *
 * Notification shape mirrors `installApprovalInboxBridge`:
 *   - `id` / `sourceId`: the task id (idempotent — a re-installed
 *     bridge after a hot reload won't duplicate inbox entries).
 *   - `title`: the task `description` (formatted by the producer:
 *     intent → `"send_email: <target>"`; service.query → `"Service
 *     review: <capability> from <did>"`).
 *   - `body`: empty — the title carries the salient info; payload
 *     details (target, agent_did) live on the `/approvals` screen so
 *     we don't double-render. Brain bridges are deliberately terse.
 *   - `deepLink`: `dina://approvals` — same as the ApprovalManager
 *     bridge; opens the Approvals list screen (no per-item route).
 *   - `expiresAt`: the task's expiry (seconds → ms) — lets the inbox
 *     auto-purge cards whose underlying approval has timed out.
 *
 * Returns a disposer that detaches the listener.
 */
export function installWorkflowApprovalInboxBridge(workflowRepo: WorkflowRepository): () => void {
  return workflowRepo.subscribeApprovalCreated((task: WorkflowTask) => {
    const title = task.description !== '' ? task.description : `Approval requested (${task.id})`;
    appendNotification({
      id: task.id,
      kind: 'approval',
      title,
      body: '',
      sourceId: task.id,
      deepLink: 'dina://approvals',
      // `expires_at` on workflow_tasks is unix seconds; the inbox uses ms.
      expiresAt:
        task.expires_at !== undefined && task.expires_at > 0 ? task.expires_at * 1_000 : undefined,
      // `created_at` is already ms — pass through so reorders by
      // chronology pin the row at the right place.
      now: task.created_at,
    });
  });
}

/**
 * Bridge: workflow approval tasks → chat-thread inline approval bubble.
 *
 * Closes the dina_details §13.4 expectation that an agent's vault-read
 * request lands as an inline "🔐 claw-agent wants to access health
 * [Approve] [Deny]" card in the owner's primary chat surface, not
 * just in the Approvals tab + Notifications inbox. Mirrors the existing
 * `InlineApprovalCard` rendering path the chat-tab bridge already uses
 * for owner-initiated asks — same `MessageType: 'approval'` row, same
 * metadata shape, same Approve/Deny button wiring.
 *
 * Scope: fires for both vault-read approval payloads:
 * `payload.type === 'vault_read_request'` from Brain's persona guard and
 * `payload.type === 'agent_persona_access'` from Core's direct agent vault
 * gate. The intent_validation flow (`dina validate`) already shows up in
 * the Approvals tab and is operator-driven, not chat-driven; surfacing those
 * in chat would clutter the primary thread without adding signal.
 *
 * Defaults: writes to the `'main'` thread (the chat orchestrator's
 * DEFAULT_THREAD constant — keep both in lockstep). Callers can
 * override per-call via the second arg if the boot wiring chooses
 * a different default thread per persona.
 */
export function installWorkflowApprovalChatBridge(
  workflowRepo: WorkflowRepository,
  options: {
    /** Thread id to write inline approval cards to. Default `'main'`. */
    threadId?: string;
  } = {},
): () => void {
  const targetThread = options.threadId ?? 'main';
  const maybePost = (task: WorkflowTask): void => {
    const card = toVaultAccessApprovalCard(task);
    if (card === null) return;
    if (hasApprovalCard(targetThread, task.id)) return;
    addMessage(targetThread, 'approval', card.body, {
      metadata: {
        approvalKind: 'vault_read',
        approvalTaskId: task.id,
        persona: card.persona,
        agentDid: card.agentDid,
        reason: card.reason,
        // `InlineVaultReadApprovalCard` reads these to render the Approve/Deny
        // buttons + the reason, and to drive the same scope dialog the Approvals
        // tab uses (This time only / Allow for this session / Cancel).
      },
      timestamp: task.created_at,
    });
  };

  // Cold-start replay: the repository subscription only sees future
  // creates. If mobile reconnects after an agent already minted a
  // pending approval, replay the still-pending rows into chat so the
  // user is not forced to discover them only in Activity.
  for (const task of workflowRepo.listByKindAndState(
    'approval',
    WorkflowTaskState.PendingApproval,
    100,
  )) {
    maybePost(task);
  }

  return workflowRepo.subscribeApprovalCreated(maybePost);
}

interface VaultAccessApprovalCard {
  persona: string;
  agentDid: string;
  reason: string;
  body: string;
}

function toVaultAccessApprovalCard(task: WorkflowTask): VaultAccessApprovalCard | null {
  // Only render vault/persona access approvals in the chat thread.
  // Intent-validation (dina validate) approvals stay in the Approvals
  // tab; the chat thread shouldn't surface every agent policy decision.
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(task.payload);
    if (parsed !== null && typeof parsed === 'object') {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed payload — skip */
    return null;
  }

  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (payloadType !== 'vault_read_request' && payloadType !== 'agent_persona_access') {
    return null;
  }

  const persona = typeof payload.persona === 'string' ? payload.persona : '';
  const agentDid =
    typeof payload.agent_did === 'string'
      ? payload.agent_did
      : typeof payload.requester_did === 'string'
        ? payload.requester_did
        : '';
  const reason =
    payloadType === 'agent_persona_access' && typeof payload.scope === 'string'
      ? payload.scope.trim()
      : typeof payload.reason === 'string' && payload.reason.trim() !== ''
        ? payload.reason.trim()
        : typeof task.description === 'string'
          ? task.description.trim()
          : '';
  const shortAgent = agentDid.length > 32 ? `${agentDid.slice(0, 32)}…` : agentDid;
  return {
    persona,
    agentDid,
    reason,
    body: `🔐 An agent wants to access /${persona}\n${shortAgent}`,
  };
}

function hasApprovalCard(threadId: string, approvalTaskId: string): boolean {
  return getThread(threadId).some((message) => {
    const metadata = message.metadata as Record<string, unknown> | undefined;
    return (
      message.type === 'approval' &&
      metadata?.approvalKind === 'vault_read' &&
      metadata.approvalTaskId === approvalTaskId
    );
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
