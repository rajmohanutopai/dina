/**
 * Notification priority mapping — maps guardian tiers to notification levels.
 *
 * Tier 1 (fiduciary)  → high priority, heads-up, sound — MUST interrupt
 * Tier 2 (solicited)  → default priority, notification shade
 * Tier 3 (engagement) → low priority, bundled in daily briefing
 *
 * Source: core/test/notify_test.go
 */

export type GuardianTier = 1 | 2 | 3;
export type NotificationPriority = 'high' | 'default' | 'low';

/** Tier → priority mapping. */
const TIER_PRIORITY_MAP: Record<GuardianTier, NotificationPriority> = {
  1: 'high',
  2: 'default',
  3: 'low',
};

/**
 * Map a guardian priority tier to a notification priority.
 */
export function mapTierToPriority(tier: GuardianTier): NotificationPriority {
  return TIER_PRIORITY_MAP[tier];
}

/**
 * Check if a tier should trigger an immediate interruption.
 * Only Tier 1 (fiduciary) interrupts — security alerts, health critical, payment due.
 */
export function shouldInterrupt(tier: GuardianTier): boolean {
  return tier === 1;
}

/**
 * Check if a tier should be deferred to the daily briefing.
 * Only Tier 3 (engagement) items are deferred — social, promo, RSS, podcast.
 */
export function shouldDeferToBriefing(tier: GuardianTier): boolean {
  return tier === 3;
}
