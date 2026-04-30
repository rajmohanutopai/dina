/** Subject reference — used in attestations to identify what's being reviewed */
export interface SubjectRef {
  type: 'did' | 'content' | 'product' | 'dataset' | 'organization' | 'claim' | 'place'
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

/** com.dina.trust.attestation */
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
  /**
   * `namespace` (TN-DB-012 / Plan §3.5) — optional fragment id of the
   * `verificationMethod` in the author's DID document under which this
   * record was signed. E.g. `'#namespace_2'` for an attestation
   * published under the author's third pseudonymous compartment.
   * Absent or empty = signed under the root identity.
   * The ingester verifies the commit signature against this key
   * (TN-ING-003). Reviewer-trust scoring is per-(did, namespace).
   */
  namespace?: string
  createdAt: string
}

/** com.dina.trust.vouch */
export interface Vouch {
  subject: string
  vouchType: string
  confidence: 'high' | 'moderate' | 'low'
  relationship?: string
  knownSince?: string
  text?: string
  createdAt: string
}

/** com.dina.trust.endorsement */
export interface Endorsement {
  subject: string
  skill: string
  endorsementType: string
  relationship?: string
  text?: string
  /**
   * `namespace` (TN-DB-012 / Plan §3.5) — fragment id of the
   * `verificationMethod` under which this endorsement was signed,
   * symmetric with `Attestation.namespace`. Pseudonymous endorsements
   * keep the same accountability semantics as the attestations they
   * cosign.
   */
  namespace?: string
  createdAt: string
}

/** com.dina.trust.flag */
export interface Flag {
  subject: SubjectRef
  flagType: string
  severity: 'critical' | 'serious' | 'warning' | 'informational'
  text?: string
  evidence?: EvidenceItem[]
  createdAt: string
}

/** com.dina.trust.reply */
export interface Reply {
  rootUri: string
  parentUri: string
  intent: 'agree' | 'disagree' | 'dispute' | 'correct' | 'clarify' | 'add-context' | 'thank'
  text: string
  evidence?: EvidenceItem[]
  createdAt: string
}

/** com.dina.trust.reaction */
export interface Reaction {
  targetUri: string
  reaction: 'helpful' | 'unhelpful' | 'agree' | 'disagree' | 'verified' | 'can-confirm' | 'suspicious' | 'outdated'
  createdAt: string
}

/** com.dina.trust.reportRecord */
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

/** com.dina.trust.revocation */
export interface Revocation {
  targetUri: string
  reason: string
  createdAt: string
}

/** com.dina.trust.delegation */
export interface Delegation {
  subject: string
  scope: string
  permissions: string[]
  expiresAt?: string
  createdAt: string
}

/** com.dina.trust.collection */
export interface Collection {
  name: string
  description?: string
  items: string[]
  isDiscoverable: boolean
  createdAt: string
}

/** com.dina.trust.media */
export interface Media {
  parentUri: string
  mediaType: string
  url: string
  alt?: string
  createdAt: string
}

/** com.dina.trust.subject */
export interface SubjectRecord {
  name: string
  subjectType: string
  description?: string
  identifiers?: Record<string, string>[]
  createdAt: string
}

/** com.dina.trust.amendment */
export interface Amendment {
  targetUri: string
  amendmentType: string
  text?: string
  newValues?: Record<string, unknown>
  createdAt: string
}

/** com.dina.trust.verification */
export interface Verification {
  targetUri: string
  verificationType: string
  evidence?: EvidenceItem[]
  result: 'confirmed' | 'denied' | 'inconclusive'
  text?: string
  createdAt: string
}

/** com.dina.trust.reviewRequest */
export interface ReviewRequest {
  subject: SubjectRef
  requestType: string
  text?: string
  expiresAt?: string
  createdAt: string
}

/** com.dina.trust.comparison */
export interface Comparison {
  subjects: SubjectRef[]
  category: string
  dimensions?: DimensionRating[]
  text?: string
  createdAt: string
}

/** com.dina.trust.subjectClaim */
export interface SubjectClaim {
  sourceSubjectId: string
  targetSubjectId: string
  claimType: 'same-entity' | 'related' | 'part-of'
  evidence?: EvidenceItem[]
  text?: string
  createdAt: string
}

/** com.dina.trust.trustPolicy */
export interface TrustPolicy {
  maxGraphDepth?: number
  trustedDomains?: string[]
  blockedDids?: string[]
  requireVouch?: boolean
  createdAt: string
}

/** com.dina.service.profile */
export interface ServiceProfile {
  name: string
  description: string
  capabilities: string[]
  capabilitySchemas?: Record<string, unknown>
  /** Coords are E7-scaled integers — atproto forbids floats in CBOR records. */
  serviceArea?: { latE7: number; lngE7: number; radiusKm: number }
  hours?: { open: string; close: string; timezone: string }
  responsePolicy: Record<string, string>
  isDiscoverable: boolean
  updatedAt: string
}

/** com.dina.trust.notificationPrefs */
export interface NotificationPrefs {
  enableMentions: boolean
  enableReactions: boolean
  enableReplies: boolean
  enableFlags: boolean
  createdAt: string
}
