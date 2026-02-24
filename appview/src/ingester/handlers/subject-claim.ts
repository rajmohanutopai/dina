import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { SubjectClaim } from '@/shared/types/lexicon-types.js'
import { subjectClaims } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.reputation.subjectClaim records.
 *
 * Subject claims assert relationships between subject entities:
 * - same-entity: two subject IDs refer to the same real-world entity
 * - related: the subjects are related but distinct
 * - part-of: one subject is a component of the other
 *
 * These claims feed into the subject merge/linking system.
 */
export const subjectClaimHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as SubjectClaim

    await ctx.db.insert(subjectClaims).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      sourceSubjectId: record.sourceSubjectId,
      targetSubjectId: record.targetSubjectId,
      claimType: record.claimType,
      evidenceJson: record.evidence ?? null,
      text: record.text ?? null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: subjectClaims.uri,
      set: {
        cid: op.cid!,
        sourceSubjectId: record.sourceSubjectId,
        targetSubjectId: record.targetSubjectId,
        claimType: record.claimType,
        evidenceJson: record.evidence ?? null,
        text: record.text ?? null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    ctx.metrics.incr('ingester.subjectClaim.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'subjectClaim', subjectClaims)
    ctx.metrics.incr('ingester.subjectClaim.deleted')
  },
}
