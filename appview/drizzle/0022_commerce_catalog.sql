-- §10 commerce catalog ingest (WS-5.4) — the tables the AppView handler,
-- projection and search already read and write, and which NO migration
-- created.
--
-- Fourth instance of the drift 0019, 0020 and 0021 record. This one is the
-- costliest: `com.dinakernel.commerce.searchCatalog` is registered in the
-- router and every commerce catalog module queries these tables, so on a
-- Docker-deployed AppView — which runs `drizzle-kit migrate`, not `push` —
-- the whole commerce discovery lane fails at the first query. The endpoint
-- exists, the code is tested, and the storage underneath it was never
-- created.
--
-- DDL taken from what the schema actually produces (`drizzle-kit push` into a
-- scratch database, then `pg_dump -s`), not hand-transcribed from the
-- TypeScript. Transcribing invites a column that differs by a default or a
-- nullability nobody notices until a row is rejected in production.

CREATE TABLE IF NOT EXISTS "commerce_catalog_pointers" (
  "id" text PRIMARY KEY NOT NULL,
  "supplier_did" text NOT NULL,
  "catalog_id" text NOT NULL,
  "snapshot_sequence" integer NOT NULL,
  "protocol_version" text NOT NULL,
  "published_at" text NOT NULL,
  -- Nullable: §10.2 lets a pointer be published BEFORE its snapshot arrives,
  -- which `awaiting_snapshot` marks.
  "snapshot_digest" text,
  "previous_snapshot_digest" text,
  "withdrawn" boolean DEFAULT false NOT NULL,
  "awaiting_snapshot" boolean DEFAULT false NOT NULL,
  "uri" text NOT NULL,
  "indexed_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "commerce_catalog_snapshots" (
  -- Keyed by CONTENT digest: a snapshot is evidence, and two publications of
  -- identical content are one row.
  "snapshot_digest" text PRIMARY KEY NOT NULL,
  "supplier_did" text NOT NULL,
  "catalog_id" text NOT NULL,
  "snapshot_sequence" integer NOT NULL,
  "snapshot_json" jsonb NOT NULL,
  "pages_json" jsonb NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "commerce_catalog_products" (
  "row_key" text PRIMARY KEY NOT NULL,
  "product_key" text NOT NULL,
  "supplier_did" text NOT NULL,
  "catalog_id" text NOT NULL,
  "snapshot_sequence" integer NOT NULL,
  "snapshot_digest" text NOT NULL,
  "item_revision" text NOT NULL,
  "name" text NOT NULL,
  "brand" text,
  "description" text,
  "category_ids" jsonb NOT NULL,
  "identifier_keys" jsonb NOT NULL,
  "fulfilment_regions" jsonb NOT NULL,
  -- §10.4: indicative only. An AppView must never present a snapshot as live
  -- stock or price, which is why this is not a Money column.
  "indicative_price" jsonb,
  "generated_at" text NOT NULL,
  "valid_until" text,
  "indexed_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "commerce_relationship_claims" (
  "uri" text PRIMARY KEY NOT NULL,
  "claim_id" text NOT NULL,
  "issuer_did" text NOT NULL,
  "subject_key" text NOT NULL,
  "relationship" text NOT NULL,
  "object_key" text NOT NULL,
  "source" text NOT NULL,
  "confidence_bp" integer NOT NULL,
  "inference_version" text,
  "claim_json" jsonb NOT NULL,
  "asserted_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "commerce_product_relationships" (
  "edge_key" text PRIMARY KEY NOT NULL,
  "subject_key" text NOT NULL,
  "relationship" text NOT NULL,
  "object_key" text NOT NULL,
  "confidence_bp" integer NOT NULL,
  "disputed" boolean DEFAULT false NOT NULL,
  "evidence_json" jsonb NOT NULL,
  "indexed_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "commerce_catalog_pointers_supplier_idx" ON "commerce_catalog_pointers" ("supplier_did");
CREATE INDEX IF NOT EXISTS "commerce_catalog_pointers_pending_idx" ON "commerce_catalog_pointers" ("snapshot_digest");
CREATE INDEX IF NOT EXISTS "commerce_catalog_snapshots_supplier_idx" ON "commerce_catalog_snapshots" ("supplier_did");
CREATE INDEX IF NOT EXISTS "commerce_catalog_products_catalog_idx" ON "commerce_catalog_products" ("supplier_did","catalog_id");
CREATE INDEX IF NOT EXISTS "commerce_catalog_products_product_idx" ON "commerce_catalog_products" ("product_key");
CREATE INDEX IF NOT EXISTS "commerce_relationship_claims_subject_idx" ON "commerce_relationship_claims" ("subject_key");
CREATE INDEX IF NOT EXISTS "commerce_product_relationships_subject_idx" ON "commerce_product_relationships" ("subject_key");
CREATE INDEX IF NOT EXISTS "commerce_product_relationships_object_idx" ON "commerce_product_relationships" ("object_key");
