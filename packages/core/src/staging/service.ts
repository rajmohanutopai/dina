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
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { STAGING_LEASE_DURATION_S, STAGING_ITEM_TTL_S, STAGING_MAX_RETRIES } from '../constants';
import { storeItem } from '../vault/crud';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  isTerminal as isTerminalWorkflowState,
} from '../workflow/domain';
import { WorkflowConflictError, getWorkflowService } from '../workflow/service';

import { getStagingRepository, type StagingRepository } from './repository';
import {
  type StagingStatus,
  shouldRetry,
  isLeaseExpired,
  isItemExpired,
} from './state_machine';

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

export const STAGING_PERSONA_ACCESS_APPROVAL_TYPE = 'staging_persona_access';

export interface StagingPersonaAccessApprovalPayload {
  type: typeof STAGING_PERSONA_ACCESS_APPROVAL_TYPE;
  approval_id: string;
  staging_id: string;
  persona: string;
  source: string;
  source_id: string;
  producer_id: string;
  preview: string;
}

export interface StagingApprovalActionResult {
  approvalId: string;
  matched: number;
  drained: number;
  alreadyStored: number;
  denied: number;
}

const LEASE_DURATION_S = STAGING_LEASE_DURATION_S;
const ITEM_TTL_S = STAGING_ITEM_TTL_S;

/** In-memory staging inbox. */
// Module-private state lives on `globalThis` so Metro's bundler can't
// split it across two copies of this module when the same file resolves
// via both a relative path (from inside @dina/core) and an `@dina/core/...`
// symlink import (from apps/mobile). Without this, `inbox` populated by
// `ingest()` in one copy was invisible to `claim()` in the other copy,
// leaving the staging drain tick permanently empty. Jest + Node-side
// tests are unaffected — they load one module instance anyway, and the
// globalThis indirection is free.
interface StagingGlobals {
  inbox: Map<string, StagingItem>;
  dedupIndex: Map<string, string>;
}
const globalWithStaging = globalThis as unknown as { __dinaStagingState?: StagingGlobals };
const _stagingState: StagingGlobals =
  globalWithStaging.__dinaStagingState ??
  (globalWithStaging.__dinaStagingState = { inbox: new Map(), dedupIndex: new Map() });
const inbox = _stagingState.inbox;

/** Dedup index: "producer_id|source|source_id" → staging ID. */
const dedupIndex = _stagingState.dedupIndex;

function dedupKey(producerId: string, source: string, sourceId: string): string {
  return `${producerId}|${source}|${sourceId}`;
}

function cacheItem(item: StagingItem): void {
  inbox.set(item.id, item);
  dedupIndex.set(dedupKey(item.producer_id, item.source, item.source_id), item.id);
}

function removeCachedItem(item: StagingItem): void {
  inbox.delete(item.id);
  dedupIndex.delete(dedupKey(item.producer_id, item.source, item.source_id));
}

function loadItem(id: string): StagingItem | null {
  const repo = getStagingRepository();
  if (repo) {
    const item = repo.get(id);
    if (item) cacheItem(item);
    else inbox.delete(id);
    return item;
  }
  return inbox.get(id) ?? null;
}

function replaceCacheFromRepository(repo: StagingRepository): number {
  inbox.clear();
  dedupIndex.clear();
  const items = repo.listAll();
  for (const item of items) cacheItem(item);
  return items.length;
}

export function hydrateStagingFromRepository(): number {
  const repo = getStagingRepository();
  return repo ? replaceCacheFromRepository(repo) : 0;
}

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

function stagingApprovalId(stagingId: string, persona: string): string {
  const safePersona = persona.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `approval-staging-${stagingId}-${safePersona}`;
}

function previewForApproval(
  item: StagingItem,
  classifiedItem?: Record<string, unknown>,
): string {
  const candidates = [
    classifiedItem?.summary,
    classifiedItem?.title,
    classifiedItem?.text,
    item.data.summary,
    item.data.subject,
    item.data.body,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '') return trimmed.length <= 180 ? trimmed : `${trimmed.slice(0, 180)}...`;
  }
  return '';
}

function createPersonaAccessApproval(
  item: StagingItem,
  persona: string,
  classifiedItem?: Record<string, unknown>,
): string {
  const service = getWorkflowService();
  if (service === null) {
    throw new Error(
      'staging: workflow service must be wired before parking locked persona targets',
    );
  }

  const approvalId = stagingApprovalId(item.id, persona);
  const existing = service.store().getById(approvalId);
  if (existing !== null) {
    if (isTerminalWorkflowState(existing.status as WorkflowTaskState)) {
      throw new Error(
        `staging: approval task "${approvalId}" is already terminal while target is still locked`,
      );
    }
    return approvalId;
  }

  const payload: StagingPersonaAccessApprovalPayload = {
    type: STAGING_PERSONA_ACCESS_APPROVAL_TYPE,
    approval_id: approvalId,
    staging_id: item.id,
    persona,
    source: item.source,
    source_id: item.source_id,
    producer_id: item.producer_id,
    preview: previewForApproval(item, classifiedItem),
  };

  try {
    service.create({
      id: approvalId,
      kind: WorkflowTaskKind.Approval,
      description: `Remember access for ${persona}`,
      payload: JSON.stringify(payload),
      expiresAtSec: item.expires_at,
      priority: WorkflowTaskPriority.UserBlocking,
      origin: 'system',
      idempotencyKey: approvalId,
      initialState: WorkflowTaskState.PendingApproval,
    });
  } catch (err) {
    if (err instanceof WorkflowConflictError) {
      const duplicate = service.store().getById(approvalId);
      if (duplicate !== null && !isTerminalWorkflowState(duplicate.status as WorkflowTaskState)) {
        return approvalId;
      }
    }
    throw err;
  }

  return approvalId;
}

function itemsByApprovalId(approvalId: string): StagingItem[] {
  const repo = getStagingRepository();
  const items = repo ? repo.listAll() : Array.from(inbox.values());
  return items.filter((item) => item.approval_id === approvalId);
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
  const repo = getStagingRepository();
  const dk = dedupKey(producer, input.source, input.source_id);

  if (repo) {
    const existing = repo.findByDedup(producer, input.source, input.source_id);
    if (existing) {
      cacheItem(existing);
      return { id: existing.id, duplicate: true };
    }
  } else {
    const existingId = dedupIndex.get(dk);
    if (existingId && inbox.has(existingId)) {
      return { id: existingId, duplicate: true };
    }
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

  if (repo) {
    const inserted = repo.ingest(item);
    if (!inserted) {
      const existing = repo.findByDedup(producer, input.source, input.source_id);
      if (existing) {
        cacheItem(existing);
        return { id: existing.id, duplicate: true };
      }
      throw new Error('staging: repository rejected ingest without an existing dedup row');
    }
  }
  cacheItem(item);
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
export function claim(limit = 10, leaseDurationSeconds?: number): StagingItem[] {
  const now = nowSeconds();
  const leaseDuration = leaseDurationSeconds ?? LEASE_DURATION_S;
  const repo = getStagingRepository();
  if (repo) {
    const claimed = repo.claim(limit, leaseDuration, now);
    for (const item of claimed) cacheItem(item);
    return claimed;
  }

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
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : inbox.get(id) ?? null;
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot resolve item in status "${item.status}"`);
  }

  const approvalId = personaOpen
    ? undefined
    : createPersonaAccessApproval(item, persona, classifiedItem);

  item.persona = persona;
  item.status = personaOpen ? 'stored' : 'pending_unlock';
  if (classifiedItem) {
    item.classified_item = classifiedItem;
  }
  if (approvalId !== undefined) {
    item.approval_id = approvalId;
  }

  // Vault write path: when persona is open AND classified data exists,
  // write the enriched item to the vault. This completes the staging→vault
  // pipeline — matching Go's storeToVault() call in Resolve.
  let storedOpenPersona: string | null = null;
  if (personaOpen && classifiedItem) {
    try {
      storeItem(persona, classifiedItem);
      storedOpenPersona = persona;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`staging: vault store failed for persona "${persona}": ${reason}`);
    }
  }

  // Clear raw body from data after classification (privacy protection).
  // The enriched content is in classified_item; the raw body is no longer
  // needed and should not linger in the inbox. Matches Go's body clearing
  // on resolve — prevents sensitive raw text from persisting after vault write.
  if (item.data.body !== undefined) {
    item.data = { ...item.data, body: '' };
  }

  if (repo) {
    repo.updateStatus(id, item.status, {
      persona: item.persona,
      data: item.data,
      ...(item.classified_item ? { classified_item: item.classified_item } : {}),
      ...(item.approval_id ? { approval_id: item.approval_id } : {}),
    });
  }
  cacheItem(item);
  if (storedOpenPersona && onDrainCallback) onDrainCallback(item, storedOpenPersona);
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
  targets: { persona: string; personaOpen: boolean }[],
  classifiedItem?: Record<string, unknown>,
): number {
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : inbox.get(id) ?? null;
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot resolve item in status "${item.status}"`);
  }
  if (targets.length === 0) {
    throw new Error('staging: resolveMulti requires at least one target persona');
  }
  const primary = targets[0];
  if (!primary) {
    throw new Error('staging: resolveMulti requires at least one target persona');
  }

  if (classifiedItem) {
    item.classified_item = classifiedItem;
  }

  // Create durable approvals before any open-persona writes. If Core
  // cannot persist the approval record, the resolve fails without
  // partially storing the open side of a multi-persona item.
  const lockedTargets = targets
    .filter((target) => !target.personaOpen)
    .map((target) => target.persona);
  const approvalIds = new Map<string, string>();
  for (const lockedPersona of lockedTargets) {
    const approvalItem =
      lockedPersona === primary.persona
        ? item
        : ({
            ...item,
            id: `${id}-${lockedPersona}`,
            source_id: `${item.source_id}:${lockedPersona}`,
            persona: lockedPersona,
            status: 'pending_unlock',
            classified_item: classifiedItem,
          } satisfies StagingItem);
    approvalIds.set(
      lockedPersona,
      createPersonaAccessApproval(approvalItem, lockedPersona, classifiedItem),
    );
  }

  // Track which personas actually got a vault row. A persona that
  // fails to store (validation reject, adapter error) must not
  // advance to the drain callback — otherwise post-publish hooks
  // fire against a row that doesn't exist.
  const storedPersonas: string[] = [];
  const failures: { persona: string; reason: string }[] = [];

  for (const target of targets) {
    if (target.personaOpen && classifiedItem) {
      try {
        storeItem(target.persona, classifiedItem);
        storedPersonas.push(target.persona);
      } catch (err) {
        // Surface the reason so the drain / ops can see WHY the vault
        // rejected the write (invalid type, missing required field,
        // adapter failure). A silent catch here would make the drain
        // report `stored: 1` even though no vault row
        // existed, making `/remember` appear to work but `/ask` find
        // nothing. The per-persona failure is still non-fatal: we
        // continue the loop so other targets can still store.
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ persona: target.persona, reason });
        // eslint-disable-next-line no-console
        console.warn(
          `[staging/resolveMulti] vault store failed persona=${target.persona} reason=${reason}`,
        );
      }
    }
  }

  // If NOTHING stored + nothing pending_unlock, the resolve is a
  // total loss — re-throw the first failure so the drain can mark
  // the staging item failed instead of silently moving on.
  if (storedPersonas.length === 0 && lockedTargets.length === 0 && failures.length > 0) {
    const firstFailure = failures[0];
    throw new Error(
      `staging: resolveMulti wrote 0 vault rows (all ${failures.length} targets failed): ${firstFailure?.reason ?? 'unknown'}`,
    );
  }

  // Create separate pending_unlock records for each locked secondary persona
  for (const lockedPersona of lockedTargets) {
    if (lockedPersona === primary.persona) continue; // primary handled below
    const copyId = `${id}-${lockedPersona}`;
    const copy: StagingItem = {
      ...item,
      id: copyId,
      source_id: `${item.source_id}:${lockedPersona}`,
      persona: lockedPersona,
      status: 'pending_unlock',
      classified_item: classifiedItem,
    };
    copy.approval_id = approvalIds.get(lockedPersona);
    if (repo) repo.ingest(copy);
    cacheItem(copy);
  }

  // Primary persona tracks on the original item
  item.persona = primary.persona;
  const primaryOpen = primary.personaOpen;
  if (!primaryOpen) {
    item.approval_id = approvalIds.get(primary.persona);
  }
  item.status = primaryOpen ? 'stored' : 'pending_unlock';

  // Clear raw body
  if (item.data.body !== undefined) {
    item.data = { ...item.data, body: '' };
  }

  if (repo) {
    repo.updateStatus(id, item.status, {
      persona: item.persona,
      data: item.data,
      ...(item.classified_item ? { classified_item: item.classified_item } : {}),
      ...(item.approval_id ? { approval_id: item.approval_id } : {}),
    });
  }
  cacheItem(item);
  if (onDrainCallback) {
    for (const storedPersona of storedPersonas) onDrainCallback(item, storedPersona);
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
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : inbox.get(id) ?? null;
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot fail item in status "${item.status}"`);
  }

  item.status = 'failed';
  item.retry_count += 1;
  if (errorMessage) {
    item.error = errorMessage;
  }
  if (repo) {
    repo.updateStatus(id, item.status, {
      retry_count: item.retry_count,
      ...(item.error ? { error: item.error } : {}),
    });
  }
  cacheItem(item);
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
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : inbox.get(id) ?? null;
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot mark pending_approval from status "${item.status}"`);
  }

  item.status = 'pending_approval';
  item.approval_id = approvalId;
  if (repo) repo.updateStatus(id, item.status, { approval_id: approvalId });
  cacheItem(item);
}

/**
 * Resume processing after approval is granted.
 *
 * Transitions pending_approval → classifying so the item can be
 * re-processed (resolve to vault).
 */
export function resumeAfterApprovalGranted(id: string): void {
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : inbox.get(id) ?? null;
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'pending_approval') {
    throw new Error(`staging: cannot resume from status "${item.status}"`);
  }

  item.status = 'classifying';
  item.lease_until = nowSeconds() + LEASE_DURATION_S;
  if (repo) repo.updateStatus(id, item.status, { lease_until: item.lease_until });
  cacheItem(item);
}

/**
 * Extend the lease on a claimed item by N seconds.
 *
 * Uses max(current lease_until, now) as the base — ensures extensions
 * never result in a lease that's already expired. Matches Go's
 * ExtendLease which computes from max(lease_until, current_time).
 */
export function extendLease(id: string, extensionSeconds: number): void {
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : inbox.get(id) ?? null;
  if (!item) throw new Error(`staging: item "${id}" not found`);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot extend lease on item in status "${item.status}"`);
  }

  const now = nowSeconds();
  const base = Math.max(item.lease_until, now);
  item.lease_until = base + extensionSeconds;
  if (repo) repo.updateStatus(id, item.status, { lease_until: item.lease_until });
  cacheItem(item);
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
  const repo = getStagingRepository();
  if (repo) {
    const result = repo.sweep(currentTime);
    replaceCacheFromRepository(repo);
    return result;
  }

  const result = { expired: 0, leaseReverted: 0, requeued: 0, deadLettered: 0 };

  for (const item of inbox.values()) {
    // 1. Delete expired items (7d TTL)
    if (isItemExpired(item.expires_at, currentTime)) {
      removeCachedItem(item);
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
  const repo = getStagingRepository();
  const items = repo ? repo.listByStatus('pending_unlock') : Array.from(inbox.values());
  for (const item of items) {
    if (item.status === 'pending_unlock' && item.persona === persona) {
      if (item.approval_id !== undefined) continue;
      // Write classified data to vault if available
      if (item.classified_item) {
        try {
          storeItem(persona, item.classified_item);
        } catch {
          /* fail-safe */
        }
      }
      item.status = 'stored';
      if (repo) repo.updateStatus(item.id, item.status);
      cacheItem(item);
      // OnDrain callback: post-publication event extraction
      if (onDrainCallback) onDrainCallback(item, persona);
      drained++;
    }
  }
  return drained;
}

/**
 * Store all staging rows guarded by one workflow approval task.
 *
 * This is the durable resume path for locked persona targets: the
 * workflow inbox owns the user decision, and staging owns the actual
 * pending_unlock → stored transition.
 */
export function drainForApproval(approvalId: string): StagingApprovalActionResult {
  const result: StagingApprovalActionResult = {
    approvalId,
    matched: 0,
    drained: 0,
    alreadyStored: 0,
    denied: 0,
  };
  const repo = getStagingRepository();
  for (const item of itemsByApprovalId(approvalId)) {
    result.matched++;
    if (item.status === 'stored') {
      result.alreadyStored++;
      continue;
    }
    if (item.status === 'failed') {
      result.denied++;
      continue;
    }
    if (item.status !== 'pending_unlock') continue;
    if (!item.classified_item) {
      throw new Error(
        `staging: pending unlock item "${item.id}" has no classified_item to store`,
      );
    }
    try {
      storeItem(item.persona, item.classified_item);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`staging: vault store failed for persona "${item.persona}": ${reason}`);
    }
    item.status = 'stored';
    if (repo) repo.updateStatus(item.id, item.status);
    cacheItem(item);
    if (onDrainCallback) onDrainCallback(item, item.persona);
    result.drained++;
  }
  return result;
}

/**
 * Reject all pending_unlock rows guarded by one workflow approval task.
 *
 * Denied rows are marked failed with retries exhausted so a later sweep
 * never requeues them for storage.
 */
export function denyApproval(
  approvalId: string,
  reason = 'approval_denied',
): StagingApprovalActionResult {
  const result: StagingApprovalActionResult = {
    approvalId,
    matched: 0,
    drained: 0,
    alreadyStored: 0,
    denied: 0,
  };
  const repo = getStagingRepository();
  const error = reason.trim() === '' ? 'approval_denied' : reason.trim();
  for (const item of itemsByApprovalId(approvalId)) {
    result.matched++;
    if (item.status === 'stored') {
      result.alreadyStored++;
      continue;
    }
    if (item.status === 'failed') {
      result.denied++;
      continue;
    }
    if (item.status !== 'pending_unlock') continue;
    item.status = 'failed';
    item.error = error;
    item.retry_count = Math.max(item.retry_count, STAGING_MAX_RETRIES + 1);
    if (repo) {
      repo.updateStatus(item.id, item.status, {
        error: item.error,
        retry_count: item.retry_count,
      });
    }
    cacheItem(item);
    result.denied++;
  }
  return result;
}

/** Get a staging item by ID. */
export function getItem(id: string): StagingItem | null {
  return loadItem(id);
}

/** Get inbox size. */
export function inboxSize(): number {
  const repo = getStagingRepository();
  return repo ? repo.size() : inbox.size;
}

/** Reset all staging state (for testing). */
export function resetStagingState(options?: { preserveRepositoryRows?: boolean }): void {
  inbox.clear();
  dedupIndex.clear();
  onDrainCallback = null;
  const repo = getStagingRepository();
  if (repo && options?.preserveRepositoryRows !== true) repo.clear();
}

/**
 * List all staging items with a given status.
 *
 * Matching Go's ListByStatus — used for monitoring and batch operations.
 */
export function listByStatus(status: StagingStatus): StagingItem[] {
  const repo = getStagingRepository();
  if (repo) {
    const items = repo.listByStatus(status);
    for (const item of items) cacheItem(item);
    return items;
  }

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
  const item = loadItem(id);
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
