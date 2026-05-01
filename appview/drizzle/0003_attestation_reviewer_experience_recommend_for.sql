-- TN-V2-REV-002 / TN-V2-REV-004 — V2 reviewer-declared metadata.
--
-- Adds three opt-in fields to `attestations`:
--   * `reviewer_experience`  — text     — closed enum
--                                         (novice|intermediate|expert).
--                                         Validated by Zod at the gate;
--                                         stored as text so the column
--                                         survives future enum-tier
--                                         additions without an ALTER TYPE.
--   * `recommend_for`        — text[]   — endorsement use-case tags
--                                         ("good for travel"). Same
--                                         opaque-tag treatment as
--                                         `use_cases`.
--   * `not_recommend_for`    — text[]   — warning use-case tags
--                                         ("not for calligraphy").
--
-- All nullable. Empty arrays are collapsed to NULL on the ingest
-- path so the GIN indexes stay sparse.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "reviewer_experience" text;
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "recommend_for" text[];
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "not_recommend_for" text[];

-- Partial b-tree on reviewer_experience — three values plus NULL,
-- and "any tier" queries don't touch this index. Keeping it
-- non-null only mirrors the existing `attestations_language_idx`
-- pattern. Powers RANK-008 expert-weighted ranking.
CREATE INDEX IF NOT EXISTS "attestations_reviewer_experience_idx"
  ON "attestations" ("reviewer_experience")
  WHERE "reviewer_experience" IS NOT NULL;

-- GIN array-overlap indexes for recommendation-tag search filters.
-- Mirrors the `attestations_use_cases_idx` shape so the search
-- xRPC's array-containment queries hit a consistent plan.
CREATE INDEX IF NOT EXISTS "attestations_recommend_for_idx"
  ON "attestations" USING gin ("recommend_for");
CREATE INDEX IF NOT EXISTS "attestations_not_recommend_for_idx"
  ON "attestations" USING gin ("not_recommend_for");
