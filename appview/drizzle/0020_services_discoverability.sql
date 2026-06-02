-- Second half of the catalog schema/migration drift (commit 6a076dc
-- "wire discoverability + category end-to-end"): the
-- `services.discoverability` column (catalog §5.2 — `public` |
-- `unlisted` | `known_only`) was added to the Drizzle schema with no
-- generated migration, same as `capability_categories_json` (0019).
-- The service-profile ingest handler INSERTs this column on every
-- upsert, so a DB missing it makes EVERY service.profile ingest throw
-- → no provider ever lands in the `services` table → discovery is
-- permanently empty. This adds the column so ingest (and the search
-- query's category/discoverability projection) work.
--
-- text, nullable: a listing that predates the catalog (or published no
-- explicit discoverability) stores NULL; readers treat NULL as the
-- legacy `is_discoverable`-only behaviour.

ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "discoverability" text;
