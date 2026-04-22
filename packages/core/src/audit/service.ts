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

import { buildAuditEntry, verifyChain, type AuditEntry } from './hash_chain';
import { getAuditRepository } from './repository';

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

/**
 * Monotonic sequence counter — never decremented, even after purge.
 * Prevents seq collision that would occur with `log.length + 1`.
 * Matches Go's AUTOINCREMENT behavior.
 */
let nextSeq = 1;

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
): AuditEntry {
  // Input validation — actor and action are required (matching Go's error path)
  if (!actor || actor.trim().length === 0) {
    throw new Error('audit: actor is required');
  }
  if (!action || action.trim().length === 0) {
    throw new Error('audit: action is required');
  }

  const seq = nextSeq++;
  const prevHash = log.length > 0 ? log[log.length - 1].entry_hash : '';
  const entry = buildAuditEntry(seq, actor, action, resource, detail ?? '', prevHash, tsOverride);
  log.push(entry);
  // SQL write-through — fire-and-forget since Phase 2.3 (task 2.3).
  // The in-memory `log` is the authoritative read source within the
  // process; SQL persists across restart but a transient write failure
  // doesn't affect correctness (the prior `try/catch` with fail-safe
  // comment already encoded this). Keeping `appendAudit` sync preserves
  // every caller's existing signature (7 files across core + brain).
  const sqlRepo = getAuditRepository();
  if (sqlRepo) {
    void sqlRepo.append(entry).catch(() => {
      /* fail-safe — transient SQL write loss is acceptable */
    });
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
): AuditEntry {
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
  return verifyChain(log);
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
    log.length = 0;
    return purged;
  }

  if (keepFromIndex === 0) {
    return 0; // nothing to purge
  }

  // Splice out old entries in one operation (O(n))
  const purged = keepFromIndex;
  log.splice(0, keepFromIndex);
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
  nextSeq = 1;
  retentionDays = 90;
}
