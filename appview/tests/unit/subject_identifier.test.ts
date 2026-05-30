/**
 * Subject Tier-1 identity resolution — type-specific precedence + the
 * per-type identifier canonicalizer.
 *
 * Spec: docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 3.
 */

import { describe, expect, it } from 'vitest'
import {
  tier1Precedence,
  canonicalizeUri,
  canonicalizeIdentifier,
  resolveTier1Key,
} from '../../src/db/queries/subject_identifier.js'
import type { SubjectRef } from '../../src/shared/types/lexicon-types.js'

describe('tier1Precedence — type-specific Tier-1 order', () => {
  it('product / dataset: identifier beats uri (did still first)', () => {
    expect(tier1Precedence('product')).toEqual(['did', 'identifier', 'uri'])
    expect(tier1Precedence('dataset')).toEqual(['did', 'identifier', 'uri'])
  })

  it('content / place / organization / claim / did: uri beats identifier', () => {
    for (const t of ['content', 'place', 'organization', 'claim', 'did'] as const) {
      expect(tier1Precedence(t)).toEqual(['did', 'uri', 'identifier'])
    }
  })
})

describe('canonicalizeUri — YouTube video id extraction', () => {
  const ID = 'dQw4w9WgXcQ'

  it('the 5 URL spellings collapse to one `youtube:<id>` key', () => {
    const spellings = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
    ]
    const keys = spellings.map(canonicalizeUri)
    for (const k of keys) expect(k).toBe(`youtube:${ID}`)
  })

  it('drops timestamp / playlist / tracking params (same video)', () => {
    expect(canonicalizeUri(`https://youtu.be/${ID}?t=42`)).toBe(`youtube:${ID}`)
    expect(
      canonicalizeUri(`https://www.youtube.com/watch?v=${ID}&list=PLxxxx&index=3&t=90s`),
    ).toBe(`youtube:${ID}`)
    expect(
      canonicalizeUri(`https://www.youtube.com/watch?v=${ID}&utm_source=newsletter`),
    ).toBe(`youtube:${ID}`)
  })

  it('http vs https + www folds to the same key', () => {
    expect(canonicalizeUri(`http://youtube.com/watch?v=${ID}`)).toBe(`youtube:${ID}`)
  })

  it('shorts + live permalinks resolve to the same id', () => {
    expect(canonicalizeUri(`https://www.youtube.com/shorts/${ID}`)).toBe(`youtube:${ID}`)
    expect(canonicalizeUri(`https://www.youtube.com/live/${ID}`)).toBe(`youtube:${ID}`)
  })

  it('TWO DIFFERENT video ids → TWO different keys (no over-merge)', () => {
    const a = canonicalizeUri('https://youtu.be/aaaaaaaaaaa')
    const b = canonicalizeUri('https://youtu.be/bbbbbbbbbbb')
    expect(a).not.toBe(b)
  })

  it('a non-video YouTube URL (channel) is NOT mistaken for a video', () => {
    // No 11-char id → falls back to generic normalization, not youtube:<x>.
    const key = canonicalizeUri('https://www.youtube.com/@someChannel')
    expect(key.startsWith('youtube:')).toBe(false)
  })
})

describe('canonicalizeUri — generic article normalization', () => {
  it('folds scheme + host case and root trailing slash', () => {
    expect(canonicalizeUri('HTTPS://Example.COM/')).toBe('https://example.com')
  })

  it('strips the fragment (anchor != identity)', () => {
    expect(canonicalizeUri('https://x.test/article#section-2')).toBe('https://x.test/article')
  })

  it('strips tracking params but PRESERVES routing query (and its order)', () => {
    // utm_* dropped; the real ?id= survives, untouched + unreordered.
    expect(canonicalizeUri('https://shop.test/item?id=42&utm_source=fb')).toBe(
      'https://shop.test/item?id=42',
    )
    // order preserved — b before a, not sorted.
    expect(canonicalizeUri('https://x.test/p?b=2&a=1')).toBe('https://x.test/p?b=2&a=1')
  })

  it('distinct routing query → distinct keys (no conflation)', () => {
    expect(canonicalizeUri('https://shop.test/item?id=1')).not.toBe(
      canonicalizeUri('https://shop.test/item?id=2'),
    )
  })

  it('a malformed URL falls back to the raw string (drop-do-not-guess)', () => {
    expect(canonicalizeUri('not a url')).toBe('not a url')
  })
})

describe('canonicalizeIdentifier — barcode / ASIN format-normalize', () => {
  it('ASIN value uppercases; scheme lowercases', () => {
    expect(canonicalizeIdentifier('ASIN:b01234abcd')).toBe('asin:B01234ABCD')
    expect(canonicalizeIdentifier('asin:B01234ABCD')).toBe('asin:B01234ABCD')
  })

  it('UPC / EAN / GTIN all unify to gtin:<14-digit> (one product, one id)', () => {
    // A UPC-A (12), the EAN-13, and the GTIN-14 of the same product are the
    // SAME GS1 identifier at different lengths — they must converge to ONE
    // canonical key (scheme collapses to `gtin`, digits zero-padded to 14).
    const upc = canonicalizeIdentifier('upc:036000291452') // 12 digits
    const ean = canonicalizeIdentifier('ean:0036000291452') // 13 digits
    const gtin = canonicalizeIdentifier('gtin:00036000291452') // 14 digits
    expect(upc).toBe('gtin:00036000291452')
    expect(ean).toBe('gtin:00036000291452')
    expect(gtin).toBe('gtin:00036000291452')
    expect(upc).toBe(ean)
    expect(ean).toBe(gtin)
  })

  it('a non-numeric GTIN value is NOT padded (passes through, scheme lowercased)', () => {
    // Defensive: only digit strings are GS1 codes. A malformed value keeps
    // its scheme rather than being silently coerced.
    expect(canonicalizeIdentifier('gtin:not-a-barcode')).toBe('gtin:not-a-barcode')
  })

  it('an identifier with no scheme passes through verbatim', () => {
    expect(canonicalizeIdentifier('justaplainstring')).toBe('justaplainstring')
  })

  it('an unknown scheme keeps its value verbatim (only scheme lowercased)', () => {
    expect(canonicalizeIdentifier('WIKIDATA:Q28865')).toBe('wikidata:Q28865')
  })
})

describe('resolveTier1Key — precedence + canonicalization together', () => {
  it('PRODUCT with both uri + identifier resolves by identifier (P1b)', () => {
    const ref: SubjectRef = {
      type: 'product',
      uri: 'https://store.test/dp/B01234ABCD',
      identifier: 'asin:b01234abcd',
    }
    expect(resolveTier1Key(ref)).toBe('id:asin:B01234ABCD')
  })

  it('CONTENT with both uri + identifier resolves by uri', () => {
    const ref: SubjectRef = {
      type: 'content',
      uri: 'https://youtu.be/dQw4w9WgXcQ',
      identifier: 'asin:b01234abcd',
    }
    expect(resolveTier1Key(ref)).toBe('uri:youtube:dQw4w9WgXcQ')
  })

  it('did always wins regardless of type', () => {
    const ref: SubjectRef = {
      type: 'product',
      did: 'did:plc:abc',
      uri: 'https://store.test/x',
      identifier: 'asin:b01234abcd',
    }
    expect(resolveTier1Key(ref)).toBe('did:did:plc:abc')
  })

  it('returns null when no Tier-1 field is present (caller falls to name)', () => {
    expect(resolveTier1Key({ type: 'product', name: 'Aeron Chair' })).toBeNull()
    expect(resolveTier1Key({ type: 'content' })).toBeNull()
  })

  it('treats empty-string Tier-1 fields as absent', () => {
    expect(resolveTier1Key({ type: 'product', did: '', uri: '', identifier: '' })).toBeNull()
  })
})
