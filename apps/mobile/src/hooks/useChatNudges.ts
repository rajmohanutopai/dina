/**
 * Chat nudge cards hook — data layer for context-aware suggestions.
 *
 * Nudge cards appear in the chat when Dina has a proactive suggestion:
 *   - Reconnection: "You haven't talked to Alice in 3 weeks"
 *   - Reminder context: "James's birthday tomorrow — he loves craft beer"
 *   - Pending promise: "You said you'd send that report to Bob"
 *   - Health alert: "Your lab results arrived"
 *
 * Nudges respect Silence First: Tier 3 (engagement) nudges are suppressed
 * unless the user has DND disabled. Tier 1 (fiduciary) always shows.
 *
 * Source: ARCHITECTURE.md Task 4.12
 */

import { respectsSilenceTier } from '@dina/brain';
import { addMessage } from '@dina/brain/chat';
import { appendNotification } from '@dina/brain/notifications';

export type NudgeKind =
  | 'reconnection'
  | 'reminder_context'
  | 'pending_promise'
  | 'health_alert'
  | 'general';

export interface NudgeCard {
  id: string;
  kind: NudgeKind;
  title: string;
  body: string;
  contactDID?: string;
  contactName?: string;
  tier: 1 | 2 | 3;
  actionLabel?: string;
  actionType?: 'message' | 'view' | 'dismiss';
  dismissed: boolean;
  createdAt: number;
}

/** Active nudge cards. */
const nudges = new Map<string, NudgeCard>();
let nudgeCounter = 0;

/** DND state (suppress Tier 3 nudges). */
let dndEnabled = false;

/**
 * Create a nudge card and optionally add to chat thread.
 */
export function createNudge(
  kind: NudgeKind,
  title: string,
  body: string,
  tier: 1 | 2 | 3,
  options?: {
    contactDID?: string;
    contactName?: string;
    actionLabel?: string;
    actionType?: 'message' | 'view' | 'dismiss';
    threadId?: string;
  },
): NudgeCard | null {
  // Silence First: suppress Tier 3 when DND or silence tier blocks it
  if (!respectsSilenceTier(tier) && !isFiduciaryOverride(kind)) {
    return null;
  }

  if (dndEnabled && tier === 3) {
    return null;
  }

  const id = `nudge-${++nudgeCounter}`;
  const nudge: NudgeCard = {
    id,
    kind,
    title,
    body,
    contactDID: options?.contactDID,
    contactName: options?.contactName,
    tier,
    actionLabel: options?.actionLabel ?? getDefaultActionLabel(kind),
    actionType: options?.actionType ?? getDefaultActionType(kind),
    dismissed: false,
    createdAt: Date.now(),
  };

  nudges.set(id, nudge);

  // Add to chat thread as a nudge message. Metadata carries the
  // structured fields the inline `<InlineNudgeCard>` (5.62) needs to
  // render an action chip + tier indicator instead of a plain bubble.
  // Without `kind: 'nudge'` the chat tab's `toDisplayType` falls
  // back to a generic system bubble.
  if (options?.threadId) {
    addMessage(options.threadId, 'nudge', `${title}: ${body}`, {
      metadata: {
        kind: 'nudge',
        nudgeId: id,
        nudgeKind: kind,
        title,
        body,
        tier,
        actionLabel: nudge.actionLabel ?? null,
        actionType: nudge.actionType ?? null,
        contactDID: nudge.contactDID ?? null,
        contactName: nudge.contactName ?? null,
      },
    });
  }

  // Mirror to the unified notifications inbox (5.66) so the user can
  // catch up on nudges from the Notifications screen without scrolling
  // the chat thread. The deep link routes back to the originating
  // thread when one is set; otherwise omitted (no destination to land
  // on if the producer didn't post to chat).
  appendNotification({
    id: `nt-${id}`,
    kind: 'nudge',
    title,
    body,
    sourceId: id,
    ...(options?.threadId !== undefined && {
      deepLink: `dina://chat/${options.threadId}?focus=${id}`,
    }),
  });

  return nudge;
}

/**
 * Dismiss a nudge card.
 */
export function dismissNudge(id: string): boolean {
  const nudge = nudges.get(id);
  if (!nudge) return false;
  nudge.dismissed = true;
  return true;
}

/**
 * Act on a nudge card (user tapped the action button).
 * Returns the action to perform.
 */
export function actOnNudge(id: string): { actionType: string; contactDID?: string } | null {
  const nudge = nudges.get(id);
  if (!nudge || nudge.dismissed) return null;

  nudge.dismissed = true; // auto-dismiss after acting
  return {
    actionType: nudge.actionType ?? 'dismiss',
    contactDID: nudge.contactDID,
  };
}

/**
 * Get all active (non-dismissed) nudge cards.
 */
export function getActiveNudges(): NudgeCard[] {
  return [...nudges.values()].filter((n) => !n.dismissed);
}

/**
 * Get active nudge count (for badge display).
 */
export function getActiveNudgeCount(): number {
  return getActiveNudges().length;
}

/**
 * Set DND mode (suppress Tier 3 nudges).
 */
export function setDND(enabled: boolean): void {
  dndEnabled = enabled;
}

/**
 * Check if DND is enabled.
 */
export function isDND(): boolean {
  return dndEnabled;
}

/**
 * Reset all nudge state (for testing).
 */
export function resetNudges(): void {
  nudges.clear();
  nudgeCounter = 0;
  dndEnabled = false;
}

/** Fiduciary kinds always show regardless of silence tier. */
function isFiduciaryOverride(kind: NudgeKind): boolean {
  return kind === 'health_alert';
}

/** Default action labels per kind. */
function getDefaultActionLabel(kind: NudgeKind): string {
  switch (kind) {
    case 'reconnection':
      return 'Send message';
    case 'reminder_context':
      return 'View details';
    case 'pending_promise':
      return 'Follow up';
    case 'health_alert':
      return 'View now';
    case 'general':
      return 'View';
  }
}

/** Default action types per kind. */
function getDefaultActionType(kind: NudgeKind): 'message' | 'view' | 'dismiss' {
  switch (kind) {
    case 'reconnection':
      return 'message';
    case 'reminder_context':
      return 'view';
    case 'pending_promise':
      return 'message';
    case 'health_alert':
      return 'view';
    case 'general':
      return 'dismiss';
  }
}
