/**
 * Briefing providers — concrete implementations for assembly.ts.
 *
 * Three providers source data from the real system:
 *   1. Engagement: Tier 3 staging items from last 24h (social, promo, RSS)
 *   2. Approvals: pending_unlock staging items awaiting persona unlock
 *   3. Memories: vault items stored since last briefing
 *
 * Each provider returns BriefingItem[] matching the assembly interface.
 *
 * Source: ARCHITECTURE.md Task 5.4
 */

import { stagingListByStatus, browseRecent, listPersonas } from '@dina/core';

import { listNotifications } from '../notifications/inbox';

import type { BriefingItem } from './assembly';

// ---------------------------------------------------------------
// Constants
// ---------------------------------------------------------------

const MS_24H = 24 * 60 * 60 * 1000;

/** Engagement source types that qualify for Tier 3 briefing. */
const ENGAGEMENT_SOURCES = new Set([
  'social',
  'promo',
  'rss',
  'feed',
  'newsletter',
  'notification',
  'podcast',
]);

// ---------------------------------------------------------------
// Engagement Provider
// ---------------------------------------------------------------

/** Last briefing timestamp for filtering "new since last briefing" items. */
let lastBriefingTimestamp = 0;

/** Set the last briefing timestamp (called by markBriefingSent in assembly). */
export function setLastBriefingTimestamp(ts: number): void {
  lastBriefingTimestamp = ts;
}

/**
 * Collect Tier 3 engagement items from the vault (social, promo, RSS).
 *
 * Queries vault items from the last 24h whose source is an engagement type.
 * Uses vault (persistent), not staging (transient), as the data source.
 */
export function collectEngagementItems(now?: number): BriefingItem[] {
  const currentTime = now ?? Date.now();
  const cutoff = currentTime - MS_24H;

  const personas = listPersonas();
  const items: BriefingItem[] = [];

  for (const persona of personas) {
    try {
      const recent = browseRecent(persona.name, cutoff, currentTime, 50);
      for (const item of recent) {
        if (!ENGAGEMENT_SOURCES.has((item.source ?? '').toLowerCase())) continue;
        items.push({
          type: 'engagement',
          title: item.content_l0 || item.summary || 'Notification',
          detail: (item.body ?? '').slice(0, 200),
          source: item.source || persona.name,
          timestamp: item.created_at,
        });
      }
    } catch {
      // Vault may not be open — skip
    }
  }

  return items;
}

// ---------------------------------------------------------------
// Notification-backed engagement Provider (R4-03)
// ---------------------------------------------------------------

/**
 * Collect the Tier-3 (`briefing`-kind) items the silence pipeline saved for the
 * daily digest (PUSH_SERVICES §8/§19). `deliverWatchResult` routes a benign
 * (Tier-3) watch/push result to the durable notification inbox as a `briefing`
 * item; this surfaces those into the briefing instead of leaving them stranded.
 * Reads the last 24h so the digest stays fresh.
 */
export function collectNotificationBriefingItems(now?: number): BriefingItem[] {
  const currentTime = now ?? Date.now();
  const since = currentTime - MS_24H;
  return listNotifications({ kinds: ['briefing'], since }).map((n) => ({
    type: 'engagement' as const,
    title: n.title,
    detail: n.body,
    source: 'notification',
    timestamp: n.firedAt,
  }));
}

// ---------------------------------------------------------------
// Approval Provider
// ---------------------------------------------------------------

/**
 * Collect pending approval items from staging.
 *
 * These are staging items in 'pending_unlock' status — items that were
 * routed to a locked persona and await the user's approval/unlock.
 */
export function collectApprovalItems(): BriefingItem[] {
  const pendingUnlock = stagingListByStatus('pending_unlock');
  const items: BriefingItem[] = [];

  for (const staged of pendingUnlock) {
    const data = staged.data ?? {};
    items.push({
      type: 'approval',
      title: String(data.summary ?? `Item pending unlock for ${staged.persona}`),
      detail: `Persona "${staged.persona}" is locked. Unlock to process this item.`,
      source: staged.source,
      timestamp: staged.created_at,
    });
  }

  return items;
}

// ---------------------------------------------------------------
// Memory Provider
// ---------------------------------------------------------------

/**
 * Collect recently stored vault items across all accessible personas.
 *
 * Returns items stored since the last briefing (or last 24h if no
 * previous briefing). These are the "new memories" section.
 */
export function collectNewMemories(now?: number): BriefingItem[] {
  const currentTime = now ?? Date.now();
  const since = lastBriefingTimestamp > 0 ? lastBriefingTimestamp : currentTime - MS_24H;

  const personas = listPersonas();
  const items: BriefingItem[] = [];

  for (const persona of personas) {
    try {
      const recent = browseRecent(persona.name, since, currentTime, 20);

      for (const item of recent) {
        items.push({
          type: 'memory',
          title: item.content_l0 || item.summary || 'New item stored',
          detail: item.type ? `Type: ${item.type}` : undefined,
          source: item.source || persona.name,
          timestamp: item.created_at,
        });
      }
    } catch {
      // Persona vault may not be open — skip
    }
  }

  return items;
}

// ---------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------

/**
 * Register all concrete providers with the briefing assembly.
 *
 * Call this during app startup to wire the providers.
 */
export function registerAllProviders(register: {
  engagement: (fn: () => BriefingItem[]) => void;
  approval: (fn: () => BriefingItem[]) => void;
  memory: (fn: () => BriefingItem[]) => void;
}): void {
  register.engagement(collectEngagementItems);
  register.approval(collectApprovalItems);
  register.memory(collectNewMemories);
}

/** Reset provider state (for testing). */
export function resetProviderState(): void {
  lastBriefingTimestamp = 0;
}
