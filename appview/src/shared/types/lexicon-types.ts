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
  /**
   * `useCases` (TN-V2-REV-001) — optional free-text tags from a
   * per-category curated list on the writer side (e.g.
   * `['everyday', 'professional']` for tech, `['fiction']` for books).
   * Up to 3 entries. Closed-vocabulary discipline lives on the
   * writer; AppView treats each entry as an opaque ≤50-char tag and
   * indexes the array as a GIN-searchable column for use-case-aware
   * ranking (RANK-005 family). Empty/absent array means the
   * reviewer didn't declare a use case.
   */
  useCases?: string[]
  /**
   * `lastUsedMs` (TN-V2-REV-003) — optional ms-since-epoch when the
   * reviewer last interacted with the subject. Distinct from
   * `createdAt` (the *write* time): a review composed today may
   * describe a tool last used 18 months ago. Powers per-category
   * recency-decay tuning (RANK-006) without conflating "I just
   * wrote this" with "this is fresh experience". Integer ms — AT
   * Protocol forbids floats in CBOR records.
   */
  lastUsedMs?: number
  /**
   * `reviewerExperience` (TN-V2-REV-002) — self-declared expertise
   * with the subject's category. Closed enum: novice (just
   * starting), intermediate (regular use), expert (deep familiarity
   * — domain professional, long-term user). Powers RANK-008
   * expert-weighted ranking in technical categories ("show me what
   * developers say about this IDE"). Self-declared because external
   * verification doesn't scale — the social cost of misrepresenting
   * yourself to your trust network is the gate.
   */
  reviewerExperience?: 'novice' | 'intermediate' | 'expert'
  /**
   * `recommendFor` / `notRecommendFor` (TN-V2-REV-004) — optional
   * use-case tags from the same vocabulary as `useCases` (writer
   * side enforces closed vocabulary; AppView indexes opaque tags).
   * `recommendFor` flags use-cases the reviewer endorses; the
   * negative twin flags use-cases they explicitly warn against
   * ("good for everyday writing; not for calligraphy"). Disjoint
   * from `useCases`: that field describes *how the reviewer used
   * it*; these describe *who it's for / not for*. Cap each at 5 —
   * larger lists become noise. Empty/absent = no recommendation.
   */
  recommendFor?: string[]
  notRecommendFor?: string[]
  /**
   * `alternatives` (TN-V2-REV-005) — optional list of other
   * subjects the reviewer also tried. Powers the "the reviewer
   * also looked at X, Y" surface on the detail screen and Plan
   * §6.3's `conflict_chooser` (rendering "X said Aeron, Y said
   * Steelcase, both also tried Herman Miller Mirra"). Each entry
   * is a full `SubjectRef` so the reader can navigate to that
   * subject if it's also in the network. Cap 5 — larger lists
   * become noise (and the writer cap matches mobile REV-008's
   * `MAX_REVIEW_ALTERNATIVES`).
   */
  alternatives?: SubjectRef[]
  /**
   * `compliance` (TN-V2-META-005) — optional reviewer-declared
   * compliance tags (`halal`, `kosher`, `vegan`, `gluten-free`,
   * `fda-approved`, `ce-marked`, `age-18+`, …). Closed-vocabulary
   * discipline lives on writers; AppView indexes opaque tags so
   * the vocabulary can evolve without redeploying the ingester.
   * Cap 10 — broader than `useCases` (3) because compliance is
   * additive: one product can be halal AND vegan AND gluten-free
   * AND CE-marked simultaneously, and surfacing all of them is the
   * whole point. Subject-level merge across reviewers (when
   * eventually implemented in META-001's unified pipeline) takes
   * the union of these arrays.
   */
  compliance?: string[]
  /**
   * `accessibility` (TN-V2-META-006) — optional reviewer-declared
   * accessibility tags (`wheelchair`, `captions`, `screen-reader`,
   * `color-blind-safe`, `audio-described`, `quiet-hours`, …).
   * Same opaque-tag treatment as `compliance`; same cap of 10
   * because accessibility tags are additive (a venue can be
   * wheelchair-accessible AND have captions AND audio-described).
   */
  accessibility?: string[]
  /**
   * `compat` (TN-V2-META-003) — optional reviewer-declared
   * compatibility tags (`ios`, `android`, `macos`, `windows`,
   * `usb-c`, `lightning`, `110v`, `240v`, `bluetooth-5`, …).
   * Closed-vocabulary list lives on the writer side and expands
   * by deliberate enrichment; AppView treats each entry as an
   * opaque ≤50-char tag for indexing. Cap 15 — broader than
   * `compliance` / `accessibility` (10) because devices can have
   * many compatibility surfaces simultaneously (a laptop:
   * macos + thunderbolt-4 + usb-c + bluetooth-5 + wifi-6e + … —
   * the ceiling needs to accommodate enthusiast hardware that
   * legitimately checks many boxes).
   */
  compat?: string[]
  /**
   * `price` (TN-V2-META-002) — optional reviewer-declared price
   * range. Coords are E7-scaled integers (`low_e7 = round(price *
   * 1e7)`) — same CBOR-int convention as `serviceArea.latE7/lngE7`
   * because AT Protocol records forbid floats. `currency` is ISO
   * 4217 alpha-3 (e.g. `'USD'`, `'EUR'`, `'GBP'`). `lastSeenMs` is
   * when the reviewer observed the price (distinct from the
   * review's `createdAt` because a price observed today might be
   * recorded in a review next month). Powers RANK-002's priceRange
   * filter via the e7 columns. The OpenGraph price extractor
   * (META-009) auto-fills this when the reviewer hasn't declared.
   */
  price?: {
    low_e7: number
    high_e7: number
    currency: string
    lastSeenMs: number
  }
  /**
   * `availability` (TN-V2-META-001) — optional reviewer-declared
   * availability triple:
   *   - `regions`: ISO 3166-1 alpha-2 country codes where the
   *     subject is *available* / sold (e.g. `['US', 'GB']`).
   *   - `shipsTo`: ISO codes the seller ships to (a superset of
   *     `regions` for global retailers; a subset for region-locked
   *     goods).
   *   - `soldAt`: hostnames of retailers that carry it
   *     (`['amazon.com', 'walmart.com']`). Hostname-shape, not URL —
   *     the detail page builds links lazily.
   *
   * Each sub-field independently optional — a reviewer might only
   * know "this is sold in the US" without knowing the shipping or
   * retailer set. AppView indexes each as its own GIN-overlap
   * column so RANK-001 (regions filter) and the future "ships to
   * X" / "sold at Y" filters can ride dedicated indexes. The
   * `host_to_region` enricher (META-007) auto-fills `regions` from
   * the subject's URL TLD when the reviewer hasn't declared,
   * mirroring the META-009 OpenGraph price fallback pattern.
   */
  availability?: {
    regions?: string[]
    shipsTo?: string[]
    soldAt?: string[]
  }
  /**
   * `schedule` (TN-V2-META-004) — optional reviewer-declared
   * schedule for `place` / `service` subjects:
   *   - `hours`: 7-day open/close map keyed by lowercase
   *     three-letter day code (`mon`/`tue`/.../`sun`). Each entry
   *     is `{ open: 'HH:MM', close: 'HH:MM' }` (24-hour, 5-char
   *     fixed-width). Days the venue is closed are simply absent.
   *   - `leadDays`: integer days of advance booking required (0
   *     for walk-ins; 14 for a doctor; 365 for a wedding venue).
   *   - `seasonal`: months (1-12) the venue operates. Empty/absent
   *     means year-round; partial means closed in the others.
   *
   * Heterogeneous shape (object + scalar + array) so persisted as
   * a single JSONB blob — no individual sub-field has a search
   * predicate that would benefit from a dedicated column. The
   * META-010 JSON-LD `OpeningHours` parser auto-fills `hours`
   * when the reviewer hasn't declared.
   */
  schedule?: {
    hours?: Record<string, { open: string; close: string }>
    leadDays?: number
    seasonal?: number[]
  }
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
