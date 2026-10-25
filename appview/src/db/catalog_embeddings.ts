/**
 * Catalogue embeddings: the column, its index, and the pgvector extension
 * (HOSTED_DINA §6.1, search by meaning).
 *
 * Kept out of the Drizzle schema for the same reason the FTS columns are
 * (`fts_columns.ts`): the column type comes from an extension, and a Drizzle
 * declaration would put it in every `select()` of the products table. The
 * search reads it through raw SQL only.
 *
 * OPTIONAL BY DESIGN. A Postgres without pgvector still serves the catalogue
 * search on words; this returns false and the meaning layer stays off. It
 * never fails the boot.
 */

import { sql, type SQL } from 'drizzle-orm'

import { CATALOG_EMBEDDING_DIMS } from '@/shared/semantic/catalog-semantic.js'

export interface EmbeddingCapableDb {
  execute(query: SQL): Promise<unknown>
}

export const CATALOG_EMBEDDING_DDL: readonly string[] = Object.freeze([
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `ALTER TABLE commerce_catalog_products
     ADD COLUMN IF NOT EXISTS embedding vector(${CATALOG_EMBEDDING_DIMS})`,
  // Which model made the vector: a row embedded by another model is
  // embedded again, never compared across models.
  `ALTER TABLE commerce_catalog_products
     ADD COLUMN IF NOT EXISTS embedding_model text`,
  `CREATE INDEX IF NOT EXISTS idx_commerce_catalog_products_embedding
     ON commerce_catalog_products USING hnsw (embedding vector_cosine_ops)`,
])

/** True when the column is there to use; false when pgvector is not. */
export async function ensureCatalogEmbeddingColumns(
  db: EmbeddingCapableDb,
  log: (msg: string, detail: Record<string, unknown>) => void = () => {},
): Promise<boolean> {
  for (const stmt of CATALOG_EMBEDDING_DDL) {
    try {
      await db.execute(sql.raw(stmt))
    } catch (err) {
      log('catalog embeddings unavailable; search by words only', {
        code: (err as { code?: string })?.code ?? null,
      })
      return false
    }
  }
  return true
}
