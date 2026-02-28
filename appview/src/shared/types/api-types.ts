/** Response from com.dina.trust.resolve */
export interface ResolveResponse {
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
