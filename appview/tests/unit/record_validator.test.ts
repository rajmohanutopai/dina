/**
 * Per-record-type validator coverage for `appview/src/ingester/
 * record-validator.ts` (TN-TEST-005). Each of the 20 schemas in
 * `SCHEMA_MAP` gets a happy-path round-trip plus the rejection
 * paths the ingester relies on to drop garbage at the gate. The
 * shared validators (`didString`, `boundedIsoDate`,
 * `subjectRefSchema`) are tested once on the schema where they
 * first appear — re-asserting them per schema would just inflate
 * the test count without catching new bugs.
 *
 * **Contract under test**: `validateRecord(collection, record)`
 * returns `{success: true, data}` on a parseable record OR
 * `{success: false, errors?: ZodError}` on rejection. A record
 * with no schema in `SCHEMA_MAP` returns `{success: false}`
 * without `errors` — the validator distinguishes "rejected by
 * schema" from "no schema for this NSID" so the ingester can log
 * accordingly. `hasSchema(collection)` mirrors the same map.
 */

import { describe, expect, it } from 'vitest'

import { hasSchema, validateRecord } from '@/ingester/record-validator'

// ── Test helpers ────────────────────────────────────────────────────

const VALID_DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const VALID_DID_2 = 'did:plc:zyxwvutsrqponmlkjihgfedc'
const VALID_AT_URI = `at://${VALID_DID}/com.dina.trust.attestation/abc123`
const NOW_ISO = new Date().toISOString()

/**
 * Helper to assert a record is rejected. Returns the Zod error
 * issues so callers can pin the specific path that triggered
 * rejection — important when one schema has multiple bounds + we
 * want to confirm the *intended* rule fired (not some other one
 * by accident).
 */
function expectReject(collection: string, record: unknown) {
  const r = validateRecord(collection, record)
  expect(r.success).toBe(false)
  return r.errors?.issues ?? []
}

function expectAccept(collection: string, record: unknown) {
  const r = validateRecord(collection, record)
  if (!r.success) {
    // Surface the zod errors so a test failure shows what's wrong
    // instead of just `Expected true got false`.
    throw new Error(
      `expected accept for ${collection} but got: ${JSON.stringify(r.errors?.issues)}`,
    )
  }
  return r.data
}

// ── Cross-cutting tests for shared validators ───────────────────────

describe('validateRecord — registry surface', () => {
  it('returns {success: false} (no errors) for an unknown collection', () => {
    const r = validateRecord('com.dina.trust.notARealCollection', {})
    expect(r.success).toBe(false)
    // No `errors` field — distinguishes "no schema" from "schema rejected".
    expect(r.errors).toBeUndefined()
  })

  it('returns {success: false, errors} when a known collection rejects', () => {
    const r = validateRecord('com.dina.trust.attestation', {})
    expect(r.success).toBe(false)
    expect(r.errors).toBeDefined()
    expect(r.errors?.issues.length).toBeGreaterThan(0)
  })

  it('hasSchema returns true for every registered NSID + false for unknowns', () => {
    const known = [
      'com.dina.trust.attestation',
      'com.dina.trust.vouch',
      'com.dina.trust.endorsement',
      'com.dina.trust.flag',
      'com.dina.trust.reply',
      'com.dina.trust.reaction',
      'com.dina.trust.reportRecord',
      'com.dina.trust.revocation',
      'com.dina.trust.delegation',
      'com.dina.trust.collection',
      'com.dina.trust.media',
      'com.dina.trust.subject',
      'com.dina.trust.amendment',
      'com.dina.trust.verification',
      'com.dina.trust.reviewRequest',
      'com.dina.trust.comparison',
      'com.dina.trust.subjectClaim',
      'com.dina.trust.trustPolicy',
      'com.dina.trust.notificationPrefs',
      'com.dina.service.profile',
    ]
    for (const nsid of known) {
      expect(hasSchema(nsid)).toBe(true)
    }
    expect(hasSchema('com.dina.trust.notARealCollection')).toBe(false)
    expect(hasSchema('')).toBe(false)
  })
})

// ── Shared-validator behaviour (tested once on attestation) ─────────

describe('shared validators — didString + boundedIsoDate', () => {
  it('rejects a non-DID string in a DID-typed field', () => {
    const issues = expectReject('com.dina.trust.attestation', {
      subject: { type: 'did', did: 'not-a-did' },
      category: 'product',
      sentiment: 'positive',
      createdAt: NOW_ISO,
    })
    // The rejection MUST be on the `did` path — defends against
    // a refactor that loosens didString and lets garbage slip
    // through under a different bound (e.g. just a min-length).
    expect(issues.some((i) => i.path.join('.') === 'subject.did')).toBe(true)
  })

  it('rejects a DID shorter than 8 chars', () => {
    const issues = expectReject('com.dina.trust.vouch', {
      subject: 'did:x:y',
      vouchType: 'professional',
      confidence: 'high',
      createdAt: NOW_ISO,
    })
    expect(issues.some((i) => i.path[0] === 'subject')).toBe(true)
  })

  it('rejects a createdAt > 5 minutes in the future (clock-skew guard)', () => {
    const future = new Date(Date.now() + 6 * 60 * 1000).toISOString()
    const issues = expectReject('com.dina.trust.attestation', {
      subject: { type: 'did', did: VALID_DID },
      category: 'product',
      sentiment: 'positive',
      createdAt: future,
    })
    expect(issues.some((i) => i.path[0] === 'createdAt')).toBe(true)
  })

  it('accepts a createdAt in the past (no lower bound — old replays OK)', () => {
    expectAccept('com.dina.trust.attestation', {
      subject: { type: 'did', did: VALID_DID },
      category: 'product',
      sentiment: 'positive',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
  })

  it('rejects a createdAt that is not an ISO 8601 string with offset', () => {
    const issues = expectReject('com.dina.trust.attestation', {
      subject: { type: 'did', did: VALID_DID },
      category: 'product',
      sentiment: 'positive',
      createdAt: 'yesterday',
    })
    expect(issues.some((i) => i.path[0] === 'createdAt')).toBe(true)
  })
})

// ── Per-schema happy + rejection coverage ───────────────────────────

describe('attestationSchema', () => {
  const minimal = () => ({
    subject: { type: 'did', did: VALID_DID },
    category: 'product',
    sentiment: 'positive',
    createdAt: NOW_ISO,
  })

  it('accepts the minimal valid record (subject + category + sentiment + createdAt)', () => {
    expectAccept('com.dina.trust.attestation', minimal())
  })

  it('accepts the full envelope (text, dimensions, evidence, tags, namespace)', () => {
    expectAccept('com.dina.trust.attestation', {
      ...minimal(),
      text: 'A solid chair.',
      dimensions: [{ dimension: 'comfort', value: 'exceeded' }],
      evidence: [{ type: 'photo', uri: 'https://example.com/p.jpg' }],
      tags: ['ergonomic'],
      domain: 'hermanmiller.com',
      confidence: 'high',
      isAgentGenerated: false,
      mentions: [{ did: VALID_DID_2, role: 'co-buyer' }],
      namespace: 'namespace_0',
    })
  })

  it('rejects an unknown sentiment value', () => {
    const issues = expectReject('com.dina.trust.attestation', {
      ...minimal(),
      sentiment: 'mixed',
    })
    expect(issues.some((i) => i.path[0] === 'sentiment')).toBe(true)
  })

  it('rejects an unknown subject.type', () => {
    const issues = expectReject('com.dina.trust.attestation', {
      ...minimal(),
      subject: { type: 'event', did: VALID_DID },
    })
    expect(issues.some((i) => i.path.join('.') === 'subject.type')).toBe(true)
  })

  it('rejects category exceeding the 200-char bound', () => {
    const issues = expectReject('com.dina.trust.attestation', {
      ...minimal(),
      category: 'x'.repeat(201),
    })
    expect(issues.some((i) => i.path[0] === 'category')).toBe(true)
  })

  it('rejects more than 10 dimensions (DOS guard)', () => {
    const issues = expectReject('com.dina.trust.attestation', {
      ...minimal(),
      dimensions: Array(11).fill({ dimension: 'd', value: 'met' }),
    })
    expect(issues.some((i) => i.path[0] === 'dimensions')).toBe(true)
  })

  // ── TN-V2-REV-001: useCases ────────────────────────────────────────
  describe('useCases (TN-V2-REV-001)', () => {
    it('accepts up to 3 use-case tags', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        useCases: ['everyday', 'travel', 'professional'],
      })
    })

    it('accepts a single use-case tag', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        useCases: ['everyday'],
      })
    })

    it('accepts an empty useCases array (writer ungated case)', () => {
      // Empty array is the "no use case declared" wire form. The
      // ingester collapses to NULL for storage but the schema accepts.
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        useCases: [],
      })
    })

    it('rejects more than 3 use-case tags (mirrors writer-side cap)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        useCases: ['a', 'b', 'c', 'd'],
      })
      expect(issues.some((i) => i.path[0] === 'useCases')).toBe(true)
    })

    it('rejects a use-case tag exceeding 50 chars', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        useCases: ['x'.repeat(51)],
      })
      expect(issues.some((i) => i.path[0] === 'useCases')).toBe(true)
    })

    it('rejects an empty-string use-case tag (min-length 1 guard)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        useCases: ['everyday', ''],
      })
      expect(issues.some((i) => i.path[0] === 'useCases')).toBe(true)
    })

    it('rejects a non-string use-case entry', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        useCases: ['everyday', 42],
      })
      expect(issues.some((i) => i.path[0] === 'useCases')).toBe(true)
    })
  })

  // ── TN-V2-REV-003: lastUsedMs ──────────────────────────────────────
  describe('lastUsedMs (TN-V2-REV-003)', () => {
    it('accepts a past ms-since-epoch value', () => {
      const sixMonthsAgo = Date.now() - 6 * 30 * 24 * 60 * 60 * 1000
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: sixMonthsAgo,
      })
    })

    it('accepts a value at the epoch boundary (0)', () => {
      // No special meaning attached — stored verbatim. Floor is
      // present only to reject negatives, which would invert recency
      // arithmetic downstream.
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: 0,
      })
    })

    it('accepts "now" within the clock-skew window', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: Date.now(),
      })
    })

    it('rejects a value > 5 minutes in the future (clock-skew guard)', () => {
      const future = Date.now() + 6 * 60 * 1000
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: future,
      })
      expect(issues.some((i) => i.path[0] === 'lastUsedMs')).toBe(true)
    })

    it('rejects a negative value (would invert recency math)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: -1,
      })
      expect(issues.some((i) => i.path[0] === 'lastUsedMs')).toBe(true)
    })

    it('rejects a non-integer (CBOR records forbid floats)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: Date.now() - 1234.5,
      })
      expect(issues.some((i) => i.path[0] === 'lastUsedMs')).toBe(true)
    })

    it('rejects a string-typed lastUsedMs', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        lastUsedMs: '1700000000000',
      })
      expect(issues.some((i) => i.path[0] === 'lastUsedMs')).toBe(true)
    })
  })

  // ── TN-V2-REV-002: reviewerExperience ──────────────────────────────
  describe('reviewerExperience (TN-V2-REV-002)', () => {
    it('accepts each closed-enum tier (novice / intermediate / expert)', () => {
      for (const tier of ['novice', 'intermediate', 'expert'] as const) {
        expectAccept('com.dina.trust.attestation', {
          ...minimal(),
          reviewerExperience: tier,
        })
      }
    })

    it('rejects an unknown tier value (closed enum enforced)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        reviewerExperience: 'guru',
      })
      expect(issues.some((i) => i.path[0] === 'reviewerExperience')).toBe(true)
    })

    it('rejects an empty-string tier (would otherwise pass a min-length 1 check)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        reviewerExperience: '',
      })
      expect(issues.some((i) => i.path[0] === 'reviewerExperience')).toBe(true)
    })

    it('rejects a non-string tier', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        reviewerExperience: 2,
      })
      expect(issues.some((i) => i.path[0] === 'reviewerExperience')).toBe(true)
    })
  })

  // ── TN-V2-REV-004: recommendFor / notRecommendFor ──────────────────
  describe('recommendFor / notRecommendFor (TN-V2-REV-004)', () => {
    it('accepts up to 5 recommend-for tags', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: ['everyday', 'travel', 'professional', 'kids', 'gifts'],
      })
    })

    it('accepts up to 5 not-recommend-for tags', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        notRecommendFor: ['calligraphy', 'left-handed', 'beginners', 'fine-detail', 'wet-conditions'],
      })
    })

    it('accepts both lists set simultaneously (disjoint or overlapping is the writer\'s call)', () => {
      // The writer can express "good for casual travel; not for
      // long expeditions" — overlap on a tag in both lists is
      // semantically odd but not a schema violation. AppView
      // doesn't second-guess the writer.
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: ['everyday'],
        notRecommendFor: ['professional'],
      })
    })

    it('accepts empty arrays (round-trip the "no recommendation" wire form)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: [],
        notRecommendFor: [],
      })
    })

    it('rejects more than 5 recommend-for tags (cap enforced)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: ['a', 'b', 'c', 'd', 'e', 'f'],
      })
      expect(issues.some((i) => i.path[0] === 'recommendFor')).toBe(true)
    })

    it('rejects more than 5 not-recommend-for tags (cap enforced)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        notRecommendFor: ['a', 'b', 'c', 'd', 'e', 'f'],
      })
      expect(issues.some((i) => i.path[0] === 'notRecommendFor')).toBe(true)
    })

    it('rejects a recommend-for tag exceeding 50 chars', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: ['x'.repeat(51)],
      })
      expect(issues.some((i) => i.path[0] === 'recommendFor')).toBe(true)
    })

    it('rejects an empty-string recommend-for tag (min-length 1 guard)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: ['everyday', ''],
      })
      expect(issues.some((i) => i.path[0] === 'recommendFor')).toBe(true)
    })

    it('rejects an empty-string not-recommend-for tag (min-length 1 guard)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        notRecommendFor: [''],
      })
      expect(issues.some((i) => i.path[0] === 'notRecommendFor')).toBe(true)
    })

    it('rejects a non-string recommend-for entry', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        recommendFor: ['everyday', 42],
      })
      expect(issues.some((i) => i.path[0] === 'recommendFor')).toBe(true)
    })
  })

  // ── TN-V2-REV-005: alternatives ────────────────────────────────────
  describe('alternatives (TN-V2-REV-005)', () => {
    it('accepts up to 5 alternative SubjectRefs', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        alternatives: [
          { type: 'product', name: 'Steelcase Leap' },
          { type: 'product', name: 'Herman Miller Mirra', identifier: 'asin:B07ABC1234' },
          { type: 'product', uri: 'https://example.com/chair' },
          { type: 'did', did: VALID_DID_2 },
          { type: 'organization', name: 'IKEA' },
        ],
      })
    })

    it('accepts an empty alternatives array (round-trip the "no alternatives" wire form)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        alternatives: [],
      })
    })

    it('rejects more than 5 alternatives (cap mirrors mobile MAX_REVIEW_ALTERNATIVES)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        alternatives: Array(6).fill({ type: 'product', name: 'Same Name' }),
      })
      expect(issues.some((i) => i.path[0] === 'alternatives')).toBe(true)
    })

    it('rejects an alternative whose subject.type is unknown (shared SubjectRef bound)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        alternatives: [{ type: 'event', name: 'Bad Type' }],
      })
      expect(issues.some((i) => i.path.join('.') === 'alternatives.0.type')).toBe(true)
    })

    it('rejects an alternative with a malformed DID (shared SubjectRef bound)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        alternatives: [{ type: 'did', did: 'not-a-did' }],
      })
      expect(issues.some((i) => i.path.join('.') === 'alternatives.0.did')).toBe(true)
    })

    it('rejects an alternative with an oversized name (shared SubjectRef bound)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        alternatives: [{ type: 'product', name: 'x'.repeat(201) }],
      })
      expect(issues.some((i) => i.path.join('.') === 'alternatives.0.name')).toBe(true)
    })
  })

  // ── TN-V2-META-005: compliance tags ────────────────────────────────
  describe('compliance (TN-V2-META-005)', () => {
    it('accepts up to 10 compliance tags', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        compliance: ['halal', 'kosher', 'vegan', 'vegetarian', 'gluten-free', 'organic', 'fda-approved', 'ce-marked', 'age-18+', 'fair-trade'],
      })
    })

    it('accepts a single compliance tag', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        compliance: ['halal'],
      })
    })

    it('accepts an empty compliance array', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        compliance: [],
      })
    })

    it('rejects more than 10 compliance tags', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compliance: Array(11).fill('halal'),
      })
      expect(issues.some((i) => i.path[0] === 'compliance')).toBe(true)
    })

    it('rejects a compliance tag exceeding 50 chars', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compliance: ['x'.repeat(51)],
      })
      expect(issues.some((i) => i.path[0] === 'compliance')).toBe(true)
    })

    it('rejects an empty-string compliance tag (min-length 1 guard)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compliance: ['halal', ''],
      })
      expect(issues.some((i) => i.path[0] === 'compliance')).toBe(true)
    })

    it('rejects a non-string compliance entry', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compliance: ['halal', true],
      })
      expect(issues.some((i) => i.path[0] === 'compliance')).toBe(true)
    })
  })

  // ── TN-V2-META-006: accessibility tags ─────────────────────────────
  describe('accessibility (TN-V2-META-006)', () => {
    it('accepts up to 10 accessibility tags', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        accessibility: ['wheelchair', 'captions', 'screen-reader', 'color-blind-safe', 'audio-described', 'quiet-hours', 'sign-language', 'large-print', 'audio-only', 'tactile'],
      })
    })

    it('accepts a single accessibility tag', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        accessibility: ['wheelchair'],
      })
    })

    it('accepts an empty accessibility array', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        accessibility: [],
      })
    })

    it('rejects more than 10 accessibility tags', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        accessibility: Array(11).fill('wheelchair'),
      })
      expect(issues.some((i) => i.path[0] === 'accessibility')).toBe(true)
    })

    it('rejects an accessibility tag exceeding 50 chars', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        accessibility: ['x'.repeat(51)],
      })
      expect(issues.some((i) => i.path[0] === 'accessibility')).toBe(true)
    })

    it('rejects an empty-string accessibility tag', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        accessibility: [''],
      })
      expect(issues.some((i) => i.path[0] === 'accessibility')).toBe(true)
    })
  })

  // ── TN-V2-META-003: compat tags ────────────────────────────────────
  describe('compat (TN-V2-META-003)', () => {
    it('accepts up to 15 compat tags', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        compat: ['ios', 'android', 'macos', 'windows', 'linux', 'usb-c', 'lightning', 'thunderbolt-4', 'bluetooth-5', 'wifi-6e', '110v', '240v', 'qi-charge', 'magsafe', 'arm64'],
      })
    })

    it('accepts a single compat tag', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        compat: ['usb-c'],
      })
    })

    it('accepts an empty compat array (round-trip)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        compat: [],
      })
    })

    it('rejects more than 15 compat tags', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compat: Array(16).fill('usb-c'),
      })
      expect(issues.some((i) => i.path[0] === 'compat')).toBe(true)
    })

    it('rejects a compat tag exceeding 50 chars', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compat: ['x'.repeat(51)],
      })
      expect(issues.some((i) => i.path[0] === 'compat')).toBe(true)
    })

    it('rejects an empty-string compat tag', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        compat: ['ios', ''],
      })
      expect(issues.some((i) => i.path[0] === 'compat')).toBe(true)
    })
  })

  // ── TN-V2-META-002: price range ────────────────────────────────────
  describe('price (TN-V2-META-002)', () => {
    const validPrice = () => ({
      low_e7: 19_99_000_000,   // $19.99
      high_e7: 29_99_000_000,  // $29.99
      currency: 'USD',
      lastSeenMs: Date.now() - 60_000,
    })

    it('accepts a fully populated price object', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        price: validPrice(),
      })
    })

    it('accepts low_e7 == high_e7 (point price)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), low_e7: 25_00_000_000, high_e7: 25_00_000_000 },
      })
    })

    it('accepts price.low_e7 = 0 (free / sample)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), low_e7: 0, high_e7: 5_00_000_000 },
      })
    })

    it('rejects low_e7 > high_e7 (reversed range)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), low_e7: 50_00_000_000, high_e7: 10_00_000_000 },
      })
      // The cross-field refine surfaces under the `price` path.
      expect(issues.some((i) => i.path[0] === 'price')).toBe(true)
    })

    it('rejects negative low_e7', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), low_e7: -1, high_e7: 100 },
      })
      expect(issues.some((i) => i.path.includes('low_e7'))).toBe(true)
    })

    it('rejects non-integer low_e7 (CBOR-int contract)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), low_e7: 19.99 },
      })
      expect(issues.some((i) => i.path.includes('low_e7'))).toBe(true)
    })

    it('rejects non-ISO 4217 currency (lowercase)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), currency: 'usd' },
      })
      expect(issues.some((i) => i.path.includes('currency'))).toBe(true)
    })

    it('rejects non-ISO 4217 currency (4-letter)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), currency: 'USDD' },
      })
      expect(issues.some((i) => i.path.includes('currency'))).toBe(true)
    })

    it('rejects non-ISO 4217 currency (digits)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), currency: '840' },
      })
      expect(issues.some((i) => i.path.includes('currency'))).toBe(true)
    })

    it('rejects lastSeenMs > now + 5min skew', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), lastSeenMs: Date.now() + 10 * 60 * 1000 },
      })
      expect(issues.some((i) => i.path.includes('lastSeenMs'))).toBe(true)
    })

    it('rejects negative lastSeenMs', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        price: { ...validPrice(), lastSeenMs: -1 },
      })
      expect(issues.some((i) => i.path.includes('lastSeenMs'))).toBe(true)
    })

    it('rejects price object missing required fields', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        // currency + lastSeenMs missing — no defaults; the wire
        // contract is "object or absent," never "partial object".
        price: { low_e7: 100, high_e7: 200 },
      })
      expect(issues.some((i) => i.path[0] === 'price')).toBe(true)
    })
  })

  // ── TN-V2-META-001: availability ────────────────────────────────────
  describe('availability (TN-V2-META-001)', () => {
    it('accepts a fully populated availability triple', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        availability: {
          regions: ['US', 'GB', 'IN'],
          shipsTo: ['US', 'GB', 'CA', 'AU'],
          soldAt: ['amazon.com', 'walmart.com'],
        },
      })
    })

    it('accepts availability with only regions (each sub-field independently optional)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        availability: { regions: ['US'] },
      })
    })

    it('accepts availability with only soldAt (hostname-only declaration)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        availability: { soldAt: ['amazon.com'] },
      })
    })

    it('accepts an empty availability object (all sub-fields absent — handler collapses to NULL)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        availability: {},
      })
    })

    it('rejects lowercase region code (must be uppercase ISO 3166-1 alpha-2)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { regions: ['us'] },
      })
      expect(issues.some((i) => i.path.includes('regions'))).toBe(true)
    })

    it('rejects 3-letter region code', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { regions: ['USA'] },
      })
      expect(issues.some((i) => i.path.includes('regions'))).toBe(true)
    })

    it('rejects digit region code', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { shipsTo: ['12'] },
      })
      expect(issues.some((i) => i.path.includes('shipsTo'))).toBe(true)
    })

    it('rejects > 30 regions', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { regions: Array(31).fill('US') },
      })
      expect(issues.some((i) => i.path.includes('regions'))).toBe(true)
    })

    it('rejects > 20 soldAt entries', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { soldAt: Array(21).fill('amazon.com') },
      })
      expect(issues.some((i) => i.path.includes('soldAt'))).toBe(true)
    })

    it('rejects soldAt entry exceeding 253 chars (RFC 1035)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { soldAt: ['x'.repeat(254)] },
      })
      expect(issues.some((i) => i.path.includes('soldAt'))).toBe(true)
    })

    it('rejects empty-string soldAt entry', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        availability: { soldAt: [''] },
      })
      expect(issues.some((i) => i.path.includes('soldAt'))).toBe(true)
    })
  })

  // ── TN-V2-META-004: schedule ────────────────────────────────────────
  describe('schedule (TN-V2-META-004)', () => {
    it('accepts a fully populated schedule', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        schedule: {
          hours: {
            mon: { open: '09:00', close: '17:00' },
            tue: { open: '09:00', close: '17:00' },
            sat: { open: '10:00', close: '14:00' },
          },
          leadDays: 7,
          seasonal: [3, 4, 5, 6, 7, 8, 9, 10],
        },
      })
    })

    it('accepts schedule with only leadDays', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { leadDays: 14 },
      })
    })

    it('accepts schedule with only seasonal months', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { seasonal: [12, 1, 2] },
      })
    })

    it('accepts hours with a subset of days (closed days simply absent)', () => {
      expectAccept('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { hours: { mon: { open: '09:00', close: '17:00' } } },
      })
    })

    it('rejects HH:MM that is not 24-hour (e.g. 25:00)', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { hours: { mon: { open: '25:00', close: '17:00' } } },
      })
      expect(issues.some((i) => i.path.includes('open'))).toBe(true)
    })

    it('rejects HH:MM with single-digit hour', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { hours: { tue: { open: '9:00', close: '17:00' } } },
      })
      expect(issues.some((i) => i.path.includes('open'))).toBe(true)
    })

    it('rejects unknown day code (typo: "monday")', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { hours: { monday: { open: '09:00', close: '17:00' } } as any },
      })
      // Zod's z.record(enum, ...) raises on unknown keys.
      expect(issues.length).toBeGreaterThan(0)
    })

    it('rejects negative leadDays', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { leadDays: -1 },
      })
      expect(issues.some((i) => i.path.includes('leadDays'))).toBe(true)
    })

    it('rejects leadDays > 365', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { leadDays: 366 },
      })
      expect(issues.some((i) => i.path.includes('leadDays'))).toBe(true)
    })

    it('rejects month 0 in seasonal', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { seasonal: [0, 1, 2] },
      })
      expect(issues.some((i) => i.path.includes('seasonal'))).toBe(true)
    })

    it('rejects month 13 in seasonal', () => {
      const issues = expectReject('com.dina.trust.attestation', {
        ...minimal(),
        schedule: { seasonal: [12, 13] },
      })
      expect(issues.some((i) => i.path.includes('seasonal'))).toBe(true)
    })
  })

  // ── TEST-005 hardening: cross-field invariants ─────────────────────
  it('TEST-005: V1 minimal record still round-trips after V2 schema additions', () => {
    // Regression guard — every V2 field is optional, so a writer
    // unaware of V2 (legacy or pre-V2 binary) must keep working.
    expectAccept('com.dina.trust.attestation', minimal())
  })

  it('TEST-005: multiple V2 fields malformed simultaneously surface all errors (no short-circuit)', () => {
    // Zod's safeParse aggregates errors across the object — pinning
    // this means a future refactor that swaps `.extend()` for
    // `.merge()` (or vice versa) can't silently drop error paths.
    const issues = expectReject('com.dina.trust.attestation', {
      ...minimal(),
      useCases: Array(4).fill('x'),               // > 3 cap
      reviewerExperience: 'guru',                  // unknown enum
      lastUsedMs: -1,                              // < 0 floor
      recommendFor: ['x'.repeat(51)],              // > 50 char per-entry
      alternatives: [{ type: 'event', name: 'X' }], // unknown subject.type
    })
    const paths = new Set(issues.map((i) => i.path[0]))
    for (const p of ['useCases', 'reviewerExperience', 'lastUsedMs', 'recommendFor', 'alternatives']) {
      expect(paths.has(p)).toBe(true)
    }
  })

  // ── Round-trip: full V2 envelope ───────────────────────────────────
  it('accepts the full V2 envelope (all REV-001..005 + META-005/006 fields)', () => {
    expectAccept('com.dina.trust.attestation', {
      ...minimal(),
      text: 'Solid daily driver.',
      tags: ['ergonomic'],
      domain: 'hermanmiller.com',
      confidence: 'high',
      namespace: 'namespace_2',
      useCases: ['everyday', 'professional'],
      lastUsedMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
      reviewerExperience: 'expert',
      recommendFor: ['everyday', 'professional'],
      notRecommendFor: ['gaming'],
      alternatives: [
        { type: 'product', name: 'Steelcase Leap' },
        { type: 'product', name: 'Herman Miller Mirra' },
      ],
      compliance: ['ce-marked'],
      accessibility: ['wheelchair', 'quiet-hours'],
    })
  })
})

describe('vouchSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.vouch', {
      subject: VALID_DID,
      vouchType: 'professional',
      confidence: 'high',
      createdAt: NOW_ISO,
    })
  })

  it('rejects an unknown confidence value (not in [high, moderate, low])', () => {
    const issues = expectReject('com.dina.trust.vouch', {
      subject: VALID_DID,
      vouchType: 'professional',
      confidence: 'speculative', // attestation has this; vouch deliberately doesn't
      createdAt: NOW_ISO,
    })
    expect(issues.some((i) => i.path[0] === 'confidence')).toBe(true)
  })

  it('rejects empty vouchType (min-length 1 guard)', () => {
    expectReject('com.dina.trust.vouch', {
      subject: VALID_DID,
      vouchType: '',
      confidence: 'high',
      createdAt: NOW_ISO,
    })
  })
})

describe('endorsementSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.endorsement', {
      subject: VALID_DID,
      skill: 'TypeScript',
      endorsementType: 'professional',
      createdAt: NOW_ISO,
    })
  })

  it('accepts the namespace fragment', () => {
    expectAccept('com.dina.trust.endorsement', {
      subject: VALID_DID,
      skill: 'Go',
      endorsementType: 'professional',
      namespace: 'namespace_3',
      createdAt: NOW_ISO,
    })
  })

  it('rejects empty skill', () => {
    expectReject('com.dina.trust.endorsement', {
      subject: VALID_DID,
      skill: '',
      endorsementType: 'professional',
      createdAt: NOW_ISO,
    })
  })
})

describe('flagSchema', () => {
  it('accepts a minimal flag', () => {
    expectAccept('com.dina.trust.flag', {
      subject: { type: 'did', did: VALID_DID },
      flagType: 'spam',
      severity: 'warning',
      createdAt: NOW_ISO,
    })
  })

  it('rejects an unknown severity value', () => {
    const issues = expectReject('com.dina.trust.flag', {
      subject: { type: 'did', did: VALID_DID },
      flagType: 'spam',
      severity: 'medium', // not in [critical, serious, warning, informational]
      createdAt: NOW_ISO,
    })
    expect(issues.some((i) => i.path[0] === 'severity')).toBe(true)
  })
})

describe('replySchema', () => {
  it('accepts a minimal reply', () => {
    expectAccept('com.dina.trust.reply', {
      rootUri: VALID_AT_URI,
      parentUri: VALID_AT_URI,
      intent: 'agree',
      text: 'Same experience.',
      createdAt: NOW_ISO,
    })
  })

  it('rejects empty text (min-length 1 enforced — replies must say something)', () => {
    const issues = expectReject('com.dina.trust.reply', {
      rootUri: VALID_AT_URI,
      parentUri: VALID_AT_URI,
      intent: 'agree',
      text: '',
      createdAt: NOW_ISO,
    })
    expect(issues.some((i) => i.path[0] === 'text')).toBe(true)
  })

  it('rejects an unknown intent value', () => {
    expectReject('com.dina.trust.reply', {
      rootUri: VALID_AT_URI,
      parentUri: VALID_AT_URI,
      intent: 'random', // not in the closed enum
      text: 'x',
      createdAt: NOW_ISO,
    })
  })
})

describe('reactionSchema', () => {
  it('accepts a minimal reaction', () => {
    expectAccept('com.dina.trust.reaction', {
      targetUri: VALID_AT_URI,
      reaction: 'helpful',
      createdAt: NOW_ISO,
    })
  })

  it('rejects an unknown reaction value', () => {
    expectReject('com.dina.trust.reaction', {
      targetUri: VALID_AT_URI,
      reaction: 'awesome',
      createdAt: NOW_ISO,
    })
  })
})

describe('reportRecordSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.reportRecord', {
      targetUri: VALID_AT_URI,
      reportType: 'spam',
      createdAt: NOW_ISO,
    })
  })

  it('rejects an unknown reportType (closed taxonomy enforced)', () => {
    expectReject('com.dina.trust.reportRecord', {
      targetUri: VALID_AT_URI,
      reportType: 'general-disagreement', // not in the 13-value closed list
      createdAt: NOW_ISO,
    })
  })
})

describe('revocationSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.revocation', {
      targetUri: VALID_AT_URI,
      reason: 'I changed my mind',
      createdAt: NOW_ISO,
    })
  })

  it('rejects empty reason (min-length 1 — must explain the revoke)', () => {
    expectReject('com.dina.trust.revocation', {
      targetUri: VALID_AT_URI,
      reason: '',
      createdAt: NOW_ISO,
    })
  })
})

describe('delegationSchema', () => {
  it('accepts a minimal delegation with one permission', () => {
    expectAccept('com.dina.trust.delegation', {
      subject: VALID_DID,
      scope: 'attest',
      permissions: ['publish'],
      createdAt: NOW_ISO,
    })
  })

  it('rejects an empty permissions array (min-length 1 — empty delegation is meaningless)', () => {
    expectReject('com.dina.trust.delegation', {
      subject: VALID_DID,
      scope: 'attest',
      permissions: [],
      createdAt: NOW_ISO,
    })
  })

  it('rejects more than 20 permissions (DOS guard)', () => {
    expectReject('com.dina.trust.delegation', {
      subject: VALID_DID,
      scope: 'attest',
      permissions: Array(21).fill('p'),
      createdAt: NOW_ISO,
    })
  })
})

describe('collectionSchema', () => {
  it('accepts the minimal record (empty items list is OK)', () => {
    expectAccept('com.dina.trust.collection', {
      name: 'Favourites',
      items: [],
      isDiscoverable: true,
      createdAt: NOW_ISO,
    })
  })

  it('rejects more than 100 items (DOS guard)', () => {
    expectReject('com.dina.trust.collection', {
      name: 'Favourites',
      items: Array(101).fill(VALID_AT_URI),
      isDiscoverable: true,
      createdAt: NOW_ISO,
    })
  })

  it('rejects when isDiscoverable is missing (boolean is required, no default)', () => {
    // Critical: privacy-relevant flag must be explicit. A missing
    // isDiscoverable defaulting to true would be a privacy footgun.
    expectReject('com.dina.trust.collection', {
      name: 'Favourites',
      items: [],
      createdAt: NOW_ISO,
    })
  })
})

describe('mediaSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.media', {
      parentUri: VALID_AT_URI,
      mediaType: 'image/jpeg',
      url: 'https://example.com/p.jpg',
      createdAt: NOW_ISO,
    })
  })

  it('rejects URL exceeding the 4096-char bound', () => {
    expectReject('com.dina.trust.media', {
      parentUri: VALID_AT_URI,
      mediaType: 'image/jpeg',
      url: 'https://example.com/' + 'x'.repeat(4096),
      createdAt: NOW_ISO,
    })
  })
})

describe('subjectRecordSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.subject', {
      name: 'Aeron Chair',
      subjectType: 'product',
      createdAt: NOW_ISO,
    })
  })

  it('accepts identifiers as an array of string-keyed records', () => {
    expectAccept('com.dina.trust.subject', {
      name: 'Aeron Chair',
      subjectType: 'product',
      identifiers: [{ uri: 'https://hermanmiller.com/aeron' }, { id: 'AER1B23N' }],
      createdAt: NOW_ISO,
    })
  })

  it('rejects more than 20 identifiers', () => {
    expectReject('com.dina.trust.subject', {
      name: 'Aeron Chair',
      subjectType: 'product',
      identifiers: Array(21).fill({ id: 'x' }),
      createdAt: NOW_ISO,
    })
  })
})

describe('amendmentSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.amendment', {
      targetUri: VALID_AT_URI,
      amendmentType: 'correction',
      createdAt: NOW_ISO,
    })
  })

  it('accepts opaque newValues as a record', () => {
    expectAccept('com.dina.trust.amendment', {
      targetUri: VALID_AT_URI,
      amendmentType: 'correction',
      newValues: { rating: 5, note: 'Updated after second use' },
      createdAt: NOW_ISO,
    })
  })
})

describe('verificationSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.verification', {
      targetUri: VALID_AT_URI,
      verificationType: 'fact-check',
      result: 'confirmed',
      createdAt: NOW_ISO,
    })
  })

  it('rejects an unknown result value', () => {
    expectReject('com.dina.trust.verification', {
      targetUri: VALID_AT_URI,
      verificationType: 'fact-check',
      result: 'maybe', // not in [confirmed, denied, inconclusive]
      createdAt: NOW_ISO,
    })
  })
})

describe('reviewRequestSchema', () => {
  it('accepts the minimal record', () => {
    expectAccept('com.dina.trust.reviewRequest', {
      subject: { type: 'product', name: 'Aeron Chair' },
      requestType: 'general',
      createdAt: NOW_ISO,
    })
  })

  it('accepts an optional expiresAt (ISO date)', () => {
    expectAccept('com.dina.trust.reviewRequest', {
      subject: { type: 'product', name: 'Aeron Chair' },
      requestType: 'time-sensitive',
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: NOW_ISO,
    })
  })
})

describe('comparisonSchema', () => {
  it('accepts the minimal record (>=2 subjects required)', () => {
    expectAccept('com.dina.trust.comparison', {
      subjects: [
        { type: 'product', name: 'A' },
        { type: 'product', name: 'B' },
      ],
      category: 'office-chairs',
      createdAt: NOW_ISO,
    })
  })

  it('rejects with only one subject (min 2 — comparing one thing is meaningless)', () => {
    expectReject('com.dina.trust.comparison', {
      subjects: [{ type: 'product', name: 'A' }],
      category: 'office-chairs',
      createdAt: NOW_ISO,
    })
  })

  it('rejects with > 10 subjects (DOS guard)', () => {
    expectReject('com.dina.trust.comparison', {
      subjects: Array(11).fill({ type: 'product', name: 'A' }),
      category: 'office-chairs',
      createdAt: NOW_ISO,
    })
  })
})

describe('subjectClaimSchema', () => {
  it('accepts a same-entity claim', () => {
    expectAccept('com.dina.trust.subjectClaim', {
      sourceSubjectId: 'subj-1',
      targetSubjectId: 'subj-2',
      claimType: 'same-entity',
      createdAt: NOW_ISO,
    })
  })

  it('rejects an unknown claimType', () => {
    expectReject('com.dina.trust.subjectClaim', {
      sourceSubjectId: 'subj-1',
      targetSubjectId: 'subj-2',
      claimType: 'mentions', // not in [same-entity, related, part-of]
      createdAt: NOW_ISO,
    })
  })
})

describe('trustPolicySchema', () => {
  it('accepts an empty policy (all fields optional besides createdAt)', () => {
    expectAccept('com.dina.trust.trustPolicy', {
      createdAt: NOW_ISO,
    })
  })

  it('accepts maxGraphDepth in [1, 10]', () => {
    expectAccept('com.dina.trust.trustPolicy', {
      maxGraphDepth: 5,
      createdAt: NOW_ISO,
    })
  })

  it('rejects maxGraphDepth = 0 (min 1)', () => {
    expectReject('com.dina.trust.trustPolicy', {
      maxGraphDepth: 0,
      createdAt: NOW_ISO,
    })
  })

  it('rejects > 1000 blockedDids (DOS guard)', () => {
    expectReject('com.dina.trust.trustPolicy', {
      blockedDids: Array(1001).fill(VALID_DID),
      createdAt: NOW_ISO,
    })
  })
})

describe('notificationPrefsSchema', () => {
  it('accepts when all four flags are explicit booleans', () => {
    expectAccept('com.dina.trust.notificationPrefs', {
      enableMentions: true,
      enableReactions: false,
      enableReplies: true,
      enableFlags: false,
      createdAt: NOW_ISO,
    })
  })

  it('rejects when a flag is missing — booleans are required, no implicit defaults', () => {
    // Privacy + UX contract: notification routing must be set
    // explicitly. An unset flag defaulting to `true` would
    // surprise users who paused a category.
    expectReject('com.dina.trust.notificationPrefs', {
      enableMentions: true,
      enableReactions: false,
      enableReplies: true,
      // enableFlags missing
      createdAt: NOW_ISO,
    })
  })
})

describe('serviceProfileSchema', () => {
  const minimal = () => ({
    name: 'Notary Bot',
    description: 'Document notarisation service',
    capabilities: ['notarise'],
    responsePolicy: { notarise: 'auto' },
    isDiscoverable: true,
    updatedAt: NOW_ISO,
  })

  it('accepts the minimal profile (no capabilitySchemas)', () => {
    expectAccept('com.dina.service.profile', minimal())
  })

  it('accepts the cross-field refine when capabilitySchemas covers every capability', () => {
    expectAccept('com.dina.service.profile', {
      ...minimal(),
      capabilitySchemas: {
        notarise: {
          params: { type: 'object' },
          result: { type: 'object' },
          schema_hash: 'abc123',
        },
      },
    })
  })

  it('rejects capabilitySchemas missing one of the declared capabilities (cross-field rule)', () => {
    // Plan §3.5.5: partial coverage is worse than none — consumers
    // can't predict which capabilities will validate. The refine
    // catches this before persistence.
    expectReject('com.dina.service.profile', {
      ...minimal(),
      capabilities: ['notarise', 'translate'],
      capabilitySchemas: {
        notarise: {
          params: { type: 'object' },
          result: { type: 'object' },
          schema_hash: 'abc123',
        },
        // translate is missing — refine should fire
      },
    })
  })

  it('rejects when serviceArea uses float lat (atproto CBOR forbids floats — coords must be E7 integers)', () => {
    const issues = expectReject('com.dina.service.profile', {
      ...minimal(),
      serviceArea: {
        latE7: 37.7749, // float — must be int (round(lat * 1e7))
        lngE7: -1224194000,
        radiusKm: 25,
      },
    })
    expect(issues.some((i) => i.path.join('.').includes('latE7'))).toBe(true)
  })

  it('rejects radiusKm > 500 (Plan §3.5.5 cap)', () => {
    expectReject('com.dina.service.profile', {
      ...minimal(),
      serviceArea: { latE7: 377749000, lngE7: -1224194000, radiusKm: 501 },
    })
  })

  it('rejects empty capabilities array (min 1 — a profile with no capabilities is meaningless)', () => {
    expectReject('com.dina.service.profile', { ...minimal(), capabilities: [] })
  })

  it('rejects > 50 capabilities (DOS guard)', () => {
    expectReject('com.dina.service.profile', {
      ...minimal(),
      capabilities: Array(51).fill('cap'),
    })
  })
})
