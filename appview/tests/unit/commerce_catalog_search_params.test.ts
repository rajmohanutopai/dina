/**
 * The xRPC QUERY-STRING contract for catalog discovery (§10.5, WS-11.4).
 *
 * THE DEFECT THIS PINS. The server built its parameter object with
 * `Object.fromEntries(url.searchParams.entries())`, which keeps one value per
 * key — the last copy of a repeated parameter. `searchCatalog` declares
 * `identifier` and `category` as ARRAYS, so neither could ever be supplied:
 * the schema saw a string, answered `Expected array, received string`, and the
 * endpoint returned 400 for every request that used them.
 *
 * Those two are discovery's strongest signals. An exact identifier match IS
 * the product, and category is how a buyer with no supplier in mind starts. So
 * the one endpoint that exists to let a buyer find a supplier they were never
 * told about worked only for free text and region — which is exactly the
 * shape of failure that reads as "a market with fewer suppliers in it" rather
 * than as an error.
 *
 * Both halves are pinned here because either alone still fails: the transport
 * has to PRESERVE repeats, and the schema has to accept a single value as a
 * one-element list, because one value in a query string is a string and a
 * caller has no way to say otherwise.
 */

import { describe, expect, it } from 'vitest'

import { CommerceCatalogSearchParams } from '@/api/xrpc/commerce-catalog-search.js'
import { dispatchXrpc } from '@/web/xrpc-dispatch.js'
import { queryToRecord } from '@/web/xrpc-query.js'
import { XRPC_ROUTES } from '@/web/xrpc-routes.js'

/** Exactly what the server does with an incoming URL, in the same order. */
function asServerDoes(queryString: string) {
  const url = new URL(`http://appview.test/xrpc/com.dinakernel.commerce.searchCatalog${queryString}`)
  return CommerceCatalogSearchParams.safeParse(queryToRecord(url.searchParams))
}

describe('queryToRecord', () => {
  it('keeps a repeated key as an array', () => {
    const record = queryToRecord(new URLSearchParams('category=a&category=b'))
    expect(record.category).toEqual(['a', 'b'])
  })

  it('leaves a single key as a scalar, so scalar fields still parse', () => {
    const record = queryToRecord(new URLSearchParams('q=chair'))
    expect(record.q).toBe('chair')
  })

  it('does NOT split on commas', () => {
    // A comma is legal inside a category id, a product identifier and a DID.
    // Splitting would turn one caller's value into two.
    const record = queryToRecord(new URLSearchParams('category=a%2Cb'))
    expect(record.category).toBe('a,b')
  })

  it('keeps an empty value rather than dropping the key', () => {
    // `?q=` is a caller saying something, and the schema is where that is
    // judged. Dropping it here would turn a bad request into a broad one.
    expect(queryToRecord(new URLSearchParams('q=')).q).toBe('')
  })
})

describe('a real query string reaches the schema', () => {
  it('accepts ONE category', () => {
    const parsed = asServerDoes('?category=furniture.seating')
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.category).toEqual(['furniture.seating'])
  })

  it('accepts SEVERAL categories', () => {
    const parsed = asServerDoes('?category=furniture.seating&category=furniture.tables')
    expect(parsed.success && parsed.data.category).toEqual([
      'furniture.seating',
      'furniture.tables',
    ])
  })

  it('accepts one identifier and several', () => {
    expect(asServerDoes('?identifier=gtin:05012345678900').success).toBe(true)
    const many = asServerDoes('?identifier=gtin:05012345678900&identifier=gtin:05012345678917')
    expect(many.success && many.data.identifier).toHaveLength(2)
  })

  it('still accepts the scalar fields, and applies the default limit', () => {
    const parsed = asServerDoes('?q=chair&region=admin_area:IN-KA&supplier=did:plc:x')
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.limit).toBe(20)
  })

  it('the bounds are REAL — a caller cannot ask for the whole index', () => {
    // The cap exists so one request cannot become a scan. A schema whose
    // fields could not be supplied never enforced anything.
    expect(asServerDoes('?limit=100000').success).toBe(false)
    expect(asServerDoes('?limit=0').success).toBe(false)
    expect(asServerDoes('?limit=50').success).toBe(true)
  })

  it('refuses more list entries than the cap allows', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `category=c${String(i)}`).join('&')
    expect(asServerDoes(`?${tooMany}`).success).toBe(false)
  })

  it('refuses an over-long list entry', () => {
    expect(asServerDoes(`?category=${'x'.repeat(65)}`).success).toBe(false)
  })

  it('refuses an empty list entry rather than treating it as absent', () => {
    expect(asServerDoes('?category=').success).toBe(false)
  })
})

/**
 * THE REAL REGISTRATION, through the real dispatch.
 *
 * The first version of this block read `server.ts` as TEXT and asserted a
 * substring, because the route table lived inside a module that calls
 * `server.listen` on import. That guard was better than nothing and worse than
 * a test: it pinned a spelling, not a behaviour.
 *
 * The table is now data in `xrpc-routes.ts` and the rules are a pure function
 * in `xrpc-dispatch.ts`, so this drives what the server drives — the same map,
 * the same parse, the same status mapping — with no port and no socket.
 */
describe('the registered searchCatalog route, end to end through the dispatch', () => {
  const METHOD = 'com.dinakernel.commerce.searchCatalog'

  /** A database that records the parameters it was handed and returns nothing. */
  function recordingDb() {
    const seen: unknown[] = []
    return { seen }
  }

  it('is registered under its lexicon id', () => {
    expect(XRPC_ROUTES[METHOD]).toBeDefined()
  })

  it('passes a REPEATED category through to the handler as an array', async () => {
    const seen: unknown[] = []
    const outcome = await dispatchXrpc({
      routes: {
        [METHOD]: {
          params: XRPC_ROUTES[METHOD]!.params,
          handler: async (_db, params) => {
            seen.push(params)
            return { candidates: [] }
          },
        },
      },
      db: recordingDb(),
      methodId: METHOD,
      searchParams: new URLSearchParams('category=furniture.seating&category=furniture.tables'),
    })

    expect(outcome.status).toBe(200)
    expect((seen[0] as { category: string[] }).category).toEqual([
      'furniture.seating',
      'furniture.tables',
    ])
  })

  it('answers 400 on a parameter the schema refuses, without reaching the handler', async () => {
    let reached = false
    const outcome = await dispatchXrpc({
      routes: {
        [METHOD]: {
          params: XRPC_ROUTES[METHOD]!.params,
          handler: async () => {
            reached = true
            return {}
          },
        },
      },
      db: recordingDb(),
      methodId: METHOD,
      searchParams: new URLSearchParams('limit=100000'),
    })

    expect(outcome.status).toBe(400)
    expect(reached).toBe(false)
  })

  it('answers 400 for a method it does not know', async () => {
    const outcome = await dispatchXrpc({
      routes: XRPC_ROUTES,
      db: recordingDb(),
      methodId: 'com.dinakernel.commerce.notAThing',
      searchParams: new URLSearchParams(),
    })
    expect(outcome.status).toBe(400)
  })

  it('turns a handler failure into a 500 that says NOTHING about why', async () => {
    // A handler's error can name a table, a query or a connection string.
    const reported: unknown[] = []
    const outcome = await dispatchXrpc({
      routes: {
        [METHOD]: {
          params: XRPC_ROUTES[METHOD]!.params,
          handler: async () => {
            throw new Error('relation "commerce_catalog_products" does not exist')
          },
        },
      },
      db: recordingDb(),
      methodId: METHOD,
      searchParams: new URLSearchParams('q=chair'),
      onError: (err) => reported.push(err),
    })

    expect(outcome.status).toBe(500)
    expect(JSON.stringify(outcome.body)).not.toContain('commerce_catalog_products')
    // And the operator still learns of it.
    expect(reported).toHaveLength(1)
  })
})
