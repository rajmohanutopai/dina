import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, bigserial, index, uniqueIndex, check } from 'drizzle-orm/pg-core'

/**
 * `cosig_requests` (TN-DB-003 / Plan §4.1 + §10).
 *
 * Bilateral co-signature lifecycle state machine. One row per
 * `(requester_did, attestation_uri, recipient_did)` tuple — the same
 * recipient can be asked to cosign different attestations, or different
 * recipients can be asked about the same attestation, but the same
 * (requester, attestation, recipient) combination is unique.
 *
 * **Distinct from `dina_tasks`** (Core's local delegation queue): cosig
 * has cross-network, multi-day expiry semantics that don't fit the
 * local-delegation model — the recipient may be offline for days, the
 * sender may revoke or amend, the attestation may be deleted upstream.
 * Modeling this as its own table keeps the state-machine transitions
 * explicit (see `cosig_expiry_sweep` job, hourly, TN-SCORE-006).
 *
 * **Status state machine** — closed enum enforced by CHECK constraint:
 *   - `pending`   → initial state; awaiting recipient response
 *   - `accepted`  → recipient signed; `endorsement_uri` set
 *   - `rejected`  → recipient declined; `reject_reason` set
 *   - `expired`   → past `expires_at` without response; swept hourly
 *
 * All terminal states are sticky — no transition out of accepted /
 * rejected / expired. The `cosig_expiry_sweep` job flips pending →
 * expired when `now() > expires_at`.
 *
 * **endorsement_uri** is set ONLY on `accepted` — the AT-URI of the
 * `com.dina.trust.endorsement` record the recipient published.
 * **reject_reason** is set on `rejected` (`'declined' | 'unknown'`)
 * AND on `expired` (`'expired'`) so consumers can render uniform UX
 * for "did not endorse".
 *
 * **Indexes**:
 *   - `cosig_requests_recipient_status_idx` — recipient inbox lookup
 *     ("show me pending requests for me") + per-status filtering.
 *   - `cosig_requests_expiry_idx` — partial index on `expires_at` WHERE
 *     `status = 'pending'`. Hot path for the hourly sweep job — only
 *     pending rows can expire, so the index excludes the much larger
 *     terminal-state population.
 *
 * Plain TIMESTAMP for `expires_at` / `created_at` / `updated_at` to
 * match AppView's codebase convention; Plan §4.1 calls for TIMESTAMPTZ
 * but every other timestamp column across the 27 baseline tables is
 * plain TIMESTAMP — consistent deviation, same as
 * `ingest_rejections.rejected_at` and `subjects.enriched_at`.
 */
export const cosigRequests = pgTable('cosig_requests', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  requesterDid: text('requester_did').notNull(),
  recipientDid: text('recipient_did').notNull(),
  attestationUri: text('attestation_uri').notNull(),
  status: text('status').notNull(),
  // Set on `accepted` — AT-URI of the recipient's endorsement record.
  endorsementUri: text('endorsement_uri'),
  // Set on `rejected` (`'declined' | 'unknown'`) or `expired` (`'expired'`).
  rejectReason: text('reject_reason'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  // CHECK constraint — closed status enum at the DB level. Application
  // also validates, but the CHECK is the authoritative truth: a
  // mistyped INSERT in a future code path fails loudly instead of
  // silently writing a garbage state that breaks the sweep job.
  check(
    'cosig_requests_status_check',
    sql`${table.status} IN ('pending', 'accepted', 'rejected', 'expired')`,
  ),
  uniqueIndex('cosig_requests_unique_tuple_idx').on(
    table.requesterDid,
    table.attestationUri,
    table.recipientDid,
  ),
  index('cosig_requests_recipient_status_idx').on(table.recipientDid, table.status),
  index('cosig_requests_expiry_idx')
    .on(table.expiresAt)
    .where(sql`${table.status} = 'pending'`),
])
