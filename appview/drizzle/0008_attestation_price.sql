-- TN-V2-META-002 — reviewer-declared price range on attestations.
--
-- Stored as 4 separate columns (`price_low_e7`, `price_high_e7`,
-- `price_currency`, `price_last_seen_at`) rather than JSONB so the
-- RANK-002 range-overlap predicate (`low <= max AND high >= min`)
-- runs as ordinary integer comparisons over a composite b-tree
-- index. JSONB path traversal would force every range query to
-- extract + cast on the hot path.
--
-- `bigint` (Postgres `int8`) because the e7-scaled value of a
-- mid-priced item easily exceeds 2^31 ($300 = 3_000_000_000_e7,
-- still well inside int8 but outside int4).
--
-- All four columns are nullable + tied together (a row either has
-- the full price object or none of it; ingester enforces this at
-- write time).
--
-- Cross-field check (low_e7 ≤ high_e7) and ISO 4217 currency
-- format enforced by Zod at the gate; no DB-level CHECK because
-- the wire is the canonical contract and the gate is the
-- enforcement point.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "price_low_e7" bigint;
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "price_high_e7" bigint;
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "price_currency" text;
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "price_last_seen_at" timestamp;

-- Composite b-tree index for RANK-002's range-overlap predicate.
-- Partial WHERE the low-end column is non-NULL — NULL price = "no
-- price declared" and the RANK-002 predicate's missing-pass clause
-- (`price_low_e7 IS NULL OR ...`) short-circuits before this index
-- is consulted. Composite ordering (`low_e7, high_e7`) supports a
-- leading-column range scan on `price_low_e7 <= max` with
-- `price_high_e7 >= min` refined from the same index entry.
CREATE INDEX IF NOT EXISTS "attestations_price_range_idx"
  ON "attestations" ("price_low_e7", "price_high_e7")
  WHERE "price_low_e7" IS NOT NULL;
