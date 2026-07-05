/**
 * Owner-private contact-service decision log (CONTACT_SERVICES_ARCHITECTURE.md
 * §2/§10). The GRANTOR's quiet, reviewable record of every inbound
 * `service.grant_request` and how policy responded — persisted in
 * identity.sqlite (`contact_service_decisions`, migration v16).
 *
 * Why it exists: the requester-visible outcome is deliberately collapsed (a
 * close/medium/distant contact all see the same "couldn't complete"), so the
 * owner needs a private place to see the TRUTH — "Alonso's Dina asked for
 * availability_coordination — auto-declined by policy" — and spot a mis-tiered
 * contact WITHOUT leaking social rank back to the requester.
 *
 * Privacy invariant: this is sensitive relationship metadata. It lives in THIS
 * node's encrypted identity DB, is NEVER sent to / synced to / derivable by the
 * requester, and is a LOG (surfaced in Activity), never a push. It is distinct
 * from the infra `audit_log` (debugging); this is the product-visible surface.
 *
 * **Sync-by-design** — same rationale as the other identity repos: a thin
 * wrapper over the exempt sync `DatabaseAdapter`.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

/**
 * What policy did with an inbound grant request. Mirrors the grant handler's
 * branches:
 *   - `granted`           — auto_grant (closeness 'close' + default-offerable).
 *   - `auto_declined`     — soft_reject (distant/unknown, or not offerable).
 *   - `prompt_shown`      — ask_to_enable; the owner got a one-time allow prompt.
 *   - `prompt_timed_out`  — an ask_to_enable prompt was dismissed/expired.
 *   - `error`             — the request failed to process (not wired, send error).
 */
export type ServiceDecisionOutcome =
  | 'granted'
  | 'auto_declined'
  | 'prompt_shown'
  | 'prompt_timed_out'
  | 'error';

export interface ServiceDecision {
  id: number;
  /** Who asked — the relay-authenticated `from_did`. */
  requesterDid: string;
  /** Canonical capability requested. */
  capability: string;
  decision: ServiceDecisionOutcome;
  /** Short, NON-PII policy tag (e.g. `closeness=unknown`, `no_talk_listing`). */
  reason: string;
  /** Unix seconds. */
  createdAt: number;
}

export interface ServiceDecisionInput {
  requesterDid: string;
  capability: string;
  decision: ServiceDecisionOutcome;
  reason?: string;
  createdAt: number;
}

export interface ServiceDecisionRepository {
  /** Append one decision (newest-first read order is by created_at). */
  record(entry: ServiceDecisionInput): void;
  /** Most recent decisions, newest first. `limit` defaults to 100. */
  list(limit?: number): ServiceDecision[];
}

/** Singleton repository (null = not wired / in-memory test). */
let repo: ServiceDecisionRepository | null = null;
export function setServiceDecisionRepository(r: ServiceDecisionRepository | null): void {
  repo = r;
}
export function getServiceDecisionRepository(): ServiceDecisionRepository | null {
  return repo;
}

function rowToDecision(r: DBRow): ServiceDecision {
  return {
    id: Number(r.id ?? 0),
    requesterDid: String(r.requester_did ?? ''),
    capability: String(r.capability ?? ''),
    decision: String(r.decision ?? 'error') as ServiceDecisionOutcome,
    reason: String(r.reason ?? ''),
    createdAt: Number(r.created_at ?? 0),
  };
}

/**
 * Hard cap on retained rows. This log lives in the encrypted identity DB and a
 * noisy (or hostile) contact can drive many inbound grant-requests; without a
 * bound the table would grow unbounded and bury the useful recent rows. We keep
 * the newest N (the surface only ever lists ≤500) and prune the tail on every
 * insert. We deliberately do NOT dedupe identical (requester, capability,
 * decision) rows — repeated requests from one contact are exactly what the owner
 * needs to SEE (a contact hammering for access), so collapsing them would hide
 * the signal.
 */
const MAX_DECISION_ROWS = 2000;

export class SQLiteServiceDecisionRepository implements ServiceDecisionRepository {
  /** `maxRows` is injectable only so the retention cap is testable without
   *  inserting thousands of rows; production always uses the default. */
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly maxRows: number = MAX_DECISION_ROWS,
  ) {}

  record(entry: ServiceDecisionInput): void {
    if (entry.requesterDid === '')
      throw new Error('service_decisions.repository: requesterDid is required');
    this.db.execute(
      `INSERT INTO contact_service_decisions
         (requester_did, capability, decision, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [entry.requesterDid, entry.capability, entry.decision, entry.reason ?? '', entry.createdAt],
    );
    // Prune the tail beyond the retention cap (newest-first by created_at,id).
    this.db.execute(
      `DELETE FROM contact_service_decisions
         WHERE id NOT IN (
           SELECT id FROM contact_service_decisions
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )`,
      [this.maxRows],
    );
  }

  list(limit = 100): ServiceDecision[] {
    const rows = this.db.query(
      'SELECT * FROM contact_service_decisions ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit],
    );
    return rows.map(rowToDecision);
  }
}
