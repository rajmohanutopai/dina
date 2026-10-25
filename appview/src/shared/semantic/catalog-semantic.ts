/**
 * Catalogue search by meaning (HOSTED_DINA §6.1).
 *
 * An owner asks for "croissants", "pastries for a café" or "something buttery
 * for breakfast"; a catalogue says "Butter croissant". Words alone miss most
 * of that, so each catalogue item gets a vector made from its name, brand,
 * description and categories, and a query is compared with them by cosine.
 *
 * THE MODEL RUNS HERE. `bge-small-en-v1.5` (384 numbers, about 34 MB in its
 * 8-bit form) through transformers.js, from files baked into the image: no
 * API key, no per-search cost, and no catalogue or query text sent anywhere.
 * English only; the model's name is stored beside each vector, so a
 * multilingual one can replace it and every row is embedded again.
 *
 * THE CUT-OFF IS MEASURED, not guessed (2026-10-25, on the test catalogues):
 * real matches score 0.60–0.83 ("croissants" → Butter croissant 0.78,
 * "pastries for a cafe" → Cinnamon bun 0.63, "something buttery for
 * breakfast" → Butter croissant 0.62); unrelated asks stay below it
 * ("coffee beans" 0.57, "laptop" 0.55, "plumber" 0.48). Below 0.60 a vector
 * match is noise wearing a score, and the search does not return it.
 *
 * Similarity is RECALL, like every other signal in `catalog-search.ts`: it
 * says why a row was offered, never how good the supplier is.
 */

import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import { MEANING_MIN_SIMILARITY } from '@/shared/commerce/catalog-search.js'

export const CATALOG_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'
export const CATALOG_EMBEDDING_DIMS = 384
/** Rows the meaning layer hands the search, best first. */
export const MEANING_CANDIDATES = 50
/** Nearest rows one query reads before the per-supplier cap. */
export const MEANING_NEAREST = 400
/** No more than this many rows from one supplier reach the search by meaning. */
export const MEANING_PER_SUPPLIER = 3

export interface TextEmbedder {
  readonly model: string
  /** One unit-length vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>
}

/**
 * The local model. Imported lazily, so a process or test that never searches
 * by meaning never loads ONNX. `allowRemote: false` (production) refuses to
 * fetch model files at run time: the image carries them.
 */
export async function loadLocalEmbedder(opts: {
  modelDir?: string
  allowRemote: boolean
}): Promise<TextEmbedder> {
  const { pipeline, env } = await import('@huggingface/transformers')
  if (opts.modelDir !== undefined && opts.modelDir !== '') env.cacheDir = opts.modelDir
  env.allowRemoteModels = opts.allowRemote
  const extract = await pipeline('feature-extraction', CATALOG_EMBEDDING_MODEL, { dtype: 'q8' })
  return {
    model: CATALOG_EMBEDDING_MODEL,
    async embed(texts) {
      const out: Float32Array[] = []
      for (const text of texts) {
        const tensor = await extract(text, { pooling: 'mean', normalize: true })
        out.push(Float32Array.from(tensor.data as Float32Array))
      }
      return out
    },
  }
}

/** What an item is embedded from: what a buyer would read about it. */
export function catalogPassage(row: {
  name: string
  brand: string | null
  description: string | null
  categoryIds: unknown
}): string {
  const categories = Array.isArray(row.categoryIds)
    ? (row.categoryIds as unknown[]).filter((c): c is string => typeof c === 'string')
    : []
  return [row.name, row.brand ?? '', row.description ?? '', categories.join(' ')]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('. ')
    .slice(0, 2000)
}

/** pgvector's text form. Fixed precision, so the same vector writes the same text. */
export function vectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector, (x) => x.toFixed(6)).join(',')}]`
}

export interface SemanticDb {
  execute(query: SQL): Promise<unknown>
  /** Drizzle's; the search uses it to scope its index settings. */
  transaction?<T>(run: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<T>): Promise<T>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown })?.rows ?? result
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * Embed rows that have no vector, or one from another model. The ingester
 * replaces a catalogue's rows wholesale, so a new snapshot's rows arrive
 * here unembedded; until then they are still found by their words. The
 * update names the row's revision, so a row replaced meanwhile is left for
 * the next pass rather than given the old item's vector.
 */
export async function backfillCatalogEmbeddings(
  db: SemanticDb,
  embedder: TextEmbedder,
  batch = 32,
): Promise<number> {
  const pending = rowsOf(
    await db.execute(sql`
      SELECT row_key, item_revision, name, brand, description, category_ids
      FROM commerce_catalog_products
      WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM ${embedder.model}
      ORDER BY row_key
      LIMIT ${batch}`),
  )
  if (pending.length === 0) return 0
  const vectors = await embedder.embed(
    pending.map((row) =>
      catalogPassage({
        name: String(row.name ?? ''),
        brand: (row.brand as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        categoryIds: row.category_ids,
      }),
    ),
  )
  let written = 0
  for (const [i, row] of pending.entries()) {
    const vector = vectors[i]
    if (vector === undefined || vector.length !== CATALOG_EMBEDDING_DIMS) continue
    await db.execute(sql`
      UPDATE commerce_catalog_products
      SET embedding = ${vectorLiteral(vector)}::vector, embedding_model = ${embedder.model}
      WHERE row_key = ${String(row.row_key)} AND item_revision = ${String(row.item_revision)}`)
    written += 1
  }
  return written
}

/**
 * The meaning layer the search asks. `similar` returns row keys at or above
 * the cut-off, best first, inside the region constraint the search already
 * applies; an empty map when the query matches nothing by meaning.
 */
export interface CatalogSemantic {
  similar(db: SemanticDb, text: string, regionConstraint: SQL | null): Promise<Map<string, number>>
}

const QUERY_CACHE_LIMIT = 256

export function createCatalogSemantic(embedder: TextEmbedder): CatalogSemantic {
  const cache = new Map<string, Float32Array>()
  async function queryVector(text: string): Promise<Float32Array | null> {
    const key = text.trim().toLowerCase()
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const [vector] = await embedder.embed([key])
    if (vector === undefined || vector.length !== CATALOG_EMBEDDING_DIMS) return null
    cache.set(key, vector)
    if (cache.size > QUERY_CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    return vector
  }
  return {
    async similar(db, text, regionConstraint) {
      const vector = await queryVector(text)
      if (vector === null) return new Map()
      const literal = vectorLiteral(vector)
      // Nearest rows first, then no more than MEANING_PER_SUPPLIER from any
      // one supplier, so a publisher with many similar items cannot fill
      // every slot and push the others out before the matcher sees them.
      // Inactive accounts are left out here, before the cap, as the main
      // query leaves them out after it.
      const query = sql`
        SELECT row_key, similarity FROM (
          SELECT row_key, similarity,
                 row_number() OVER (PARTITION BY supplier_did ORDER BY similarity DESC, row_key)
                   AS rank_in_supplier
          FROM (
            SELECT commerce_catalog_products.row_key,
                   commerce_catalog_products.supplier_did,
                   1 - (commerce_catalog_products.embedding <=> ${literal}::vector) AS similarity
            FROM commerce_catalog_products
            LEFT JOIN service_account_status
              ON service_account_status.did = commerce_catalog_products.supplier_did
            WHERE commerce_catalog_products.embedding IS NOT NULL
              AND commerce_catalog_products.embedding_model = ${embedder.model}
              AND COALESCE(service_account_status.active, true)
              ${regionConstraint === null ? sql`` : sql`AND ${regionConstraint}`}
            ORDER BY commerce_catalog_products.embedding <=> ${literal}::vector
            LIMIT ${MEANING_NEAREST}
          ) nearest
        ) ranked
        WHERE rank_in_supplier <= ${MEANING_PER_SUPPLIER}
        ORDER BY similarity DESC, row_key
        LIMIT ${MEANING_CANDIDATES}`
      // pgvector's HNSW scan returns about `ef_search` rows (40 by default)
      // and the region filter runs after it, so a far-off region could come
      // back empty. Keep scanning until enough rows pass (pgvector 0.8's
      // iterative scan), inside one transaction so the settings end with it.
      const rows = rowsOf(
        db.transaction === undefined
          ? await db.execute(query)
          : await db.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(MEANING_NEAREST))}`)
              await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
              return tx.execute(query)
            }),
      )
      const out = new Map<string, number>()
      for (const row of rows) {
        const similarity = Number(row.similarity)
        if (Number.isFinite(similarity) && similarity >= MEANING_MIN_SIMILARITY) {
          out.set(String(row.row_key), similarity)
        }
      }
      return out
    },
  }
}

let installed: CatalogSemantic | null = null

/** Installed by the web server once the model and the column are ready. */
export function installCatalogSemantic(next: CatalogSemantic | null): void {
  installed = next
}

export function getCatalogSemantic(): CatalogSemantic | null {
  return installed
}
