-- Subjects can be tombstoned by a moderator (ToS / abuse / legal).
-- Tombstoning preserves the subject row so old URLs / cached
-- subject_ids continue to resolve to *something*, but the row is
-- excluded from active ranking + reviewer rosters in the read APIs.
--
-- Distinct from:
--   - `canonical_subject_id` (admin merge of duplicate subjects)
--   - orphan-GC (hard delete of subjects with no remaining references)
--   - attestation revocation (the author retracts their own attestation)
--
-- The companion `admin_audit_log` row carries the full record of who
-- tombstoned when; this column carries the inline reason that travels
-- with read responses.

ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "tombstoned_at" timestamp;
--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "tombstone_reason" text;
--> statement-breakpoint

-- Partial b-tree index. Tombstoning is rare; partial WHERE keeps the
-- index small while still serving operator queries ("show tombstoned
-- subjects in the last 7 days").
CREATE INDEX IF NOT EXISTS "subjects_tombstoned_idx"
  ON "subjects" ("tombstoned_at")
  WHERE "tombstoned_at" IS NOT NULL;
