/**
 * Audit log data hook — browse, filter, verify chain.
 *
 * Provides:
 *   - Paginated audit entry list (most recent first)
 *   - Filter by actor, action, time range
 *   - Chain integrity verification
 *   - Entry count and latest entry info
 *   - Human-readable action labels
 *
 * Source: ARCHITECTURE.md Task 9.13
 */

import {
  appendAudit,
  queryAudit,
  verifyAuditChain,
  auditCount,
  latestEntry,
  resetAuditState,
} from '@dina/core/audit';
import type { AuditEntry } from '@dina/test-harness';

export interface AuditUIEntry {
  seq: number;
  timestamp: number;
  timeLabel: string;
  actor: string;
  actorLabel: string;
  action: string;
  actionLabel: string;
  resource: string;
  detail: string;
  hasHash: boolean;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  since?: number;
  until?: number;
}

export interface ChainVerification {
  valid: boolean;
  brokenAt: number | null;
  totalEntries: number;
  message: string;
}

/** Human-readable action labels. */
const ACTION_LABELS: Record<string, string> = {
  d2d_send: 'Sent D2D message',
  d2d_recv_staged: 'Received D2D message',
  d2d_recv_quarantined: 'Quarantined D2D message',
  d2d_recv_dropped: 'Dropped D2D message',
  d2d_recv_bad_sig: 'Rejected (bad signature)',
  d2d_recv_scenario_denied: 'Rejected (policy denied)',
  vault_store: 'Stored vault item',
  vault_delete: 'Deleted vault item',
  persona_unlock: 'Unlocked persona',
  persona_lock: 'Locked persona',
  approval_granted: 'Approval granted',
  approval_denied: 'Approval denied',
  config_change: 'Configuration changed',
  export_created: 'Export archive created',
  import_completed: 'Import completed',
};

/** Actor label mapping. */
const ACTOR_LABELS: Record<string, string> = {
  system: 'System',
  user: 'You',
  brain: 'Brain',
};

/**
 * Get audit entries with optional filters.
 * Returns most recent first.
 */
export function getAuditEntries(filter?: AuditFilter, limit?: number): AuditUIEntry[] {
  const entries = queryAudit({
    actor: filter?.actor,
    action: filter?.action,
    since: filter?.since,
    until: filter?.until,
    limit: limit ?? 50,
  });

  return entries.map(toUIEntry);
}

/**
 * Get distinct actors for the filter dropdown.
 */
export function getDistinctActors(): string[] {
  const entries = queryAudit({ limit: 1000 });
  return [...new Set(entries.map((e) => e.actor))].sort();
}

/**
 * Get distinct actions for the filter dropdown.
 */
export function getDistinctActions(): string[] {
  const entries = queryAudit({ limit: 1000 });
  return [...new Set(entries.map((e) => e.action))].sort();
}

/**
 * Verify the audit chain integrity.
 */
export function verifyChain(): ChainVerification {
  const total = auditCount();

  if (total === 0) {
    return { valid: true, brokenAt: null, totalEntries: 0, message: 'No audit entries to verify' };
  }

  const result = verifyAuditChain();

  return {
    valid: result.valid,
    brokenAt: result.brokenAt ?? null,
    totalEntries: total,
    message: result.valid
      ? `Chain verified: ${total} entries, all hashes valid`
      : `Chain broken at entry #${result.brokenAt} — possible tampering`,
  };
}

/**
 * Get a summary for the header bar.
 */
export function getAuditSummary(): {
  count: number;
  latestAction: string;
  latestTime: number | null;
} {
  const count = auditCount();
  const latest = latestEntry();

  return {
    count,
    latestAction: latest ? (ACTION_LABELS[latest.action] ?? latest.action) : '',
    latestTime: latest ? latest.ts * 1000 : null,
  };
}

/**
 * Reset (for testing).
 */
export function resetAudit(): void {
  resetAuditState();
}

/** Map AuditEntry to UI entry. */
function toUIEntry(e: AuditEntry): AuditUIEntry {
  return {
    seq: e.seq,
    timestamp: e.ts * 1000, // Unix seconds → milliseconds
    timeLabel: formatTimeLabel(e.ts * 1000),
    actor: e.actor,
    actorLabel: ACTOR_LABELS[e.actor] ?? e.actor,
    action: e.action,
    actionLabel: ACTION_LABELS[e.action] ?? e.action,
    resource: e.resource,
    detail: e.detail,
    hasHash: e.entry_hash.length > 0,
  };
}

/** Format timestamp as relative time or date. */
function formatTimeLabel(tsMs: number): string {
  const diff = Date.now() - tsMs;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(tsMs).toLocaleDateString();
}
