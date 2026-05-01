/**
 * §unit — OpenGraph + JSON-LD price parser (TN-V2-META-009)
 *
 * Pure parser tests; HTTP fetch is a deferred orchestration concern.
 * The injectable `now` keeps assertions deterministic.
 */

import { describe, it, expect } from 'vitest'
import { parseOpenGraphPrice } from '@/util/parse_open_graph_price'

const FROZEN_NOW = 1_777_500_000_000
const opts = { now: () => FROZEN_NOW }

describe('parseOpenGraphPrice — input shape', () => {
  it('returns null for empty / null / non-string input', () => {
    expect(parseOpenGraphPrice('', opts)).toBeNull()
    expect(parseOpenGraphPrice(null, opts)).toBeNull()
    expect(parseOpenGraphPrice(undefined, opts)).toBeNull()
    expect(parseOpenGraphPrice(123 as unknown as string, opts)).toBeNull()
  })

  it('returns null when HTML has no price markup at all', () => {
    expect(parseOpenGraphPrice('<html><body>just text</body></html>', opts)).toBeNull()
  })

  it('returns null when only currency is present (price missing)', () => {
    const html = `<head><meta property="product:price:currency" content="USD"></head>`
    expect(parseOpenGraphPrice(html, opts)).toBeNull()
  })

  it('returns null when only price is present (currency missing)', () => {
    const html = `<head><meta property="product:price:amount" content="29.99"></head>`
    expect(parseOpenGraphPrice(html, opts)).toBeNull()
  })
})

describe('parseOpenGraphPrice — OpenGraph product meta', () => {
  it('extracts a point price from product:price:amount + currency', () => {
    const html = `
      <head>
        <meta property="product:price:amount" content="29.99">
        <meta property="product:price:currency" content="USD">
      </head>`
    expect(parseOpenGraphPrice(html, opts)).toEqual({
      low_e7: 299_900_000,
      high_e7: 299_900_000,
      currency: 'USD',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('handles single-quoted attributes', () => {
    const html = `
      <meta property='product:price:amount' content='10.00'>
      <meta property='product:price:currency' content='gbp'>`
    expect(parseOpenGraphPrice(html, opts)).toEqual({
      low_e7: 100_000_000,
      high_e7: 100_000_000,
      currency: 'GBP',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('handles content-before-property attribute order', () => {
    const html = `
      <meta content="100" property="product:price:amount">
      <meta content="EUR" property="product:price:currency">`
    expect(parseOpenGraphPrice(html, opts)).toEqual({
      low_e7: 1_000_000_000,
      high_e7: 1_000_000_000,
      currency: 'EUR',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('handles European decimal-comma price (29,99 → 29.99)', () => {
    const html = `
      <meta property="product:price:amount" content="29,99">
      <meta property="product:price:currency" content="EUR">`
    expect(parseOpenGraphPrice(html, opts)?.low_e7).toBe(299_900_000)
  })

  it('returns null when price has currency symbol prefix (we want decimal-only)', () => {
    const html = `
      <meta property="product:price:amount" content="$29.99">
      <meta property="product:price:currency" content="USD">`
    expect(parseOpenGraphPrice(html, opts)).toBeNull()
  })

  it('returns null when currency is a symbol, not an ISO 4217 code', () => {
    const html = `
      <meta property="product:price:amount" content="29.99">
      <meta property="product:price:currency" content="$">`
    expect(parseOpenGraphPrice(html, opts)).toBeNull()
  })

  it('returns null when price is negative', () => {
    const html = `
      <meta property="product:price:amount" content="-1">
      <meta property="product:price:currency" content="USD">`
    expect(parseOpenGraphPrice(html, opts)).toBeNull()
  })

  it('rounds float imprecision to clean integer e7', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754 — the parser
    // must round so we don't smuggle float imprecision into a
    // CBOR-int wire field.
    const html = `
      <meta property="product:price:amount" content="0.30000000000000004">
      <meta property="product:price:currency" content="USD">`
    const r = parseOpenGraphPrice(html, opts)
    expect(r?.low_e7).toBe(3_000_000)
  })
})

describe('parseOpenGraphPrice — JSON-LD Offer fallback', () => {
  it('extracts a point price from a Product.offers Offer node', () => {
    const ld = JSON.stringify({
      '@type': 'Product',
      name: 'Aeron Chair',
      offers: {
        '@type': 'Offer',
        price: '999.00',
        priceCurrency: 'USD',
      },
    })
    const html = `<script type="application/ld+json">${ld}</script>`
    expect(parseOpenGraphPrice(html, opts)).toEqual({
      low_e7: 9_990_000_000,
      high_e7: 9_990_000_000,
      currency: 'USD',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('extracts a range from an AggregateOffer (lowPrice / highPrice)', () => {
    const ld = JSON.stringify({
      '@type': 'Product',
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: '19.99',
        highPrice: '49.99',
        priceCurrency: 'GBP',
      },
    })
    const html = `<script type="application/ld+json">${ld}</script>`
    expect(parseOpenGraphPrice(html, opts)).toEqual({
      low_e7: 199_900_000,
      high_e7: 499_900_000,
      currency: 'GBP',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('drills into a `@graph` envelope', () => {
    const ld = JSON.stringify({
      '@graph': [
        { '@type': 'WebSite' },
        {
          '@type': 'Product',
          offers: { '@type': 'Offer', price: '5.00', priceCurrency: 'EUR' },
        },
      ],
    })
    expect(parseOpenGraphPrice(`<script type="application/ld+json">${ld}</script>`, opts)).toEqual({
      low_e7: 50_000_000,
      high_e7: 50_000_000,
      currency: 'EUR',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('AggregateOffer with low > high falls through to point-price (malformed range)', () => {
    const ld = JSON.stringify({
      '@type': 'Product',
      offers: {
        '@type': 'AggregateOffer',
        lowPrice: '99.99',
        highPrice: '9.99',     // reversed — drop
        price: '50.00',         // point fallback
        priceCurrency: 'USD',
      },
    })
    expect(parseOpenGraphPrice(`<script type="application/ld+json">${ld}</script>`, opts)).toEqual({
      low_e7: 500_000_000,
      high_e7: 500_000_000,
      currency: 'USD',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('AggregateOffer wins over Offer when both are present in the same block (range > point)', () => {
    // Real-world schema.org Product pages sometimes emit both a
    // canonical AggregateOffer and individual Offer entries. The
    // canonical price summary is the AggregateOffer's range — if
    // the Offer (point price) appeared earlier in the JSON and
    // tree-walk order was the only tiebreaker, the range would be
    // silently dropped. Pin "range beats point regardless of
    // ordering" so this preference can't regress.
    const ldOfferFirst = JSON.stringify({
      '@type': 'Product',
      offers: [
        { '@type': 'Offer', price: '25.00', priceCurrency: 'USD' },
        { '@type': 'AggregateOffer', lowPrice: '10.00', highPrice: '50.00', priceCurrency: 'USD' },
      ],
    })
    const r = parseOpenGraphPrice(`<script type="application/ld+json">${ldOfferFirst}</script>`, opts)
    expect(r).toEqual({
      low_e7: 100_000_000,
      high_e7: 500_000_000,
      currency: 'USD',
      lastSeenMs: FROZEN_NOW,
    })
  })

  it('returns null when JSON-LD Offer has no priceCurrency', () => {
    const ld = JSON.stringify({
      '@type': 'Product',
      offers: { '@type': 'Offer', price: '10.00' }, // no currency
    })
    expect(parseOpenGraphPrice(`<script type="application/ld+json">${ld}</script>`, opts)).toBeNull()
  })

  it('returns null when JSON-LD is malformed (graceful degrade)', () => {
    expect(parseOpenGraphPrice(`<script type="application/ld+json">{ broken</script>`, opts)).toBeNull()
  })
})

describe('parseOpenGraphPrice — priority + integration', () => {
  it('OpenGraph wins over JSON-LD when both are present (deterministic priority)', () => {
    const ld = JSON.stringify({
      '@type': 'Product',
      offers: { '@type': 'Offer', price: '999.00', priceCurrency: 'EUR' },
    })
    const html = `
      <head>
        <meta property="product:price:amount" content="29.99">
        <meta property="product:price:currency" content="USD">
      </head>
      <script type="application/ld+json">${ld}</script>`
    const r = parseOpenGraphPrice(html, opts)!
    expect(r.currency).toBe('USD')
    expect(r.low_e7).toBe(299_900_000)
  })

  it('lastSeenMs reflects the injectable now (deterministic)', () => {
    const html = `
      <meta property="product:price:amount" content="1.00">
      <meta property="product:price:currency" content="USD">`
    const r1 = parseOpenGraphPrice(html, { now: () => 1000 })
    const r2 = parseOpenGraphPrice(html, { now: () => 2000 })
    expect(r1?.lastSeenMs).toBe(1000)
    expect(r2?.lastSeenMs).toBe(2000)
  })

  it('output is META-002 wire-compatible (passes Zod validator round-trip)', async () => {
    const { validateRecord } = await import('@/ingester/record-validator')
    const html = `
      <meta property="product:price:amount" content="29.99">
      <meta property="product:price:currency" content="USD">`
    const parsed = parseOpenGraphPrice(html, opts)!
    // The parser output must round-trip cleanly through the META-002
    // validator — i.e. the auto-fill matches the wire contract for
    // reviewer-declared price. This is the hard-pin against schema
    // drift between the enricher and reviewer paths.
    const r = validateRecord('com.dina.trust.attestation', {
      subject: { type: 'product', name: 'Product' },
      category: 'product',
      sentiment: 'positive',
      price: parsed,
      createdAt: new Date().toISOString(),
    })
    expect(r.success).toBe(true)
  })
})
