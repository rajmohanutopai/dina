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
