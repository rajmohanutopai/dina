import { z } from 'zod'
import type { DrizzleDB } from '@/db/connection.js'
import { getLatestCatalogPayload } from '@/db/queries/catalog.js'
import { logger } from '@/shared/utils/logger.js'

/**
 * xRPC endpoint: com.dinakernel.catalog.capabilities
 *
 * Serves the official service-capability catalog (SERVICE_CAPABILITY_CATALOG_DESIGN.md
 * §5). The catalog SOURCE is `@dina/protocol`; it is seeded into AppView's
 * `catalog_snapshots` table by the re-runnable seed script. This endpoint reads
 * the newest snapshot and returns its payload VERBATIM — AppView never imports
 * protocol types (the payload is opaque). Mobile caches the result and falls
 * back to a bundled minimal catalog only when AppView is unavailable (§2).
 *
 * The optional filters (locale/platform/include/sinceVersion) are part of the
 * scale-ready contract (spec §5) but unused in V1 — the client compares
 * `catalog_hash` against its cache to decide whether to refresh.
 */

export const CatalogCapabilitiesParams = z.object({
  locale: z.string().max(35).optional(),
  platform: z.string().max(32).optional(),
  include: z.string().max(128).optional(),
  sinceVersion: z.string().max(64).optional(),
})

export type CatalogCapabilitiesParamsType = z.infer<typeof CatalogCapabilitiesParams>

/**
 * Empty-but-valid catalog returned before the first seed. Mobile treats this as
 * "no remote catalog" and uses its bundled fallback (spec §2). Shape matches
 * `CapabilityCatalog` so clients never see a malformed payload.
 */
const EMPTY_CATALOG = {
  catalog_version: '',
  catalog_hash: '',
  generated_at: new Date(0).toISOString(),
  categories: [],
  capabilities: [],
  deprecated_capabilities: [],
}

export async function catalogCapabilities(
  db: DrizzleDB,
  _params: CatalogCapabilitiesParamsType,
): Promise<unknown> {
  const payload = await getLatestCatalogPayload(db)
  if (payload === null) {
    // Operational signal: the catalog has never been seeded (or the snapshot
    // row is missing). Mobile silently falls back to its bundled catalog, so
    // without this log a broken/forgotten `seed:catalog` is invisible (#8).
    logger.warn(
      {},
      '[catalog] serving EMPTY catalog — no snapshot seeded. Run `npm run seed:catalog`.',
    )
    return EMPTY_CATALOG
  }
  return payload
}
