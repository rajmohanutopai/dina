import { eq } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { ServiceProfile } from '@/shared/types/lexicon-types.js'
import { services } from '@/db/schema/index.js'
import { canonicalizeForIndex } from '@/shared/capability-registry.js'

/**
 * Handler for com.dina.service.profile records.
 *
 * Service profiles allow operators (e.g., bus drivers, plumbers) to publish
 * discoverable service descriptions via AT Protocol. The AppView ingests
 * these records, indexes them, and exposes search/lookup endpoints.
 *
 * Phase 1 constraints:
 * - Only provider services are indexed (isDiscoverable must be true)
 * - All responsePolicy values must be "auto" (no manual approval flows yet)
 * - DID binding: op.did IS the operator (author == operator)
 */
export const serviceProfileHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as ServiceProfile

    // A provider can UNPUBLISH a listing by re-publishing the same record with
    // isDiscoverable=false. We must remove any existing indexed row for this
    // uri — a bare `return` would leave the prior discoverable row alive, so
    // the service would still surface in search after the provider unpublished
    // it. Idempotent: deleting a non-existent uri is a no-op.
    if (!record.isDiscoverable) {
      await ctx.db.delete(services).where(eq(services.uri, op.uri))
      ctx.logger.debug(
        { uri: op.uri },
        '[ServiceProfile] non-discoverable — removed any existing indexed row (unpublish)',
      )
      ctx.metrics.incr('ingester.service_profile.unpublished')
      return
    }

    // Lexicon enforces the closed `{auto, review}` enum at validation
    // time. Belt-and-braces runtime gate here covers any future code
    // path that calls the handler without going through the lexicon
    // validator (tests, scripted reindex, etc.) so a stray policy
    // value can't sneak into the index.
    const SUPPORTED_POLICIES = new Set(['auto', 'review'])
    if (
      Object.values(record.responsePolicy).some((v) => !SUPPORTED_POLICIES.has(v))
    ) {
      ctx.logger.debug(
        { uri: op.uri },
        '[ServiceProfile] Skipping service with unsupported response policy',
      )
      return
    }

    // Canonicalize capabilities at the index layer (SERVICES_LAUNCH_
    // ARCHITECTURE.md Part 1, Layer 2). Each published capability →
    // its canonical name; the capabilitySchemas + responsePolicy maps
    // are re-keyed to match (P1b — so a search matching the canonical
    // capability also finds its schema/hash, not a null keyed under the
    // alias). Unknown capabilities are dropped from the PUBLIC arrays
    // and metered (P2) — this does NOT flip row-level `isDiscoverable`,
    // so a profile with one known + one unknown capability stays
    // discoverable for the known one. The same `resolveCanonicalCapability`
    // runs in `service-search.ts`; both import the one shared registry.
    const canon = canonicalizeForIndex(
      record.capabilities,
      record.capabilitySchemas,
      record.responsePolicy,
    )
    const normalizedCapabilities = canon.capabilities
    for (const unknown of canon.unknown) {
      ctx.metrics.incr('service.capability.unknown', { cap: unknown })
      ctx.logger.debug(
        { uri: op.uri, cap: unknown },
        '[ServiceProfile] dropping unknown capability from public index',
      )
    }

    // Build search content from name + description + (canonical)
    // capabilities. Used by the ILIKE text-score branch in search.
    const searchParts: string[] = []
    searchParts.push(record.name)
    if (record.description) searchParts.push(record.description)
    if (normalizedCapabilities.length > 0) searchParts.push(...normalizedCapabilities)
    const searchContent = searchParts.join(' ').slice(0, 10_000) || null

    // Convert E7-scaled integer coords back to floats for Postgres.
    // Lexicon stores latE7/lngE7 because atproto records can't carry
    // floats; search/ranking math needs real degrees.
    const area = record.serviceArea
    const latFloat = area?.latE7 != null ? (area.latE7 / 1e7).toString() : null
    const lngFloat = area?.lngE7 != null ? (area.lngE7 / 1e7).toString() : null
    const radiusKm = area?.radiusKm != null ? area.radiusKm.toString() : null

    // ONE INDEXED ROW PER `uri` (per published profile record), NOT per
    // operator. A provider may publish many independent listings under the
    // same DID — each service.profile record (its own rkey -> its own uri)
    // is its own discoverable row. This is the marketplace model: a seller
    // with ten products lists ten profiles. A listing is removed by deleting
    // its record (-> handleDelete), never by publishing a sibling.
    //
    // Concurrency safety (the bug this replaced): the old path was
    // `delete(operatorDid)` + plain `insert(uri)` with NO ON CONFLICT,
    // relying on "the DELETE guarantees no row at this URI". That
    // guarantee is FALSE under concurrency — the ingester queue runs many
    // items in parallel and replays a spool of events for the SAME uri on
    // every Jetstream reconnect. Two same-uri events interleave, both
    // insert, the second hits `services_pkey` duplicate_key -> requeue
    // storm -> the row never lands. Fix: an idempotent UPSERT on `uri`. We
    // do NOT delete the operator's other uris (that would cap them at one
    // listing); each uri is independent.
    const now = new Date()
    await ctx.db.transaction(async (tx) => {
      // Preserve `createdAt` across re-publishes of the SAME uri. Capture
      // it from the existing row (if any) so the upsert's createdAt is
      // correct on first insert; on conflict we deliberately do not
      // overwrite it (see the `set` block — createdAt is omitted).
      const prior = await tx
        .select({ createdAt: services.createdAt })
        .from(services)
        .where(eq(services.uri, op.uri))
        .limit(1)
      const createdAt = prior[0]?.createdAt ?? now

      const values = {
        uri: op.uri,
        operatorDid: op.did,
        cid: op.cid!,
        name: record.name,
        description: record.description ?? null,
        capabilitiesJson: normalizedCapabilities,
        lat: latFloat,
        lng: lngFloat,
        radiusKm,
        hoursJson: record.hours ?? null,
        // P1b: store the canonical-re-keyed maps, NOT the raw published
        // ones, so all three public fields (array + schemas + policy)
        // agree on the canonical capability names. `responsePolicy` is
        // always an object; `capabilitySchemas` is `{}` when the provider
        // published none — store `null` in that case to preserve the
        // "no schemas" wire shape (search treats `{}` and `null` the same,
        // but `null` matches the prior column convention).
        responsePolicyJson: canon.responsePolicy,
        capabilitySchemasJson:
          Object.keys(canon.capabilitySchemas).length > 0 ? canon.capabilitySchemas : null,
        isDiscoverable: record.isDiscoverable,
        searchContent,
        createdAt,
        // `updatedAt` mirrors the operator-stamped `record.updatedAt`
        // (lexicon-required ISO timestamp) — the source of truth for "when
        // did the operator last touch this profile", independent of when
        // AppView ingested. Falls back to `now` for malformed records.
        updatedAt: record.updatedAt ? new Date(record.updatedAt) : now,
        // `indexedAt` is the AppView-side write time. Always = `now`.
        indexedAt: now,
      }

      await tx
        .insert(services)
        .values(values)
        .onConflictDoUpdate({
          target: services.uri,
          // Overwrite everything EXCEPT createdAt (preserve the original).
          set: {
            operatorDid: values.operatorDid,
            cid: values.cid,
            name: values.name,
            description: values.description,
            capabilitiesJson: values.capabilitiesJson,
            lat: values.lat,
            lng: values.lng,
            radiusKm: values.radiusKm,
            hoursJson: values.hoursJson,
            responsePolicyJson: values.responsePolicyJson,
            capabilitySchemasJson: values.capabilitySchemasJson,
            isDiscoverable: values.isDiscoverable,
            searchContent: values.searchContent,
            updatedAt: values.updatedAt,
            indexedAt: values.indexedAt,
          },
        })
    })

    ctx.metrics.incr('ingester.service_profile.created')
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    await ctx.db.delete(services).where(eq(services.uri, op.uri))
    ctx.metrics.incr('ingester.service_profile.deleted')
  },
}
