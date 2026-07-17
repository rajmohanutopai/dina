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
import { isPersonaOpen, personaExists } from '../persona/service';
import { currentDataScope, setCurrentDataScope, type DataScope } from '../scope/data_scope';
import { storeItem } from '../vault/crud';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  isTerminal as isTerminalWorkflowState,
} from '../workflow/domain';
import { WorkflowConflictError, getWorkflowService } from '../workflow/service';

import { getStagingRepository, type StagingRepository } from './repository';
import { type StagingStatus, shouldRetry, isLeaseExpired, isItemExpired } from './state_machine';

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
  /**
   * SHA-256 of the serialized data payload at ingest (matching Go source_hash).
   * PLG-31 #20: this is an ADVISORY fingerprint only — NO read/claim/resolve path
   * verifies it against the stored payload, and per PLG-31 #1 the producer controls
   * both `data` and thus its own hash, so it cannot detect owner-provenance
   * tampering. Do NOT treat it as an integrity/tamper-detection guarantee.
   */
  source_hash: string;
  /** Enriched VaultItem JSON stored on resolve for later drain (matching Go classified_item). */
  classified_item?: Record<string, unknown>;
  /** Error message from the last failed processing attempt (matching Go error column). */
  error?: string;
  /** Approval request ID when item is pending_approval (matching Go). */
  approval_id?: string;
  /**
   * Data scope the item was ingested in (guided-demo isolation). Stamped at
   * `ingest` from the runtime scope. The drain only CLAIMS items in the current
   * scope, and resolve pins the vault write to THIS scope, so a guided-demo
   * staging row can never drain into the user vault — and `tearDownDataScope`
   * deletes it. Defaults to `user` for rows written before the column existed.
   */
  data_scope: DataScope;
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

function dedupKey(producerId: string, source: string, sourceId: string, scope: DataScope): string {
  // data_scope is part of the dedup key (mirrors the v13 UNIQUE constraint): a
  // demo row and a user row with the same (producer, source, source_id) are
  // distinct rows, not duplicates.
  return `${producerId}|${source}|${sourceId}|${scope}`;
}

function cacheItem(item: StagingItem): void {
  inbox.set(item.id, item);
  dedupIndex.set(dedupKey(item.producer_id, item.source, item.source_id, item.data_scope), item.id);
}

function removeCachedItem(item: StagingItem): void {
  inbox.delete(item.id);
  dedupIndex.delete(dedupKey(item.producer_id, item.source, item.source_id, item.data_scope));
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

/**
 * PLG-32 #25: fire the OnDrain hook in ISOLATION. The hook runs AFTER the
 * durable vault write + status persist, so a throw from it must NOT bubble out
 * and turn a committed store into an apparent failure (which the caller would
 * retry against already-stored data) or abort the rest of a batch drain. Post-
 * publication processing (event extraction, last-seen, reminder planning) is
 * best-effort by definition; log and swallow.
 */
function fireOnDrain(item: StagingItem, persona: string): void {
  if (!onDrainCallback) return;
  try {
    onDrainCallback(item, persona);
  } catch (err) {
    console.warn(
      `[staging] OnDrain hook threw after commit (persona=${persona}, item=${item.id}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Store a classified item into the vault PINNED to the staging row's own data
 * scope, then restore the prior runtime scope. The interval drain's
 * claim→enrich→resolve has an async gap (LLM enrichment); if the runtime scope
 * flips (e.g. the user exits a guided demo) during that gap, an unpinned
 * `storeItem` would write the row's vault item into whatever scope is current —
 * leaking a demo memory into the user vault. Pinning makes the vault row land
 * in `item.data_scope` regardless of the live scope. The vault's
 * `scopedInsertFields` reads `currentDataScope()`, so this temporary set is the
 * one authoritative way to redirect the write.
 */
function storeItemInScope(
  persona: string,
  classifiedItem: Record<string, unknown>,
  scope: DataScope,
  ownedId: string,
): void {
  // PLG-29 #3: Core OWNS the vault primary key — NEVER trust a classifier /
  // producer-supplied `id`. `storeItem` uses INSERT-OR-REPLACE keyed on the
  // item id, so a supplied id that collides with an existing vault row would
  // REPLACE (overwrite) that unrelated record. The classifier/enrichment output
  // arrives at Core as untrusted brain-supplied data, so we stamp the
  // Core-derived id (`stg-<stagingId>`, deterministic for crash-recovery
  // idempotency) on a SHALLOW COPY — the caller's stored classified_item is
  // untouched, and any supplied `id` can never dictate the storage key.
  const owned = { ...classifiedItem, id: ownedId };
  const prev = currentDataScope();
  if (scope !== prev) setCurrentDataScope(scope);
  try {
    storeItem(persona, owned);
  } finally {
    if (scope !== prev) setCurrentDataScope(prev);
  }
}

/**
 * Guard for exact-ID staging mutations (resolve / fail / extendLease /
 * markPendingApproval / …). A claimed item is always claimed in the current
 * scope (claim is scope-filtered), so a by-id mutation should never touch a row
 * from a DIFFERENT scope. This asserts that — defense-in-depth for the scope
 * model, mirroring the "exact-ID deletes are still scope-bound" rule in
 * `scope/repository.ts`. The realistic trigger is a runtime scope flip between
 * claim and resolve (e.g. a guided demo exited mid-drain); throwing here makes
 * the drain mark the item failed instead of mutating a cross-scope row, and the
 * row is cleaned up with its own scope's teardown.
 */
function assertItemInCurrentScope(item: StagingItem): void {
  const scope = currentDataScope();
  if (item.data_scope !== scope) {
    throw new Error(
      `staging: item "${item.id}" belongs to scope "${item.data_scope}", not the current scope "${scope}"`,
    );
  }
}

function stagingApprovalId(stagingId: string, persona: string): string {
  const safePersona = persona.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `approval-staging-${stagingId}-${safePersona}`;
}

/**
 * Sources that originate directly from the device owner via the mobile app.
 * These bypass the persona access approval gate — the owner IS the approval
 * authority, so asking them to approve their own vault writes is meaningless.
 * External agents, connectors, and third-party pipelines are not in this set
 * and still require approval when the target persona vault is closed.
 */
export const OWNER_DIRECT_SOURCES = new Set(['user_remember']);

function previewForApproval(item: StagingItem, classifiedItem?: Record<string, unknown>): string {
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

/**
 * PLG-32 #8: best-effort roll back approval tasks created during a resolve that
 * then failed to persist all its targets. Cancelling is idempotent-safe (a
 * missing / already-terminal task is skipped) and must never mask the original
 * error — swallow any cancel failure.
 */
function cancelStagingApprovals(approvalIds: Map<string, string>, reason: string): void {
  const service = getWorkflowService();
  if (service === null) return;
  for (const approvalId of approvalIds.values()) {
    try {
      const existing = service.store().getById(approvalId);
      if (existing === null) continue;
      if (isTerminalWorkflowState(existing.status as WorkflowTaskState)) continue;
      service.cancel(approvalId, reason);
    } catch (err) {
      console.warn(
        `[staging] failed to roll back orphan approval "${approvalId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * PLG-32 #1: derive the effective open-state instead of blindly trusting the
 * caller's `persona_open`. `/v1/staging/resolve` is brain-only, and the sidecar
 * model treats the Brain as an UNTRUSTED tenant — a faulty/compromised Brain
 * that sends `persona_open=true` for a LOCKED persona would otherwise skip the
 * approval card and write straight into a sealed vault. Core owns the persona
 * registry, so it can refuse: when Core POSITIVELY knows the persona exists AND
 * is currently closed, override the caller's `true` to `false` (force the
 * approval gate). When Core has no record (e.g. a context where the registry
 * isn't populated), fall back to the caller's claim so existing flows are
 * unchanged — the override only ever tightens, never loosens.
 */
function effectivePersonaOpen(persona: string, claimedOpen: boolean): boolean {
  if (claimedOpen && personaExists(persona) && !isPersonaOpen(persona)) return false;
  return claimedOpen;
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
  // Dedup is per-scope: an item is only a duplicate of another in the SAME data
  // scope (a demo /remember and a user /remember of the same source are
  // distinct). Stamp + dedup against the current runtime scope.
  const scope = currentDataScope();
  const dk = dedupKey(producer, input.source, input.source_id, scope);

  if (repo) {
    const existing = repo.findByDedup(producer, input.source, input.source_id, scope);
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
    // Stamp the scope this item was ingested in — a guided-demo /remember tags
    // its rows so the drain never claims them outside the demo + cleanup can
    // delete them on teardown.
    data_scope: scope,
  };

  if (repo) {
    const inserted = repo.ingest(item);
    if (!inserted) {
      const existing = repo.findByDedup(producer, input.source, input.source_id, scope);
      if (existing) {
        cacheItem(existing);
        return { id: existing.id, duplicate: true };
      }
      // PLG-32 #10: the INSERT was IGNOREd (dedup key held) yet no row projects —
      // the key is occupied by a CORRUPT row that quarantines at read
      // (rowToStagingItem → null). Left alone this dead-locks the key forever: every
      // retry IGNOREs and every read returns null. Evict the unreadable row and
      // retry the insert once (repair-on-conflict) so a valid retry can proceed.
      repo.deleteByDedup(producer, input.source, input.source_id, scope);
      if (!repo.ingest(item)) {
        throw new Error('staging: repository rejected ingest after dedup-conflict repair');
      }
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
  // Only claim items belonging to the CURRENT data scope. This is the core of
  // guided-demo isolation: after a demo ends (scope → user) the interval drain
  // must never pick up a leftover demo staging row and resolve it into the user
  // vault. During the demo (scope → guided_demo:*) it claims only demo rows.
  const scope = currentDataScope();
  const repo = getStagingRepository();
  if (repo) {
    const claimed = repo.claim(limit, leaseDuration, now, scope);
    for (const item of claimed) cacheItem(item);
    return claimed;
  }

  const claimed: StagingItem[] = [];

  for (const item of inbox.values()) {
    if (claimed.length >= limit) break;
    if (item.status !== 'received') continue;
    if (item.data_scope !== scope) continue;

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
  claimedPersonaOpen: boolean,
  classifiedItem?: Record<string, unknown>,
): void {
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : (inbox.get(id) ?? null);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  assertItemInCurrentScope(item);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot resolve item in status "${item.status}"`);
  }

  // PLG-32 #1: Core decides open vs. locked, not the caller.
  const personaOpen = effectivePersonaOpen(persona, claimedPersonaOpen);
  const needsApproval = !personaOpen && !OWNER_DIRECT_SOURCES.has(item.source);
  const approvalId = needsApproval
    ? createPersonaAccessApproval(item, persona, classifiedItem)
    : undefined;

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
      storeItemInScope(persona, classifiedItem, item.data_scope, `stg-${item.id}`);
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
  if (storedOpenPersona) fireOnDrain(item, storedOpenPersona);
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
  claimedTargets: { persona: string; personaOpen: boolean }[],
  classifiedItem?: Record<string, unknown>,
): number {
  const repo = getStagingRepository();
  const item = repo ? repo.get(id) : (inbox.get(id) ?? null);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  assertItemInCurrentScope(item);
  if (item.status !== 'classifying') {
    throw new Error(`staging: cannot resolve item in status "${item.status}"`);
  }
  if (claimedTargets.length === 0) {
    throw new Error('staging: resolveMulti requires at least one target persona');
  }
  // PLG-32 #1: Core decides open vs. locked per target, not the caller — a
  // persona Core knows is closed can never be stored open on the caller's word.
  const targets = claimedTargets.map((t) => ({
    persona: t.persona,
    personaOpen: effectivePersonaOpen(t.persona, t.personaOpen),
  }));
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
  // Owner-direct sources skip the approval gate — the owner IS the
  // approval authority and does not need to approve their own writes.
  const lockedTargets = targets
    .filter((target) => !target.personaOpen)
    .map((target) => target.persona);
  const approvalIds = new Map<string, string>();
  if (!OWNER_DIRECT_SOURCES.has(item.source)) {
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
        storeItemInScope(target.persona, classifiedItem, item.data_scope, `stg-${item.id}`);
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

  // Create separate pending_unlock records for each locked secondary persona.
  // PLG-32 #8: the locked-target approvals were created ABOVE, before these
  // copies are persisted. If a copy fails to persist (dedup collision / storage
  // failure → the PLG-31 #12 throw), the already-created approval cards would be
  // ORPHANED — the owner sees an approvable card guarding a staging row that was
  // never written. Wrap the persistence so a throw cancels every approval this
  // call created before it propagates, leaving no dangling cards.
  try {
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
      if (repo && !repo.ingest(copy)) {
        // PLG-30 #4: a rejected INSERT OR IGNORE (id / dedup collision, storage
        // failure) must NOT be represented as a live target. Cache the AUTHORITATIVE
        // persisted row, not the un-persisted copy — otherwise the "target" exists
        // only in the in-memory cache and silently vanishes on restart. Mirrors the
        // primary-ingest reconcile at the top of `ingest`.
        const persisted = repo.get(copyId);
        if (persisted) {
          cacheItem(persisted);
          continue;
        }
        // PLG-31 #12: ingest was rejected AND no row exists at this id — the IGNORE
        // fired on the UNIQUE(producer_id, source, source_id, data_scope) key under a
        // DIFFERENT id, or storage failed. Do NOT fall through to cache the
        // un-persisted copy: that phantom would back an approval that disappears on
        // restart. Fail the resolve so the caller retries cleanly.
        throw new Error(
          `staging: secondary copy for persona "${lockedPersona}" could not be persisted (dedup collision or storage failure)`,
        );
      }
      cacheItem(copy);
    }
  } catch (err) {
    cancelStagingApprovals(approvalIds, 'resolve failed before persisting all targets');
    throw err;
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
  for (const storedPersona of storedPersonas) fireOnDrain(item, storedPersona);
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
  const item = repo ? repo.get(id) : (inbox.get(id) ?? null);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  assertItemInCurrentScope(item);
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
  const item = repo ? repo.get(id) : (inbox.get(id) ?? null);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  assertItemInCurrentScope(item);
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
  const item = repo ? repo.get(id) : (inbox.get(id) ?? null);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  assertItemInCurrentScope(item);
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
  const item = repo ? repo.get(id) : (inbox.get(id) ?? null);
  if (!item) throw new Error(`staging: item "${id}" not found`);
  assertItemInCurrentScope(item);
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
      // PLG-29 #20: FAIL CLOSED like drainForApproval — a swallowed store error
      // followed by `status = 'stored'` marked the row terminal though nothing
      // landed in the vault (silent data loss). Only mark stored AFTER a
      // successful store; on failure leave the row `pending_unlock` so a later
      // drain/sweep re-attempts, and skip it. (Per-item non-fatal — one bad item
      // must not abort the batch.) The Core-owned id (#3) is stamped in
      // storeItemInScope.
      if (item.classified_item) {
        try {
          storeItemInScope(persona, item.classified_item, item.data_scope, `stg-${item.id}`);
        } catch {
          continue; // leave pending_unlock; do NOT mark stored
        }
      } else {
        // PLG-31 #3: no classified payload → nothing to write. Marking this row
        // `stored` (below) would terminalize it as a success with an empty vault
        // (silent loss). Leave it pending_unlock and skip, mirroring the store-fail
        // branch and drainForApproval's payload guard.
        continue;
      }
      item.status = 'stored';
      if (repo) repo.updateStatus(item.id, item.status);
      cacheItem(item);
      // OnDrain callback: post-publication event extraction
      fireOnDrain(item, persona);
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
      throw new Error(`staging: pending unlock item "${item.id}" has no classified_item to store`);
    }
    // PLG-27 #6 + PLG-29 #3: the vault write uses a STABLE, deterministic,
    // Core-OWNED id (`stg-<stagingId>`), stamped in storeItemInScope. Stable →
    // storeItem's INSERT-OR-REPLACE is an idempotent upsert, so a crash after the
    // vault write but before the status persist doesn't duplicate on re-drain.
    // Core-owned → a classifier-supplied id can never dictate the key and
    // overwrite an unrelated vault row.
    try {
      storeItemInScope(item.persona, item.classified_item, item.data_scope, `stg-${item.id}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`staging: vault store failed for persona "${item.persona}": ${reason}`);
    }
    item.status = 'stored';
    if (repo) repo.updateStatus(item.id, item.status);
    cacheItem(item);
    fireOnDrain(item, item.persona);
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
 * Compute SHA-256 of a data payload — an ADVISORY fingerprint (matching Go's
 * source_hash). PLG-31 #20: it is written at ingest but NEVER verified downstream,
 * and cannot detect provenance tampering (the producer controls the data + hash),
 * so it is not an integrity/tamper-detection guarantee — only a deterministic
 * content fingerprint. Deterministic: same data always produces the same hash.
 */
export function computeSourceHash(data: Record<string, unknown>): string {
  const serialized = JSON.stringify(data);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}
