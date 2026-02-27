import { z } from 'zod'
import { logger } from '@/shared/utils/logger.js'
import type { ReputationCollection } from '@/config/lexicons.js'

/**
 * Zod validation schemas for all 19 reputation record types.
 *
 * Each record arriving from Jetstream is validated before being passed
 * to a handler. Invalid records are logged and dropped — never persisted.
 */

// ── Shared schemas ──────────────────────────────────────────────────

// ── Bounded validators (APPVIEW-MED-02, MED-09) ────────────────────
const didString = z.string().min(8).max(2048).regex(/^did:[a-z]+:/, 'Must be a valid DID')
const boundedUri = z.string().min(1).max(2048)

const subjectRefSchema = z.object({
  type: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim']),
  did: didString.optional(),
  uri: boundedUri.optional(),
  name: z.string().max(200).optional(),
  identifier: z.string().max(500).optional(),
})

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
  isPublic: z.boolean(),
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

// ── Schema map ──────────────────────────────────────────────────────

const SCHEMA_MAP: Record<string, z.ZodSchema> = {
  'com.dina.reputation.attestation': attestationSchema,
  'com.dina.reputation.vouch': vouchSchema,
  'com.dina.reputation.endorsement': endorsementSchema,
  'com.dina.reputation.flag': flagSchema,
  'com.dina.reputation.reply': replySchema,
  'com.dina.reputation.reaction': reactionSchema,
  'com.dina.reputation.reportRecord': reportRecordSchema,
  'com.dina.reputation.revocation': revocationSchema,
  'com.dina.reputation.delegation': delegationSchema,
  'com.dina.reputation.collection': collectionSchema,
  'com.dina.reputation.media': mediaSchema,
  'com.dina.reputation.subject': subjectRecordSchema,
  'com.dina.reputation.amendment': amendmentSchema,
  'com.dina.reputation.verification': verificationSchema,
  'com.dina.reputation.reviewRequest': reviewRequestSchema,
  'com.dina.reputation.comparison': comparisonSchema,
  'com.dina.reputation.subjectClaim': subjectClaimSchema,
  'com.dina.reputation.trustPolicy': trustPolicySchema,
  'com.dina.reputation.notificationPrefs': notificationPrefsSchema,
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
