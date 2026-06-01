import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { DrizzleDB } from '../connection.js'
import { catalogSnapshots } from '../schema/index.js'

/**
 * Catalog-snapshot queries + the pure assembly used by the seed script.
 *
 * The catalog SOURCE is `@dina/protocol`; the seed script emits it to JSON and
 * calls `assembleCatalogSnapshot` (pure — unit-testable without a DB) to hash +
 * wrap it, then `upsertCatalogSnapshot` (idempotent). The endpoint reads
 * `getLatestCatalogPayload`. AppView never imports protocol types — the payload
 * is opaque JSON.
 */

export interface AssembledSnapshot {
  readonly catalogVersion: string
  readonly catalogHash: string
  readonly generatedAt: Date
  /** Full served payload = content + injected catalog_hash + generated_at. */
  readonly payload: Record<string, unknown>
}

/**
 * Hash the protocol-emitted catalog CONTENT (the serialized
 * `{catalog_version, categories, capabilities, deprecated_capabilities}`) and
 * assemble the full served `CapabilityCatalog` payload. Pure + deterministic
 * for a given `(content, generatedAt)`. Throws on malformed/empty content
 * (fail-closed — never seed a versionless snapshot).
 */
export function assembleCatalogSnapshot(contentJson: string, generatedAt: Date): AssembledSnapshot {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(contentJson) as Record<string, unknown>
  } catch {
    throw new Error('catalog content is not valid JSON')
  }
  const version = typeof parsed.catalog_version === 'string' ? parsed.catalog_version : ''
  if (version === '') throw new Error('catalog content has no catalog_version')
  // Hash the raw content bytes — the idempotency key. (Volatile generated_at is
  // NOT part of the content, so the hash is stable across re-runs.)
  const catalogHash = createHash('sha256').update(contentJson).digest('hex')
  const payload: Record<string, unknown> = {
    ...parsed,
    catalog_hash: catalogHash,
    generated_at: generatedAt.toISOString(),
  }
  return { catalogVersion: version, catalogHash, generatedAt, payload }
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged'

/**
 * Idempotent upsert of a snapshot, keyed by `catalog_version`. Re-running with
 * identical content is a no-op (`unchanged`); a content change `updated`s the
 * row; a new version `inserted`s. Safe to run any number of times / any env.
 */
export async function upsertCatalogSnapshot(
  db: DrizzleDB,
  snap: AssembledSnapshot,
): Promise<UpsertOutcome> {
  const existing = await db
    .select({ hash: catalogSnapshots.catalogHash })
    .from(catalogSnapshots)
    .where(eq(catalogSnapshots.catalogVersion, snap.catalogVersion))
    .limit(1)

  if (existing.length > 0) {
    if (existing[0]!.hash === snap.catalogHash) return 'unchanged'
    await db
      .update(catalogSnapshots)
      .set({
        catalogHash: snap.catalogHash,
        generatedAt: snap.generatedAt,
        payload: snap.payload,
        updatedAt: new Date(),
      })
      .where(eq(catalogSnapshots.catalogVersion, snap.catalogVersion))
    return 'updated'
  }

  await db.insert(catalogSnapshots).values({
    catalogVersion: snap.catalogVersion,
    catalogHash: snap.catalogHash,
    generatedAt: snap.generatedAt,
    payload: snap.payload,
  })
  return 'inserted'
}

/** The newest catalog snapshot payload (by generated_at), or `null` if unseeded. */
export async function getLatestCatalogPayload(db: DrizzleDB): Promise<unknown | null> {
  const rows = await db
    .select({ payload: catalogSnapshots.payload })
    .from(catalogSnapshots)
    .orderBy(desc(catalogSnapshots.generatedAt))
    .limit(1)
  return rows.length > 0 ? rows[0]!.payload : null
}
