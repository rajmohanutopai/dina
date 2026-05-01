-- TN-V2-META-001 + META-004 — reviewer-declared availability +
-- schedule on attestations.
--
-- META-001 — three independent text[] columns rather than a single
-- JSONB so each sub-field gets its own GIN array-overlap index. The
-- natural search shape ("subjects sold in GB", "ships to US",
-- "sold at amazon.com") is per-sub-field; JSONB would force every
-- search to traverse a path expression and skip the index.
--
--   - `availability_regions`: ISO 3166-1 alpha-2 country codes the
--     subject is *available* / sold in. Cap 30 entries (validator).
--   - `availability_ships_to`: ISO codes the seller ships to. Often
--     a superset of `regions` for global retailers; subset for
--     region-locked goods.
--   - `availability_sold_at`: hostnames of retailers carrying the
--     subject (`amazon.com`, `walmart.com`). RFC 1035 ≤253 chars
--     per host; cap 20 (validator). Hostname-shape, not URL — the
--     detail page builds the link lazily.
--
-- META-004 — schedule as JSONB. Heterogeneous shape (per-day map +
-- scalar leadDays + month array) — JSONB keeps the wire shape
-- addressable on read without a denormalised explosion of columns.
-- No search predicate today benefits from a dedicated column.

ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "availability_regions" text[];
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "availability_ships_to" text[];
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "availability_sold_at" text[];
ALTER TABLE "attestations" ADD COLUMN IF NOT EXISTS "schedule_json" jsonb;

-- GIN array-overlap indexes for the three META-001 sub-fields.
-- Empty arrays collapsed to NULL on the ingest path so the GIN
-- indexes stay sparse (same pattern as compliance / compat).
CREATE INDEX IF NOT EXISTS "attestations_availability_regions_idx"
  ON "attestations" USING gin ("availability_regions");
CREATE INDEX IF NOT EXISTS "attestations_availability_ships_to_idx"
  ON "attestations" USING gin ("availability_ships_to");
CREATE INDEX IF NOT EXISTS "attestations_availability_sold_at_idx"
  ON "attestations" USING gin ("availability_sold_at");

-- No index on schedule_json — no current search predicate over it.
-- A future "places open after 9pm" feature would add a functional
-- index over `schedule_json->'hours'->'mon'->>'close'` then.
