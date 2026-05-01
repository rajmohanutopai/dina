-- TN-V2-META-011 — subject `last_active_at` server-derived freshness.
--
-- Adds `last_active_at timestamp` to `subjects`. Updated by the
-- attestation handler on every create to
-- `GREATEST(last_active_at, attestation.record_created_at)`. NULL
-- semantics: no attestation has landed yet (rare in V1; permitted
-- for future "subject pre-registration" flows).
--
-- Powers:
--   * Stale-review badge (§5): subjects with last_active_at older
--     than a per-category threshold get a grey "no recent reviews"
--     banner.
--   * Per-category recency-decay tuning (RANK-006): subjects with
--     fresher activity rank slightly higher.
--
-- Index is partial WHERE NOT NULL — pre-attestation rows are
-- rare, and "stale subject" queries always filter on a non-null
-- threshold.

ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "last_active_at" timestamp;

CREATE INDEX IF NOT EXISTS "subjects_last_active_idx"
  ON "subjects" ("last_active_at")
  WHERE "last_active_at" IS NOT NULL;
