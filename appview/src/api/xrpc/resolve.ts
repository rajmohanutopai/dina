import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { subjectScores, didProfiles, flags } from '@/db/schema/index.js'
import { computeGraphContext } from '@/db/queries/graph.js'
import { resolveSubject } from '@/db/queries/subjects.js'
import { computeRecommendation } from '@/scorer/algorithms/recommendation.js'
import { withSWR, resolveKey, CACHE_TTLS } from '../middleware/swr-cache.js'
import type { ResolveResponse, GraphContext } from '@/shared/types/api-types.js'

export const ResolveParams = z.object({
  subject: z.string().max(4096),
  requesterDid: z.string().optional(),
  domain: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional(),
  context: z.enum([
    'before-transaction', 'before-interaction',
    'content-verification', 'product-evaluation', 'general-lookup',
  ]).optional(),
})

export type ResolveParamsType = z.infer<typeof ResolveParams>

export async function resolve(
  db: DrizzleDB,
  params: ResolveParamsType,
): Promise<ResolveResponse> {
  const { subject: subjectJson, requesterDid, domain, context } = params

  const cacheKey = resolveKey(subjectJson, requesterDid, domain, context)

  return withSWR(cacheKey, CACHE_TTLS.RESOLVE, async () => {
    return computeResolveResponse(db, subjectJson, requesterDid, domain, context)
  })
}

async function computeResolveResponse(
  db: DrizzleDB,
  subjectJson: string,
  requesterDid?: string,
  domain?: string,
  context?: string,
): Promise<ResolveResponse> {
  let subjectRef: any
  try {
    subjectRef = JSON.parse(subjectJson)
  } catch {
    return {
      // TN-API-003 fields — null on parse failure (subject can't be resolved):
      subjectId: null,
      reviewCount: 0,
      lastAttestedAt: null,
      // Legacy fields:
      subjectType: 'unknown',
      trustLevel: 'none',
      confidence: 0,
      attestationSummary: null,
      flags: [],
      authenticity: null,
      graphContext: null,
      recommendation: 'error',
      reasoning: 'Invalid subject JSON',
    }
  }

  const subjectId = await resolveSubject(db, subjectRef)

  const scores = subjectId
    ? await db.select().from(subjectScores)
        .where(eq(subjectScores.subjectId, subjectId))
        .limit(1).then(r => r[0] ?? null)
    : null

  let didProfile = null
  if (subjectRef.type === 'did' && subjectRef.did) {
    didProfile = await db.select().from(didProfiles)
      .where(eq(didProfiles.did, subjectRef.did))
      .limit(1).then(r => r[0] ?? null)
  }

  const activeFlags = subjectId
    ? await db.select().from(flags)
        .where(and(eq(flags.subjectId, subjectId), eq(flags.isActive, true)))
        .limit(10)
    : []

  let graphContext: GraphContext | null = null
  if (requesterDid && subjectRef.type === 'did' && subjectRef.did) {
    const graph = await computeGraphContext(db, requesterDid)
    const targetNode = graph.nodes.find(n => n.did === subjectRef.did)
    graphContext = {
      shortestPath: targetNode?.depth ?? null,
      mutualConnections: null,
      trustedAttestors: [],
    }
  }

  let authenticity = null
  if (scores?.authenticityConsensus) {
    authenticity = {
      predominantAssessment: scores.authenticityConsensus,
      confidence: scores.authenticityConfidence,
    }
  }

  const rec = computeRecommendation({
    scores, didProfile, flags: activeFlags.map(f => ({
      flagType: f.flagType, severity: f.severity,
    })),
    graphContext, authenticity, context, domain,
  })

  return {
    // TN-API-003 / Plan §6.3 fields:
    //   - `subjectId` is the canonical resolved ID (or null when the
    //     SubjectRef doesn't yet exist in the index)
    //   - `reviewCount` is total attestations as seen by the scorer
    //     (0 when subjectId is null OR when the row hasn't been
    //     scored yet — `subjectScores` may be absent if the scorer
    //     hasn't ticked since the first attestation landed)
    //   - `lastAttestedAt` is `subject_scores.last_attestation_at`,
    //     populated by `refresh-subject-scores`. Null when the row
    //     hasn't been scored OR has no attestations.
    //   - `conflicts` is intentionally omitted — V1 doesn't perform
    //     fuzzy/same-as merging (Plan §13.10), so a single resolution
    //     always wins. V2 fills this when the merge resolver lands.
    subjectId,
    reviewCount: scores?.totalAttestations ?? 0,
    lastAttestedAt: scores?.lastAttestationAt
      ? scores.lastAttestationAt.toISOString()
      : null,

    // Legacy trust-decision fields (kept verbatim):
    subjectType: subjectRef.type,
    trustLevel: rec.trustLevel,
    confidence: rec.confidence,
    attestationSummary: scores ? {
      total: scores.totalAttestations ?? 0,
      positive: scores.positive ?? 0,
      neutral: scores.neutral ?? 0,
      negative: scores.negative ?? 0,
      averageDimensions: scores.dimensionSummaryJson,
    } : null,
    flags: activeFlags.map(f => ({ flagType: f.flagType, severity: f.severity })),
    authenticity,
    graphContext,
    recommendation: rec.action,
    reasoning: rec.reasoning,
  }
}
