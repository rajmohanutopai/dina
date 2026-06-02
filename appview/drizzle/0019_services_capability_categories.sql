-- Adds the per-listing capability→category map column the services
-- catalog (SERVICES_LAUNCH_ARCHITECTURE §9.1, commit 6a076dc "wire
-- discoverability + category end-to-end") introduced into the Drizzle
-- schema (`services.capabilityCategoriesJson`) WITHOUT a generated
-- migration. The search query (`api/xrpc/service-search.ts`) selects
-- and filters on this column, so a DB missing it makes EVERY
-- `service.search` throw `column services.capability_categories_json
-- does not exist` → discovery silently returns zero providers. This
-- migration closes that schema/migration drift.
--
-- jsonb, nullable: a listing that published no category map stores
-- NULL (search treats it as "no declared vertical").

ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "capability_categories_json" jsonb;
