/**
 * Trust level assignment and cache semantics.
 *
 * Trust hierarchy (lowest → highest): blocked < unknown < verified < trusted
 *
 * Behavioral rules:
 *   blocked  → silently drop messages (no sharing, no quarantine)
 *   unknown  → quarantine messages (no sharing, pending verification)
 *   verified → allow sharing (ZKP-verified identity)
 *   trusted  → allow sharing (credential-verified, full trust)
 *
 * Trust rings:
 *   Ring 1: unverified (unknown entities, high-risk actions require Ring 2+)
 *   Ring 2: ZKP-verified (moderate actions allowed with approval)
 *   Ring 3: credential-verified (full trust, low-friction)
 *
 * Cache: trust level cached locally with 1-hour staleness window.
 * Re-sync from AppView when stale.
 *
 * Source: core/test/trust_test.go
 */

import { TRUST_CACHE_TTL_MS } from '../constants';

export type TrustLevel = 'blocked' | 'unknown' | 'verified' | 'trusted';
export type TrustRing = 1 | 2 | 3;

/** Numeric ordering for trust levels (higher = more trusted). */
const TRUST_ORDER: Record<TrustLevel, number> = {
  blocked: 0,
  unknown: 1,
  verified: 2,
  trusted: 3,
};

/** Minimum trust ring required per action category. */
const ACTION_RING_REQUIREMENTS: Record<string, TrustRing> = {
  // Ring 1 — basic interactions (anyone can do these)
  search: 1,
  query: 1,
  list: 1,
  send_small: 1,
  // Ring 2 — moderate actions (need ZKP verification)
  send_large: 2,
  delete_large: 2,
  modify_settings: 2,
  // Ring 3 — high-trust actions (need credential verification)
  purchase: 3,
  payment: 3,
  bulk_operation: 3,
};

/** Trust cache staleness threshold (derived from shared TTL). */
const CACHE_STALE_SECONDS = TRUST_CACHE_TTL_MS / 1000;

/**
 * Check if a trust level allows data sharing.
 * Only verified and trusted contacts can receive shared data.
 */
export function allowsSharing(level: TrustLevel): boolean {
  return level === 'verified' || level === 'trusted';
}

/**
 * Check if a trust level should trigger quarantine.
 * Only unknown contacts are quarantined (pending verification).
 * Blocked contacts are dropped, not quarantined.
 */
export function shouldQuarantine(level: TrustLevel): boolean {
  return level === 'unknown';
}

/**
 * Check if a trust level means messages should be silently dropped.
 * Only blocked contacts are dropped.
 */
export function shouldDrop(level: TrustLevel): boolean {
  return level === 'blocked';
}

/**
 * Compare two trust levels.
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareTrustLevels(a: TrustLevel, b: TrustLevel): number {
  const diff = TRUST_ORDER[a] - TRUST_ORDER[b];
  if (diff > 0) return 1;
  if (diff < 0) return -1;
  return 0;
}

/**
 * Get the minimum trust ring required for a given action.
 * Unknown actions default to Ring 2 (moderate trust needed).
 */
export function minRingForAction(action: string): TrustRing {
  return ACTION_RING_REQUIREMENTS[action] ?? 2;
}

/**
 * Check if a trust cache entry is stale (older than 1 hour).
 *
 * @param lastVerifiedAt - Unix timestamp (seconds) of last verification
 * @param now - Current Unix timestamp (seconds). Defaults to Date.now()/1000.
 * @returns true if stale (needs re-sync from AppView)
 */
export function isCacheStale(lastVerifiedAt: number, now?: number): boolean {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  return currentTime - lastVerifiedAt >= CACHE_STALE_SECONDS;
}
