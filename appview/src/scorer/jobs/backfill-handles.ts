/**
 * Backfill DID handles by resolving each `did:plc:` against the PLC
 * directory and storing `alsoKnownAs[0]` in `did_profiles.handle`.
 *
 * Why a separate job rather than inline in `refresh-profiles`: the
 * scorer pass shouldn't take a hard dependency on PLC reachability,
 * and PLC fetches per profile would slow each tick. Decoupled here,
 * a flaky PLC directory only delays the cosmetic handle population —
 * scoring stays clean.
 *
 * Cadence: scheduled at 10-minute intervals. Each run pulls a small
 * batch (`BATCH_SIZE = 50`) of DIDs missing a handle, resolves them
 * with bounded concurrency, and upserts results. With ~1k profiles
 * and a 50-DID batch every 10 minutes, full backfill of a fresh
 * deployment completes in ~3.5 hours.
 *
 * Re-resolution: V1 only resolves DIDs whose `handle` is currently
 * NULL. A DID that publishes a new handle later (e.g., user changes
 * their PDS handle) won't see the change until V2 adds a periodic
 * re-resolve sweep keyed off `last_active`. The mobile UI will keep
 * showing the cached handle until then — informational only, not
 * security-critical.
 *
 * Backoff: per-DID failures (network throw / PLC 5xx) are logged
 * and the row is left untouched. The DID gets re-tried on the next
 * tick. To avoid infinite hot-poll on a permanently-broken DID, we
 * persist `null` for any 404/410 from PLC (doc gone) — the WHERE
 * clause `handle IS NULL` would still pick it up; we use a sentinel
 * `last_handle_resolve_failed_at` column? No — V1 takes the simpler
 * path: 404/410 update the column to a sentinel empty string '' so
 * the next pass skips it. V2 can model this more carefully.
 */

import { isNull, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { didProfiles } from '@/db/schema/index.js'
import { resolveHandlesBatch, type ResolverConfig } from '@/util/handle_resolver.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'

/**
 * Per-tick batch size. Conservative — small enough that a stuck PLC
 * directory doesn't pile up in-flight requests, large enough to make
 * forward progress on a typical deployment.
 */
const BATCH_SIZE = 50

/**
 * Concurrent PLC fetches inside a batch. PLC tolerates this fine
 * but we cap to be polite. Tunable via `BACKFILL_HANDLES_CONCURRENCY`
 * env at the resolver config layer (out of scope for V1).
 */
const CONCURRENCY = 10

export async function backfillHandles(
  db: DrizzleDB,
  resolverConfig: ResolverConfig = {},
): Promise<void> {
  // Pull a batch of DIDs that haven't been resolved yet. Only
  // `did:plc:` DIDs participate — the PLC directory doesn't host
  // anything else. `did:web:` resolution is V2 work.
  const candidates = await db
    .select({ did: didProfiles.did })
    .from(didProfiles)
    .where(isNull(didProfiles.handle))
    .limit(BATCH_SIZE * 2) // over-fetch to allow filtering non-plc DIDs

  const dids = candidates
    .map((row) => row.did)
    .filter((did) => did.startsWith('did:plc:'))
    .slice(0, BATCH_SIZE)

  if (dids.length === 0) {
    logger.debug('backfill-handles: no DIDs need resolution')
    return
  }

  logger.info({ count: dids.length }, 'backfill-handles: resolving batch')

  const resolved = await resolveHandlesBatch(dids, {
    ...resolverConfig,
    concurrency: CONCURRENCY,
  })

  // Partition into (did, handle) UPDATEs. Handles that came back as
  // null still get written — the column starts NULL so we'd thrash
  // the row on every tick. We persist '' as a sentinel "we tried, no
  // handle". The xRPC layer maps '' → null for the wire (handles are
  // never legitimately empty strings).
  const withHandle: Array<{ did: string; handle: string }> = []
  const noHandle: string[] = []
  for (const [did, handle] of resolved) {
    if (typeof handle === 'string' && handle.length > 0) {
      withHandle.push({ did, handle })
    } else {
      noHandle.push(did)
    }
  }

  if (withHandle.length > 0) {
    // Drizzle doesn't have a clean batch-UPDATE-different-values, so
    // we issue one UPDATE per DID. With BATCH_SIZE=50 this is fine —
    // 50 small UPDATEs per 10 minutes is invisible to the DB.
    for (const row of withHandle) {
      await db
        .update(didProfiles)
        .set({ handle: row.handle })
        .where(inArray(didProfiles.did, [row.did]))
    }
  }
  if (noHandle.length > 0) {
    // Set sentinel '' for "tried, none". Avoids re-polling these next
    // tick. If the DID later publishes a handle, V2's periodic
    // re-resolve sweep will pick it up.
    await db
      .update(didProfiles)
      .set({ handle: '' })
      .where(inArray(didProfiles.did, noHandle))
  }

  metrics.counter('scorer.backfill_handles.resolved', withHandle.length)
  metrics.counter('scorer.backfill_handles.no_handle', noHandle.length)

  logger.info(
    { resolved: withHandle.length, noHandle: noHandle.length },
    'backfill-handles: batch complete',
  )
}
