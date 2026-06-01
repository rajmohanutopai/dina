import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core'

/**
 * `catalog_snapshots` — the official service-capability catalog AppView serves.
 *
 * See `docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md`. The catalog SOURCE OF TRUTH
 * is `@dina/protocol` (the curated TS data). AppView has no `@dina/protocol`
 * dependency (the deploy boundary — same reason the resolver registry is
 * byte-duplicated), so the runtime never imports protocol: it serves this
 * OPAQUE JSONB `payload` verbatim at `com.dinakernel.catalog.capabilities`.
 *
 * The ONLY bridge from the protocol source to this table is the re-runnable
 * seed script (`appview/scripts/seed_catalog.ts`), which reads the protocol-
 * emitted catalog JSON, hashes it, and UPSERTS here. Idempotent — re-running
 * with unchanged content is a no-op; a content change updates the row (or a
 * version bump adds one). Env-configurable (`DATABASE_URL`) → works on
 * dev/test/prod.
 *
 * One row per `catalog_version`; the endpoint serves the newest by
 * `generated_at`. History is retained for auditability / `?sinceVersion`.
 *
 * GREENFIELD: this table is applied directly from the schema (fresh setup /
 * `drizzle-kit push`) — no incremental migration is maintained for it.
 */
export const catalogSnapshots = pgTable('catalog_snapshots', {
  /** Catalog content version (e.g. `2026-06-01`). One snapshot per version. */
  catalogVersion: text('catalog_version').primaryKey(),
  /** SHA-256 of the canonical catalog content — the idempotency key. */
  catalogHash: text('catalog_hash').notNull(),
  /** When this snapshot was generated (set by the seed script). */
  generatedAt: timestamp('generated_at').notNull(),
  /** The full `CapabilityCatalog` payload, served verbatim. Opaque to AppView. */
  payload: jsonb('payload').notNull(),
  /** Last upsert time — lets ops see when a re-seed last touched the row. */
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
