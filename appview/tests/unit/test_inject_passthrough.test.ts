/**
 * §unit — `com.dina.test.injectAttestation` Zod-passthrough regression
 * (TN-V2-MOBILE-WIRE).
 *
 * The dev-shortcut test-inject endpoint validates the inbound body
 * with Zod, then hands `body.record` directly to
 * `attestationHandler.handleCreate` (which reads V2 fields like
 * `record.price`, `record.compliance`, etc. directly).
 *
 * Zod's default `.object({...})` STRIPS unknown keys silently. If
 * the inner record schema isn't `.passthrough()`-ed, every V2 wire
 * field the mobile compose form sends gets dropped between Zod
 * parse and handler call — silently. The mobile UI looks like it
 * worked, but the rendered subject detail page is missing every
 * V2 field.
 *
 * This test pins `.passthrough()` so a future schema update can't
 * regress to the "strip unknowns" default without lighting up a
 * loud failure.
 */

import { describe, it, expect } from 'vitest'
import { InjectAttestationBody } from '@/api/xrpc/test-inject'

const BASE_BODY = {
  authorDid: 'did:plc:test123',
  rkey: 'mob-test',
  cid: 'bafyreim-test',
  record: {
    subject: { type: 'product' as const, name: 'Aeron Chair' },
    category: 'commerce/product',
    sentiment: 'positive' as const,
    confidence: 'high' as const,
    text: 'Great chair',
    createdAt: '2025-01-15T12:00:00.000Z',
  },
}

describe('InjectAttestationBody — V2 passthrough', () => {
  it('preserves price block (META-002)', () => {
    const parsed = InjectAttestationBody.parse({
      ...BASE_BODY,
      record: {
        ...BASE_BODY.record,
        price: {
          low_e7: 299_900_000,
          high_e7: 299_900_000,
          currency: 'USD',
          lastSeenMs: 1_777_500_000_000,
        },
      },
    })
    expect((parsed.record as Record<string, unknown>).price).toEqual({
      low_e7: 299_900_000,
      high_e7: 299_900_000,
      currency: 'USD',
      lastSeenMs: 1_777_500_000_000,
    })
  })

  it('preserves availability block (META-001)', () => {
    const parsed = InjectAttestationBody.parse({
      ...BASE_BODY,
      record: {
        ...BASE_BODY.record,
        availability: {
          regions: ['US', 'GB'],
          soldAt: ['amazon.com'],
        },
      },
    })
    expect((parsed.record as Record<string, unknown>).availability).toEqual({
      regions: ['US', 'GB'],
      soldAt: ['amazon.com'],
    })
  })

  it('preserves schedule block (META-004)', () => {
    const parsed = InjectAttestationBody.parse({
      ...BASE_BODY,
      record: {
        ...BASE_BODY.record,
        schedule: { leadDays: 14, seasonal: [4, 5, 6] },
      },
    })
    expect((parsed.record as Record<string, unknown>).schedule).toEqual({
      leadDays: 14,
      seasonal: [4, 5, 6],
    })
  })

  it('preserves all V2 tag arrays + reviewerExperience (META-003/005/006, REV-002/004/006/008)', () => {
    const parsed = InjectAttestationBody.parse({
      ...BASE_BODY,
      record: {
        ...BASE_BODY.record,
        useCases: ['everyday', 'travel'],
        lastUsedMs: 1_777_500_000_000,
        reviewerExperience: 'expert',
        recommendFor: ['professional'],
        notRecommendFor: ['gaming'],
        alternatives: [
          { type: 'product', name: 'Steelcase Leap' },
        ],
        compliance: ['halal', 'vegan'],
        accessibility: ['wheelchair', 'captions'],
        compat: ['ios', 'android'],
      },
    })
    const r = parsed.record as Record<string, unknown>
    expect(r.useCases).toEqual(['everyday', 'travel'])
    expect(r.lastUsedMs).toBe(1_777_500_000_000)
    expect(r.reviewerExperience).toBe('expert')
    expect(r.recommendFor).toEqual(['professional'])
    expect(r.notRecommendFor).toEqual(['gaming'])
    expect(r.alternatives).toEqual([{ type: 'product', name: 'Steelcase Leap' }])
    expect(r.compliance).toEqual(['halal', 'vegan'])
    expect(r.accessibility).toEqual(['wheelchair', 'captions'])
    expect(r.compat).toEqual(['ios', 'android'])
  })

  it('still rejects malformed required fields (passthrough is unknown-only, not anything-goes)', () => {
    expect(() =>
      InjectAttestationBody.parse({
        ...BASE_BODY,
        record: {
          ...BASE_BODY.record,
          // sentiment is REQUIRED + closed-enum — passthrough must
          // not accidentally relax this gate.
          sentiment: 'maybe' as unknown as 'positive',
        },
      }),
    ).toThrow()
  })

  it('strips nothing — full record round-trips with all V2 fields', () => {
    const fullRecord = {
      ...BASE_BODY.record,
      useCases: ['everyday'],
      lastUsedMs: 1_777_500_000_000,
      reviewerExperience: 'expert' as const,
      recommendFor: ['professional'],
      notRecommendFor: ['gaming'],
      alternatives: [{ type: 'product' as const, name: 'X' }],
      compliance: ['vegan'],
      accessibility: ['wheelchair'],
      compat: ['ios'],
      price: { low_e7: 100_000_000, high_e7: 100_000_000, currency: 'USD', lastSeenMs: 1_777_500_000_000 },
      availability: { regions: ['US'] },
      schedule: { leadDays: 0 },
    }
    const parsed = InjectAttestationBody.parse({ ...BASE_BODY, record: fullRecord })
    // Round-trip JSON to canonicalise (passthrough preserves keys
    // but Zod strips dates etc. — JSON normalisation is the safest
    // equality.)
    expect(JSON.parse(JSON.stringify(parsed.record))).toEqual(fullRecord)
  })
})
