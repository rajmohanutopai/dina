/**
 * Plugin decision log — `plugin_decisions` (PLUGIN_ARCHITECTURE.md §14,
 * migration v18).
 *
 * Clone of the `contact_service_decisions` v16 pattern: OWNER-private
 * (owner-visible in Activity, never brain/LLM-readable — the authz
 * matrix must never grant `brain` a read on this surface), append-only
 * records of the past. §9.5 reconciliation actions (confirmed-happened
 * / confirmed-didn't / unresolved) land HERE, beside the parked task —
 * never as a task-state rewrite. late_report evidence surfacing also
 * reads from this log's Activity projection.
 *
 * Reasons are short non-PII policy tags; never vault content, never
 * params.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type PluginDecisionKind =
  | 'consent_granted'
  | 'consent_declined'
  | 'invocation_approved'
  | 'invocation_denied'
  | 'grant_created'
  | 'grant_revoked'
  | 'update_applied'
  | 'update_declined'
  | 'paused'
  | 'resumed'
  | 'uninstalled'
  | 'advisory_disable'
  | 'reconciled_confirmed_happened'
  | 'reconciled_confirmed_not_happened'
  | 'reconciled_unresolved'
  | 'late_report_received';

export interface PluginDecision {
  id: number;
  installId: string;
  capability: string;
  decision: PluginDecisionKind;
  reason: string;
  createdAt: number;
}

export interface PluginDecisionRepository {
  record(args: {
    installId: string;
    capability?: string;
    decision: PluginDecisionKind;
    reason?: string;
    nowSec: number;
  }): number;
  listByInstall(installId: string, limit: number): PluginDecision[];
  listRecent(limit: number): PluginDecision[];
}

let repo: PluginDecisionRepository | null = null;
export function setPluginDecisionRepository(r: PluginDecisionRepository | null): void {
  repo = r;
}
export function getPluginDecisionRepository(): PluginDecisionRepository | null {
  return repo;
}

function rowToDecision(r: DBRow): PluginDecision {
  return {
    id: Number(r.id),
    installId: String(r.install_id),
    capability: typeof r.capability === 'string' ? r.capability : '',
    decision: String(r.decision) as PluginDecisionKind,
    reason: typeof r.reason === 'string' ? r.reason : '',
    createdAt: Number(r.created_at),
  };
}

export class SQLitePluginDecisionRepository implements PluginDecisionRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  record(args: {
    installId: string;
    capability?: string;
    decision: PluginDecisionKind;
    reason?: string;
    nowSec: number;
  }): number {
    this.db.execute(
      `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
       VALUES (?,?,?,?,?)`,
      [args.installId, args.capability ?? '', args.decision, args.reason ?? '', args.nowSec],
    );
    const rows = this.db.query<{ id: number }>('SELECT last_insert_rowid() AS id');
    return rows.length > 0 ? Number(rows[0].id) : 0;
  }

  listByInstall(installId: string, limit: number): PluginDecision[] {
    const rows = this.db.query(
      `SELECT * FROM plugin_decisions WHERE install_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [installId, limit],
    );
    return rows.map(rowToDecision);
  }

  listRecent(limit: number): PluginDecision[] {
    const rows = this.db.query(
      'SELECT * FROM plugin_decisions ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit],
    );
    return rows.map(rowToDecision);
  }
}
