import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { ReviewRequest } from '@/shared/types/lexicon-types.js'
import { reviewRequests } from '@/db/schema/index.js'
import { resolveOrCreateSubject } from '@/db/queries/subjects.js'
import { deletionHandler } from '../deletion-handler.js'

/**
 * Handler for com.dina.trust.reviewRequest records.
 *
 * Review requests ask the community to provide attestations about a
 * specific subject. The handler resolves (or creates) the subject entity
 * before upserting the request record.
 */
export const reviewRequestHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as ReviewRequest

    // Resolve or create the subject entity
    const subjectId = await resolveOrCreateSubject(ctx.db, record.subject, op.did)

    // Upsert the review request
    await ctx.db.insert(reviewRequests).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      subjectId,
      subjectRefRaw: record.subject,
      requestType: record.requestType,
      text: record.text ?? null,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: reviewRequests.uri,
      set: {
        cid: op.cid!,
        subjectId,
        subjectRefRaw: record.subject,
        requestType: record.requestType,
        text: record.text ?? null,
        expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
        recordCreatedAt: new Date(record.createdAt),
      },
    })

    ctx.metrics.incr('ingester.reviewRequest.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'reviewRequest', reviewRequests)
    ctx.metrics.incr('ingester.reviewRequest.deleted')
  },
}
