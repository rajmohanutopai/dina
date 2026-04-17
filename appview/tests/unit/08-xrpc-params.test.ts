/**
 * =============================================================================
 * Section 8 -- XRPC Parameter Validation (src/app/xrpc/)
 * =============================================================================
 * Plan traceability: UNIT_TEST_PLAN.md SS8
 * Subsections:       SS8.1 Resolve Params   (UT-RP-001 .. UT-RP-005)
 *                    SS8.2 Search Params     (UT-SP-001 .. UT-SP-010)
 * Total tests:       15
 * =============================================================================
 */

import { describe, it, expect } from 'vitest'
import { ResolveParams } from '@/api/xrpc/resolve.js'
import { SearchParams } from '@/api/xrpc/search.js'
import { ServiceSearchParams } from '@/api/xrpc/service-search.js'

// ---------------------------------------------------------------------------
// SS8.1 Resolve Params
// ---------------------------------------------------------------------------
describe('SS8.1 Resolve Params', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0280", "section": "01", "sectionName": "General", "title": "UT-RP-001: valid params -- subject only"}
  it('UT-RP-001: valid params -- subject only', () => {
    // Description: subject = '{"type":"did","did":"did:plc:abc"}'
    // Expected: Parses successfully
    const result = ResolveParams.safeParse({
      subject: '{"type":"did","did":"did:plc:abc"}',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subject).toBe('{"type":"did","did":"did:plc:abc"}')
      expect(result.data.requesterDid).toBeUndefined()
      expect(result.data.domain).toBeUndefined()
      expect(result.data.context).toBeUndefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0281", "section": "01", "sectionName": "General", "title": "UT-RP-002: valid params -- all fields"}
  it('UT-RP-002: valid params -- all fields', () => {
    // Description: subject + requesterDid + domain + context
    // Expected: Parses successfully
    const result = ResolveParams.safeParse({
      subject: '{"type":"did","did":"did:plc:abc"}',
      requesterDid: 'did:plc:requester123',
      domain: 'example.com',
      context: 'before-transaction',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subject).toBe('{"type":"did","did":"did:plc:abc"}')
      expect(result.data.requesterDid).toBe('did:plc:requester123')
      expect(result.data.domain).toBe('example.com')
      expect(result.data.context).toBe('before-transaction')
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0282", "section": "01", "sectionName": "General", "title": "UT-RP-003: missing subject -> error"}
  it('UT-RP-003: missing subject -> error', () => {
    // Description: No subject param
    // Expected: Zod error
    const result = ResolveParams.safeParse({
      requesterDid: 'did:plc:abc',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const subjectError = result.error.issues.find((i) => i.path.includes('subject'))
      expect(subjectError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0283", "section": "01", "sectionName": "General", "title": "UT-RP-004: invalid context enum"}
  it('UT-RP-004: invalid context enum', () => {
    // Description: context = "shopping"
    // Expected: Zod error
    const result = ResolveParams.safeParse({
      subject: '{"type":"did","did":"did:plc:abc"}',
      context: 'shopping',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const contextError = result.error.issues.find((i) => i.path.includes('context'))
      expect(contextError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0284", "section": "01", "sectionName": "General", "title": "UT-RP-005: all context values valid"}
  it('UT-RP-005: all context values valid', () => {
    // Description: "before-transaction", "before-interaction", "content-verification",
    //              "product-evaluation", "general-lookup"
    // Expected: All parse
    const validContexts = [
      'before-transaction',
      'before-interaction',
      'content-verification',
      'product-evaluation',
      'general-lookup',
    ]

    for (const context of validContexts) {
      const result = ResolveParams.safeParse({
        subject: '{"type":"did","did":"did:plc:abc"}',
        context,
      })
      expect(result.success, `context "${context}" should be valid`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// SS8.2 Search Params
// ---------------------------------------------------------------------------
describe('SS8.2 Search Params', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0285", "section": "01", "sectionName": "General", "title": "UT-SP-001: valid params -- q only"}
  it('UT-SP-001: valid params -- q only', () => {
    // Description: q = "darshini"
    // Expected: Parses successfully
    const result = SearchParams.safeParse({ q: 'darshini' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.q).toBe('darshini')
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0286", "section": "01", "sectionName": "General", "title": "UT-SP-002: valid params -- all filters"}
  it('UT-SP-002: valid params -- all filters', () => {
    // Description: q + category + domain + sentiment + tags + authorDid + since + until
    // Expected: Parses successfully
    const result = SearchParams.safeParse({
      q: 'restaurant review',
      category: 'food',
      domain: 'reviews.example.com',
      sentiment: 'positive',
      tags: 'food,quality,service',
      authorDid: 'did:plc:author123',
      since: '2024-01-01T00:00:00Z',
      until: '2024-12-31T23:59:59Z',
      subjectType: 'product',
      sort: 'recent',
      limit: 50,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.q).toBe('restaurant review')
      expect(result.data.category).toBe('food')
      expect(result.data.domain).toBe('reviews.example.com')
      expect(result.data.sentiment).toBe('positive')
      expect(result.data.tags).toBe('food,quality,service')
      expect(result.data.authorDid).toBe('did:plc:author123')
      expect(result.data.sort).toBe('recent')
      expect(result.data.limit).toBe(50)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0287", "section": "01", "sectionName": "General", "title": "UT-SP-003: limit bounds -- too high"}
  it('UT-SP-003: limit bounds -- too high', () => {
    // Description: limit = 200 (max 100)
    // Expected: Zod error
    const result = SearchParams.safeParse({ q: 'test', limit: 200 })
    expect(result.success).toBe(false)
    if (!result.success) {
      const limitError = result.error.issues.find((i) => i.path.includes('limit'))
      expect(limitError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0288", "section": "01", "sectionName": "General", "title": "UT-SP-004: limit bounds -- too low"}
  it('UT-SP-004: limit bounds -- too low', () => {
    // Description: limit = 0 (min 1)
    // Expected: Zod error
    const result = SearchParams.safeParse({ q: 'test', limit: 0 })
    expect(result.success).toBe(false)
    if (!result.success) {
      const limitError = result.error.issues.find((i) => i.path.includes('limit'))
      expect(limitError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0289", "section": "01", "sectionName": "General", "title": "UT-SP-005: limit default"}
  it('UT-SP-005: limit default', () => {
    // Description: limit unset
    // Expected: Default = 25
    const result = SearchParams.safeParse({ q: 'test' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(25)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0290", "section": "01", "sectionName": "General", "title": "UT-SP-006: sort default"}
  it('UT-SP-006: sort default', () => {
    // Description: sort unset
    // Expected: Default = "relevant"
    const result = SearchParams.safeParse({ q: 'test' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sort).toBe('relevant')
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0291", "section": "01", "sectionName": "General", "title": "UT-SP-007: invalid sort enum"}
  it('UT-SP-007: invalid sort enum', () => {
    // Description: sort = "popularity"
    // Expected: Zod error
    const result = SearchParams.safeParse({ q: 'test', sort: 'popularity' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const sortError = result.error.issues.find((i) => i.path.includes('sort'))
      expect(sortError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0292", "section": "01", "sectionName": "General", "title": "UT-SP-008: invalid sentiment enum"}
  it('UT-SP-008: invalid sentiment enum', () => {
    // Description: sentiment = "very-positive"
    // Expected: Zod error
    const result = SearchParams.safeParse({ q: 'test', sentiment: 'very-positive' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const sentimentError = result.error.issues.find((i) => i.path.includes('sentiment'))
      expect(sentimentError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0293", "section": "01", "sectionName": "General", "title": "UT-SP-009: invalid subjectType enum"}
  it('UT-SP-009: invalid subjectType enum', () => {
    // Description: subjectType = "place"
    // Expected: Zod error
    const result = SearchParams.safeParse({ q: 'test', subjectType: 'place' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const typeError = result.error.issues.find((i) => i.path.includes('subjectType'))
      expect(typeError).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0294", "section": "01", "sectionName": "General", "title": "UT-SP-010: tags -- comma-separated parsing"}
  it('UT-SP-010: tags -- comma-separated parsing', () => {
    // Description: tags = "food,quality,service"
    // Expected: Parses to string "food,quality,service" (split happens at runtime in search())
    // The Zod schema accepts tags as a string; the splitting into an array
    // happens inside the search() function, not in the schema.
    const result = SearchParams.safeParse({ q: 'test', tags: 'food,quality,service' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tags).toBe('food,quality,service')
      // Verify the runtime split behavior matches expectations
      const tagList = result.data.tags!.split(',').map((t) => t.trim())
      expect(tagList).toEqual(['food', 'quality', 'service'])
      expect(tagList).toHaveLength(3)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0295", "section": "01", "sectionName": "General", "title": "UT-SP-011: MEDIUM-03: minConfidence filter accepted"}
  it('UT-SP-011: MEDIUM-03: minConfidence filter accepted', () => {
    // Description: minConfidence = "high"
    // Expected: Parses successfully (MEDIUM-03 added minConfidence param)
    const result = SearchParams.safeParse({ q: 'test', minConfidence: 'high' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.minConfidence).toBe('high')
    }
  })
})

// ---------------------------------------------------------------------------
// SS8.3 Service Search Params (com.dina.service.search)
// WS2 schema-driven discovery — lat/lng optional for non-geospatial queries.
// ---------------------------------------------------------------------------
describe('SS8.3 Service Search Params', () => {
  it('UT-SSP-001: capability alone is valid (non-geospatial default)', () => {
    const result = ServiceSearchParams.safeParse({ capability: 'keyword_lookup' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.capability).toBe('keyword_lookup')
      expect(result.data.lat).toBeUndefined()
      expect(result.data.lng).toBeUndefined()
      // radiusKm has a default of 5.
      expect(result.data.radiusKm).toBe(5)
      // limit defaults to 10.
      expect(result.data.limit).toBe(10)
    }
  })

  it('UT-SSP-002: full geospatial params accepted', () => {
    const result = ServiceSearchParams.safeParse({
      capability: 'eta_query',
      lat: 37.7625,
      lng: -122.4351,
      radiusKm: 10,
      q: 'bus 42',
      limit: 25,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.lat).toBe(37.7625)
      expect(result.data.lng).toBe(-122.4351)
      expect(result.data.radiusKm).toBe(10)
      expect(result.data.q).toBe('bus 42')
    }
  })

  it('UT-SSP-003: capability missing is rejected', () => {
    const result = ServiceSearchParams.safeParse({ lat: 37.77, lng: -122.43 })
    expect(result.success).toBe(false)
  })

  it('UT-SSP-004: lat out of range is rejected', () => {
    const result = ServiceSearchParams.safeParse({
      capability: 'eta_query', lat: 91, lng: 0,
    })
    expect(result.success).toBe(false)
  })

  it('UT-SSP-005: lng out of range is rejected', () => {
    const result = ServiceSearchParams.safeParse({
      capability: 'eta_query', lat: 0, lng: 181,
    })
    expect(result.success).toBe(false)
  })

  it('UT-SSP-006: radiusKm bounds enforced', () => {
    // Too small (< 0.1)
    expect(ServiceSearchParams.safeParse({
      capability: 'eta_query', radiusKm: 0.05,
    }).success).toBe(false)
    // Too large (> 500)
    expect(ServiceSearchParams.safeParse({
      capability: 'eta_query', radiusKm: 600,
    }).success).toBe(false)
  })

  it('UT-SSP-007: limit bounds enforced', () => {
    expect(ServiceSearchParams.safeParse({
      capability: 'eta_query', limit: 0,
    }).success).toBe(false)
    expect(ServiceSearchParams.safeParse({
      capability: 'eta_query', limit: 51,
    }).success).toBe(false)
  })

  it('UT-SSP-008: string-coerced lat/lng parses (xRPC sends query-string)', () => {
    const result = ServiceSearchParams.safeParse({
      capability: 'eta_query', lat: '37.77', lng: '-122.43',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.lat).toBe(37.77)
      expect(result.data.lng).toBe(-122.43)
    }
  })

  it('UT-SSP-009: cursor passthrough', () => {
    const result = ServiceSearchParams.safeParse({
      capability: 'eta_query', cursor: '820::at://did:plc:x/com.dina.service.profile/self',
    })
    expect(result.success).toBe(true)
  })

  it('UT-SSP-010: oversize q rejected', () => {
    const result = ServiceSearchParams.safeParse({
      capability: 'eta_query', q: 'x'.repeat(300),
    })
    expect(result.success).toBe(false)
  })
})
