/**
 * Staging service — ingest, claim, resolve, fail, extend lease, sweep.
 *
 * The staging inbox is the entry point for all data entering the vault.
 * Items flow: ingest → claim (lease) → classify/enrich → resolve or fail.
 *
 * Dedup: (source, source_id) — same email ingested twice is rejected.
 * Lease: 15-minute claim window. Expired leases reverted by sweep.
 * Retry: failed items re-queued up to 3 times, then dead-lettered.
 * Expiry: items older than 7 days are purged by sweep.
 *
 * Source: ARCHITECTURE.md Tasks 2.41–2.46
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { storeItem } from '../vault/crud';
import { getStagingRepository } from './repository';
import {
  type StagingStatus,
  isValidTransition,
  shouldRetry,
  isLeaseExpired,
  isItemExpired,
} from './state_machine';
import { STAGING_LEASE_DURATION_S, STAGING_ITEM_TTL_S } from '../constants';

export interface StagingItem {
  id: string;
  source: string;
  source_id: string;
  producer_id: string;
  status: StagingStatus;
  persona: string;
  retry_count: number;
  lease_until: number; // unix seconds
  expires_at: number; // unix seconds
  created_at: number; // unix seconds
  data: Record<string, unknown>;
  /** SHA-256 hash of the serialized data payload for integrity verification (matching Go source_hash). */
  source_hash: string;
  /** Enriched VaultItem JSON stored on resolve for later drain (matching Go classified_item). */
  classified_item?: Record<string, unknown>;
  /** Error message from the last failed processing attempt (matching Go error column). */
  error?: string;
  /** Approval request ID when item is pending_approval (matching Go). */
  approval_id?: string;
}

const LEASE_DURATION_S = STAGING_LEASE_DURATION_S;
const ITEM_TTL_S = STAGING_ITEM_TTL_S;

/** In-memory staging inbox. */
const inbox = new Map<string, StagingItem>();

/** Dedup index: "source|source_id" → staging ID. */
const dedupIndex = new Map<string, string>();

/**
 * Injectable OnDrain callback — invoked for each item written to vault
 * after drain. Used for post-publication processing (event extraction,
 * contact last-seen update, reminder planning).
 * Matching Go's OnDrain hook in the staging processor.
 */
let onDrainCallback: ((item: StagingItem, persona: string) => void) | null = null;

/** Register an OnDrain callback. */
export function setOnDrainCallback(cb: (item: StagingItem, persona: string) => void): void {
  onDrainCallback = cb;
}

/** Clear the OnDrain callback (for testing). */
export function clearOnDrainCallback(): void {
  onDrainCallback = null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Ingest a new item into the staging inbox.
 *
 * Dedup by (producer_id, source, source_id) — 3-part key matching Go.
 * Two different producers for the same source item won't collide.
 * Default expires_at: 7 days from now. Override with caller-provided value.
 */
export function ingest(input: {
  source: string;
  source_id: string;
  producer_id?: string;
  data?: Record<string, unknown>;
  /** Optional TTL override in Unix seconds. If omitted, defaults to now + 7 days. */
  expires_at?: number;
}): { id: string; duplicate: boolean } {
  const producer = input.producer_id ?? '';
  const dk = `${producer}|${input.source}|${input.source_id}`;
  const existingId = dedupIndex.get(dk);
  if (existingId && inbox.has(existingId)) {
    return { id: existingId, duplicate: true };
  }

  const id = `stg-${bytesToHex(randomBytes(8))}`;
  const now = nowSeconds();

  const data = input.data ?? {};
  const item: StagingItem = {
    id,
    source: input.source,
    source_id: input.source_id,
    producer_id: input.producer_id ?? '',
    status: 'received',
    persona: '',
    retry_count: 0,
    lease_until: 0,
    expires_at: input.expires_at ?? now + ITEM_TTL_S,
    created_at: now,
    data,
    source_hash: computeSourceHash(data),
  };

  inbox.set(id, item);
  dedupIndex.set(dk, id);
  // SQL write-through — fire-and-forget since Phase 2.3 (task 2.3).
  // Double-guarded: outer try/catch for sync-throw variants (test
  // mocks), inner .catch for async rejection. `inbox` Map is
  // authoritative for reads within the process.
  const sqlRepo = getStagingRepository();
  if (sqlRepo) {
    try {
      void sqlRepo.ingest(item).catch(() => {
        /* fail-safe — transient SQL write loss is acceptable */
      });
    } catch {
      /* fail-safe — sync-throw variant */
    }
  }
  return { id, duplicate: false };
}

/**
 * Claim up to `limit` received items for processing.
 *
 * Atomically transitions received → classifying with a configurable lease.
 * Default lease: STAGING_LEASE_DURATION_S (900s = 15 minutes).
 * Returns the claimed items. Re-claim returns empty (items already claimed).
 *
 * @param limit - Max items to claim (default 10)
 * @param leaseDurationSeconds - Lease duration in seconds (default 900s, matching Go)
 */
export function claim(limit: number = 10, leaseDurationSeconds?: number): StagingItem[] {
  const now = nowSeconds();
  const leaseDuration = leaseDurationSeconds ?? LEASE_DURATION_S;
  const claimed: StagingItem[] = [];

  for (const item of inbox.values()) {
    if (claimed.length >= limit) break;
    if (item.status !== 'received') continue;

    item.status = 'classifying';
    item.lease_until = now + leaseDuration;
    claimed.push(item);
  }

  return claimed;
}

/**
 * Resolve a claimed item — store in vault or mark pending_unlock.
 *
 * Optionally accepts classifiedItem — the enriched VaultItem JSON to
 * store for later drain (matching Go's classified_item column). This
 * is critical for pending_unlock items: when the persona unlocks later,
 * drainForPersona needs the enriched data to write to the vault.
 *
 * @param personaOpen — whether the target persona vault is currently open
 * @param classifiedItem — optional enriched VaultItem for later drain
 */
export function resolve(
  id: string,
  persona: string,
  personaOpen: boolean,
  classifiedItem?: Record<string, unknown>,
): void {
  const item = inbox.get(id);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot resolve item in status "${item.status}"`);
  }

  item.persona = persona;
  item.status = personaOpen ? 'stored' : 'pending_unlock';
  if (classifiedItem) {
    item.classified_item = classifiedItem;
  }

  // Vault write path: when persona is open AND classified data exists,
  // write the enriched item to the vault. This completes the staging→vault
  // pipeline — matching Go's storeToVault() call in Resolve.
  // Fail-safe: vault write errors don't block staging resolution.
  if (personaOpen && classifiedItem) {
    try {
      storeItem(persona, classifiedItem);
    } catch {
      // Vault validation may reject incomplete enrichment data — not fatal
    }
    if (onDrainCallback) onDrainCallback(item, persona);
  }

  // Clear raw body from data after classification (privacy protection).
  // The enriched content is in classified_item; the raw body is no longer
  // needed and should not linger in the inbox. Matches Go's body clearing
  // on resolve — prevents sensitive raw text from persisting after vault write.
  if (item.data.body !== undefined) {
    item.data = { ...item.data, body: '' };
  }
}

/**
 * Resolve a claimed item into multiple persona vaults simultaneously.
 *
 * For items that span multiple domains (e.g., "medical bill" → health + financial),
 * writes the classifiedItem to each open persona vault. Locked personas are marked
 * pending_unlock. Matching Go's ResolveMulti.
 *
 * @param targets — array of { persona, personaOpen } for each target vault
 * @returns count of personas the item was resolved into
 */
export function resolveMulti(
  id: string,
  targets: Array<{ persona: string; personaOpen: boolean }>,
  classifiedItem?: Record<string, unknown>,
): number {
  const item = inbox.get(id);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot resolve item in status "${item.status}"`);
  }
  if (targets.length === 0) {
    throw new Error('staging: resolveMulti requires at least one target persona');
  }

  if (classifiedItem) {
    item.classified_item = classifiedItem;
  }

  // Write to each open persona vault immediately.
  // For locked personas, create a separate pending_unlock staging record
  // so drainForPersona can find each one independently.
  // Fix: Codex #4 — previously only stored targets[0].persona, losing locked secondaries.
  const lockedTargets: string[] = [];

  for (const target of targets) {
    if (target.personaOpen && classifiedItem) {
      try {
        storeItem(target.persona, classifiedItem);
      } catch {
        /* fail-safe */
      }
      if (onDrainCallback) onDrainCallback(item, target.persona);
    } else if (!target.personaOpen) {
      lockedTargets.push(target.persona);
    }
  }

  // Create separate pending_unlock records for each locked secondary persona
  for (const lockedPersona of lockedTargets) {
    if (lockedPersona === targets[0].persona) continue; // primary handled below
    const copyId = `${id}-${lockedPersona}`;
    const copy: StagingItem = {
      ...item,
      id: copyId,
      persona: lockedPersona,
      status: 'pending_unlock',
      classified_item: classifiedItem,
    };
    inbox.set(copyId, copy);
  }

  // Primary persona tracks on the original item
  item.persona = targets[0].persona;
  const primaryOpen = targets[0].personaOpen;
  item.status = primaryOpen ? 'stored' : 'pending_unlock';

  // Clear raw body
  if (item.data.body !== undefined) {
    item.data = { ...item.data, body: '' };
  }

  return targets.length;
}

/**
 * Mark a claimed item as failed. Increments retry_count.
 *
 * Optionally stores an error message for debugging/audit
 * (matching Go's error column in staging inbox).
 */
export function fail(id: string, errorMessage?: string): void {
  const item = inbox.get(id);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot fail item in status "${item.status}"`);
  }

  item.status = 'failed';
  item.retry_count += 1;
  if (errorMessage) {
    item.error = errorMessage;
  }
}

/**
 * Mark a classifying item as pending approval.
 *
 * Used when the target persona requires user consent before the item
 * can be stored (e.g., sensitive persona + cloud processing).
 * Stores the approval request ID for later resume.
 *
 * Matching Go's MarkPendingApproval in the staging handler.
 */
export function markPendingApproval(id: string, approvalId: string): void {
  const item = inbox.get(id);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot mark pending_approval from status "${item.status}"`);
  }

  item.status = 'pending_approval';
  item.approval_id = approvalId;
}

/**
 * Resume processing after approval is granted.
 *
 * Transitions pending_approval → classifying so the item can be
 * re-processed (resolve to vault).
 */
export function resumeAfterApprovalGranted(id: string): void {
  const item = inbox.get(id);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'pending_approval') {
    throw new Error(`staging: cannot resume from status "${item.status}"`);
  }

  item.status = 'classifying';
  item.lease_until = nowSeconds() + LEASE_DURATION_S;
}

/**
 * Extend the lease on a claimed item by N seconds.
 *
 * Uses max(current lease_until, now) as the base — ensures extensions
 * never result in a lease that's already expired. Matches Go's
 * ExtendLease which computes from max(lease_until, current_time).
 */
export function extendLease(id: string, extensionSeconds: number): void {
  const item = inbox.get(id);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot extend lease on item in status "${item.status}"`);
  }

  const now = nowSeconds();
  const base = Math.max(item.lease_until, now);
  item.lease_until = base + extensionSeconds;
}

/**
 * Sweep the inbox: delete expired, revert stale leases, requeue failed, dead-letter exhausted.
 *
 * Returns counts of each action taken.
 */
export function sweep(now?: number): {
  expired: number;
  leaseReverted: number;
  requeued: number;
  deadLettered: number;
} {
  const currentTime = now ?? nowSeconds();
  const result = { expired: 0, leaseReverted: 0, requeued: 0, deadLettered: 0 };

  for (const [id, item] of inbox.entries()) {
    // 1. Delete expired items (7d TTL)
    if (isItemExpired(item.expires_at, currentTime)) {
      inbox.delete(id);
      result.expired++;
      continue;
    }

    // 2. Revert expired leases (classifying → received)
    if (item.status === 'classifying' && isLeaseExpired(item.lease_until, currentTime)) {
      item.status = 'received';
      item.lease_until = 0;
      result.leaseReverted++;
      continue;
    }

    // 3. Requeue failed items (retry ≤ 3) or dead-letter (retry > 3)
    if (item.status === 'failed') {
      if (shouldRetry(item.retry_count)) {
        item.status = 'received';
        item.lease_until = 0; // Reset lease so item is immediately eligible for re-claim
        result.requeued++;
      } else {
        // Dead-letter: leave as failed, don't requeue
        result.deadLettered++;
      }
    }
  }

  return result;
}

/**
 * Drain all pending_unlock items for a persona (after persona unlocked).
 *
 * Transitions pending_unlock → stored for the given persona.
 * Returns count of drained items.
 */
export function drainForPersona(persona: string): number {
  let drained = 0;
  for (const item of inbox.values()) {
    if (item.status === 'pending_unlock' && item.persona === persona) {
      // Write classified data to vault if available
      if (item.classified_item) {
        try {
          storeItem(persona, item.classified_item);
        } catch {
          /* fail-safe */
        }
      }
      item.status = 'stored';
      // OnDrain callback: post-publication event extraction
      if (onDrainCallback) onDrainCallback(item, persona);
      drained++;
    }
  }
  return drained;
}

/** Get a staging item by ID. */
export function getItem(id: string): StagingItem | null {
  return inbox.get(id) ?? null;
}

/** Get inbox size. */
export function inboxSize(): number {
  return inbox.size;
}

/** Reset all staging state (for testing). */
export function resetStagingState(): void {
  inbox.clear();
  dedupIndex.clear();
  onDrainCallback = null;
}

/**
 * List all staging items with a given status.
 *
 * Matching Go's ListByStatus — used for monitoring and batch operations.
 */
export function listByStatus(status: StagingStatus): StagingItem[] {
  const results: StagingItem[] = [];
  for (const item of inbox.values()) {
    if (item.status === status) results.push(item);
  }
  return results;
}

/**
 * Get staging item status with ownership enforcement.
 *
 * Only returns the item if the caller's originDID matches the item's
 * producer_id. Returns null if not found or ownership mismatch.
 * Matching Go's GetStatus with origin_did check.
 */
export function getStatusForOwner(
  id: string,
  originDID: string,
): { status: StagingStatus; persona: string } | null {
  const item = inbox.get(id);
  if (!item) return null;
  if (item.producer_id !== originDID) return null;
  return { status: item.status, persona: item.persona };
}

/**
 * Compute SHA-256 hash of a data payload for integrity verification.
 *
 * Matches Go's source_hash: SHA-256 of the serialized body content.
 * Used to detect content tampering during the staging pipeline.
 * Deterministic: same data always produces the same hash.
 */
export function computeSourceHash(data: Record<string, unknown>): string {
  const serialized = JSON.stringify(data);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}
