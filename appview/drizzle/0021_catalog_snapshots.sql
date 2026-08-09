-- Third instance of the schema/migration drift 0019 and 0020 already record:
-- a table added to the Drizzle schema with no generated migration.
--
-- `catalog_snapshots` holds the service-capability catalog AppView serves at
-- `com.dinakernel.catalog.capabilities`, and `src/db/queries/catalog.ts`
-- SELECTs and UPDATEs it on every read and every re-seed.
--
-- The schema file says the table is "applied directly from the schema (fresh
-- setup / `drizzle-kit push`)" — and `install_appview.sh` does run `push`, so
-- that path works. But the DOCKER deploy does not: `Dockerfile` runs
-- `drizzle-kit migrate`, chosen deliberately because it is "non-interactive
-- (unlike `push --force`, which still prompts on renames)". Two install paths,
-- one of which never creates this table, and the catalog endpoint fails on any
-- database built by the other.
--
-- Hand-written rather than generated. `drizzle-kit generate` cannot diff this
-- schema without asking whether `admin_audit_log` is a RENAME of `trust_edges`
-- — the peerlens rename left the schema and the journal describing different
-- worlds — and answering that wrongly emits a destructive migration. One
-- explicit CREATE TABLE has no such ambiguity.
--
-- `IF NOT EXISTS` because `push`-built databases already have it: this must be
-- a no-op there, not a failure.

CREATE TABLE IF NOT EXISTS "catalog_snapshots" (
  -- Catalog content version (e.g. `2026-06-01`). One snapshot per version;
  -- the endpoint serves the newest by `generated_at` and history is retained
  -- for auditability and `?sinceVersion`.
  "catalog_version" text PRIMARY KEY NOT NULL,
  -- SHA-256 of the canonical catalog content — the seed script's idempotency
  -- key, so re-running with unchanged content is a no-op.
  "catalog_hash" text NOT NULL,
  "generated_at" timestamp NOT NULL,
  -- The full `CapabilityCatalog`, served verbatim. OPAQUE to AppView, which
  -- has no `@dina/protocol` dependency by design (the deploy boundary).
  "payload" jsonb NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
