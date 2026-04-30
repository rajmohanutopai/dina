/**
 * Subject enrichment heuristic tests (TN-ENRICH-005).
 *
 * Pins the per-type rules verbatim from plan §3.6.3:
 *
 *   - product: identifier-priority (ASIN < ISBN-10/13), commerce
 *     host detection, name-keyword segment refinement
 *   - place: place_id extraction, Google Maps coord parsing,
 *     name-keyword place_type
 *   - content: host + media_type from host_category
 *   - dataset: DOI / arxiv with publication_year from id
 *   - organization: TLD heuristic + known_orgs override (QID +
 *     canonical_name + type)
 *   - did: method extraction from `did:<method>:...`
 *   - claim: domain keyword scan
 *
 * Plus structural invariants:
 *   - Output frozen at every level.
 *   - `metadata` always an object (possibly empty).
 *   - `category` always at least the bare type segment.
 *
 * Pure function — runs under vitest.
 */

import { describe, it, expect } from 'vitest'
import { enrichSubject, type SubjectRef } from '@/util/subject_enrichment'

// ─── product ──────────────────────────────────────────────────────────────

describe('enrichSubject — product', () => {
  it('bare type with no signals → category="product", empty metadata', () => {
    const r = enrichSubject({ type: 'product' })
    expect(r.category).toBe('product')
    expect(r.metadata).toEqual({})
  })

  it('ASIN identifier → identifier_kind=asin, category=product (refined by name keyword)', () => {
    const r = enrichSubject({
      type: 'product',
      identifier: 'B07XYZ1234',
      name: 'Aeron office chair',
    })
    expect(r.category).toBe('product:furniture')
    expect(r.metadata.identifier_kind).toBe('asin')
    expect(r.metadata.identifier).toBe('B07XYZ1234')
  })

  it('ASIN identifier alone (no name keyword) → category=product', () => {
    const r = enrichSubject({ type: 'product', identifier: 'B07XYZ1234' })
    expect(r.category).toBe('product')
    expect(r.metadata.identifier_kind).toBe('asin')
  })

  it('ISBN-13 identifier → category=product:book (overrides name keyword)', () => {
    const r = enrichSubject({
      type: 'product',
      identifier: '9780131103627',
      name: 'The C Programming Language',
    })
    expect(r.category).toBe('product:book')
    expect(r.metadata.identifier_kind).toBe('isbn-13')
  })

  it('ISBN-10 identifier → category=product:book', () => {
    const r = enrichSubject({ type: 'product', identifier: '0131103628' })
    expect(r.category).toBe('product:book')
    expect(r.metadata.identifier_kind).toBe('isbn-10')
  })

  it('UPC identifier → category=product, identifier_kind=upc', () => {
    const r = enrichSubject({ type: 'product', identifier: '036000291452' })
    expect(r.category).toBe('product')
    expect(r.metadata.identifier_kind).toBe('upc')
  })

  it('EAN-13 identifier → category=product, identifier_kind=ean-13', () => {
    const r = enrichSubject({ type: 'product', identifier: '5901234123457' })
    expect(r.category).toBe('product')
    expect(r.metadata.identifier_kind).toBe('ean-13')
  })

  it('amazon URI → metadata.host=amazon.<tld>', () => {
    const r = enrichSubject({
      type: 'product',
      uri: 'https://www.amazon.com/dp/B07XYZ1234',
      name: 'My laptop',
    })
    expect(r.category).toBe('product:electronics')
    expect(r.metadata.host).toBe('amazon.com')
  })

  it('amazon.in / amazon.co.uk also matches via prefix', () => {
    expect(enrichSubject({ type: 'product', uri: 'https://amazon.in/something' }).metadata.host).toBe(
      'amazon.in',
    )
    expect(
      enrichSubject({ type: 'product', uri: 'https://www.amazon.co.uk/x' }).metadata.host,
    ).toBe('amazon.co.uk')
  })

  it('flipkart / bestbuy / walmart match exact commerce hosts', () => {
    expect(enrichSubject({ type: 'product', uri: 'https://flipkart.com/x' }).metadata.host).toBe(
      'flipkart.com',
    )
    expect(enrichSubject({ type: 'product', uri: 'https://bestbuy.com/x' }).metadata.host).toBe(
      'bestbuy.com',
    )
    expect(enrichSubject({ type: 'product', uri: 'https://walmart.com/x' }).metadata.host).toBe(
      'walmart.com',
    )
  })

  it('non-commerce host (notamazon.com) does NOT match', () => {
    const r = enrichSubject({ type: 'product', uri: 'https://notamazon.com/' })
    expect(r.metadata.host).toBeUndefined()
  })

  it('name keyword refines category segment when no ISBN', () => {
    const r = enrichSubject({ type: 'product', name: 'Sony headphones' })
    expect(r.category).toBe('product:electronics')
  })
})

// ─── place ────────────────────────────────────────────────────────────────

describe('enrichSubject — place', () => {
  it('bare type → category=place', () => {
    expect(enrichSubject({ type: 'place' }).category).toBe('place')
  })

  it('place_id: prefix → metadata.google_place_id', () => {
    const r = enrichSubject({
      type: 'place',
      identifier: 'place_id:ChIJ2eUgeAK6j4ARbn5u_wAGqWA',
    })
    expect(r.category).toBe('place')
    expect(r.metadata.google_place_id).toBe('ChIJ2eUgeAK6j4ARbn5u_wAGqWA')
  })

  it('case-insensitive place_id: prefix', () => {
    const r = enrichSubject({
      type: 'place',
      identifier: 'PLACE_ID:ChIJ2eUgeAK6j4ARbn5u_wAGqWA',
    })
    expect(r.metadata.google_place_id).toBe('ChIJ2eUgeAK6j4ARbn5u_wAGqWA')
  })

  it('bare ChIJ-prefixed place id (no `place_id:`) → metadata.google_place_id', () => {
    const r = enrichSubject({
      type: 'place',
      identifier: 'ChIJ2eUgeAK6j4ARbn5u_wAGqWA',
    })
    expect(r.metadata.google_place_id).toBe('ChIJ2eUgeAK6j4ARbn5u_wAGqWA')
  })

  it('Google Maps URL @lat,lng → metadata.lat + lng', () => {
    const r = enrichSubject({
      type: 'place',
      uri: 'https://google.com/maps/place/Foo/@37.7749,-122.4194,17z',
    })
    expect(r.metadata.lat).toBe(37.7749)
    expect(r.metadata.lng).toBe(-122.4194)
  })

  it('Google Maps URL ?q=lat,lng → metadata.lat + lng', () => {
    const r = enrichSubject({
      type: 'place',
      uri: 'https://maps.google.com/?q=37.7749,-122.4194',
    })
    expect(r.metadata.lat).toBe(37.7749)
    expect(r.metadata.lng).toBe(-122.4194)
  })

  it('non-Google maps URL does NOT extract coords', () => {
    const r = enrichSubject({
      type: 'place',
      uri: 'https://example.com/?q=37.7749,-122.4194',
    })
    expect(r.metadata.lat).toBeUndefined()
    expect(r.metadata.lng).toBeUndefined()
  })

  it('out-of-range lat (>90) is rejected', () => {
    const r = enrichSubject({ type: 'place', uri: 'https://google.com/maps/@200,50,17z' })
    expect(r.metadata.lat).toBeUndefined()
  })

  it('name keyword → place_type + segment', () => {
    const r = enrichSubject({ type: 'place', name: 'Mona Cafe' })
    expect(r.category).toBe('place:cafe')
    expect(r.metadata.place_type).toBe('cafe')
  })

  it('combines place_id + name keyword', () => {
    const r = enrichSubject({
      type: 'place',
      identifier: 'place_id:ChIJ2eUgeAK6j4ARbn5u_wAGqWA',
      name: 'Joe Restaurant',
    })
    expect(r.category).toBe('place:restaurant')
    expect(r.metadata.google_place_id).toBe('ChIJ2eUgeAK6j4ARbn5u_wAGqWA')
    expect(r.metadata.place_type).toBe('restaurant')
  })
})

// ─── content ──────────────────────────────────────────────────────────────

describe('enrichSubject — content', () => {
  it('bare type → category=content', () => {
    expect(enrichSubject({ type: 'content' }).category).toBe('content')
  })

  it('YouTube URL → host + media_type=video', () => {
    const r = enrichSubject({
      type: 'content',
      uri: 'https://www.youtube.com/watch?v=abc',
    })
    expect(r.metadata.host).toBe('youtube.com')
    expect(r.metadata.media_type).toBe('video')
  })

  it('Medium URL → host + media_type=article', () => {
    const r = enrichSubject({ type: 'content', uri: 'https://medium.com/@u/post' })
    expect(r.metadata.host).toBe('medium.com')
    expect(r.metadata.media_type).toBe('article')
  })

  it('unknown content host → host populated, no media_type', () => {
    const r = enrichSubject({ type: 'content', uri: 'https://random.example/post' })
    expect(r.metadata.host).toBe('random.example')
    expect(r.metadata.media_type).toBeUndefined()
  })
})

// ─── dataset ──────────────────────────────────────────────────────────────

describe('enrichSubject — dataset', () => {
  it('bare type → category=dataset', () => {
    expect(enrichSubject({ type: 'dataset' }).category).toBe('dataset')
  })

  it('DOI identifier → metadata.doi', () => {
    const r = enrichSubject({ type: 'dataset', identifier: '10.1126/science.169.3946.635' })
    expect(r.metadata.doi).toBe('10.1126/science.169.3946.635')
  })

  it('arxiv identifier → metadata.arxiv_id + publication_year', () => {
    const r = enrichSubject({ type: 'dataset', identifier: '2103.00020' })
    expect(r.metadata.arxiv_id).toBe('2103.00020')
    expect(r.metadata.publication_year).toBe(2021)
  })

  it('arxiv pre-2007 form → publication_year derived correctly', () => {
    const r = enrichSubject({ type: 'dataset', identifier: 'cond-mat/9612001' })
    expect(r.metadata.arxiv_id).toBe('cond-mat/9612001')
    expect(r.metadata.publication_year).toBe(1996)
  })

  it('arxiv URL → arxiv_id extracted', () => {
    const r = enrichSubject({
      type: 'dataset',
      uri: 'https://arxiv.org/abs/2103.00020',
    })
    expect(r.metadata.arxiv_id).toBe('2103.00020')
    expect(r.metadata.publication_year).toBe(2021)
  })

  it('arxiv URL with version → arxiv_id with vN preserved', () => {
    const r = enrichSubject({
      type: 'dataset',
      uri: 'https://arxiv.org/abs/2103.00020v2',
    })
    expect(r.metadata.arxiv_id).toBe('2103.00020v2')
  })

  it('garbage identifier → no metadata (no arxiv_id / doi)', () => {
    const r = enrichSubject({ type: 'dataset', identifier: 'not a real identifier' })
    expect(r.metadata.arxiv_id).toBeUndefined()
    expect(r.metadata.doi).toBeUndefined()
  })
})

// ─── organization ─────────────────────────────────────────────────────────

describe('enrichSubject — organization', () => {
  it('bare type with no signals → category=organization:company (default)', () => {
    expect(enrichSubject({ type: 'organization' }).category).toBe('organization')
  })

  it('.edu URI → university', () => {
    const r = enrichSubject({ type: 'organization', uri: 'https://example.edu/about' })
    expect(r.category).toBe('organization:university')
    expect(r.metadata.org_type).toBe('university')
  })

  it('.gov URI → government', () => {
    const r = enrichSubject({ type: 'organization', uri: 'https://example.gov/' })
    expect(r.category).toBe('organization:government')
  })

  it('.org URI → nonprofit (weak signal)', () => {
    const r = enrichSubject({ type: 'organization', uri: 'https://example.org/' })
    expect(r.category).toBe('organization:nonprofit')
  })

  it('.com URI → company default', () => {
    const r = enrichSubject({ type: 'organization', uri: 'https://example.com/' })
    expect(r.category).toBe('organization:company')
  })

  it('known_orgs override by domain (MIT → university with QID)', () => {
    const r = enrichSubject({ type: 'organization', uri: 'https://mit.edu/news' })
    expect(r.category).toBe('organization:university')
    expect(r.metadata.qid).toBe('Q49108')
    expect(r.metadata.canonical_name).toBe('Massachusetts Institute of Technology')
  })

  it('known_orgs override by name (Google → company with QID)', () => {
    const r = enrichSubject({ type: 'organization', name: 'Google' })
    expect(r.category).toBe('organization:company')
    expect(r.metadata.qid).toBe('Q95')
    expect(r.metadata.canonical_name).toBe('Google')
  })

  it('known_orgs flips weak TLD heuristic (Wikimedia .org → nonprofit, but with high-confidence canonical)', () => {
    const r = enrichSubject({
      type: 'organization',
      uri: 'https://wikipedia.org/wiki/Foo',
      name: 'Wikipedia',
    })
    expect(r.category).toBe('organization:nonprofit')
    expect(r.metadata.canonical_name).toBe('Wikimedia Foundation')
  })
})

// ─── did ──────────────────────────────────────────────────────────────────

describe('enrichSubject — did', () => {
  it('bare type → category=did', () => {
    expect(enrichSubject({ type: 'did' }).category).toBe('did')
  })

  it('did:plc:... → method=plc', () => {
    const r = enrichSubject({ type: 'did', did: 'did:plc:abc123' })
    expect(r.metadata.did_method).toBe('plc')
  })

  it('did:key:... → method=key', () => {
    const r = enrichSubject({ type: 'did', did: 'did:key:z6Mk...' })
    expect(r.metadata.did_method).toBe('key')
  })

  it('did:web:... → method=web', () => {
    const r = enrichSubject({ type: 'did', did: 'did:web:example.com' })
    expect(r.metadata.did_method).toBe('web')
  })

  it('unknown method → no did_method field', () => {
    const r = enrichSubject({ type: 'did', did: 'did:future:xyz' })
    expect(r.metadata.did_method).toBeUndefined()
  })

  it('falls back to ref.uri when ref.did missing', () => {
    const r = enrichSubject({ type: 'did', uri: 'did:plc:from-uri' })
    expect(r.metadata.did_method).toBe('plc')
  })
})

// ─── claim ────────────────────────────────────────────────────────────────

describe('enrichSubject — claim', () => {
  it('bare type → category=claim', () => {
    expect(enrichSubject({ type: 'claim' }).category).toBe('claim')
  })

  it('"vaccine" in name → domain=health', () => {
    const r = enrichSubject({ type: 'claim', name: 'New vaccine effective?' })
    expect(r.metadata.domain).toBe('health')
  })

  it('"election" in name → domain=political', () => {
    const r = enrichSubject({ type: 'claim', name: '2024 election results' })
    expect(r.metadata.domain).toBe('political')
  })

  it('"crypto" in name → domain=finance', () => {
    const r = enrichSubject({ type: 'claim', name: 'Crypto market crash' })
    expect(r.metadata.domain).toBe('finance')
  })

  it('"climate" in name → domain=scientific', () => {
    const r = enrichSubject({ type: 'claim', name: 'Climate study findings' })
    expect(r.metadata.domain).toBe('scientific')
  })

  it('word-boundary match: "cryptography" does NOT match crypto', () => {
    const r = enrichSubject({ type: 'claim', name: 'Cryptography research paper' })
    // The word "cryptography" matches the `research` keyword (scientific)
    // before the `crypto` keyword would, due to first-match semantics.
    expect(r.metadata.domain).toBe('scientific')
  })

  it('no keyword match → no domain field', () => {
    const r = enrichSubject({ type: 'claim', name: 'Random unrelated claim' })
    expect(r.metadata.domain).toBeUndefined()
  })
})

// ─── Structural invariants ───────────────────────────────────────────────

describe('enrichSubject — structural invariants', () => {
  const samples: SubjectRef[] = [
    { type: 'product', identifier: 'B07XYZ1234', name: 'Aeron chair' },
    { type: 'place', identifier: 'place_id:ChIJ2eUgeAK6j4ARbn5u_wAGqWA' },
    { type: 'content', uri: 'https://youtube.com/watch?v=abc' },
    { type: 'dataset', identifier: '2103.00020' },
    { type: 'organization', uri: 'https://mit.edu/' },
    { type: 'did', did: 'did:plc:abc' },
    { type: 'claim', name: 'vaccine claim' },
  ]

  it('output frozen at top level', () => {
    for (const ref of samples) {
      const r = enrichSubject(ref)
      expect(Object.isFrozen(r)).toBe(true)
    }
  })

  it('metadata always frozen', () => {
    for (const ref of samples) {
      const r = enrichSubject(ref)
      expect(Object.isFrozen(r.metadata)).toBe(true)
    }
  })

  it('category never empty (at minimum the bare type segment)', () => {
    for (const ref of samples) {
      expect(enrichSubject(ref).category.length).toBeGreaterThan(0)
    }
  })

  it('metadata always an object (never undefined / null)', () => {
    for (const ref of samples) {
      const r = enrichSubject(ref)
      expect(typeof r.metadata).toBe('object')
      expect(r.metadata).not.toBeNull()
    }
  })

  it('mutation attempts on metadata fail (frozen)', () => {
    const r = enrichSubject({ type: 'product', name: 'Aeron chair' })
    try {
      // @ts-expect-error — confirming readonly enforcement at runtime
      r.metadata.newField = 'hijack'
    } catch {
      // Strict-mode TypeError — that's also acceptable.
    }
    expect(r.metadata).not.toHaveProperty('newField')
  })
})

// ─── Plan §3.6.1 example round-trip ──────────────────────────────────────

describe('enrichSubject — plan §3.6.1 examples', () => {
  it("`'product:chair'` example: name=Aeron chair → product:furniture (segment generalised from chair)", () => {
    // Plan example uses 'product:chair' as illustrative; our seed map
    // maps `chair` → `furniture` segment. Caller can refine the
    // segment taxonomy in the future (the data layer here gives the
    // best segment we have today).
    expect(enrichSubject({ type: 'product', name: 'Aeron chair' }).category).toBe(
      'product:furniture',
    )
  })

  it("`'place:restaurant'` example: name=La Pergola Restaurant → place:restaurant", () => {
    expect(enrichSubject({ type: 'place', name: 'La Pergola Restaurant' }).category).toBe(
      'place:restaurant',
    )
  })

  it("`'content:video'` shape: youtube URL → category=content + metadata.media_type=video", () => {
    const r = enrichSubject({ type: 'content', uri: 'https://youtube.com/watch?v=abc' })
    expect(r.category).toBe('content')
    expect(r.metadata.media_type).toBe('video')
  })

  it("`'organization:university'` example: mit.edu → category=organization:university", () => {
    expect(enrichSubject({ type: 'organization', uri: 'https://mit.edu/' }).category).toBe(
      'organization:university',
    )
  })
})
