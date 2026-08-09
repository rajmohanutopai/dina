import { eq } from 'drizzle-orm'

import { commerceProductRelationships, commerceRelationshipClaims } from '@/db/schema/index.js'
import { productKey } from '@/shared/commerce/catalog-projection.js'
import {
  claimConfidenceBp,
  projectRelationships,
  type EdgeSource,
  type RelationshipClaimShape,
} from '@/shared/commerce/relationship-projection.js'

import type { HandlerContext, RecordHandler, RecordOp } from './index.js'

/**
 * Jetstream handler for `com.dinakernel.commerce.relationshipClaim` (§10.7).
 *
 * STORE THE CLAIM, THEN DERIVE THE EDGES FOR ITS SUBJECT. Not "update the edge
 * in place": a dispute has to be able to DISAPPEAR when the claim that caused
 * it is withdrawn, and an edge mutated in place cannot un-dispute itself
 * without re-reading the claims anyway. Deriving from the claim table is the
 * only version of this that survives a deletion.
 *
 * WHO IS A FIRST PARTY. The publishing repo. A supplier saying "my CHAIR-2 is
 * a variant of my CHAIR-1" is first-party; the same claim in a rival's repo is
 * third-party, and the rival cannot promote it by saying so. `source` is
 * therefore derived from `op.did` against the claim's issuer rather than read
 * from the record — a self-declared trust level is not evidence.
 */

function objectKeyOf(object: RelationshipClaimShape['object']): string {
  return 'did' in object ? `did:${object.did}` : productKey(object)
}

/** An inference must SAY it is one, and name its model version (§10.7). */
function readSource(record: Record<string, unknown>, repoDid: string, issuerDid: string): EdgeSource {
  if (record.inference_version !== undefined) return 'inferred'
  return repoDid === issuerDid ? 'first_party_claim' : 'third_party_claim'
}

/**
 * Rebuild every edge whose subject this claim touches.
 *
 * Scoped to ONE subject rather than the whole graph: relationships are keyed
 * by subject, so no other subject's edges can change because of this claim,
 * and rebuilding the world on every record would make ingest quadratic.
 */
async function rebuildSubject(ctx: HandlerContext, subjectKey: string): Promise<void> {
  const rows = await ctx.db
    .select()
    .from(commerceRelationshipClaims)
    .where(eq(commerceRelationshipClaims.subjectKey, subjectKey))

  const { edges } = projectRelationships(
    rows.map((row) => ({
      claim: row.claimJson as RelationshipClaimShape,
      source: row.source as EdgeSource,
      confidenceBp: row.confidenceBp,
      assertedAt: row.assertedAt,
      ...(row.inferenceVersion === null ? {} : { inferenceVersion: row.inferenceVersion }),
    })),
  )

  await ctx.db.transaction(async (tx) => {
    // Replace, never merge: an edge that no surviving claim supports must go,
    // and a partial update would leave it behind looking believed.
    await tx
      .delete(commerceProductRelationships)
      .where(eq(commerceProductRelationships.subjectKey, subjectKey))
    if (edges.length > 0) {
      await tx.insert(commerceProductRelationships).values(
        edges.map((edge) => ({
          edgeKey: edge.edgeKey,
          subjectKey: edge.subjectKey,
          relationship: edge.relationship,
          objectKey: edge.objectKey,
          confidenceBp: edge.confidenceBp,
          disputed: edge.disputed,
          evidenceJson: edge.evidence,
        })),
      )
    }
  })
}

export const commerceRelationshipClaimHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record ?? {}
    const claim = record as unknown as RelationshipClaimShape
    const source = readSource(record, op.did, claim.issuer_did)
    const declared = record.confidence_bp
    const subjectKey = productKey(claim.subject)

    await ctx.db
      .insert(commerceRelationshipClaims)
      .values({
        uri: op.uri,
        claimId: claim.claim_id,
        issuerDid: claim.issuer_did,
        subjectKey,
        relationship: claim.relationship,
        objectKey: objectKeyOf(claim.object),
        source,
        confidenceBp: claimConfidenceBp(
          source,
          typeof declared === 'number' ? declared : undefined,
        ),
        inferenceVersion:
          typeof record.inference_version === 'string' ? record.inference_version : null,
        claimJson: claim,
        assertedAt:
          typeof record.asserted_at === 'string' ? record.asserted_at : claim.effective_from ?? '',
      })
      .onConflictDoUpdate({
        target: commerceRelationshipClaims.uri,
        set: {
          claimId: claim.claim_id,
          relationship: claim.relationship,
          objectKey: objectKeyOf(claim.object),
          source,
          confidenceBp: claimConfidenceBp(
            source,
            typeof declared === 'number' ? declared : undefined,
          ),
          claimJson: claim,
        },
      })

    await rebuildSubject(ctx, subjectKey)
    ctx.metrics.incr('ingester.commerce_relationship.claimed')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // Withdrawing a claim must be able to un-dispute an edge, which is the
    // whole reason edges are derived rather than mutated.
    const rows = await ctx.db
      .select()
      .from(commerceRelationshipClaims)
      .where(eq(commerceRelationshipClaims.uri, op.uri))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return
    await ctx.db.delete(commerceRelationshipClaims).where(eq(commerceRelationshipClaims.uri, op.uri))
    await rebuildSubject(ctx, row.subjectKey)
    ctx.metrics.incr('ingester.commerce_relationship.withdrawn')
  },
}
