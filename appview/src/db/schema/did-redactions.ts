import { pgTable, text, timestamp, bigint, index } from 'drizzle-orm/pg-core'
import { adminAuditLog } from './admin-audit-log'

/**
 * Author DID redactions.
 *
 * When a user (or court order) demands their DID be erased from
 * AppView, we can't safely hard-delete attestations.author_did
 * everywhere it appears — that would corrupt scoring aggregates,
 * break attestation URIs that depend on the DID, and orphan trust
 * edges. Instead, we map the DID → "redacted" in this table; read
 * paths that surface author identity (subjectGet's reviewer roster,
 * search results, peerlens profile) LEFT JOIN against this table
 * and substitute a sentinel handle (`"[redacted]"`) + null DID when
 * a row exists.
 *
 * The underlying attestation rows are preserved so:
 *   - Trust scoring continues with the original signal.
 *   - The audit trail (admin_audit_log) stays intact.
 *   - If the redaction is reversed (court vacates, user changes
 *     mind), un-redacting is a single row delete here, not a
 *     cross-table restore.
 *
 * **Schema-only placeholder.** The application-side LEFT JOIN +
 * sentinel substitution will be wired when the redaction flow is
 * actually implemented. Shipping the table now means GDPR / takedown
 * requests don't need a hot-path schema migration to honor.
 *
 * **No reverse audit log here.** The admin_audit_log row that fired
 * the redaction carries the actor + reason + timestamp; this table
 * only needs the DID + when (for response-time joins) + the inline
 * reason that gets surfaced in the substituted output (e.g. "GDPR
 * request 2026-05-22").
 */
export const didRedactions = pgTable('did_redactions', {
  // The DID being redacted. Single-row-per-DID — re-redacting
  // updates the timestamp + reason.
  did: text('did').primaryKey(),
  // When the redaction took effect.
  redactedAt: timestamp('redacted_at').notNull().defaultNow(),
  // Free-text reason surfaced in operator queries + (optionally) in
  // the substituted output. Required at the application layer.
  reason: text('reason'),
  // Reference to the admin_audit_log row that fired this redaction.
  // Nullable to permit emergency / scripted redactions outside the
  // normal admin surface; expected to be set in steady-state. Typed
  // as bigint with an explicit FK so the integrity check is enforced
  // at the DB layer + the JS side reads a BigInt (admin_audit_log.id
  // is BIGSERIAL).
  auditLogId: bigint('audit_log_id', { mode: 'bigint' }).references(() => adminAuditLog.id),
}, (table) => [
  index('did_redactions_redacted_at_idx').on(table.redactedAt),
])
