/**
 * Chat approval cards hook — data layer for inline approval cards.
 *
 * Approval cards appear in the chat thread when the Brain or an agent
 * requests a sensitive action. The user can:
 *   - Approve (this time) → single-use grant, consumed after one use
 *   - Approve (this session) → session-scoped grant, valid until session end
 *   - Deny → block the action
 *
 * Each card shows: requester, action, persona, reason, preview.
 *
 * Source: ARCHITECTURE.md Task 4.11
 */

import {
  getApprovalManager,
  resetApprovalManager,
  type ApprovalRequest,
} from '../../../core/src/approval/manager';
import { addMessage, type ChatMessage } from '../../../brain/src/chat/thread';

export interface ApprovalCardData {
  id: string;
  action: string;
  requesterDID: string;
  requesterLabel: string;
  persona: string;
  reason: string;
  preview: string;
  status: 'pending' | 'approved' | 'denied';
  scope?: 'single' | 'session';
  createdAt: number;
}

/** DID → label mapping for display. */
const didLabels = new Map<string, string>();

/**
 * Register a display label for a DID (e.g., "Brain" for the brain's DID).
 */
export function registerDIDLabel(did: string, label: string): void {
  didLabels.set(did, label);
}

/**
 * Create a new approval request (called by Brain/agent via event processor).
 *
 * Adds an approval card to the chat thread.
 */
export function createApprovalCard(
  id: string,
  action: string,
  requesterDID: string,
  persona: string,
  reason: string,
  preview: string,
  threadId?: string,
): ApprovalCardData {
  getApprovalManager().requestApproval({
    id,
    action,
    requester_did: requesterDID,
    persona,
    reason,
    preview,
    created_at: Date.now(),
  });

  // Add approval message to chat thread
  if (threadId) {
    addMessage(threadId, 'approval', JSON.stringify({ id, action, persona, reason, preview }));
  }

  return toCardData(getApprovalManager().getRequest(id)!);
}

/**
 * Approve a pending request.
 *
 * @param scope — 'single' (one-time use) or 'session' (valid until session end)
 */
export function approveCard(
  id: string,
  scope: 'single' | 'session',
  approverDID: string,
): ApprovalCardData | null {
  try {
    getApprovalManager().approveRequest(id, scope, approverDID);
    return toCardData(getApprovalManager().getRequest(id)!);
  } catch {
    return null;
  }
}

/**
 * Deny a pending request.
 */
export function denyCard(id: string): ApprovalCardData | null {
  try {
    getApprovalManager().denyRequest(id);
    return toCardData(getApprovalManager().getRequest(id)!);
  } catch {
    return null;
  }
}

/**
 * Get all pending approval cards for the chat UI.
 */
export function getPendingCards(): ApprovalCardData[] {
  return getApprovalManager().listPending().map(toCardData);
}

/**
 * Get a specific card's data.
 */
export function getCard(id: string): ApprovalCardData | null {
  const req = getApprovalManager().getRequest(id);
  return req ? toCardData(req) : null;
}

/**
 * Get the count of pending approvals (for badge display).
 */
export function getPendingCount(): number {
  return getApprovalManager().listPending().length;
}

/**
 * Check if a specific approval was granted (for action execution).
 */
export function isApproved(id: string): boolean {
  return getApprovalManager().isApproved(id);
}

/**
 * Consume a single-use approval (after the action is executed).
 */
export function consumeApproval(id: string): boolean {
  return getApprovalManager().consumeSingle(id);
}

/**
 * Revoke all session-scoped approvals (on session end).
 * Returns the count of revoked approvals.
 */
export function endSession(): number {
  return getApprovalManager().revokeSession();
}

/**
 * Reset all approval state (for testing).
 */
export function resetApprovalCards(): void {
  didLabels.clear();
  resetApprovalManager();
}

/** Convert ApprovalRequest to UI card data. */
function toCardData(req: ApprovalRequest): ApprovalCardData {
  return {
    id: req.id,
    action: req.action,
    requesterDID: req.requester_did,
    requesterLabel: didLabels.get(req.requester_did) ?? shortDID(req.requester_did),
    persona: req.persona,
    reason: req.reason,
    preview: req.preview,
    status: req.status,
    scope: req.scope,
    createdAt: req.created_at,
  };
}

/** Shorten a DID for display. */
function shortDID(did: string): string {
  if (!did || did.length <= 20) return did || 'Unknown';
  return `${did.slice(0, 12)}...${did.slice(-4)}`;
}
