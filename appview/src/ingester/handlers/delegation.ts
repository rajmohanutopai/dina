import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Delegation } from '@/shared/types/lexicon-types.js'
import { delegations } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { addTrustEdge } from '../trust-edge-sync.js'

/**
 * Handler for com.dina.reputation.delegation records.
 *
 * A delegation grants scoped permissions from one DID to another —
 * "I allow this agent to act on my behalf within this scope."
 * Carries a high trust edge weight (0.9) because delegating authority
 * is a strong trust signal.
 */
export const delegationHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Delegation

    // Upsert the delegation record
    await ctx.db.insert(delegations).values({
      uri: op.uri,
      authorDid: op.did,
      cid: op.cid!,
      subjectDid: record.subject,
      scope: record.scope,
      permissionsJson: record.permissions,
      expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
      recordCreatedAt: new Date(record.createdAt),
    }).onConflictDoUpdate({
      target: delegations.uri,
      set: {
        cid: op.cid!,
        subjectDid: record.subject,
        scope: record.scope,
        permissionsJson: record.permissions,
        expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
        recordCreatedAt: new Date(record.createdAt),
        indexedAt: new Date(),
      },
    })

    // Add trust edge — delegation is a strong trust signal
    await addTrustEdge(ctx, {
      fromDid: op.did,
      toDid: record.subject,
      edgeType: 'delegation',
      domain: record.scope,
      weight: 0.9,
      sourceUri: op.uri,
      createdAt: new Date(record.createdAt),
    })

    ctx.metrics.incr('ingester.delegation.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'delegation', delegations)
    ctx.metrics.incr('ingester.delegation.deleted')
  },
}
