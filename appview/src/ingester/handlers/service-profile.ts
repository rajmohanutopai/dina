import { eq } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { ServiceProfile } from '@/shared/types/lexicon-types.js'
import { services } from '@/db/schema/index.js'

/**
 * Handler for com.dina.service.profile records.
 *
 * Service profiles allow operators (e.g., bus drivers, plumbers) to publish
 * discoverable service descriptions via AT Protocol. The AppView ingests
 * these records, indexes them, and exposes search/lookup endpoints.
 *
 * Phase 1 constraints:
 * - Only public services are indexed (isPublic must be true)
 * - All responsePolicy values must be "auto" (no manual approval flows yet)
 * - DID binding: op.did IS the operator (author == operator)
 */
export const serviceProfileHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as ServiceProfile

    // Phase 1: only index public services with fully automatic response policies
    if (!record.isPublic) {
      ctx.logger.debug({ uri: op.uri }, '[ServiceProfile] Skipping non-public service')
      return
    }

    const policyValues = Object.values(record.responsePolicy)
    if (policyValues.length > 0 && !policyValues.every(v => v === 'auto')) {
      ctx.logger.debug({ uri: op.uri }, '[ServiceProfile] Skipping service with non-auto response policy')
      return
    }

    // Build search content from name + description + capabilities
    const searchParts: string[] = []
    searchParts.push(record.name)
    if (record.description) searchParts.push(record.description)
    if (record.capabilities) searchParts.push(...record.capabilities)
    const searchContent = searchParts.join(' ').slice(0, 10_000) || null

    // One profile per DID: delete any existing records for this operator before inserting.
    await ctx.db.delete(services).where(eq(services.operatorDid, op.did))

    // Upsert the service record
    await ctx.db.insert(services).values({
      uri: op.uri,
      operatorDid: op.did,
      cid: op.cid!,
      name: record.name,
      description: record.description ?? null,
      capabilitiesJson: record.capabilities,
      lat: record.serviceArea?.lat?.toString() ?? null,
      lng: record.serviceArea?.lng?.toString() ?? null,
      radiusKm: record.serviceArea?.radiusKm?.toString() ?? null,
      hoursJson: record.hours ?? null,
      responsePolicyJson: record.responsePolicy,
      isPublic: record.isPublic,
      searchContent,
    }).onConflictDoUpdate({
      target: services.uri,
      set: {
        cid: op.cid!,
        name: record.name,
        description: record.description ?? null,
        capabilitiesJson: record.capabilities,
        lat: record.serviceArea?.lat?.toString() ?? null,
        lng: record.serviceArea?.lng?.toString() ?? null,
        radiusKm: record.serviceArea?.radiusKm?.toString() ?? null,
        hoursJson: record.hours ?? null,
        responsePolicyJson: record.responsePolicy,
        isPublic: record.isPublic,
        searchContent,
        indexedAt: new Date(),
      },
    })

    ctx.metrics.incr('ingester.service_profile.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await ctx.db.delete(services).where(eq(services.uri, op.uri))
    ctx.metrics.incr('ingester.service_profile.deleted')
  },
}
