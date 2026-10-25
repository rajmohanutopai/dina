/**
 * Catalogue search by meaning and by stemmed words (HOSTED_DINA §6.1).
 *
 * "butter croissants" must find "Butter croissant"; "pastries for a cafe"
 * should find a bakery's croissants; "plumber" must find nothing in a bakery.
 * The matcher takes SQL's word on stems and the meaning layer's on
 * similarity, and says which one found the row.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { productKey, type CatalogProductRow } from '@/shared/commerce/catalog-projection.js'
import {
  MEANING_MIN_SIMILARITY,
  REGION_WEIGHT_BP,
  TEXT_WEIGHT_BP,
  matchCatalogRow,
  rankCatalogMatches,
} from '@/shared/commerce/catalog-search.js'
import {
  CATALOG_EMBEDDING_DIMS,
  backfillCatalogEmbeddings,
  catalogPassage,
  createCatalogSemantic,
  getCatalogSemantic,
  installCatalogSemantic,
  vectorLiteral,
  type TextEmbedder,
} from '@/shared/semantic/catalog-semantic.js'
import { ensureCatalogEmbeddingColumns } from '@/db/catalog_embeddings.js'
import { startCatalogSemantic } from '@/web/catalog-semantic-boot.js'

const NOW = '2026-10-25T09:00:00.000Z'

function row(overrides: Partial<CatalogProductRow> = {}): CatalogProductRow {
  const product = { scheme: 'manufacturer_sku' as const, value: 'MC-CROI-BUT', issuer_did: 'did:plc:mc' }
  return {
    rowKey: 'row-croissant',
    productKey: productKey(product),
    supplierDid: 'did:plc:mc',
    catalogId: 'main',
    snapshotSequence: 1,
    snapshotDigest: 'a'.repeat(64),
    serviceRkey: null,
    itemRevision: '1',
    name: 'Butter croissant',
    brand: null,
    description: 'All-butter croissant, baked fresh each morning',
    categoryIds: ['bakery'],
    identifierKeys: [productKey(product)],
    fulfilmentRegions: [{ scheme: 'postal_area', value: '94103' }],
    indicativePrice: { currency: 'USD', minor_units: '375' },
    generatedAt: NOW,
    validUntil: null,
    ...overrides,
  }
}

describe('the matcher: stemmed words and meaning', () => {
  it('counts a stemmed word hit from SQL as a text match', () => {
    // "butter croissants" is not a substring of "Butter croissant".
    expect(matchCatalogRow(row(), { atIso: NOW, text: 'butter croissants' })).toBeNull()
    const hit = matchCatalogRow(row(), {
      atIso: NOW,
      text: 'butter croissants',
      textHits: new Set(['row-croissant']),
    })
    expect(hit).toMatchObject({ matchedFields: ['text'], retrievalScoreBp: TEXT_WEIGHT_BP })
  })

  it('finds a row by meaning at the cut-off, says so, and scores by closeness', () => {
    const at = (similarity: number) =>
      matchCatalogRow(row(), {
        atIso: NOW,
        text: 'pastries for a cafe',
        meaning: new Map([['row-croissant', similarity]]),
      })
    expect(at(MEANING_MIN_SIMILARITY - 0.01)).toBeNull()
    expect(at(MEANING_MIN_SIMILARITY)).toMatchObject({
      matchedFields: ['meaning'],
      retrievalScoreBp: Math.round(TEXT_WEIGHT_BP * MEANING_MIN_SIMILARITY),
    })
    expect(at(0.8)?.retrievalScoreBp).toBeGreaterThan(at(0.65)?.retrievalScoreBp ?? 0)
  })

  it('ranks a row found by its words above one found only by meaning', () => {
    const words = matchCatalogRow(row({ rowKey: 'a' }), {
      atIso: NOW,
      text: 'croissant',
      meaning: new Map([['a', 0.9]]),
    })
    const meaning = matchCatalogRow(row({ rowKey: 'b', name: 'Pain au chocolat', description: null }), {
      atIso: NOW,
      text: 'croissant',
      meaning: new Map([['b', 0.99]]),
    })
    expect(words?.matchedFields).toEqual(['text'])
    expect(meaning?.matchedFields).toEqual(['meaning'])
    const ranked = rankCatalogMatches([
      { ...meaning!, rowKey: 'b' },
      { ...words!, rowKey: 'a' },
    ])
    expect(ranked.map((r) => r.rowKey)).toEqual(['a', 'b'])
  })

  it('keeps region a constraint for a meaning match', () => {
    const query = {
      atIso: NOW,
      text: 'pastries',
      meaning: new Map([['row-croissant', 0.7]]),
    }
    expect(matchCatalogRow(row(), { ...query, region: 'postal_area:10001' })).toBeNull()
    expect(matchCatalogRow(row(), { ...query, region: 'postal_area:94103' })).toMatchObject({
      matchedFields: ['meaning', 'region'],
      retrievalScoreBp: Math.round(TEXT_WEIGHT_BP * 0.7) + REGION_WEIGHT_BP,
    })
  })
})

describe('what an item is embedded from', () => {
  it('joins what a buyer reads about it, and nothing empty', () => {
    expect(
      catalogPassage({
        name: 'Butter croissant',
        brand: null,
        description: 'All-butter croissant',
        categoryIds: ['bakery', 7],
      }),
    ).toBe('Butter croissant. All-butter croissant. bakery')
  })

  it('writes a vector in pgvector’s text form, the same way every time', () => {
    expect(vectorLiteral(Float32Array.from([0.5, -0.25, 1 / 3]))).toBe('[0.500000,-0.250000,0.333333]')
  })
})

/** A stand-in Postgres: records each statement, answers from a queue. */
function stubDb(answers: unknown[][] = []) {
  const statements: { text: string; params: unknown[] }[] = []
  return {
    statements,
    async execute(query: unknown) {
      const chunks = (query as { queryChunks: unknown[] }).queryChunks
      const text: string[] = []
      const params: unknown[] = []
      const walk = (parts: unknown[]) => {
        for (const part of parts) {
          if (part !== null && typeof part === 'object' && 'value' in (part as object) && Array.isArray((part as { value: unknown }).value)) {
            text.push(((part as { value: string[] }).value).join(''))
          } else if (part !== null && typeof part === 'object' && 'queryChunks' in (part as object)) {
            walk((part as { queryChunks: unknown[] }).queryChunks)
          } else {
            params.push(part)
          }
        }
      }
      walk(chunks)
      statements.push({ text: text.join('?'), params })
      return { rows: answers.shift() ?? [] }
    },
  }
}

function fakeEmbedder(byText: Record<string, number[]> = {}): TextEmbedder & { seen: string[] } {
  const seen: string[] = []
  return {
    model: 'test-model',
    seen,
    async embed(texts) {
      seen.push(...texts)
      return texts.map((t) => {
        const v = new Float32Array(CATALOG_EMBEDDING_DIMS)
        const head = byText[t] ?? [1]
        head.forEach((x, i) => {
          v[i] = x
        })
        return v
      })
    },
  }
}

describe('embedding catalogue rows', () => {
  it('embeds rows with no vector or another model’s, bound to the row’s revision', async () => {
    const db = stubDb([
      [
        {
          row_key: 'r1',
          item_revision: '3',
          name: 'Butter croissant',
          brand: null,
          description: 'All-butter',
          category_ids: ['bakery'],
        },
      ],
    ])
    const embedder = fakeEmbedder()
    expect(await backfillCatalogEmbeddings(db, embedder)).toBe(1)
    expect(embedder.seen).toEqual(['Butter croissant. All-butter. bakery'])
    expect(db.statements[0]?.text).toContain('embedding IS NULL OR embedding_model IS DISTINCT FROM')
    expect(db.statements[0]?.params).toContain('test-model')
    const update = db.statements[1]
    expect(update?.text).toContain('UPDATE commerce_catalog_products')
    expect(update?.params).toEqual(expect.arrayContaining(['test-model', 'r1', '3']))
  })

  it('does nothing when every row is embedded', async () => {
    const db = stubDb([[]])
    expect(await backfillCatalogEmbeddings(db, fakeEmbedder())).toBe(0)
    expect(db.statements).toHaveLength(1)
  })
})

describe('the meaning layer the search asks', () => {
  afterEach(() => installCatalogSemantic(null))

  it('keeps rows at or above the cut-off, and embeds a repeated query once', async () => {
    const embedder = fakeEmbedder()
    const semantic = createCatalogSemantic(embedder)
    const db = stubDb([
      [
        { row_key: 'close', similarity: 0.78 },
        { row_key: 'edge', similarity: MEANING_MIN_SIMILARITY },
        { row_key: 'noise', similarity: 0.57 },
      ],
      [],
    ])
    const found = await semantic.similar(db, 'Croissants', null)
    expect([...found.entries()]).toEqual([
      ['close', 0.78],
      ['edge', MEANING_MIN_SIMILARITY],
    ])
    await semantic.similar(db, 'croissants ', null)
    expect(embedder.seen).toEqual(['croissants'])
    expect(db.statements[0]?.text).toContain('embedding_model =')
  })

  it('is off until the web process installs it', () => {
    expect(getCatalogSemantic()).toBeNull()
  })
})

describe('starting it', () => {
  it('stays off when told to, and on a Postgres without pgvector', async () => {
    startCatalogSemantic(stubDb(), { CATALOG_SEMANTIC: 'off' } as NodeJS.ProcessEnv)
    expect(getCatalogSemantic()).toBeNull()
    const refusing = {
      async execute() {
        throw Object.assign(new Error('extension "vector" is not available'), { code: '0A000' })
      },
    }
    expect(await ensureCatalogEmbeddingColumns(refusing)).toBe(false)
  })
})

/**
 * The real model against the cut-off (`RUN_MODEL_TESTS=1`; fetches the model
 * on first run). Guards the numbers in `catalog-semantic.ts`: a new model or
 * new cut-off must still find a bakery for "croissants" and not for
 * "plumber".
 */
describe.runIf(process.env.RUN_MODEL_TESTS === '1')('the real model', () => {
  it('finds bakery items by meaning, and keeps unrelated asks below the cut-off', async () => {
    const { loadLocalEmbedder } = await import('@/shared/semantic/catalog-semantic.js')
    const embedder = await loadLocalEmbedder({
      ...(process.env.CATALOG_EMBED_MODEL_DIR !== undefined ? { modelDir: process.env.CATALOG_EMBED_MODEL_DIR } : {}),
      allowRemote: true,
    })
    const items = [
      'Butter croissant. All-butter croissant, baked fresh each morning. bakery',
      'Pain au chocolat. Laminated dough with two dark chocolate batons. bakery',
      'Cinnamon bun. Soft cinnamon swirl bun. bakery',
    ]
    const itemVectors = await embedder.embed(items)
    const best = async (q: string) => {
      const [qv] = await embedder.embed([q])
      return Math.max(...itemVectors.map((v) => v.reduce((a, x, i) => a + x * qv![i]!, 0)))
    }
    for (const q of ['croissants', 'chocolate pastry', 'pastries for a cafe']) {
      expect(await best(q)).toBeGreaterThanOrEqual(MEANING_MIN_SIMILARITY)
    }
    for (const q of ['plumber', 'laptop', 'car tyres']) {
      expect(await best(q)).toBeLessThan(MEANING_MIN_SIMILARITY)
    }
  }, 120_000)
})
