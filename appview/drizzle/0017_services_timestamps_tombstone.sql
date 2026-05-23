-- Three distinct timestamps on services so operators can tell apart:
--   - createdAt: first AppView ingest of this URI (never updated)
--   - updatedAt: last operator-driven content change (cid bump)
--   - indexedAt: last write to this row (re-ingests + content changes)
--
-- Plus moderator-takedown columns. `isDiscoverable` is operator-
-- controlled; `tombstoned_at` is operator-side enforcement and stays
-- distinct in both column name and audit-log verb (separate from any
-- author-side flag flip).
--
-- Plus DB-level CHECK constraints on lat/lng ranges, mirroring the
-- lexicon validator so direct SQL writes can't store invalid coords.

ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "created_at" timestamp NOT NULL DEFAULT NOW();
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT NOW();
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "tombstoned_at" timestamp;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "tombstone_reason" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "services_tombstoned_idx"
  ON "services" ("tombstoned_at")
  WHERE "tombstoned_at" IS NOT NULL;
--> statement-breakpoint

-- Adding CHECK constraints to a table that may already contain
-- arbitrary numeric values is risky; NOT VALID would defer existing-row
-- validation, then a separate VALIDATE CONSTRAINT would catch up. For
-- a pre-launch table we expect no offending rows, so a straight ADD is
-- fine; the migration will fail loudly if reality disagrees, which is
-- the desired signal.
ALTER TABLE "services"
  ADD CONSTRAINT "services_lat_range"
  CHECK ("lat" IS NULL OR ("lat" BETWEEN -90 AND 90));
--> statement-breakpoint
ALTER TABLE "services"
  ADD CONSTRAINT "services_lng_range"
  CHECK ("lng" IS NULL OR ("lng" BETWEEN -180 AND 180));
