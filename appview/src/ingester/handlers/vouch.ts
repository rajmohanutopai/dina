import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Vouch } from '@/shared/types/lexicon-types.js'
import { vouches } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { addTrustEdge } from '../trust-edge-sync.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.trust.vouch records.
 *
 * A vouch is a trust signal from one DID to another — "I trust this person."
 * The trust edge weight is derived from the confidence level.
 */

function confidenceToWeight(confidence: string): number {
  switch (confidence) {
    case 'high': return 1.0
    case 'moderate': return 0.6
    case 'low': return 0.3
    default: return 0.3
  }
}

export const vouchHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Vouch

    // Upsert the vouch record
    await ctx.db.insert(vouches).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      subjectDid: record.subject,
      vouchType: record.vouchType,
      confidence: record.confidence,
      relationship: record.relationship ?? null,
      knownSince: record.knownSince ?? null,
      text: record.text ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: vouches.uri,
      set: {
        cid: op.cid!,
        subjectDid: record.subject,
        vouchType: record.vouchType,
        confidence: record.confidence,
        relationship: record.relationship ?? null,
        knownSince: record.knownSince ?? null,
        text: record.text ?? null,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    // Add trust edge weighted by confidence
    await addTrustEdge(ctx, {
      fromDid: op.did,
      toDid: record.subject,
      edgeType: 'vouch',
      domain: null,
      weight: confidenceToWeight(record.confidence),
      sourceUri: op.uri,
      createdAt: new Date(record.createdAt),
    })

    // Mark affected entities for score recalculation
    await markDirty(ctx.db, {
      subjectId: null,
      authorDid: op.did,
      subjectDid: record.subject,
    })

    ctx.metrics.incr('ingester.vouch.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'vouch', vouches)
    ctx.metrics.incr('ingester.vouch.deleted')
  },
}
