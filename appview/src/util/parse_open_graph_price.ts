/**
 * OpenGraph + JSON-LD price → wire-shape parser (TN-V2-META-009).
 *
 * Pure parser: given an HTML string, extract a price object that
 * matches the META-002 wire contract:
 *
 *   { low_e7: number, high_e7: number, currency: string, lastSeenMs: number }
 *
 * Falls through to reviewer-declared `price` (the META-002 wire
 * field) when the page has no usable price markup. Returns `null`
 * to signal "no signal" so the downstream layer can distinguish a
 * missing extraction from a confirmed-zero price.
 *
 * **What this parses (priority order):**
 *   1. OpenGraph product meta tags:
 *        <meta property="product:price:amount" content="29.99">
 *        <meta property="product:price:currency" content="USD">
 *      (These are Facebook's product-extension Open Graph spec —
 *      Amazon, Walmart, Etsy, and most major retail platforms emit
 *      them.)
 *   2. Schema.org JSON-LD `Product.offers.price` + `priceCurrency`:
 *        { "@type": "Offer", "price": "29.99", "priceCurrency": "USD" }
 *      AggregateOffer with `lowPrice` / `highPrice` is supported
 *      explicitly because that's the natural carrier for a range.
 *
 * **What this does NOT parse:**
 *   - Microdata / RDFa — JSON-LD only (same coverage rationale as
 *     META-010).
 *   - Free-text price scraping (e.g. "$29.99" in body copy) — too
 *     unreliable; the missing-pass behaviour of RANK-002 already
 *     covers the no-signal case.
 *
 * **Range vs point price:**
 *   - When the input declares a single price (point), `low_e7 == high_e7`.
 *   - When AggregateOffer declares a range, `low_e7 < high_e7`.
 * The wire contract requires `low_e7 ≤ high_e7`; this parser
 * guarantees it.
 *
 * **Currency normalisation:**
 *   - Always uppercased to match ISO 4217 alpha-3.
 *   - Currency symbols (`$`, `€`) are NOT mapped to codes — too
 *     ambiguous (`$` is USD, CAD, AUD, MXN, …). Markup that uses
 *     symbols instead of codes returns `null`.
 *
 * **lastSeenMs:**
 *   - Set to the current time at parse time. The HTTP fetcher (the
 *     deferred orchestration layer) is the natural source of
 *     "when did we observe this." The parser is pure but exposes
 *     `now()` as an injectable param for deterministic testing.
 *
 * Pure function. Same input + same `now` always returns the same
 * output. Designed to be fed into the (deferred) HTTP enricher
 * pipeline.
 */

import { extractJsonLdBlocks } from './json_ld_extract'

export interface ParsedPrice {
  low_e7: number
  high_e7: number
  currency: string
  lastSeenMs: number
}

const E7 = 10_000_000

/**
 * Convert a decimal-string price to e7 integer. Returns `null` for
 * non-numeric, negative, or out-of-safe-int range values.
 *
 * Handles:
 *   - `'29.99'` → `299_900_000`
 *   - `'1000'`  → `10_000_000_000`
 *   - `'29,99'` (European decimal comma) → `299_900_000`
 * Rejects:
 *   - `'$29.99'` (symbol prefix)
 *   - `'-1'` (negative)
 *   - `''` / non-string
 */
function priceToE7(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const s = typeof raw === 'number'
    ? String(raw)
    : typeof raw === 'string'
      ? raw.trim()
      : null
  if (s === null || s.length === 0) return null
  // Accept European decimal comma — many .de / .fr Open Graph emitters
  // use it. ASCII digits + at most one separator.
  const normalised = s.replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(normalised)) return null
  const n = Number(normalised)
  if (!Number.isFinite(n) || n < 0) return null
  // Round to integer e7 so float imprecision doesn't leak through.
  // Math.round guards `29.99 * 1e7 = 299899999.99...` → `299_900_000`.
  const e7 = Math.round(n * E7)
  if (!Number.isSafeInteger(e7)) return null
  return e7
}

function normaliseCurrency(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const upper = raw.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(upper)) return null
  return upper
}

/**
 * Pull the `content` attribute value for the first matching OpenGraph
 * meta tag. Robust against:
 *   - Single OR double quotes around attributes
 *   - Attribute order (`property` before/after `content`)
 *   - Self-closing `/>` vs `>`
 *   - Optional whitespace
 */
function extractMetaContent(html: string, property: string): string | null {
  // We need both shapes: property=...content=... AND content=...property=...
  const propEsc = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // property before content
  const r1 = new RegExp(
    `<meta\\b[^>]*\\bproperty\\s*=\\s*["']${propEsc}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  )
  const m1 = html.match(r1)
  if (m1) return m1[1]
  // content before property
  const r2 = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bproperty\\s*=\\s*["']${propEsc}["']`,
    'i',
  )
  const m2 = html.match(r2)
  return m2 ? m2[1] : null
}

function extractOpenGraphPrice(html: string): { low: number; high: number; currency: string } | null {
  const amount = extractMetaContent(html, 'product:price:amount')
  const currency = extractMetaContent(html, 'product:price:currency')
  if (!amount || !currency) return null
  const e7 = priceToE7(amount)
  const cur = normaliseCurrency(currency)
  if (e7 === null || cur === null) return null
  return { low: e7, high: e7, currency: cur }
}

function* iterOffers(node: unknown): IterableIterator<Record<string, unknown>> {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) yield* iterOffers(item)
    return
  }
  if (typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if ('@graph' in obj) yield* iterOffers(obj['@graph'])
  if ('offers' in obj) yield* iterOffers(obj.offers)
  // Direct Offer / AggregateOffer node
  const t = obj['@type']
  if (t === 'Offer' || t === 'AggregateOffer'
      || (Array.isArray(t) && t.some((x) => x === 'Offer' || x === 'AggregateOffer'))) {
    yield obj
  }
}

function extractJsonLdPrice(html: string): { low: number; high: number; currency: string } | null {
  // Two-pass: collect candidates per block, then prefer AggregateOffer
  // (range) over Offer (point). Schema.org best practice puts the
  // canonical price summary in an AggregateOffer when both types are
  // emitted on the same Product; if we just took the first valid match
  // in tree-walk order, an Offer appearing earlier than the
  // AggregateOffer would silently win and the range would be lost.
  // Within each type, first valid wins (deterministic given JSON
  // insertion order).
  const blocks = extractJsonLdBlocks(html)
  for (const block of blocks) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    let aggregate: { low: number; high: number; currency: string } | null = null
    let point: { low: number; high: number; currency: string } | null = null
    for (const offer of iterOffers(parsed)) {
      const cur = normaliseCurrency(offer.priceCurrency)
      if (!cur) continue
      // AggregateOffer takes priority when valid.
      if (aggregate === null) {
        const low = priceToE7(offer.lowPrice)
        const high = priceToE7(offer.highPrice)
        if (low !== null && high !== null && low <= high) {
          aggregate = { low, high, currency: cur }
        }
      }
      // Point-Offer is the fallback.
      if (point === null) {
        const p = priceToE7(offer.price)
        if (p !== null) {
          point = { low: p, high: p, currency: cur }
        }
      }
      // Early-exit when we have a range — no need to keep walking.
      if (aggregate !== null) break
    }
    if (aggregate !== null) return aggregate
    if (point !== null) return point
  }
  return null
}

export interface ParseOpenGraphPriceOptions {
  /**
   * Injectable clock for deterministic tests. Defaults to
   * `Date.now()`. The HTTP fetcher will pass the actual
   * fetch-completion time so `lastSeenMs` reflects the observation
   * moment, not the parse moment.
   */
  now?: () => number
}

/**
 * Parse OpenGraph product meta tags and JSON-LD `Offer` from an HTML
 * string. Returns a META-002-shaped object or `null` when no usable
 * signal is present.
 *
 * Priority: OpenGraph product:price:amount + currency wins over
 * JSON-LD Offer. Both are valid signals; OpenGraph is the more
 * widely deployed convention and is structurally simpler so we
 * prefer it for determinism.
 */
export function parseOpenGraphPrice(
  html: string | null | undefined,
  options: ParseOpenGraphPriceOptions = {},
): ParsedPrice | null {
  if (typeof html !== 'string' || html.length === 0) return null
  const now = options.now ?? (() => Date.now())
  const og = extractOpenGraphPrice(html)
  const result = og ?? extractJsonLdPrice(html)
  if (!result) return null
  return {
    low_e7: result.low,
    high_e7: result.high,
    currency: result.currency,
    lastSeenMs: now(),
  }
}
