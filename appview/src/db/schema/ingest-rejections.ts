import { pgTable, text, timestamp, jsonb, bigserial, index } from 'drizzle-orm/pg-core'

/**
 * `ingest_rejections` (TN-DB-005 / Plan §4.1).
 *
 * 7-day-retained log of records the firehose ingester rejected. The mobile
 * outbox watcher (Plan §3.5.1) polls this by `at_uri` to surface async
 * publish failures the user can't see locally — e.g. a record that left
 * the device's PDS but failed AppView's signature / schema / rate-limit /
 * namespace / feature-flag gates.
 *
 * Reasons (closed set per Plan §4.1):
 *   - `rate_limit`         — author exceeded per-day cap for the record kind
 *   - `signature_invalid`  — record's signature failed verification
 *   - `schema_invalid`     — record body didn't match the lexicon Zod schema
 *   - `namespace_disabled` — author published under a `verificationMethod`
 *                            id that's no longer in their DID document
 *   - `feature_off`        — `appview_config.trust_v1_enabled = false`
 *
 * `detail` is reason-specific JSON (e.g. `{limit_remaining: 0}` for rate
 * limits, `{expected_key_id: "did:plc:.../#namespace_2"}` for namespace
 * mismatches). Kept as `jsonb` rather than per-reason columns so future
 * reason kinds don't churn the schema.
 *
 * Retention: rows older than 7 days are purged by a daily janitor (TODO
 * task tracked separately under §5 scorer extensions). The `idx_ingest_
 * rejections_purge` index makes that range scan cheap.
 *
 * NOT a unique index on `(at_uri, reason)` — the same record CAN be
 * rejected more than once (e.g. signature_invalid on first attempt, then
 * rate_limit on retry). Row count per AT-URI is itself a useful signal.
 */
export const ingestRejections = pgTable('ingest_rejections', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  atUri: text('at_uri').notNull(),
  did: text('did').notNull(),
  reason: text('reason').notNull(),
  detail: jsonb('detail'),
  // Plain `timestamp` (TIMESTAMP WITHOUT TIME ZONE) matches AppView's
  // existing convention across all 27 baseline tables — see
  // `anomaly-events.ts:detectedAt`, `subjects.ts:createdAt`, etc.
  // Plan §4.1 long-form spec calls for TIMESTAMPTZ; deviating to match the
  // codebase consistency, since a single TIMESTAMPTZ column in an
  // otherwise-TIMESTAMP schema is its own bug magnet.
  rejectedAt: timestamp('rejected_at').notNull().defaultNow(),
}, (table) => [
  // Outbox-watcher hot path: lookup by AT-URI (mobile polls "is my pending
  // publish on the rejection list?"). Non-unique — same URI may be rejected
  // multiple times across retries; row count per URI is a useful signal.
  index('idx_ingest_rejections_at_uri').on(table.atUri),
  // Janitor hot path: range scan `WHERE rejected_at < NOW() - INTERVAL '7 days'`.
  index('idx_ingest_rejections_purge').on(table.rejectedAt),
])
