import { z } from 'zod'
import { logger } from '@/shared/utils/logger.js'
import type { TrustCollection } from '@/config/lexicons.js'
import { CONSTANTS } from '@/config/constants.js'

/**
 * Zod validation schemas for all 19 trust record types.
 *
 * Each record arriving from Jetstream is validated before being passed
 * to a handler. Invalid records are logged and dropped — never persisted.
 */

// ── Shared schemas ──────────────────────────────────────────────────

// ── Bounded validators (APPVIEW-MED-02, MED-09) ────────────────────
//
// Tier 1 fields (did / uri / identifier) are hashed VERBATIM by the
// subject-id resolver (per packages/protocol/docs/features/subject-id.md).
// That makes surrounding whitespace identity-significant: `"did:plc:x "`
// would mint a different subject than `"did:plc:x"`. Reject padded /
// whitespace-only Tier 1 values here so the verbatim hash only ever
// sees canonical input. `v === v.trim()` rejects both leading/trailing
// padding AND whitespace-only strings (whose trim differs from the
// original). A truly-empty string `""` passes this refine but the
// resolver treats length-0 as "absent" (falls through to the next
// tier), and the SubjectRef-level "at least one field" refine rejects
// an all-empty ref — so empty needs no extra guard here.
const noSurroundingWhitespace = (v: string) => v === v.trim()
const WS_MSG = 'must not have leading/trailing whitespace'

const didString = z
  .string()
  .min(8)
  .max(CONSTANTS.SUBJECT_REF_MAX_DID_LEN)
  // `.+` after the method colon requires a non-empty method-specific
  // id — `did:plc:` (no id) is not a real DID and was previously
  // accepted by the looser `^did:[a-z]+:`. The trailing identifier
  // can itself contain colons (e.g. did:web:host:port), so `.+` is
  // the right breadth; surrounding-whitespace is caught by the refine.
  .regex(/^did:[a-z]+:.+/, 'Must be a valid DID (method-specific id required)')
  .refine(noSurroundingWhitespace, { message: `DID ${WS_MSG}` })
const boundedUri = z
  .string()
  .min(1)
  .max(CONSTANTS.SUBJECT_REF_MAX_URI_LEN)
  .refine(noSurroundingWhitespace, { message: `uri ${WS_MSG}` })

// A SubjectRef must carry at least one resolver input — without one,
// AppView can't mint a stable subject_id. The refine here is the
// first gate; the resolver fails loud if a malformed ref ever slips
// past (defense in depth).
const subjectRefSchema = z
  .object({
    type: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim', 'place']),
    did: didString.optional(),
    uri: boundedUri.optional(),
    name: z.string().max(CONSTANTS.SUBJECT_REF_MAX_NAME_LEN).optional(),
    // No `.min(1)`: an empty identifier is "absent" (resolver falls
    // through to name), not an error — preserving the pre-existing
    // leniency. The refine still rejects whitespace-only / padded
    // values, which is the part that matters for verbatim hashing.
    identifier: z
      .string()
      .max(CONSTANTS.SUBJECT_REF_MAX_IDENTIFIER_LEN)
      .refine(noSurroundingWhitespace, { message: `identifier ${WS_MSG}` })
      .optional(),
  })
  .refine(
    (ref) =>
      !!ref.did ||
      !!ref.uri ||
      !!ref.identifier ||
      (typeof ref.name === 'string' && ref.name.trim().length > 0),
    {
      message:
        'SubjectRef must carry at least one of: did, uri, identifier, or a non-empty name.',
    },
  )

const evidenceItemSchema = z.object({
  type: z.string().max(100),
  uri: z.string().max(2048).optional(),
  hash: z.string().max(256).optional(),
  description: z.string().max(300).optional(),
})

const dimensionRatingSchema = z.object({
  dimension: z.string().max(100),
  value: z.enum(['exceeded', 'met', 'below', 'failed']),
  note: z.string().max(500).optional(),
})

const mentionSchema = z.object({
  did: didString,
  role: z.string().max(100).optional(),
})

const coSignatureSchema = z.object({
  did: didString,
  sig: z.string().max(500),
  sigCreatedAt: z.string().max(50),
})

const relatedAttestationSchema = z.object({
  uri: boundedUri,
  relation: z.string().max(100),
})

const isoDateString = z.string().datetime({ offset: true })
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000 // 5 minutes
const boundedIsoDate = isoDateString.refine(
  (val) => new Date(val).getTime() <= Date.now() + MAX_CLOCK_SKEW_MS,
  { message: 'createdAt cannot be more than 5 minutes in the future' },
)

// ── Record schemas ──────────────────────────────────────────────────

// Pseudonymous-namespace fragment (TN-DB-012 / Plan §3.5). Format
// `#namespace_<N>` per `packages/core/src/identity/plc_namespace_update.ts`,
// or absent / empty for the root identity. Length-bounded; strict
// fragment-format check is the ingester's job (TN-ING-003) since it
// requires resolving the author's DID document.
const namespaceFragment = z.string().min(1).max(255)

const attestationSchema = z.object({
  subject: subjectRefSchema,
  category: z.string().min(1).max(200),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  dimensions: z.array(dimensionRatingSchema).max(10).optional(),
  text: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  domain: z.string().max(253).optional(),
  interactionContext: z.record(z.unknown()).optional(),
  contentContext: z.record(z.unknown()).optional(),
  productContext: z.record(z.unknown()).optional(),
  evidence: z.array(evidenceItemSchema).max(10).optional(),
  confidence: z.enum(['certain', 'high', 'moderate', 'speculative']).optional(),
  isAgentGenerated: z.boolean().optional(),
  coSignature: coSignatureSchema.optional(),
  mentions: z.array(mentionSchema).max(10).optional(),
  relatedAttestations: z.array(relatedAttestationSchema).max(5).optional(),
  bilateralReview: z.record(z.unknown()).optional(),
  namespace: namespaceFragment.optional(),
  // TN-V2-REV-001 — per-category use-case tags. Cap at 3 to match the
  // writer-side mobile cap (`MAX_USE_CASES`) and match `tags`'
  // per-string bound. Closed-vocabulary discipline lives in the
  // writer; AppView accepts whatever opaque tag the writer declared.
  useCases: z.array(z.string().min(1).max(50)).max(3).optional(),
  // TN-V2-REV-003 — optional ms-since-epoch when reviewer last used
  // the subject. Bounded the same way `boundedIsoDate` bounds
  // `createdAt`: ≤ now + 5min skew (since "last used" is past-tense
  // by definition; future values are clock-skew or malformed). Lower
  // bound 0 (epoch start) — AT Protocol records are post-1970, and
  // negative ms would invert recency math downstream.
  lastUsedMs: z.number().int().min(0).refine(
    (val) => val <= Date.now() + MAX_CLOCK_SKEW_MS,
    { message: 'lastUsedMs cannot be more than 5 minutes in the future' },
  ).optional(),
  // TN-V2-REV-002 — self-declared reviewer expertise with the
  // category. Closed enum so the scorer can weight by tier without
  // string-matching free-form values.
  reviewerExperience: z.enum(['novice', 'intermediate', 'expert']).optional(),
  // TN-V2-REV-004 — disjoint endorsement / warning use-case tags.
  // Same per-string bound as `useCases` (writer-enforced
  // vocabulary). Cap 5 each — larger lists become noise on the
  // detail surface that renders them.
  recommendFor: z.array(z.string().min(1).max(50)).max(5).optional(),
  notRecommendFor: z.array(z.string().min(1).max(50)).max(5).optional(),
  // TN-V2-REV-005 — other subjects the reviewer also tried. Same
  // cap (5) as the mobile writer-side `MAX_REVIEW_ALTERNATIVES`.
  // Reuses the shared `subjectRefSchema` so the bounds (DID
  // length, URI length, name/identifier sizes) match the primary
  // subject — readers navigating an alternative shouldn't run
  // into a SubjectRef the rest of the system can't render.
  alternatives: z.array(subjectRefSchema).max(5).optional(),
  // TN-V2-META-005 — compliance tags. Cap 10; one product can
  // legitimately be halal AND vegan AND gluten-free AND
  // CE-marked, and the surfaces that render these (filter chips,
  // detail-page badges) want all the badges, not a truncated
  // sample. Per-tag bound matches `tags` / `useCases`.
  compliance: z.array(z.string().min(1).max(50)).max(10).optional(),
  // TN-V2-META-006 — accessibility tags. Same shape and cap
  // rationale as `compliance` — accessibility is additive across
  // dimensions (wheelchair access AND captions AND audio
  // description on the same venue is normal).
  accessibility: z.array(z.string().min(1).max(50)).max(10).optional(),
  // TN-V2-META-003 — compatibility tags. Cap 15 (vs 10 for
  // compliance/accessibility) because devices can legitimately
  // check many compatibility boxes — a modern laptop checks
  // OS-family + bus + connector + wireless + power + … easily
  // hitting double digits before any per-platform expansion.
  compat: z.array(z.string().min(1).max(50)).max(15).optional(),
  // TN-V2-META-002 — reviewer-declared price range. Coords are
  // E7-scaled integers (`low_e7 = round(price * 1e7)`) — same
  // CBOR-int convention as `serviceArea.latE7/lngE7` because AT
  // Protocol records forbid floats. `currency` is ISO 4217
  // alpha-3. `lastSeenMs` is when the reviewer observed the
  // price (distinct from the review's `createdAt` because a
  // price observed today may be recorded in a review next month).
  // Bounds:
  //  - `low_e7` / `high_e7`: non-negative (negative prices are
  //    nonsensical for the surfaces this powers — RANK-002 range
  //    overlap, filter chips). Upper bound JS_MAX_SAFE / 1e7 so
  //    the integer survives both CBOR encode and Postgres
  //    `bigint`.
  //  - `low_e7 <= high_e7`: cross-field refine — a reversed range
  //    is malformed and would silently break range-overlap math
  //    if persisted (`low <= max AND high >= min` with `low > high`
  //    matches nothing).
  //  - `currency`: 3 uppercase ASCII letters (ISO 4217 alpha-3).
  //    Closed-vocab discipline lives on the writer; AppView
  //    enforces shape only.
  //  - `lastSeenMs`: same bounds as `lastUsedMs` — non-negative
  //    integer ms, ≤ now + 5min skew.
  price: z.object({
    low_e7: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    high_e7: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Must be ISO 4217 alpha-3 (uppercase, 3 letters)'),
    lastSeenMs: z.number().int().min(0).refine(
      (val) => val <= Date.now() + MAX_CLOCK_SKEW_MS,
      { message: 'lastSeenMs cannot be more than 5 minutes in the future' },
    ),
  }).refine(
    (val) => val.low_e7 <= val.high_e7,
    { message: 'price.low_e7 must be less than or equal to price.high_e7' },
  ).optional(),
  // TN-V2-META-001 — reviewer-declared availability triple. Each
  // sub-field independently optional: a reviewer may know "sold
  // in US" without knowing shipping or retailer set. The
  // host_to_region enricher (META-007) auto-fills `regions` when
  // the reviewer hasn't declared.
  //  - `regions` / `shipsTo`: ISO 3166-1 alpha-2 (uppercase 2
  //    letters). Cap 30 — global retailers operate in dozens of
  //    countries; the cap holds an ordering-stable bound for the
  //    UI rendering pipeline without truncating real-world cases.
  //  - `soldAt`: hostnames (RFC 1035 — ≤ 253 chars). Cap 20 —
  //    even the most ubiquitous products aren't sold at more than
  //    a couple of dozen distinct retailers a reviewer can name.
  // All three honour the empty-array → NULL handler convention so
  // the GIN indexes don't carry zero-length rows.
  availability: z.object({
    regions: z.array(z.string().regex(/^[A-Z]{2}$/, 'Must be ISO 3166-1 alpha-2 (uppercase, 2 letters)')).max(30).optional(),
    shipsTo: z.array(z.string().regex(/^[A-Z]{2}$/, 'Must be ISO 3166-1 alpha-2 (uppercase, 2 letters)')).max(30).optional(),
    soldAt: z.array(z.string().min(1).max(253)).max(20).optional(),
  }).optional(),
  // TN-V2-META-004 — reviewer-declared schedule. Heterogeneous
  // shape (per-day open/close map + scalar leadDays + month
  // array) so persisted as JSONB. No individual sub-field has a
  // search predicate that would benefit from a dedicated column.
  //  - `hours`: keyed by lowercase 3-letter day code; values are
  //    `{ open: 'HH:MM', close: 'HH:MM' }` 24-hour. Day keys
  //    bounded by enum so a typo (`'monday'`) is caught at the
  //    gate, not silently dropped on render.
  //  - `leadDays`: integer 0–365; lower bound prevents negative
  //    nonsense, upper bound 365 because anything beyond a year
  //    advance is a special-event quote, not a schedule.
  //  - `seasonal`: months 1–12; cap matches calendar.
  schedule: z.object({
    hours: z.record(
      z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      z.object({
        open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM 24-hour'),
        close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM 24-hour'),
      }),
    ).optional(),
    leadDays: z.number().int().min(0).max(365).optional(),
    seasonal: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  }).optional(),
  createdAt: boundedIsoDate,
})

const vouchSchema = z.object({
  subject: didString,
  vouchType: z.string().min(1).max(100),
  confidence: z.enum(['high', 'moderate', 'low']),
  relationship: z.string().max(200).optional(),
  knownSince: z.string().max(50).optional(),
  text: z.string().max(2000).optional(),
  createdAt: boundedIsoDate,
})

const endorsementSchema = z.object({
  subject: didString,
  skill: z.string().min(1).max(200),
  endorsementType: z.string().min(1).max(100),
  relationship: z.string().max(200).optional(),
  text: z.string().max(2000).optional(),
  namespace: namespaceFragment.optional(),
  createdAt: boundedIsoDate,
})

const flagSchema = z.object({
  subject: subjectRefSchema,
  flagType: z.string().min(1).max(100),
  severity: z.enum(['critical', 'serious', 'warning', 'informational']),
  text: z.string().max(2000).optional(),
  evidence: z.array(evidenceItemSchema).max(10).optional(),
  createdAt: boundedIsoDate,
})

const replySchema = z.object({
  rootUri: z.string().min(1).max(2048),
  parentUri: z.string().min(1).max(2048),
  intent: z.enum(['agree', 'disagree', 'dispute', 'correct', 'clarify', 'add-context', 'thank']),
  text: z.string().min(1).max(5000),
  evidence: z.array(evidenceItemSchema).max(10).optional(),
  createdAt: boundedIsoDate,
})

const reactionSchema = z.object({
  targetUri: z.string().min(1).max(2048),
  reaction: z.enum([
    'helpful', 'unhelpful', 'agree', 'disagree',
    'verified', 'can-confirm', 'suspicious', 'outdated',
  ]),
  createdAt: boundedIsoDate,
})

const reportRecordSchema = z.object({
  targetUri: z.string().min(1).max(2048),
  reportType: z.enum([
    'spam', 'fake-review', 'incentivized-undisclosed', 'self-review',
    'competitor-attack', 'harassment', 'doxxing', 'off-topic',
    'duplicate', 'ai-generated-undisclosed', 'defamation',
    'conflict-of-interest', 'brigading',
  ]),
  text: z.string().max(1000).optional(),
  evidence: z.array(evidenceItemSchema).max(5).optional(),
  relatedRecords: z.array(z.string().max(2048)).max(10).optional(),
  createdAt: boundedIsoDate,
})

const revocationSchema = z.object({
  targetUri: z.string().min(1).max(2048),
  reason: z.string().min(1).max(1000),
  createdAt: boundedIsoDate,
})

const delegationSchema = z.object({
  subject: didString,
  scope: z.string().min(1).max(200),
  permissions: z.array(z.string().max(100)).min(1).max(20),
  expiresAt: isoDateString.optional(),
  createdAt: boundedIsoDate,
})

const collectionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  items: z.array(z.string().max(2048)).max(100),
  isDiscoverable: z.boolean(),
  createdAt: boundedIsoDate,
})

const mediaSchema = z.object({
  parentUri: z.string().min(1).max(2048),
  mediaType: z.string().min(1).max(100),
  url: z.string().min(1).max(4096),
  alt: z.string().max(1000).optional(),
  createdAt: boundedIsoDate,
})

const subjectRecordSchema = z.object({
  name: z.string().min(1).max(200),
  subjectType: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  identifiers: z.array(z.record(z.string().max(500))).max(20).optional(),
  createdAt: boundedIsoDate,
})

const amendmentSchema = z.object({
  targetUri: z.string().min(1).max(2048),
  amendmentType: z.string().min(1).max(100),
  text: z.string().max(2000).optional(),
  newValues: z.record(z.unknown()).optional(),
  createdAt: boundedIsoDate,
})

const verificationSchema = z.object({
  targetUri: z.string().min(1).max(2048),
  verificationType: z.string().min(1).max(100),
  evidence: z.array(evidenceItemSchema).max(10).optional(),
  result: z.enum(['confirmed', 'denied', 'inconclusive']),
  text: z.string().max(2000).optional(),
  createdAt: boundedIsoDate,
})

const reviewRequestSchema = z.object({
  subject: subjectRefSchema,
  requestType: z.string().min(1).max(100),
  text: z.string().max(2000).optional(),
  expiresAt: isoDateString.optional(),
  createdAt: boundedIsoDate,
})

const comparisonSchema = z.object({
  subjects: z.array(subjectRefSchema).min(2).max(10),
  category: z.string().min(1).max(200),
  dimensions: z.array(dimensionRatingSchema).max(10).optional(),
  text: z.string().max(5000).optional(),
  createdAt: boundedIsoDate,
})

const subjectClaimSchema = z.object({
  sourceSubjectId: z.string().min(1).max(500),
  targetSubjectId: z.string().min(1).max(500),
  claimType: z.enum(['same-entity', 'related', 'part-of']),
  evidence: z.array(evidenceItemSchema).max(10).optional(),
  text: z.string().max(2000).optional(),
  createdAt: boundedIsoDate,
})

const trustPolicySchema = z.object({
  maxGraphDepth: z.number().int().min(1).max(10).optional(),
  trustedDomains: z.array(z.string().max(253)).max(50).optional(),
  blockedDids: z.array(didString).max(1000).optional(),
  requireVouch: z.boolean().optional(),
  createdAt: boundedIsoDate,
})

const notificationPrefsSchema = z.object({
  enableMentions: z.boolean(),
  enableReactions: z.boolean(),
  enableReplies: z.boolean(),
  enableFlags: z.boolean(),
  createdAt: boundedIsoDate,
})

// Per-capability schema contract: params + result JSON Schema plus a
// deterministic schema_hash and optional TTL hint. Params/result are
// required — a capability without them can't be validated, which defeats
// the whole point of schema-driven discovery. The JSON Schema payloads
// themselves are indexed as opaque blobs.
const capabilitySchemaEntrySchema = z.object({
  description: z.string().max(2000).optional(),
  params: z.record(z.unknown()),
  result: z.record(z.unknown()),
  // Hex-encoded SHA-256 of the capability schema (64 chars). Tightening
  // to a hex-only regex catches operator typos (a colon, a space, a
  // truncation) before they land in the index, where they'd silently
  // mismatch every request's `schema_hash` field on `service.query`.
  schema_hash: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase 64-char hex SHA-256'),
  default_ttl_seconds: z.number().int().positive().max(86400).optional(),
})

const serviceProfileSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  capabilities: z.array(z.string().max(100)).min(1).max(50),
  capabilitySchemas: z.record(capabilitySchemaEntrySchema).optional(),
  // AT Protocol lexicon forbids floats in CBOR records, so coords are
  // scaled integers (latE7 = round(lat * 1e7)). Ingester divides back
  // when writing to Postgres. radiusKm stays integer (≤ 500 km).
  serviceArea: z.object({
    latE7: z.number().int().min(-900_000_000).max(900_000_000),
    lngE7: z.number().int().min(-1_800_000_000).max(1_800_000_000),
    radiusKm: z.number().int().min(0).max(500),
  }).optional(),
  hours: z.object({
    open: z.string().max(10),
    close: z.string().max(10),
    timezone: z.string().max(50),
  }).optional(),
  // Closed enum: each capability maps to one of 'auto' (provider
  // responds immediately) or 'review' (provider queues for manual
  // approval). Open `z.string()` here would let typos through that
  // the ingester's gate silently drops — closed enum surfaces them
  // at validation time. Adding a new policy verb is a coordinated
  // change (this enum + the gate in service-profile.ts).
  responsePolicy: z.record(z.enum(['auto', 'review'])),
  isDiscoverable: z.boolean(),
  updatedAt: boundedIsoDate,
}).refine(
  // Schema-driven contract: if capabilitySchemas is supplied it must cover
  // every capability the profile declares. Partial coverage is worse than
  // none because consumers can't predict which capabilities will validate.
  (data) => {
    if (!data.capabilitySchemas) return true
    for (const cap of data.capabilities) {
      if (!(cap in data.capabilitySchemas)) return false
    }
    return true
  },
  { message: 'capabilitySchemas must cover every declared capability' },
)

// ── Schema map ──────────────────────────────────────────────────────

const SCHEMA_MAP: Record<string, z.ZodSchema> = {
  'com.dina.peerlens.attestation': attestationSchema,
  'com.dina.peerlens.vouch': vouchSchema,
  'com.dina.peerlens.endorsement': endorsementSchema,
  'com.dina.peerlens.flag': flagSchema,
  'com.dina.peerlens.reply': replySchema,
  'com.dina.peerlens.reaction': reactionSchema,
  'com.dina.peerlens.reportRecord': reportRecordSchema,
  'com.dina.peerlens.revocation': revocationSchema,
  'com.dina.peerlens.delegation': delegationSchema,
  'com.dina.peerlens.collection': collectionSchema,
  'com.dina.peerlens.media': mediaSchema,
  'com.dina.peerlens.subject': subjectRecordSchema,
  'com.dina.peerlens.amendment': amendmentSchema,
  'com.dina.peerlens.verification': verificationSchema,
  'com.dina.peerlens.reviewRequest': reviewRequestSchema,
  'com.dina.peerlens.comparison': comparisonSchema,
  'com.dina.peerlens.subjectClaim': subjectClaimSchema,
  'com.dina.peerlens.trustPolicy': trustPolicySchema,
  'com.dina.peerlens.notificationPrefs': notificationPrefsSchema,
  'com.dina.service.profile': serviceProfileSchema,
}

// ── Public API ──────────────────────────────────────────────────────

export interface ValidationResult<T = unknown> {
  success: boolean
  data?: T
  errors?: z.ZodError
}

/**
 * Validate a record against its collection schema.
 * Returns the parsed data on success, or the Zod errors on failure.
 */
export function validateRecord(
  collection: string,
  record: unknown,
): ValidationResult {
  const schema = SCHEMA_MAP[collection]

  if (!schema) {
    logger.warn({ collection }, '[Validator] No schema found for collection')
    return { success: false }
  }

  const result = schema.safeParse(record)

  if (!result.success) {
    logger.warn(
      { collection, errors: result.error.issues },
      '[Validator] Record validation failed',
    )
    return { success: false, errors: result.error }
  }

  return { success: true, data: result.data }
}

/**
 * Check if a collection NSID has a registered schema.
 */
export function hasSchema(collection: string): boolean {
  return collection in SCHEMA_MAP
}
