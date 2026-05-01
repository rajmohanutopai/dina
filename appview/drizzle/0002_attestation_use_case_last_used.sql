-- TN-V2-REV-001 / TN-V2-REV-003 — V2 reviewer-declared metadata.
--
-- Adds two opt-in fields to `attestations`:
--   * `use_cases`     — text[]      — per-category curated tags
--                                    (e.g. ['everyday', 'travel'])
--   * `last_used_at`  — timestamp   — when the reviewer last used the
--                                    subject (distinct from createdAt)
--
-- Both nullable. Wire field for the second is `lastUsedMs` (integer ms
-- since epoch — AT Protocol forbids floats in CBOR records); the
-- ingester converts to a Postgres `timestamp` once at write time so
-- search and scorer queries use ordinary date arithmetic.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "use_cases" text[];
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp;

-- GIN array-overlap index — mirrors `attestations_tags_idx`. Powers
-- the use-case-aware search filter (RANK-005 family).
CREATE INDEX IF NOT EXISTS "attestations_use_cases_idx"
  ON "attestations" USING gin ("use_cases");

-- Partial index — most rows will leave `last_used_at` NULL (it's
-- opt-in and legacy rows have no value). Indexing only the
-- populated subset keeps the b-tree small. Powers per-category
-- recency-decay queries (RANK-006) and the "stale review" badge.
CREATE INDEX IF NOT EXISTS "attestations_last_used_idx"
  ON "attestations" ("last_used_at")
  WHERE "last_used_at" IS NOT NULL;
