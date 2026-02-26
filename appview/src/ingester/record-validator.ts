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

const subjectRefSchema = z.object({
  type: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim']),
  did: z.string().optional(),
  uri: z.string().optional(),
  name: z.string().max(200).optional(),
  identifier: z.string().optional(),
})

const evidenceItemSchema = z.object({
  type: z.string(),
  uri: z.string().optional(),
  hash: z.string().optional(),
  description: z.string().max(300).optional(),
})

const dimensionRatingSchema = z.object({
  dimension: z.string(),
  value: z.enum(['exceeded', 'met', 'below', 'failed']),
  note: z.string().optional(),
})

const mentionSchema = z.object({
  did: z.string(),
  role: z.string().optional(),
})

const coSignatureSchema = z.object({
  did: z.string(),
  sig: z.string(),
  sigCreatedAt: z.string(),
})

const relatedAttestationSchema = z.object({
  uri: z.string(),
  relation: z.string(),
})

const isoDateString = z.string().datetime({ offset: true })

// ── Record schemas ──────────────────────────────────────────────────

const attestationSchema = z.object({
  subject: subjectRefSchema,
  category: z.string().min(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  dimensions: z.array(dimensionRatingSchema).max(10).optional(),
  text: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  domain: z.string().optional(),
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
  createdAt: isoDateString,
})

const vouchSchema = z.object({
  subject: z.string().min(1),
  vouchType: z.string().min(1),
  confidence: z.enum(['high', 'moderate', 'low']),
  relationship: z.string().optional(),
  knownSince: z.string().optional(),
  text: z.string().optional(),
  createdAt: isoDateString,
})

const endorsementSchema = z.object({
  subject: z.string().min(1),
  skill: z.string().min(1),
  endorsementType: z.string().min(1),
  relationship: z.string().optional(),
  text: z.string().optional(),
  createdAt: isoDateString,
})

const flagSchema = z.object({
  subject: subjectRefSchema,
  flagType: z.string().min(1),
  severity: z.enum(['critical', 'serious', 'warning', 'informational']),
  text: z.string().optional(),
  evidence: z.array(evidenceItemSchema).optional(),
  createdAt: isoDateString,
})

const replySchema = z.object({
  rootUri: z.string().min(1),
  parentUri: z.string().min(1),
  intent: z.enum(['agree', 'disagree', 'dispute', 'correct', 'clarify', 'add-context', 'thank']),
  text: z.string().min(1),
  evidence: z.array(evidenceItemSchema).optional(),
  createdAt: isoDateString,
})

const reactionSchema = z.object({
  targetUri: z.string().min(1),
  reaction: z.enum([
    'helpful', 'unhelpful', 'agree', 'disagree',
    'verified', 'can-confirm', 'suspicious', 'outdated',
  ]),
  createdAt: isoDateString,
})

const reportRecordSchema = z.object({
  targetUri: z.string().min(1),
  reportType: z.enum([
    'spam', 'fake-review', 'incentivized-undisclosed', 'self-review',
    'competitor-attack', 'harassment', 'doxxing', 'off-topic',
    'duplicate', 'ai-generated-undisclosed', 'defamation',
    'conflict-of-interest', 'brigading',
  ]),
  text: z.string().max(1000).optional(),
  evidence: z.array(evidenceItemSchema).max(5).optional(),
  relatedRecords: z.array(z.string()).max(10).optional(),
  createdAt: isoDateString,
})

const revocationSchema = z.object({
  targetUri: z.string().min(1),
  reason: z.string().min(1),
  createdAt: isoDateString,
})

const delegationSchema = z.object({
  subject: z.string().min(1),
  scope: z.string().min(1),
  permissions: z.array(z.string()).min(1),
  expiresAt: z.string().optional(),
  createdAt: isoDateString,
})

const collectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  items: z.array(z.string()),
  isPublic: z.boolean(),
  createdAt: isoDateString,
})

const mediaSchema = z.object({
  parentUri: z.string().min(1),
  mediaType: z.string().min(1),
  url: z.string().min(1),
  alt: z.string().optional(),
  createdAt: isoDateString,
})

const subjectRecordSchema = z.object({
  name: z.string().min(1),
  subjectType: z.string().min(1),
  description: z.string().optional(),
  identifiers: z.array(z.record(z.string())).optional(),
  createdAt: isoDateString,
})

const amendmentSchema = z.object({
  targetUri: z.string().min(1),
  amendmentType: z.string().min(1),
  text: z.string().optional(),
  newValues: z.record(z.unknown()).optional(),
  createdAt: isoDateString,
})

const verificationSchema = z.object({
  targetUri: z.string().min(1),
  verificationType: z.string().min(1),
  evidence: z.array(evidenceItemSchema).optional(),
  result: z.enum(['confirmed', 'denied', 'inconclusive']),
  text: z.string().optional(),
  createdAt: isoDateString,
})

const reviewRequestSchema = z.object({
  subject: subjectRefSchema,
  requestType: z.string().min(1),
  text: z.string().optional(),
  expiresAt: z.string().optional(),
  createdAt: isoDateString,
})

const comparisonSchema = z.object({
  subjects: z.array(subjectRefSchema).min(2),
  category: z.string().min(1),
  dimensions: z.array(dimensionRatingSchema).optional(),
  text: z.string().optional(),
  createdAt: isoDateString,
})

const subjectClaimSchema = z.object({
  sourceSubjectId: z.string().min(1),
  targetSubjectId: z.string().min(1),
  claimType: z.enum(['same-entity', 'related', 'part-of']),
  evidence: z.array(evidenceItemSchema).optional(),
  text: z.string().optional(),
  createdAt: isoDateString,
})

const trustPolicySchema = z.object({
  maxGraphDepth: z.number().int().min(1).max(10).optional(),
  trustedDomains: z.array(z.string()).optional(),
  blockedDids: z.array(z.string()).optional(),
  requireVouch: z.boolean().optional(),
  createdAt: isoDateString,
})

const notificationPrefsSchema = z.object({
  enableMentions: z.boolean(),
  enableReactions: z.boolean(),
  enableReplies: z.boolean(),
  enableFlags: z.boolean(),
  createdAt: isoDateString,
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
