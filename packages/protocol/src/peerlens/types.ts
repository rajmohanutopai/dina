/**
 * PeerLens wire types — the canonical TS shape for the
 * `com.dinakernel.peerlens.*` AT Protocol record family.
 *
 * AppView's Zod validators (in `appview/src/ingester/record-validator.ts`)
 * are the runtime source of truth: any record that fails AppView's
 * validation gets dropped at the firehose. The interfaces here mirror
 * those Zod schemas byte-for-byte at the type level so consumers
 * (Lite trust client, Brain trust tool, mobile compose flows) all
 * share one definition.
 *
 * AppView itself is currently outside the npm workspace and keeps a
 * parallel copy at `appview/src/shared/types/lexicon-types.ts`. The
 * Zod schema there is structurally identical; AppView re-syncing
 * from this file is tracked as a follow-up (a cross-workspace
 * publish path is needed for AppView to consume `@dina/protocol`).
 *
 * Zero runtime deps — pure type declarations.
 */

// ── Shared sub-types ────────────────────────────────────────────────

/**
 * Subject types accepted by AppView's ingester.
 *
 * Adding a new type here without adding it server-side is a recipe
 * for "Lite says it's valid, AppView drops the record at the
 * firehose". Keep this enum byte-identical to the AppView Zod enum
 * in `appview/src/ingester/record-validator.ts`.
 */
export type SubjectType =
  | 'did'
  | 'content'
  | 'product'
  | 'dataset'
  | 'organization'
  | 'claim'
  | 'place';

/**
 * Reference to the subject of an attestation/flag/etc — a person
 * (DID), a piece of content (URI), a product (identifier), an
 * organization, a place, a claim, etc. AppView's Zod validator
 * requires `type`; downstream resolution requires at least one of
 * `did` / `uri` / `name` / `identifier` to be populated.
 */
export interface SubjectRef {
  type: SubjectType;
  did?: string;
  uri?: string;
  name?: string;
  identifier?: string;
}

export type Sentiment = 'positive' | 'neutral' | 'negative';

export type DimensionValue = 'exceeded' | 'met' | 'below' | 'failed';

export interface DimensionRating {
  dimension: string;
  value: DimensionValue;
  note?: string;
}

export interface EvidenceItem {
  type: string;
  uri?: string;
  hash?: string;
  description?: string;
}

export type Confidence = 'certain' | 'high' | 'moderate' | 'speculative';

export interface Mention {
  did: string;
  role?: string;
}

export interface CoSignature {
  did: string;
  sig: string;
  sigCreatedAt: string;
}

export interface RelatedAttestation {
  uri: string;
  relation: string;
}

// ── Record types (one per com.dinakernel.peerlens.* lexicon) ────────────────

/** `com.dinakernel.peerlens.attestation` — a structured review of a subject. */
export interface Attestation {
  subject: SubjectRef;
  category: string;
  sentiment: Sentiment;
  dimensions?: DimensionRating[];
  text?: string;
  tags?: string[];
  domain?: string;
  interactionContext?: Record<string, unknown>;
  contentContext?: Record<string, unknown>;
  productContext?: Record<string, unknown>;
  evidence?: EvidenceItem[];
  confidence?: Confidence;
  isAgentGenerated?: boolean;
  coSignature?: CoSignature;
  mentions?: Mention[];
  relatedAttestations?: RelatedAttestation[];
  bilateralReview?: Record<string, unknown>;
  createdAt: string;
}

export type VouchConfidence = 'high' | 'moderate' | 'low';

/** `com.dinakernel.peerlens.vouch` — vouch for the identity/character of a DID. */
export interface Vouch {
  subject: string;
  vouchType: string;
  confidence: VouchConfidence;
  relationship?: string;
  knownSince?: string;
  text?: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.endorsement` — endorsement of a skill/competency. */
export interface Endorsement {
  subject: string;
  skill: string;
  endorsementType: string;
  relationship?: string;
  text?: string;
  createdAt: string;
}

export type FlagSeverity = 'critical' | 'serious' | 'warning' | 'informational';

/** `com.dinakernel.peerlens.flag` — flag a subject for problematic behaviour. */
export interface Flag {
  subject: SubjectRef;
  flagType: string;
  severity: FlagSeverity;
  text?: string;
  evidence?: EvidenceItem[];
  createdAt: string;
}

export type ReplyIntent =
  | 'agree'
  | 'disagree'
  | 'dispute'
  | 'correct'
  | 'clarify'
  | 'add-context'
  | 'thank';

/** `com.dinakernel.peerlens.reply` — reply to an attestation/flag. */
export interface Reply {
  rootUri: string;
  parentUri: string;
  intent: ReplyIntent;
  text: string;
  evidence?: EvidenceItem[];
  createdAt: string;
}

export type ReactionType =
  | 'helpful'
  | 'unhelpful'
  | 'agree'
  | 'disagree'
  | 'verified'
  | 'can-confirm'
  | 'suspicious'
  | 'outdated';

/** `com.dinakernel.peerlens.reaction` — lightweight reaction on a target record. */
export interface Reaction {
  targetUri: string;
  reaction: ReactionType;
  createdAt: string;
}

export type ReportType =
  | 'spam'
  | 'fake-review'
  | 'incentivized-undisclosed'
  | 'self-review'
  | 'competitor-attack'
  | 'harassment'
  | 'doxxing'
  | 'off-topic'
  | 'duplicate'
  | 'ai-generated-undisclosed'
  | 'defamation'
  | 'conflict-of-interest'
  | 'brigading';

/** `com.dinakernel.peerlens.reportRecord` — moderation report on a target record. */
export interface ReportRecord {
  targetUri: string;
  reportType: ReportType;
  text?: string;
  evidence?: EvidenceItem[];
  relatedRecords?: string[];
  createdAt: string;
}

/** `com.dinakernel.peerlens.revocation` — author-driven revocation of an earlier record. */
export interface Revocation {
  targetUri: string;
  reason: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.delegation` — author delegates a scope to another DID. */
export interface Delegation {
  subject: string;
  scope: string;
  permissions: string[];
  expiresAt?: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.collection` — curated group of records. */
export interface Collection {
  name: string;
  description?: string;
  items: string[];
  isDiscoverable: boolean;
  createdAt: string;
}

/** `com.dinakernel.peerlens.media` — media attachment to a parent record. */
export interface Media {
  parentUri: string;
  mediaType: string;
  url: string;
  alt?: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.subject` — first-class subject record. */
export interface SubjectRecord {
  name: string;
  subjectType: string;
  description?: string;
  identifiers?: Record<string, string>[];
  createdAt: string;
}

/** `com.dinakernel.peerlens.amendment` — corrective amendment to an earlier record. */
export interface Amendment {
  targetUri: string;
  amendmentType: string;
  text?: string;
  newValues?: Record<string, unknown>;
  createdAt: string;
}

export type VerificationResult = 'confirmed' | 'denied' | 'inconclusive';

/** `com.dinakernel.peerlens.verification` — verification of an earlier record. */
export interface Verification {
  targetUri: string;
  verificationType: string;
  evidence?: EvidenceItem[];
  result: VerificationResult;
  text?: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.reviewRequest` — request peers to review a subject. */
export interface ReviewRequest {
  subject: SubjectRef;
  requestType: string;
  text?: string;
  expiresAt?: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.comparison` — head-to-head comparison of subjects. */
export interface Comparison {
  subjects: SubjectRef[];
  category: string;
  dimensions?: DimensionRating[];
  text?: string;
  createdAt: string;
}

export type SubjectClaimType = 'same-entity' | 'related' | 'part-of';

/** `com.dinakernel.peerlens.subjectClaim` — claim about subject identity/relations. */
export interface SubjectClaim {
  sourceSubjectId: string;
  targetSubjectId: string;
  claimType: SubjectClaimType;
  evidence?: EvidenceItem[];
  text?: string;
  createdAt: string;
}

/** `com.dinakernel.peerlens.trustPolicy` — author's policy preferences for PeerLens rating. */
export interface PeerlensPolicy {
  maxGraphDepth?: number;
  trustedDomains?: string[];
  blockedDids?: string[];
  requireVouch?: boolean;
  createdAt: string;
}

/** `com.dinakernel.peerlens.notificationPrefs` — notification preferences for trust events. */
export interface NotificationPrefs {
  enableMentions: boolean;
  enableReactions: boolean;
  enableReplies: boolean;
  enableFlags: boolean;
  createdAt: string;
}

// ── NSIDs ───────────────────────────────────────────────────────────

/**
 * AT Protocol lexicon NSIDs for the `com.dinakernel.peerlens.*` record family.
 *
 * Must match the collections registered in AppView's ingester
 * (`appview/src/ingester/handlers/index.ts`). Records published
 * under any other NSID will not be indexed.
 */
export const PEERLENS_NSIDS = {
  attestation: 'com.dinakernel.peerlens.attestation',
  vouch: 'com.dinakernel.peerlens.vouch',
  endorsement: 'com.dinakernel.peerlens.endorsement',
  flag: 'com.dinakernel.peerlens.flag',
  reply: 'com.dinakernel.peerlens.reply',
  reaction: 'com.dinakernel.peerlens.reaction',
  reportRecord: 'com.dinakernel.peerlens.reportRecord',
  revocation: 'com.dinakernel.peerlens.revocation',
  delegation: 'com.dinakernel.peerlens.delegation',
  collection: 'com.dinakernel.peerlens.collection',
  media: 'com.dinakernel.peerlens.media',
  subject: 'com.dinakernel.peerlens.subject',
  amendment: 'com.dinakernel.peerlens.amendment',
  verification: 'com.dinakernel.peerlens.verification',
  reviewRequest: 'com.dinakernel.peerlens.reviewRequest',
  comparison: 'com.dinakernel.peerlens.comparison',
  subjectClaim: 'com.dinakernel.peerlens.subjectClaim',
  trustPolicy: 'com.dinakernel.peerlens.trustPolicy',
  notificationPrefs: 'com.dinakernel.peerlens.notificationPrefs',
} as const;

export type PeerlensNsid = (typeof PEERLENS_NSIDS)[keyof typeof PEERLENS_NSIDS];
