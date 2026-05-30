import { eq, ne, and } from 'drizzle-orm'
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

    // Phase 1: only index provider services with fully automatic response policies
    if (!record.isDiscoverable) {
      ctx.logger.debug({ uri: op.uri }, '[ServiceProfile] Skipping non-provider service')
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

    // Convention: at most one indexed profile per operator. An operator
    // who publishes multiple service.profile records (any rkey) sees
    // their latest one indexed; earlier rows by the same operator are
    // dropped from the index. The records still live on their PDS.
    //
    // Runs in a single transaction so a concurrent service-search read
    // never observes the "0 profiles" gap between the delete-others and
    // the upsert.
    //
    // Concurrency safety (the bug this replaced): the old path was
    // `delete(operatorDid)` + plain `insert(uri)` with NO ON CONFLICT,
    // relying on "the DELETE guarantees no row at this URI". That
    // guarantee is FALSE under concurrency — the ingester queue runs many
    // items in parallel and replays a spool of events for the SAME `self`
    // URI on every Jetstream reconnect. Two same-URI events interleave,
    // both delete, both insert, the second hits `services_pkey` →
    // duplicate_key → requeue storm → the row never lands. Fix: an
    // idempotent UPSERT on `uri`, plus deleting only the operator's OTHER
    // uris (so "at most one indexed profile per operator" still holds).
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

      // Drop the operator's OTHER profile rows (different rkey/uri) — NOT
      // the uri we're about to upsert, so the upsert owns it.
      await tx
        .delete(services)
        .where(and(eq(services.operatorDid, op.did), ne(services.uri, op.uri)))

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
