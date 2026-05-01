-- TN-V2-META-005 / TN-V2-META-006 — reviewer-declared compliance and
-- accessibility tags on attestations.
--
-- Adds two opt-in `text[]` columns:
--   * `compliance`     — closed-vocab dietary / certification tags
--                        (halal, kosher, vegan, gluten-free,
--                        fda-approved, ce-marked, age-18+, …).
--   * `accessibility`  — closed-vocab accessibility tags
--                        (wheelchair, captions, screen-reader,
--                        color-blind-safe, audio-described, …).
--
-- Both nullable. Empty arrays collapsed to NULL on the ingest path
-- so the GIN indexes don't carry zero-length rows. Subject-level
-- merge (union into `subjects.metadata.compliance.tags`) is deferred
-- to META-001's unified reviewer-declared metadata pipeline.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "compliance" text[];
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "accessibility" text[];

-- GIN array-overlap indexes — same pattern as `attestations_use_cases_idx`
-- and `attestations_recommend_for_idx`. Power the future RANK-004
-- search filters ("halal restaurants", "wheelchair-accessible
-- venues") via array-overlap queries.
CREATE INDEX IF NOT EXISTS "attestations_compliance_idx"
  ON "attestations" USING gin ("compliance");
CREATE INDEX IF NOT EXISTS "attestations_accessibility_idx"
  ON "attestations" USING gin ("accessibility");
