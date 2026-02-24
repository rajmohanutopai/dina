/** Subject reference — used in attestations to identify what's being reviewed */
export interface SubjectRef {
  type: 'did' | 'content' | 'product' | 'dataset' | 'organization' | 'claim'
  did?: string
  uri?: string
  name?: string
  identifier?: string
}

export interface DimensionRating {
  dimension: string
  value: 'exceeded' | 'met' | 'below' | 'failed'
  note?: string
}

export interface EvidenceItem {
  type: string
  uri?: string
  hash?: string
  description?: string
}

export interface Mention {
  did: string
  role?: string
}

export interface CoSignature {
  did: string
  sig: string
  sigCreatedAt: string
}

export interface RelatedAttestation {
  uri: string
  relation: string
}

/** com.dina.reputation.attestation */
export interface Attestation {
  subject: SubjectRef
  category: string
  sentiment: 'positive' | 'neutral' | 'negative'
  dimensions?: DimensionRating[]
  text?: string
  tags?: string[]
  domain?: string
  interactionContext?: Record<string, unknown>
  contentContext?: Record<string, unknown>
  productContext?: Record<string, unknown>
  evidence?: EvidenceItem[]
  confidence?: 'certain' | 'high' | 'moderate' | 'speculative'
  isAgentGenerated?: boolean
  coSignature?: CoSignature
  mentions?: Mention[]
  relatedAttestations?: RelatedAttestation[]
  bilateralReview?: Record<string, unknown>
  createdAt: string
}

/** com.dina.reputation.vouch */
export interface Vouch {
  subject: string
  vouchType: string
  confidence: 'high' | 'moderate' | 'low'
  relationship?: string
  knownSince?: string
  text?: string
  createdAt: string
}

/** com.dina.reputation.endorsement */
export interface Endorsement {
  subject: string
  skill: string
  endorsementType: string
  relationship?: string
  text?: string
  createdAt: string
}

/** com.dina.reputation.flag */
export interface Flag {
  subject: SubjectRef
  flagType: string
  severity: 'critical' | 'serious' | 'warning' | 'informational'
  text?: string
  evidence?: EvidenceItem[]
  createdAt: string
}

/** com.dina.reputation.reply */
export interface Reply {
  rootUri: string
  parentUri: string
  intent: 'agree' | 'disagree' | 'dispute' | 'correct' | 'clarify' | 'add-context' | 'thank'
  text: string
  evidence?: EvidenceItem[]
  createdAt: string
}

/** com.dina.reputation.reaction */
export interface Reaction {
  targetUri: string
  reaction: 'helpful' | 'unhelpful' | 'agree' | 'disagree' | 'verified' | 'can-confirm' | 'suspicious' | 'outdated'
  createdAt: string
}

/** com.dina.reputation.reportRecord */
export interface ReportRecord {
  targetUri: string
  reportType: 'spam' | 'fake-review' | 'incentivized-undisclosed' | 'self-review' |
    'competitor-attack' | 'harassment' | 'doxxing' | 'off-topic' |
    'duplicate' | 'ai-generated-undisclosed' | 'defamation' |
    'conflict-of-interest' | 'brigading'
  text?: string
  evidence?: EvidenceItem[]
  relatedRecords?: string[]
  createdAt: string
}

/** com.dina.reputation.revocation */
export interface Revocation {
  targetUri: string
  reason: string
  createdAt: string
}

/** com.dina.reputation.delegation */
export interface Delegation {
  subject: string
  scope: string
  permissions: string[]
  expiresAt?: string
  createdAt: string
}

/** com.dina.reputation.collection */
export interface Collection {
  name: string
  description?: string
  items: string[]
  isPublic: boolean
  createdAt: string
}

/** com.dina.reputation.media */
export interface Media {
  parentUri: string
  mediaType: string
  url: string
  alt?: string
  createdAt: string
}

/** com.dina.reputation.subject */
export interface SubjectRecord {
  name: string
  subjectType: string
  description?: string
  identifiers?: Record<string, string>[]
  createdAt: string
}

/** com.dina.reputation.amendment */
export interface Amendment {
  targetUri: string
  amendmentType: string
  text?: string
  newValues?: Record<string, unknown>
  createdAt: string
}

/** com.dina.reputation.verification */
export interface Verification {
  targetUri: string
  verificationType: string
  evidence?: EvidenceItem[]
  result: 'confirmed' | 'denied' | 'inconclusive'
  text?: string
  createdAt: string
}

/** com.dina.reputation.reviewRequest */
export interface ReviewRequest {
  subject: SubjectRef
  requestType: string
  text?: string
  expiresAt?: string
  createdAt: string
}

/** com.dina.reputation.comparison */
export interface Comparison {
  subjects: SubjectRef[]
  category: string
  dimensions?: DimensionRating[]
  text?: string
  createdAt: string
}

/** com.dina.reputation.subjectClaim */
export interface SubjectClaim {
  sourceSubjectId: string
  targetSubjectId: string
  claimType: 'same-entity' | 'related' | 'part-of'
  evidence?: EvidenceItem[]
  text?: string
  createdAt: string
}

/** com.dina.reputation.trustPolicy */
export interface TrustPolicy {
  maxGraphDepth?: number
  trustedDomains?: string[]
  blockedDids?: string[]
  requireVouch?: boolean
  createdAt: string
}

/** com.dina.reputation.notificationPrefs */
export interface NotificationPrefs {
  enableMentions: boolean
  enableReactions: boolean
  enableReplies: boolean
  enableFlags: boolean
  createdAt: string
}
