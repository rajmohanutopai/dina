/** Response from com.dina.trust.resolve */
export interface ResolveResponse {
  // ── TN-API-003 / Plan §6.3 fields ──────────────────────────────
  // Used by the mobile compose flow to preview the canonical match
  // before publish (see Plan §6.3). When `subjectId` is null the
  // subject doesn't yet exist in the index — caller renders a
  // "Creating new subject" inline notice; if `conflicts` is set,
  // caller renders a chooser between candidates.
  /** Canonical subject ID, or null if the subject doesn't yet exist. */
  subjectId: string | null
  /** Total attestations for the canonical subject; 0 when subjectId is null. */
  reviewCount: number
  /** ISO datetime of the most recent attestation; null when no attestations. */
  lastAttestedAt: string | null
  /**
   * Populated when ≥ 2 candidates match the SubjectRef heuristically.
   * Mobile UI shows a chooser. V1 omits this field (returned as
   * undefined) — same-as merges don't run yet (Plan §13.10), so a
   * single resolution always wins. V2 will populate this when the
   * fuzzy-match resolver lands.
   */
  conflicts?: Array<{
    subjectId: string
    subject: unknown
    reviewCount: number
  }>

  // ── Legacy trust-decision fields (pre-Plan §6.3) ───────────────
  // Used by transaction / interaction / content-verification flows
  // (see ResolveParams.context). These predate the V1 plan; we keep
  // them so existing callers don't break.
  subjectType: string
  trustLevel: string
  confidence: number
  attestationSummary: {
    total: number
    positive: number
    neutral: number
    negative: number
    averageDimensions: unknown
  } | null
  flags: { flagType: string; severity: string }[]
  authenticity: {
    predominantAssessment: string
    confidence: number | null
  } | null
  graphContext: GraphContext | null
  recommendation: string
  reasoning: string
}

export interface GraphContext {
  shortestPath: number | null
  mutualConnections: number | null
  trustedAttestors: string[]
}

/** Response from com.dina.trust.search */
export interface SearchResponse {
  results: unknown[]
  cursor?: string
  totalEstimate: number | null
}

/** Response from com.dina.trust.getProfile */
export interface GetProfileResponse {
  did: string
  /**
   * Display handle (`alsoKnownAs[0]` minus `at://` from PLC). `null`
   * when AppView hasn't backfilled the handle for this DID yet, or
   * when the DID's PLC doc has no published handle.
   */
  handle: string | null
  overallTrustScore: number | null
  attestationSummary: {
    total: number
    positive: number
    neutral: number
    negative: number
  }
  vouchCount: number
  endorsementCount: number
  reviewerStats: {
    totalAttestationsBy: number
    corroborationRate: number
    evidenceRate: number
    helpfulRatio: number
  }
  activeDomains: string[]
  lastActive: string | null
}

/** Graph visualization response */
export interface GraphNode {
  did: string
  depth: number
}

export interface GraphEdge {
  from: string
  to: string
  type: string
  weight: number
}

export interface GetGraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
