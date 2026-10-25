/**
 * Starts catalogue search by meaning in the web process (HOSTED_DINA §6.1):
 * the pgvector column, the local model, the search's meaning layer, and the
 * loop that embeds rows the ingester writes.
 *
 * The web process holds the one copy of the model, because it embeds every
 * query anyway; the ingester stays as it was. Until the model is up, and on
 * a Postgres without pgvector, the search answers by words alone.
 *
 * Settings (environment):
 *   CATALOG_SEMANTIC=off            turn it off
 *   CATALOG_EMBED_MODEL_DIR=<dir>   where the model files are (the image's)
 *   CATALOG_EMBED_ALLOW_REMOTE=1    let transformers.js fetch the model (dev);
 *                                   off in production, where the image has it
 */

import { ensureCatalogEmbeddingColumns } from '@/db/catalog_embeddings.js'
import {
  backfillCatalogEmbeddings,
  createCatalogSemantic,
  installCatalogSemantic,
  loadLocalEmbedder,
  type SemanticDb,
  type TextEmbedder,
} from '@/shared/semantic/catalog-semantic.js'
import { logger } from '@/shared/utils/logger.js'

const RETRY_MS = 60_000
const BUSY_MS = 2_000
const IDLE_MS = 30_000

export function startCatalogSemantic(db: SemanticDb, env: NodeJS.ProcessEnv = process.env): void {
  if (env.CATALOG_SEMANTIC === 'off') {
    logger.info('catalog search by meaning: off')
    return
  }
  const production = (env.NODE_ENV ?? 'production') === 'production'
  const allowRemote = env.CATALOG_EMBED_ALLOW_REMOTE === '1' || !production
  let embedder: TextEmbedder | null = null

  const tick = async (): Promise<number> => {
    if (embedder === null) {
      const ready = await ensureCatalogEmbeddingColumns(db, (msg, detail) =>
        logger.warn(detail, msg),
      )
      if (!ready) return RETRY_MS
      try {
        embedder = await loadLocalEmbedder({
          ...(env.CATALOG_EMBED_MODEL_DIR !== undefined
            ? { modelDir: env.CATALOG_EMBED_MODEL_DIR }
            : {}),
          allowRemote,
        })
      } catch (err) {
        logger.warn(
          { errorClass: err instanceof Error ? err.constructor.name : typeof err },
          'catalog search by meaning: model did not load; words only',
        )
        return RETRY_MS
      }
      installCatalogSemantic(createCatalogSemantic(embedder))
      logger.info({ model: embedder.model }, 'catalog search by meaning: ready')
    }
    try {
      const written = await backfillCatalogEmbeddings(db, embedder)
      if (written > 0) logger.info({ written }, 'catalog embeddings written')
      return written > 0 ? BUSY_MS : IDLE_MS
    } catch (err) {
      logger.warn(
        { errorClass: err instanceof Error ? err.constructor.name : typeof err },
        'catalog embedding pass failed',
      )
      return RETRY_MS
    }
  }

  const loop = (): void => {
    void tick().then((waitMs) => {
      setTimeout(loop, waitMs).unref()
    })
  }
  loop()
}
