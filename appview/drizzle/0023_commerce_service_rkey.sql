-- §10.5 / DR-5: `service_rkey` — which service listing serves a catalog.
--
-- WHY THIS EXISTS ALONGSIDE THE 0022 EDIT. 0022 was already committed and
-- journaled before this column was added, so a database that has applied it
-- will never apply it again: `drizzle-kit migrate` tracks migrations by tag,
-- and `CREATE TABLE IF NOT EXISTS` is a no-op once the table is there. Adding
-- the column to 0022's CREATE TABLE therefore fixes only databases created
-- from scratch AFTER the edit. Every already-migrated database keeps a table
-- with no `service_rkey`, and the first catalog search against it fails with
-- `column "service_rkey" does not exist` — which is exactly how this was
-- found, as a 500 from a live endpoint.
--
-- So both are needed, and they do not conflict:
--   fresh database   → 0022 creates the column, this migration is a no-op
--   existing database → 0022 is skipped, this migration adds the column
--
-- IDEMPOTENT ON PURPOSE. `IF NOT EXISTS` is what makes the two paths safe to
-- combine; without it this file would fail on precisely the fresh databases
-- 0022 already served correctly.
ALTER TABLE "commerce_catalog_pointers"
  ADD COLUMN IF NOT EXISTS "service_rkey" text;
--> statement-breakpoint
ALTER TABLE "commerce_catalog_products"
  ADD COLUMN IF NOT EXISTS "service_rkey" text;
