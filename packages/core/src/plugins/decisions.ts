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

import { hasUnsafeText } from '@dina/protocol';

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

/** Round-15 #17: the runtime allowlist of decision kinds — one source of truth
 *  for the read-side guard here AND the archive-import filter. */
export const VALID_PLUGIN_DECISION_KINDS: ReadonlySet<string> = new Set<PluginDecisionKind>([
  'consent_granted',
  'consent_declined',
  'invocation_approved',
  'invocation_denied',
  'grant_created',
  'grant_revoked',
  'update_applied',
  'update_declined',
  'paused',
  'resumed',
  'uninstalled',
  'advisory_disable',
  'reconciled_confirmed_happened',
  'reconciled_confirmed_not_happened',
  'reconciled_unresolved',
  'late_report_received',
]);

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

// PLG-27 #18: one row-well-formedness contract enforced at the WRITE boundary
// (record), the READ boundary (rowToDecision), AND the archive import filter
// (archive.ts) — previously only the archive path validated the full row while
// record()/rowToDecision checked far less. install_id is a bounded, spoof-free,
// NON-EMPTY string; capability/reason are bounded + spoof-free (empty allowed);
// the timestamp is a non-negative integer. Internal callers already pass safe
// policy-tag values, so this is defense-in-depth that keeps the owner-private
// log from drifting out of the invariant the importer enforces.
const DECISION_ID_MAX = 256; // install_id / capability
const DECISION_REASON_MAX = 512;
function validDecisionText(v: string, max: number): boolean {
  return v.length <= max && !hasUnsafeText(v);
}
function validDecisionTimestamp(t: number): boolean {
  return Number.isInteger(t) && t >= 0;
}

function rowToDecision(r: DBRow): PluginDecision | null {
  // Round-15 #17: fail closed on an unknown decision kind (a value that slipped
  // past the archive-import filter or a corrupt/foreign row) — drop it from the
  // owner-facing audit listing rather than blindly casting garbage into the UI.
  const decision = String(r.decision);
  if (!VALID_PLUGIN_DECISION_KINDS.has(decision)) return null;
  // PLG-28 #17: validate `id` + `install_id` at their SOURCE type, before
  // coercion. `String(null)` → the clean 4-char string "null" (which passed the
  // text checks and hydrated a phantom install named "null"), and `Number(r.id)`
  // accepted NaN / fractional / negative. Align the live read with the archive-
  // import contract (archive.ts) which already rejects both.
  const id = Number(r.id);
  if (typeof r.install_id !== 'string' || !Number.isInteger(id) || id < 0) return null;
  // PLG-27 #18: enforce the FULL row contract on read, not just the enum.
  const installId = r.install_id;
  const capability = typeof r.capability === 'string' ? r.capability : '';
  const reason = typeof r.reason === 'string' ? r.reason : '';
  const createdAt = Number(r.created_at);
  if (
    installId === '' ||
    !validDecisionText(installId, DECISION_ID_MAX) ||
    !validDecisionText(capability, DECISION_ID_MAX) ||
    !validDecisionText(reason, DECISION_REASON_MAX) ||
    !validDecisionTimestamp(createdAt)
  ) {
    return null;
  }
  return {
    id,
    installId,
    capability,
    decision: decision as PluginDecisionKind,
    reason,
    createdAt,
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
    const capability = args.capability ?? '';
    const reason = args.reason ?? '';
    // PLG-27 #18: enforce the same contract on WRITE that the archive importer +
    // rowToDecision enforce on READ, so a malformed / spoofed row can't be
    // persisted in the first place. Real callers always pass safe values (system
    // install ids, catalog capability ids, short policy-tag reasons), so a
    // violation is a programming error and fails closed loudly rather than
    // silently poisoning the owner-private audit log.
    if (
      typeof args.installId !== 'string' ||
      args.installId === '' ||
      !validDecisionText(args.installId, DECISION_ID_MAX) ||
      !validDecisionText(capability, DECISION_ID_MAX) ||
      !validDecisionText(reason, DECISION_REASON_MAX) ||
      !VALID_PLUGIN_DECISION_KINDS.has(args.decision) ||
      !validDecisionTimestamp(args.nowSec)
    ) {
      throw new Error('plugin decision row violates the well-formedness contract');
    }
    this.db.execute(
      `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
       VALUES (?,?,?,?,?)`,
      [args.installId, capability, args.decision, reason, args.nowSec],
    );
    const rows = this.db.query<{ id: number }>('SELECT last_insert_rowid() AS id');
    return rows.length > 0 ? Number(rows[0].id) : 0;
  }

  listByInstall(installId: string, limit: number): PluginDecision[] {
    const rows = this.db.query(
      `SELECT * FROM plugin_decisions WHERE install_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [installId, clampDecisionLimit(limit)],
    );
    return rows.map(rowToDecision).filter((d): d is PluginDecision => d !== null);
  }

  listRecent(limit: number): PluginDecision[] {
    const rows = this.db.query(
      'SELECT * FROM plugin_decisions ORDER BY created_at DESC, id DESC LIMIT ?',
      [clampDecisionLimit(limit)],
    );
    return rows.map(rowToDecision).filter((d): d is PluginDecision => d !== null);
  }
}

/**
 * PLG-28 #18: clamp a caller-supplied list limit. SQLite treats `LIMIT -1` as NO
 * limit (returns the whole append-only log) and an arbitrarily large value
 * materializes it too. Bound to [1, 500]; a non-positive / non-integer limit
 * falls back to a sane default of 100.
 */
const DECISION_LIST_MAX = 500;
function clampDecisionLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, DECISION_LIST_MAX) : 100;
}

/**
 * PLG-28 #2: a decision-log write is an append-only audit SIDE EFFECT — it must
 * NEVER fail the primary lifecycle mutation that already committed. `record()`
 * throws on a malformed row (PLG-27 #18), and every caller
 * (confirmConsent/declineConsent/uninstall/late-report/device-revoke) calls it
 * AFTER its durable change — so a throw would misreport a committed success as an
 * error (and, inside a txn, roll back the evidence event). Callers use this
 * fire-safe wrapper: log-and-continue. Logs only non-PII identifiers.
 */
export function recordDecisionSafe(args: {
  installId: string;
  capability?: string;
  decision: PluginDecisionKind;
  reason?: string;
  nowSec: number;
}): void {
  try {
    getPluginDecisionRepository()?.record(args);
  } catch (err) {
    console.error(
      `[plugin-decisions] audit write failed (install=${args.installId} decision=${args.decision}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
