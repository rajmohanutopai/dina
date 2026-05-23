import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { Endorsement } from '@/shared/types/lexicon-types.js'
import type { DrizzleDB } from '@/db/connection.js'
import { endorsements } from '@/db/schema/index.js'
import { deletionHandler } from '../deletion-handler.js'
import { addTrustEdge } from '../peerlens-edge-sync.js'
import { markDirty } from '@/db/queries/dirty-flags.js'

/**
 * Handler for com.dina.peerlens.endorsement records.
 *
 * An endorsement is a skill-specific trust signal — "This person is good at X."
 * The trust edge weight is higher for first-hand experience (worked-together).
 */

function endorsementTypeToWeight(endorsementType: string): number {
  switch (endorsementType) {
    case 'worked-together': return 0.8
    default: return 0.4
  }
}

export const endorsementHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as Endorsement

    // Pseudonymous-namespace fragment (TN-DB-012). Symmetric with
    // attestations — endorsements published under a non-root namespace
    // stay accountable to that compartment.
    const namespace = record.namespace ?? null

    // Wrap the three writes (endorsement upsert, trust edge, dirty
    // flag) in one transaction so a process crash mid-flow can't
    // leave an endorsement without its skill-scoped trust edge.
    await ctx.db.transaction(async (tx) => {
      const txDb = tx as unknown as DrizzleDB

      await tx.insert(endorsements).values({
        uri: op.uri,
        authorDid: op.did,
        cid: op.cid!,
        subjectDid: record.subject,
        skill: record.skill,
        endorsementType: record.endorsementType,
        relationship: record.relationship ?? null,
        text: record.text ?? null,
        namespace,
        recordCreatedAt: new Date(record.createdAt),
      }).onConflictDoUpdate({
        target: endorsements.uri,
        set: {
          cid: op.cid!,
          subjectDid: record.subject,
          skill: record.skill,
          endorsementType: record.endorsementType,
          relationship: record.relationship ?? null,
          text: record.text ?? null,
          namespace,
          recordCreatedAt: new Date(record.createdAt),
          indexedAt: new Date(),
        },
      })

      // Add trust edge with domain = skill.
      await addTrustEdge(
        { ...ctx, db: txDb },
        {
          fromDid: op.did,
          toDid: record.subject,
          edgeType: 'endorsement',
          domain: record.skill,
          weight: endorsementTypeToWeight(record.endorsementType),
          sourceUri: op.uri,
          createdAt: new Date(record.createdAt),
        },
      )

      await markDirty(txDb, {
        subjectId: null,
        authorDid: op.did,
        subjectDid: record.subject,
      })
    })

    ctx.metrics.incr('ingester.endorsement.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await deletionHandler.process(ctx.db, op.uri, op.did, 'endorsement', endorsements)
    ctx.metrics.incr('ingester.endorsement.deleted')
  },
}
