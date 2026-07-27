/**
 * Audit service — append-only hash-chained log with query and retention.
 *
 * Every security-relevant action is appended to the audit log.
 * Entries form a tamper-evident chain (SHA-256 hash of previous entry).
 * 90-day retention: older entries are purged by sweepRetention.
 *
 * Key design decisions (matching Go audit.go):
 *   - Colon-separated canonical hash format
 *   - Genesis marker "genesis" for first entry
 *   - Monotonic seq counter (never reused, even after purge)
 *   - Newest-first query order
 *   - Max query limit of 200
 *
 * Source: ARCHITECTURE.md Task 2.48
 */

import { buildAuditEntry, computeEntryHash, type AuditEntry } from './hash_chain';
import { getAuditRepository, type AuditRepository } from './repository';

/** Default retention period in days. Configurable via setRetentionDays(). */
let retentionDays = 90;

function getRetentionMs(): number {
  return retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Set the audit retention period in days.
 * Default: 90 days. Matching Go's configurable retention.
 */
export function setRetentionDays(days: number): void {
  if (days < 1) throw new Error('audit: retention must be at least 1 day');
  retentionDays = days;
}

/** Get the current retention period in days. */
export function getRetentionDays(): number {
  return retentionDays;
}

// ---------------------------------------------------------------
// Structured audit detail (matching Go's JSON-packed detail field)
// ---------------------------------------------------------------

/**
 * Structured audit detail — sub-fields packed into JSON.
 *
 * Matching Go's detail JSON blob with query_type, reason, metadata.
 * The flat `detail` string is replaced with structured context
 * that preserves audit semantics.
 */
export interface AuditDetail {
  query_type?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  text?: string; // free-form text (backward compatible with flat detail)
}

/**
 * Build a JSON-packed detail string from structured sub-fields.
 * Matching Go's detail JSON packing.
 */
export function buildAuditDetail(detail: AuditDetail): string {
  return JSON.stringify(detail);
}

/**
 * Parse a detail string back into structured sub-fields.
 * If the detail is not valid JSON, wraps it as { text: detail }.
 */
export function parseAuditDetail(detail: string): AuditDetail {
  if (!detail) return {};
  try {
    return JSON.parse(detail);
  } catch {
    return { text: detail };
  }
}

/** Maximum query result size (matching Go's cap). */
const MAX_QUERY_LIMIT = 200;

/** In-memory audit log. Append-only array. */
const log: AuditEntry[] = [];

/** Repetitive low-risk decisions may be sampled without skipping evaluation. */
const sampledAtMs = new Map<string, number>();
const MAX_SAMPLE_KEYS = 2_048;

/**
 * Monotonic sequence counter — never decremented, even after purge.
 * Prevents seq collision that would occur with `log.length + 1`.
 * Matches Go's AUTOINCREMENT behavior.
 */
let nextSeq = 1;
let retainedAnchorHash = 'genesis';

/**
 * Load and validate the durable chain before routes begin serving traffic.
 * A tampered or structurally invalid audit database is not silently replaced
 * with a fresh chain.
 */
export function hydrateAuditState(repository: AuditRepository | null = getAuditRepository()): void {
  if (repository === null) return;
  const entries = repository.allEntries();
  const highestSequence = repository.highestSequence();
  const checkpoint = repository.retentionCheckpoint();
  const anchorHash = checkpoint?.anchorHash ?? 'genesis';
  const expectedFirstSequence = checkpoint?.firstRetainedSeq ?? 1;
  const actualFirstSequence = entries[0]?.seq ?? highestSequence + 1;
  const latestSequence = entries[entries.length - 1]?.seq ?? 0;
  const tailMatches =
    entries.length > 0
      ? latestSequence === highestSequence
      : checkpoint === null
        ? highestSequence === 0
        : highestSequence === expectedFirstSequence - 1;
  if (
    actualFirstSequence !== expectedFirstSequence ||
    !tailMatches ||
    !verifyRetainedChain(entries, anchorHash).valid
  ) {
    throw new Error('audit: durable hash chain verification failed');
  }
  log.length = 0;
  log.push(...entries);
  sampledAtMs.clear();
  retainedAnchorHash = anchorHash;
  nextSeq = highestSequence + 1;
}

/**
 * Append an audit entry.
 *
 * Automatically computes seq (monotonic), prev_hash, and entry_hash
 * using the hash_chain primitives. Returns the appended entry.
 */
export function appendAudit(
  actor: string,
  action: string,
  resource: string,
  detail?: string,
  /** Optional Unix-seconds timestamp override for import/migration. */
  tsOverride?: number,
): AuditEntry | null {
  // Input validation — actor and action are required (matching Go's error path)
  if (!actor || actor.trim().length === 0) {
    throw new Error('audit: actor is required');
  }
  if (!action || action.trim().length === 0) {
    throw new Error('audit: action is required');
  }

  const seq = nextSeq;
  const prevHash =
    log.length > 0
      ? log[log.length - 1].entry_hash
      : retainedAnchorHash === 'genesis'
        ? ''
        : retainedAnchorHash;
  const entry = buildAuditEntry(seq, actor, action, resource, detail ?? '', prevHash, tsOverride);
  const sqlRepo = getAuditRepository();
  if (sqlRepo) {
    try {
      sqlRepo.append(entry);
    } catch {
      // Audit is a best-effort side effect at existing call sites. Do not
      // publish an in-memory entry that did not commit, but also do not turn a
      // completed external action into a retry and risk executing it twice.
      return null;
    }
  }
  log.push(entry);
  nextSeq += 1;
  return entry;
}

/**
 * Append at most one matching audit event per sampling window.
 *
 * This is for repetitive SAFE/allow decisions only. Policy evaluation still
 * runs for every call, while high-risk, denied, and approval decisions continue
 * to use appendAudit and are never sampled.
 */
export function appendSampledAudit(
  actor: string,
  action: string,
  resource: string,
  detail: string,
  options: {
    key: string;
    intervalMs: number;
    nowMs?: number;
  },
): AuditEntry | null {
  if (options.intervalMs < 1) {
    throw new Error('audit: sample interval must be positive');
  }
  const nowMs = options.nowMs ?? Date.now();
  const lastAt = sampledAtMs.get(options.key);
  if (lastAt !== undefined && nowMs - lastAt < options.intervalMs) {
    return null;
  }

  if (sampledAtMs.size >= MAX_SAMPLE_KEYS) {
    const staleBefore = nowMs - options.intervalMs;
    for (const [key, sampledAt] of sampledAtMs) {
      if (sampledAt < staleBefore) sampledAtMs.delete(key);
    }
    while (sampledAtMs.size >= MAX_SAMPLE_KEYS) {
      const oldestKey = sampledAtMs.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      sampledAtMs.delete(oldestKey);
    }
  }

  const entry = appendAudit(actor, action, resource, detail);
  if (entry !== null) {
    sampledAtMs.delete(options.key);
    sampledAtMs.set(options.key, nowMs);
  }
  return entry;
}

/**
 * Append an audit entry with structured detail (JSON-packed sub-fields).
 *
 * Matching Go's audit entries that pack query_type, reason, metadata
 * into the detail JSON blob.
 */
export function appendAuditWithDetail(
  actor: string,
  action: string,
  resource: string,
  detail: AuditDetail,
): AuditEntry | null {
  return appendAudit(actor, action, resource, buildAuditDetail(detail));
}

/**
 * Query audit entries with optional filters.
 *
 * Filters by actor, action, resource, and time range.
 * Returns matching entries in newest-first order (matching Go).
 * Limit is capped at MAX_QUERY_LIMIT (200).
 */
export function queryAudit(filters?: {
  actor?: string;
  action?: string;
  resource?: string;
  since?: number; // unix ms timestamp
  until?: number; // unix ms timestamp
  limit?: number;
}): AuditEntry[] {
  let results = [...log];

  if (filters?.actor) {
    results = results.filter((e) => e.actor === filters.actor);
  }
  if (filters?.action) {
    results = results.filter((e) => e.action === filters.action);
  }
  if (filters?.resource) {
    results = results.filter((e) => e.resource === filters.resource);
  }
  if (filters?.since) {
    const sinceS = Math.floor(filters.since / 1000);
    results = results.filter((e) => e.ts >= sinceS);
  }
  if (filters?.until) {
    const untilS = Math.floor(filters.until / 1000);
    results = results.filter((e) => e.ts <= untilS);
  }

  // Newest-first ordering (matching Go's default)
  results.reverse();

  // Apply limit with cap
  const effectiveLimit = filters?.limit
    ? Math.min(filters.limit, MAX_QUERY_LIMIT)
    : MAX_QUERY_LIMIT;
  results = results.slice(0, effectiveLimit);

  return results;
}

/**
 * Verify the integrity of the full audit chain.
 *
 * Returns { valid: true } if the chain is intact, or
 * { valid: false, brokenAt: N } if entry N's hash doesn't match.
 */
export function verifyAuditChain(): { valid: boolean; brokenAt?: number } {
  return verifyRetainedChain(log, retainedAnchorHash);
}

/**
 * Sweep entries older than 90 days.
 * Returns the count of purged entries.
 *
 * Uses splice instead of shift() loop for O(n) instead of O(n²).
 *
 * Note: this breaks the hash chain at the purge point.
 * In production, a compaction marker is stored so verification
 * starts from the new head.
 */
export function sweepRetention(now?: number): number {
  const cutoff = ((now ?? Date.now()) - getRetentionMs()) / 1000;

  // Find first entry that's within retention
  const keepFromIndex = log.findIndex((e) => e.ts >= cutoff);

  if (keepFromIndex === -1) {
    // All entries are old — purge everything
    const purged = log.length;
    if (purged === 0) return 0;
    const lastRemoved = log[log.length - 1];
    const checkpoint = {
      firstRetainedSeq: lastRemoved.seq + 1,
      anchorHash: lastRemoved.entry_hash,
    };
    const sqlRepo = getAuditRepository();
    if (sqlRepo) sqlRepo.compact(checkpoint);
    log.length = 0;
    retainedAnchorHash = checkpoint.anchorHash;
    return purged;
  }

  if (keepFromIndex === 0) {
    return 0; // nothing to purge
  }

  // Splice out old entries in one operation (O(n))
  const purged = keepFromIndex;
  const checkpoint = {
    firstRetainedSeq: log[keepFromIndex].seq,
    anchorHash: log[keepFromIndex].prev_hash,
  };
  const sqlRepo = getAuditRepository();
  if (sqlRepo) sqlRepo.compact(checkpoint);
  log.splice(0, keepFromIndex);
  retainedAnchorHash = checkpoint.anchorHash;
  return purged;
}

/** Get the total number of audit entries. */
export function auditCount(): number {
  return log.length;
}

/** Get the latest entry. Returns null if log is empty. */
export function latestEntry(): AuditEntry | null {
  return log.length > 0 ? log[log.length - 1] : null;
}

/** Reset all audit state (for testing). */
export function resetAuditState(): void {
  log.length = 0;
  sampledAtMs.clear();
  nextSeq = 1;
  retainedAnchorHash = 'genesis';
  retentionDays = 90;
}

function verifyRetainedChain(
  entries: readonly AuditEntry[],
  anchorHash: string = entries[0]?.prev_hash ?? 'genesis',
): { valid: boolean; brokenAt?: number } {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedPrevious = index === 0 ? anchorHash : entries[index - 1].entry_hash;
    if (
      !Number.isSafeInteger(entry.seq) ||
      entry.seq < 1 ||
      (index > 0 && entry.seq !== entries[index - 1].seq + 1) ||
      entry.prev_hash !== expectedPrevious
    ) {
      return { valid: false, brokenAt: index };
    }
    const { entry_hash: _entryHash, ...unsigned } = entry;
    if (computeEntryHash(unsigned) !== entry.entry_hash) {
      return { valid: false, brokenAt: index };
    }
  }
  return { valid: true };
}
