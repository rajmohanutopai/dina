-- ---------------------------------------------------------------------------
-- Down migration for 0000_trust_v1.sql (TN-DB-010).
--
-- Companion to the idempotent up migration. Drops every table created in
-- the up migration in reverse FK order:
--   * `attestations.subject_id` → `subjects.id`
--   * `subject_scores.subject_id` → `subjects.id`
-- ...so `subjects` is dropped after both dependents.
--
-- All statements are `DROP ... IF EXISTS`. This file is meant to be run
-- against a database that may have a partial install: missing tables are
-- silently skipped. Re-running on a fully-dropped DB is a no-op.
--
-- Triggers / foreign-key-cascade behaviour:
--   * The FK constraints declared in the up migration use `ON DELETE no
--     action` (Drizzle default for the schema). Postgres `DROP TABLE`
--     handles the order via this file; CASCADE is intentionally NOT used
--     so that an unexpected dependent (a custom view, an extension table)
--     surfaces as an error rather than silent destruction.
--
-- FTS auxiliary objects:
--   * `idx_attestations_search` and `idx_subjects_search` are dropped via
--     `DROP TABLE` cascade on the underlying tables (Postgres drops a
--     table's indexes automatically).
--   * The `search_vector` / `search_tsv` GENERATED columns are likewise
--     dropped with their parent tables.
-- ---------------------------------------------------------------------------

-- 1. Drop FTS indexes explicitly first (defensive — also dropped via
--    DROP TABLE, but explicit is clearer for partial-revert scenarios
--    where someone wants to drop just the FTS surface).
DROP INDEX IF EXISTS idx_attestations_search;--> statement-breakpoint
DROP INDEX IF EXISTS idx_subjects_search;--> statement-breakpoint

-- 2. Drop tables that hold FOREIGN KEY references to other tables FIRST.
DROP TABLE IF EXISTS "attestations";--> statement-breakpoint
DROP TABLE IF EXISTS "subject_scores";--> statement-breakpoint

-- 3. Drop the referenced parent table now that no children remain.
DROP TABLE IF EXISTS "subjects";--> statement-breakpoint

-- 4. Drop all remaining independent tables (no FK chain among them).
DROP TABLE IF EXISTS "amendments";--> statement-breakpoint
DROP TABLE IF EXISTS "anomaly_events";--> statement-breakpoint
DROP TABLE IF EXISTS "appview_config";--> statement-breakpoint
DROP TABLE IF EXISTS "collections";--> statement-breakpoint
DROP TABLE IF EXISTS "comparisons";--> statement-breakpoint
DROP TABLE IF EXISTS "cosig_requests";--> statement-breakpoint
DROP TABLE IF EXISTS "delegations";--> statement-breakpoint
DROP TABLE IF EXISTS "did_profiles";--> statement-breakpoint
DROP TABLE IF EXISTS "domain_scores";--> statement-breakpoint
DROP TABLE IF EXISTS "endorsements";--> statement-breakpoint
DROP TABLE IF EXISTS "flags";--> statement-breakpoint
DROP TABLE IF EXISTS "ingest_rejections";--> statement-breakpoint
DROP TABLE IF EXISTS "ingester_cursor";--> statement-breakpoint
DROP TABLE IF EXISTS "media";--> statement-breakpoint
DROP TABLE IF EXISTS "mention_edges";--> statement-breakpoint
DROP TABLE IF EXISTS "notification_prefs";--> statement-breakpoint
DROP TABLE IF EXISTS "reactions";--> statement-breakpoint
DROP TABLE IF EXISTS "replies";--> statement-breakpoint
DROP TABLE IF EXISTS "report_records";--> statement-breakpoint
DROP TABLE IF EXISTS "review_requests";--> statement-breakpoint
DROP TABLE IF EXISTS "reviewer_namespace_scores";--> statement-breakpoint
DROP TABLE IF EXISTS "revocations";--> statement-breakpoint
DROP TABLE IF EXISTS "services";--> statement-breakpoint
DROP TABLE IF EXISTS "subject_claims";--> statement-breakpoint
DROP TABLE IF EXISTS "suspended_pds_hosts";--> statement-breakpoint
DROP TABLE IF EXISTS "tombstones";--> statement-breakpoint
DROP TABLE IF EXISTS "trust_edges";--> statement-breakpoint
DROP TABLE IF EXISTS "trust_policies";--> statement-breakpoint
DROP TABLE IF EXISTS "trust_v1_params";--> statement-breakpoint
DROP TABLE IF EXISTS "verifications";--> statement-breakpoint
DROP TABLE IF EXISTS "vouches";
