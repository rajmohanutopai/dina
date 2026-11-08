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
 * The owner's own words from a chat turn, proven by a span proof, that were
 * not a plain request to remember (REAL_LIFE_FIXES §2.5). First-party, but
 * NOT owner-direct: a sensitive or locked target waits for the owner's card.
 */
export const CHAT_AUTO_SOURCE = 'chat_auto';

/** Sources whose items are the owner's own memories (dedup, §2.4; TTL, below). */
export const OWNER_MEMORY_SOURCES: ReadonlySet<string> = new Set(['user_remember', CHAT_AUTO_SOURCE]);

/**
 * The TTL purge may not delete this row. An owner memory that has not reached
 * the vault is the only copy of what the owner said, so it stays until it
 * stores, the owner forgets it, or the owner refuses it on its card. A failed
 * row with a card and spent retries is the owner's no, unless the drain failed
 * after the owner's yes (`routes/workflow.ts`).
 *
 * The SQL copy is `OWNER_MEMORY_RETAINED_SQL`; keep the two together.
 */
export function retainedPastTtl(item: {
  source: string;
  status: string;
  retry_count: number;
  approval_id?: string;
  error?: string;
}): boolean {
  if (!OWNER_MEMORY_SOURCES.has(item.source) || item.status === 'stored') return false;
  const refused =
    item.status === 'failed' &&
    (item.approval_id ?? '') !== '' &&
    item.retry_count > DEFAULT_MAX_RETRIES &&
    !(item.error ?? '').startsWith(DRAIN_FAILED_PREFIX);
  return !refused;
}

/** How `routes/workflow.ts` marks a row whose store failed after the owner's yes. */
export const DRAIN_FAILED_PREFIX = 'drain failed';

export const OWNER_MEMORY_RETAINED_SQL = `(
  source IN (${[...OWNER_MEMORY_SOURCES].map((s) => `'${s}'`).join(', ')})
  AND status <> 'stored'
  AND NOT (
    status = 'failed'
    AND COALESCE(approval_id, '') <> ''
    AND retry_count > ${DEFAULT_MAX_RETRIES}
    AND COALESCE(error, '') NOT LIKE '${DRAIN_FAILED_PREFIX}%'
  )
)`;

/**
 * Seconds a failed row waits before its next try, by the count that failure
 * reached. Without this a one-minute sweep spends every retry in four minutes,
 * and an hour's model outage kills every memory that met it. Past the ceiling
 * the row is dead-lettered and the value is unused.
 */
export function stagingRetryDelaySeconds(retryCount: number): number {
  if (retryCount <= 1) return 60;
  if (retryCount === 2) return 15 * 60;
  return 6 * 60 * 60;
}

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
