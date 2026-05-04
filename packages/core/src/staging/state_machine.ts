/**
 * Staging pipeline state machine.
 *
 * States: received → classifying → stored | pending_unlock | pending_approval | failed
 *
 * Transitions:
 *   received          → classifying       (claim with 15-min lease)
 *   classifying       → stored            (resolve to open persona)
 *   classifying       → pending_unlock    (resolve to locked persona)
 *   classifying       → pending_approval  (requires user approval for sensitive persona)
 *   classifying       → failed            (classification/enrichment error)
 *   classifying       → received          (lease expired, sweep reverts)
 *   failed            → received          (retry if retry_count ≤ 3)
 *   pending_unlock    → stored            (persona unlocked / approval granted, drain)
 *   pending_unlock    → failed            (approval denied)
 *   pending_approval  → classifying       (approval granted, resume processing)
 *   pending_approval  → failed            (approval denied)
 *
 * Terminal states: stored (no outbound transitions)
 *
 * Source: core/test/staging_inbox_test.go
 */

export type StagingStatus =
  | 'received'
  | 'classifying'
  | 'stored'
  | 'pending_unlock'
  | 'pending_approval'
  | 'failed';

export interface StagingTransition {
  from: StagingStatus;
  to: StagingStatus;
  valid: boolean;
  reason?: string;
}

import { STAGING_MAX_RETRIES } from '../constants';
/** Default maximum retry count before dead-lettering. */
const DEFAULT_MAX_RETRIES = STAGING_MAX_RETRIES;

/**
 * Adjacency list: for each state, the set of valid next states.
 */
const TRANSITIONS: Record<StagingStatus, Set<StagingStatus>> = {
  received: new Set(['classifying']),
  classifying: new Set(['stored', 'pending_unlock', 'pending_approval', 'failed', 'received']),
  stored: new Set(), // terminal
  pending_unlock: new Set(['stored', 'failed']),
  pending_approval: new Set(['classifying', 'failed']), // approval granted → resume, denied → fail
  failed: new Set(['received']), // retry
};

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: StagingStatus, to: StagingStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Get all valid transitions from a given state.
 */
export function validTransitionsFrom(from: StagingStatus): StagingStatus[] {
  return Array.from(TRANSITIONS[from] ?? []);
}

/**
 * Check if an item should be retried.
 *
 * @param retryCount - Current retry count
 * @param maxRetries - Maximum retries before dead-letter (default: 3)
 * @returns true if retryCount ≤ maxRetries
 */
export function shouldRetry(retryCount: number, maxRetries: number = DEFAULT_MAX_RETRIES): boolean {
  return retryCount <= maxRetries;
}

/**
 * Check if a lease has expired.
 *
 * @param leaseUntil - Unix timestamp (seconds) when lease expires
 * @param now - Current time (seconds). Defaults to Date.now()/1000.
 * @returns true if current time is past the lease deadline
 */
export function isLeaseExpired(leaseUntil: number, now?: number): boolean {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  return currentTime > leaseUntil;
}

/**
 * Check if a staging item has expired (past its TTL).
 *
 * @param expiresAt - Unix timestamp (seconds) when item expires
 * @param now - Current time (seconds). Defaults to Date.now()/1000.
 * @returns true if current time is past the expiration
 */
export function isItemExpired(expiresAt: number, now?: number): boolean {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  return currentTime > expiresAt;
}
