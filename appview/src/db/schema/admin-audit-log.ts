import { pgTable, text, timestamp, jsonb, bigserial, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Append-only log of admin / operator actions on AppView data.
 *
 * Every privileged mutation (subject tombstone, attestation takedown,
 * subject merge, DID redaction, score recompute force, etc.) writes
 * a row here BEFORE the mutation lands. Two reasons:
 *
 *   1. **Accountability.** "Who tombstoned subject X on Tuesday?" has
 *      a single-table answer. Without this, the only record is in
 *      logs that age out, and operators can credibly deny actions.
 *   2. **Forensics.** When a moderation decision is disputed,
 *      reviewers need the `reason` + `context` that drove it.
 *
 * **Append-only.** No UPDATEs / DELETEs from application code.
 * (Postgres-level retention policies are separate; this is application
 * append-only.)
 *
 * **Schema-light, JSONB-heavy.** Actions vary widely
 * (`tombstone_subject` carries different context from `merge_subjects`).
 * Fixed columns for the common fields (`actor_did`, `action`,
 * `target_id`, `reason`, `performed_at`), `context_json` for the
 * action-specific payload. Avoids schema churn every time a new admin
 * surface ships.
 *
 * **`target_id` is a free string.** Could be a subject_id, attestation
 * URI, DID, or composite. Indexed b-tree so per-target audits
 * ("show all actions against this subject") are cheap.
 */
export const adminAuditLog = pgTable('admin_audit_log', {
  // BIGSERIAL — append-only log, monotonic id for ordering + replication.
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  // Operator DID. NOT NULL — anonymous admin actions are never logged.
  actorDid: text('actor_did').notNull(),
  // Closed enum (validated in code, not DB) for the most common
  // actions:
  //   - `tombstone_subject`         | `untombstone_subject`
  //   - `takedown_attestation`      | `restore_attestation`
  //   - `merge_subjects`            | `split_subjects` (future)
  //   - `redact_did`                | `restore_did`
  //   - `recompute_subject_score`
  // New action verbs can be added without a schema change.
  action: text('action').notNull(),
  // Free-string id of whatever the action targets. For subject
  // actions this is a subject_id; for attestation actions, the
  // at:// URI; for DID actions, the DID; for composite actions
  // (merge) it's the canonical subject_id.
  targetId: text('target_id').notNull(),
  // Free-text reason. Required for moderation actions (operator
  // discipline; required at the application layer, not the schema).
  reason: text('reason'),
  // Action-specific payload — `{from_id, to_id}` for a merge,
  // `{takedown_reason, original_text_sha256}` for a takedown, etc.
  // JSONB for flexibility without a forest of nullable columns.
  contextJson: jsonb('context_json'),
  performedAt: timestamp('performed_at').notNull().defaultNow(),
}, (table) => [
  // Per-target audit lookup. Most common admin query.
  index('admin_audit_log_target_idx').on(table.targetId),
  // Per-actor lookup ("show all actions by operator X this month").
  index('admin_audit_log_actor_idx').on(table.actorDid),
  // Time-range scans for incident review.
  index('admin_audit_log_performed_at_idx').on(table.performedAt),
  // Filter by action verb ("show all tombstones in the last 7 days").
  index('admin_audit_log_action_idx').on(table.action),
])
