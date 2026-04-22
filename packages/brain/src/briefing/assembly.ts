/**
 * Daily briefing assembly — collect and structure Tier 3 items for daily digest.
 *
 * Sections:
 *   1. Engagement items (Tier 3 from last 24h) — social, promo, RSS
 *   2. Upcoming reminders (next 24h)
 *   3. Pending approvals
 *   4. New memories stored (since last briefing)
 *
 * Configurable briefing time (default 8:00 AM).
 * Returns null if nothing to report (Silence First — no empty briefings).
 *
 * Source: ARCHITECTURE.md Task 5.4
 */

import { listPending } from '../../../core/src/reminders/service';

export interface BriefingItem {
  type: 'engagement' | 'reminder' | 'approval' | 'memory';
  title: string;
  detail?: string;
  source?: string;
  timestamp: number;
}

export interface Briefing {
  generatedAt: number;
  sections: {
    engagement: BriefingItem[];
    reminders: BriefingItem[];
    approvals: BriefingItem[];
    memories: BriefingItem[];
  };
  totalItems: number;
}

import { DEFAULT_BRIEFING_HOUR } from '../constants';

/** Default briefing hour (8 AM). */
let briefingHour = DEFAULT_BRIEFING_HOUR;

/** Injectable engagement item provider. */
let engagementProvider: (() => BriefingItem[]) | null = null;

/** Injectable approval provider. */
let approvalProvider: (() => BriefingItem[]) | null = null;

/** Injectable new memories provider. */
let memoryProvider: (() => BriefingItem[]) | null = null;

/** Set the briefing hour (0-23). */
export function setBriefingHour(hour: number): void {
  briefingHour = Math.max(0, Math.min(23, Math.floor(hour)));
}

/** Get the current briefing hour. */
export function getBriefingHour(): number {
  return briefingHour;
}

/** Register provider for Tier 3 engagement items. */
export function registerEngagementProvider(provider: () => BriefingItem[]): void {
  engagementProvider = provider;
}

/** Register provider for pending approvals. */
export function registerApprovalProvider(provider: () => BriefingItem[]): void {
  approvalProvider = provider;
}

/** Register provider for new memories. */
export function registerMemoryProvider(provider: () => BriefingItem[]): void {
  memoryProvider = provider;
}

/**
 * Assemble the daily briefing.
 *
 * Collects items from all sections. Returns null if nothing to report
 * (Silence First — don't surface an empty briefing).
 */
export function assembleBriefing(now?: number): Briefing | null {
  const currentTime = now ?? Date.now();

  // 1. Engagement: Tier 3 items from last 24h
  const engagement = engagementProvider ? engagementProvider() : [];

  // 2. Reminders: due in next 24h
  const reminderWindow = currentTime + 24 * 60 * 60 * 1000;
  const pendingReminders = listPending(reminderWindow);
  const reminders: BriefingItem[] = pendingReminders.map((r) => ({
    type: 'reminder' as const,
    title: r.message,
    detail: r.persona,
    source: r.source,
    timestamp: r.due_at,
  }));

  // 3. Pending approvals
  const approvals = approvalProvider ? approvalProvider() : [];

  // 4. New memories
  const memories = memoryProvider ? memoryProvider() : [];

  // Deduplicate by body text (matching Python: no duplicate items in briefing)
  const allItems = [...engagement, ...reminders, ...approvals, ...memories];
  const deduped = deduplicateByTitle(allItems);

  // Re-split into sections after dedup
  const dedupedSections = {
    engagement: deduped.filter((i) => i.type === 'engagement'),
    reminders: deduped.filter((i) => i.type === 'reminder'),
    approvals: deduped.filter((i) => i.type === 'approval'),
    memories: deduped.filter((i) => i.type === 'memory'),
  };

  // Sort engagement items by source priority (matching Python)
  dedupedSections.engagement = sortBySourcePriority(dedupedSections.engagement);

  const totalItems = deduped.length;

  // Silence First: no empty briefings
  if (totalItems === 0) return null;

  return {
    generatedAt: currentTime,
    sections: dedupedSections,
    totalItems,
  };
}

/**
 * Check if it's time for the daily briefing.
 *
 * Returns true if the current hour matches the configured briefing hour
 * and a briefing hasn't been sent in the last 23 hours.
 */
let lastBriefingAt = 0;

export function isBriefingTime(currentHour?: number, now?: number): boolean {
  const hour = currentHour ?? new Date().getHours();
  const currentTime = now ?? Date.now();

  if (hour !== briefingHour) return false;

  // Prevent double-send within 23 hours
  const minInterval = 23 * 60 * 60 * 1000;
  if (currentTime - lastBriefingAt < minInterval) return false;

  return true;
}

/** Mark a briefing as sent (update last sent time). */
export function markBriefingSent(now?: number): void {
  lastBriefingAt = now ?? Date.now();
}

/** Reset all briefing state (for testing). */
export function resetBriefingState(): void {
  briefingHour = 8;
  engagementProvider = null;
  approvalProvider = null;
  memoryProvider = null;
  lastBriefingAt = 0;
}

// ---------------------------------------------------------------
// Source-priority sorting (matching Python briefing)
//
// Priority order: finance > health > calendar > messaging > rss > other
// Higher priority items appear first in the briefing.
// ---------------------------------------------------------------

const SOURCE_PRIORITY: Record<string, number> = {
  finance: 6,
  financial: 6,
  bank: 6,
  health: 5,
  medical: 5,
  calendar: 4,
  event: 4,
  messaging: 3,
  telegram: 3,
  email: 3,
  rss: 2,
  feed: 2,
  social: 1,
  promo: 0,
};

/**
 * Sort briefing items by source priority (matching Python).
 *
 * Items from higher-priority sources (finance, health) appear before
 * lower-priority sources (rss, social, promo). Items with the same
 * priority maintain their original order (stable sort by timestamp).
 */
export function sortBySourcePriority(items: BriefingItem[]): BriefingItem[] {
  return [...items].sort((a, b) => {
    const aPriority = SOURCE_PRIORITY[(a.source ?? '').toLowerCase()] ?? 1;
    const bPriority = SOURCE_PRIORITY[(b.source ?? '').toLowerCase()] ?? 1;
    if (aPriority !== bPriority) return bPriority - aPriority; // higher priority first
    return b.timestamp - a.timestamp; // newer first within same priority
  });
}

/**
 * Deduplicate briefing items by title text.
 *
 * If two items have the same title, only the first (newest) is kept.
 * Matching Python's body-text dedup to prevent duplicate items.
 */
export function deduplicateByTitle(items: BriefingItem[]): BriefingItem[] {
  const seen = new Set<string>();
  const deduped: BriefingItem[] = [];

  // Sort by timestamp descending (newest first) before dedup
  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);

  for (const item of sorted) {
    const key = item.title.toLowerCase().trim();
    if (!key) {
      deduped.push(item); // empty titles always included
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  return deduped;
}
