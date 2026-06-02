import { eq } from 'drizzle-orm'
import type { RecordHandler, HandlerContext, RecordOp } from './index.js'
import type { ServiceProfile } from '@/shared/types/lexicon-types.js'
import { services } from '@/db/schema/index.js'
import {
  allowedCategoriesForCapability,
  canonicalizeForIndex,
  resolveSearchableCapability,
} from '@/shared/capability-registry.js'

/**
 * Handler for com.dinakernel.service.profile records.
 *
 * Service profiles allow operators (e.g., bus drivers, plumbers) to publish
 * discoverable service descriptions via AT Protocol. The AppView ingests
 * these records, indexes them, and exposes search/lookup endpoints.
 *
 * Constraints:
 * - `public` + `unlisted` records are indexed; `known_only` is never indexed
 *   (local/pairing-bound). Only `public` is returned by public search —
 *   `unlisted` is indexed solely so it stays resolvable by exact service_uri.
 * - All responsePolicy values must be "auto"/"review" (lexicon-enforced)
 * - DID binding: op.did IS the operator (author == operator)
 */
export const serviceProfileHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record as unknown as ServiceProfile

    // Three-state discoverability (catalog §5.2):
    //   public     → indexed + returned in public search.
    //   unlisted   → INDEXED (so it stays resolvable by exact service_uri for
    //                link/QR/invite) but EXCLUDED from public search. Search
    //                gates on isDiscoverable=true and unlisted records carry
    //                isDiscoverable=false, so storing the row here is safe —
    //                it never surfaces in search, only in resolve-by-uri.
    //   known_only → local/pairing-bound; must NEVER touch the network index.
    //                Remove any existing indexed row.
    // The publisher already keeps known_only off the PDS (it unpublishes), so
    // this is mostly a defensive gate; legacy records that predate the
    // discoverability field fall back to the isDiscoverable boolean (a bare
    // false ⇒ treat as unpublish, preserving the old behavior).
    const disc = record.discoverability
    const isKnownOnly = disc === 'known_only' || (disc === undefined && !record.isDiscoverable)
    if (isKnownOnly) {
      await ctx.db.delete(services).where(eq(services.uri, op.uri))
      ctx.logger.debug(
        { uri: op.uri, discoverability: disc ?? '(legacy isDiscoverable=false)' },
        '[ServiceProfile] known_only / unpublished — removed any existing indexed row',
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

    // Re-key per-capability categories (catalog §9.1) to the SAME canonical
    // names as `canon.capabilities`, dropping any whose capability isn't in the
    // public index. Keeps categories aligned with the indexed capability set so
    // search can filter "<capability> where category = <x>".
    const canonSet = new Set(normalizedCapabilities)
    let canonicalCategories: Record<string, string> | null = null
    if (record.capabilityCategories) {
      const rekeyed: Record<string, string> = {}
      for (const [rawCap, category] of Object.entries(record.capabilityCategories)) {
        if (typeof category !== 'string' || category === '') continue
        const canonical = resolveSearchableCapability(rawCap)
        if (canonical === null || !canonSet.has(canonical)) continue
        // Anti-spoof (Codex #3): a provider can publish ANY category string in
        // its AT record. For an OFFICIAL capability only the catalog-allowed
        // categories are honoured — a lie (e.g. appointment_availability
        // published as developer_ops) is dropped, so category-filtered search
        // can't be polluted. Custom (namespaced) caps carry no registry
        // constraint (allowed === null → provider-owned, accept as-is).
        const allowed = allowedCategoriesForCapability(canonical)
        if (allowed !== null && !allowed.includes(category)) {
          ctx.metrics.incr('service.category.invalid', { cap: canonical })
          ctx.logger.debug(
            { uri: op.uri, cap: canonical, category },
            '[ServiceProfile] dropping category not allowed for capability',
          )
          continue
        }
        rekeyed[canonical] = category
      }
      if (Object.keys(rekeyed).length > 0) canonicalCategories = rekeyed
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
        capabilityCategoriesJson: canonicalCategories,
        isDiscoverable: record.isDiscoverable,
        discoverability: record.discoverability ?? null,
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
            capabilityCategoriesJson: values.capabilityCategoriesJson,
            isDiscoverable: values.isDiscoverable,
            discoverability: values.discoverability,
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
