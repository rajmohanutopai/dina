/**
 * Unit tests for `appview/src/api/xrpc/service-search.ts`.
 *
 * Focus: pin the wire-format-load-bearing behaviors. The handler
 * composes SQL via Drizzle's sql template; the stub captures the
 * generated text fragments so we can assert ordering, filter
 * structure, and parameter handling without standing up Postgres.
 */

import { describe, it, expect } from 'vitest'
import { serviceSearch, ServiceSearchParams } from '@/api/xrpc/service-search'
import type { DrizzleDB } from '@/db/connection'

// ────────────────────────────────────────────────────────────────────
// Stub. The real handler issues one `db.select().from().leftJoin().where().orderBy().limit()`
// chain. The stub captures the SELECT projection + WHERE filter +
// ORDER BY args; returns an empty row set so the handler completes.
// ────────────────────────────────────────────────────────────────────
interface Capture {
  selectProjection: unknown
  whereFilter: unknown
  orderBy: unknown[]
  limit: number | null
}

function stubDb(rows: unknown[] = []): { db: DrizzleDB; cap: Capture } {
  const cap: Capture = {
    selectProjection: undefined,
    whereFilter: undefined,
    orderBy: [],
    limit: null,
  }
  // The handler chains two `.leftJoin()` calls (didProfiles +
  // didRedactions) before `.where()`. The stub returns the same
  // chain shape on every leftJoin so adding/removing joins doesn't
  // require touching the stub.
  function chainAfterJoin(): unknown {
    return {
      leftJoin: () => chainAfterJoin(),
      where: (filter: unknown) => {
        cap.whereFilter = filter
        return {
          orderBy: (...args: unknown[]) => {
            cap.orderBy = args
            return {
              limit: async (n: number) => {
                cap.limit = n
                return rows
              },
            }
          },
        }
      },
    }
  }
  const db = {
    select: (proj: unknown) => {
      cap.selectProjection = proj
      return { from: () => chainAfterJoin() }
    },
  } as unknown as DrizzleDB
  return { db, cap }
}

/**
 * Recursively walk an object, collecting every string found anywhere
 * in the structure. Drizzle's `sql` template stores literal
 * interpolations directly in `queryChunks` arrays (not wrapped in
 * `.value` objects); a structural walk catches them.
 *
 * The `seen` WeakSet cuts the column-to-table back-reference cycle
 * in Drizzle Column objects without missing any string-typed value.
 */
function collectParamValues(
  node: unknown,
  out: string[] = [],
  seen: WeakSet<object> = new WeakSet(),
): string[] {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (seen.has(node as object)) return out
  seen.add(node as object)
  for (const v of Object.values(node as Record<string, unknown>)) {
    collectParamValues(v, out, seen)
  }
  return out
}

/** Collect bound params across SELECT + WHERE + ORDER BY. */
function allBoundStrings(cap: Capture): string[] {
  const seen = new WeakSet<object>()
  return [
    ...collectParamValues(cap.selectProjection, [], seen),
    ...collectParamValues(cap.whereFilter, [], seen),
    ...cap.orderBy.flatMap((x) => collectParamValues(x, [], seen)),
  ]
}

describe('ServiceSearchParams (Zod)', () => {
  it('requires capability', () => {
    const r = ServiceSearchParams.safeParse({})
    expect(r.success).toBe(false)
  })

  it('accepts a minimal valid request (capability only)', () => {
    const r = ServiceSearchParams.safeParse({ capability: 'eta_query' })
    expect(r.success).toBe(true)
  })

  it('rejects lat out of range', () => {
    const r = ServiceSearchParams.safeParse({
      capability: 'eta_query',
      lat: 91,
      lng: 0,
    })
    expect(r.success).toBe(false)
  })

  it('rejects lng out of range', () => {
    const r = ServiceSearchParams.safeParse({
      capability: 'eta_query',
      lat: 0,
      lng: -181,
    })
    expect(r.success).toBe(false)
  })
})

describe('serviceSearch — text query handling', () => {
  it('escapes `%` in q so it is matched literally, not as a wildcard', async () => {
    // Without escaping, `q='50% off'` would expand into a "match
    // anything" pattern (the `%` is ILIKE's any-string wildcard) and
    // every row would score 1.0 on the text component. With escaping,
    // the literal pattern `%50\% off%` is bound.
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
      q: '50% off',
    })
    const params = allBoundStrings(cap)
    expect(params).toContain('%50\\% off%')
    expect(params).not.toContain('%50% off%')
  })

  it('escapes `_` (single-character wildcard)', async () => {
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
      q: 'a_b',
    })
    expect(allBoundStrings(cap)).toContain('%a\\_b%')
  })

  it('escapes a literal backslash so the escape character itself is preserved', async () => {
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
      q: 'a\\b',
    })
    expect(allBoundStrings(cap)).toContain('%a\\\\b%')
  })

  it('passes plain text through unchanged (no false-positive escape)', async () => {
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
      q: 'plumbing services',
    })
    expect(allBoundStrings(cap)).toContain('%plumbing services%')
  })
})

describe('serviceSearch — capability canonicalization (Layer 3)', () => {
  it('resolves a mixed-case alias to the canonical name in the index query', async () => {
    // `Bus_ETA` is a registry alias of `eta_query`; case + padding fold,
    // and the index query binds the CANONICAL name (the index stores
    // canonical names — the handler canonicalizes on ingest).
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: '  Bus_ETA  ',
      radiusKm: 5,
      limit: 10,
    })
    const params = allBoundStrings(cap)
    expect(params).toContain('["eta_query"]')
    expect(params).not.toContain('["Bus_ETA"]')
    expect(params).not.toContain('["bus_eta"]')
    expect(params).not.toContain('["  Bus_ETA  "]')
  })

  it('returns an empty result for an UNKNOWN capability without querying the DB', async () => {
    // An unknown capability resolves to null → empty result, never a
    // partial-namespace hit. No string is bound to the DB query.
    const { db, cap } = stubDb([])
    const r = await serviceSearch(db, {
      capability: 'plumbing', // not in the registry
      radiusKm: 5,
      limit: 10,
    })
    expect(r.services).toEqual([])
    expect(r.cursor).toBeNull()
    expect(r.rankingVersion).toBe('v1')
    // The early return short-circuits before binding the capability.
    expect(allBoundStrings(cap)).not.toContain('["plumbing"]')
  })
})

describe('serviceSearch — response shape', () => {
  it('returns cursor=null + rankingVersion when there are no rows', async () => {
    const { db } = stubDb([])
    const r = await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
    })
    expect(r.cursor).toBeNull()
    expect(r.rankingVersion).toBe('v1')
    expect(r.services).toEqual([])
  })

  it('every result carries matched-capability flat fields', async () => {
    const fakeRow = {
      uri: 'at://did:plc:p/com.dinakernel.service.profile/self',
      operatorDid: 'did:plc:p',
      name: 'Test',
      description: null,
      capabilities: ['eta_query', 'eta_query'],
      lat: '37.0',
      lng: '-122.0',
      radiusKm: '5',
      hours: null,
      responsePolicy: { eta_query: 'auto' },
      capabilitySchemas: {
        eta_query: {
          description: 'Plumbing service',
          params: {},
          result: {},
          schema_hash: '0000000000000000000000000000000000000000000000000000000000000abc',
        },
      },
      trustScore: 0.5,
      score: 0.8,
      scoreBucket: 800,
      distanceKm: 2.5,
    }
    const { db } = stubDb([fakeRow])
    const r = await serviceSearch(db, {
      capability: 'eta_query',
      lat: 37,
      lng: -122,
      radiusKm: 5,
      limit: 10,
    })
    expect(r.services[0].matchedCapability).toBe('eta_query')
    expect(r.services[0].matchedSchemaHash).toBe(
      '0000000000000000000000000000000000000000000000000000000000000abc',
    )
    expect(r.services[0].matchedSchema).toMatchObject({
      description: 'Plumbing service',
    })
    expect(r.services[0].distanceKm).toBe(2.5)
  })

  it('matchedSchema is null when the operator did not publish one for the matched capability', async () => {
    const fakeRow = {
      uri: 'at://did:plc:p/com.dinakernel.service.profile/self',
      operatorDid: 'did:plc:p',
      name: 'Test',
      description: null,
      capabilities: ['eta_query'],
      lat: null,
      lng: null,
      radiusKm: null,
      hours: null,
      responsePolicy: { eta_query: 'auto' },
      capabilitySchemas: null,
      trustScore: null,
      score: 0,
      scoreBucket: 0,
      distanceKm: null,
    }
    const { db } = stubDb([fakeRow])
    const r = await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
    })
    expect(r.services[0].matchedSchema).toBeNull()
    expect(r.services[0].matchedSchemaHash).toBeNull()
    expect(r.services[0].distanceKm).toBeNull()
  })

  it('every result carries the tombstoned=false marker', async () => {
    // Tombstoned rows are excluded from the result set by the WHERE
    // clause, so the only rows that reach the mapper are non-
    // tombstoned. The field is reserved in the wire shape for a
    // future includeTombstoned variant.
    const fakeRow = {
      uri: 'at://did:plc:p/com.dinakernel.service.profile/self',
      operatorDid: 'did:plc:p',
      name: 'Test',
      description: null,
      capabilities: ['eta_query'],
      lat: '37.0',
      lng: '-122.0',
      radiusKm: '5',
      hours: null,
      responsePolicy: { eta_query: 'auto' },
      capabilitySchemas: null,
      trustScore: 0.5,
      score: 0.8,
      scoreBucket: 800,
    }
    const { db } = stubDb([fakeRow])
    const r = await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
    })
    expect(r.services).toHaveLength(1)
    expect(r.services[0].tombstoned).toBe(false)
  })
})

describe('serviceSearch — WHERE filter pins required column references', () => {
  function whereColumnNames(cap: Capture): string[] {
    const out: string[] = []
    const seen = new WeakSet<object>()
    function walk(n: unknown): void {
      if (n === null || typeof n !== 'object') return
      if (seen.has(n as object)) return
      seen.add(n as object)
      const o = n as Record<string, unknown>
      if (typeof o.name === 'string') out.push(o.name)
      for (const v of Object.values(o)) walk(v)
    }
    walk(cap.whereFilter)
    return out
  }

  it('WHERE references is_discoverable AND tombstoned_at AND capabilities_json', async () => {
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
    })
    const cols = whereColumnNames(cap)
    expect(cols).toContain('is_discoverable')
    expect(cols).toContain('tombstoned_at')
    expect(cols).toContain('capabilities_json')
  })

  it('WHERE references did_redactions.did (GDPR-shaped operator exclusion)', async () => {
    // A LEFT JOIN against did_redactions + an IS NULL check in the
    // WHERE means a redacted operator's services drop out of the
    // result set entirely. Pin the column reference so a refactor
    // that drops the join surfaces in tests, not on the wire.
    const { db, cap } = stubDb([])
    await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 10,
    })
    // The `did_redactions.did` column lives in the schema; its actual
    // column name in Postgres is `did` (the table itself is what
    // distinguishes it from `did_profiles.did` and `services.did`,
    // but those aren't service-side concepts). We assert via a count
    // of `did` columns: there should be at least one in the WHERE
    // because the IS NULL filter targets `did_redactions.did`.
    const cols = whereColumnNames(cap)
    expect(cols.filter((c) => c === 'did').length).toBeGreaterThanOrEqual(1)
  })
})

describe('serviceSearch — cursor handling', () => {
  it('rejects a malformed cursor with a clear error', async () => {
    const { db } = stubDb([])
    await expect(
      serviceSearch(db, {
        capability: 'eta_query',
        radiusKm: 5,
        limit: 10,
        cursor: 'not-a-valid-base64-cursor',
      }),
    ).rejects.toThrow(/Invalid cursor/)
  })

  it('rejects a cursor with the wrong version', async () => {
    // Encode a v=99 envelope; the handler accepts only v=1.
    const v99 = Buffer.from(JSON.stringify({ v: 99, bucket: 500, uri: 'at://x' }))
      .toString('base64url')
    const { db } = stubDb([])
    await expect(
      serviceSearch(db, {
        capability: 'eta_query',
        radiusKm: 5,
        limit: 10,
        cursor: v99,
      }),
    ).rejects.toThrow(/Invalid cursor/)
  })

  it('emits a base64url cursor when there are more rows', async () => {
    // limit+1 trick: hand back limit+1 rows so the handler sets hasMore.
    const mkRow = (uri: string, scoreBucket: number) => ({
      uri,
      operatorDid: 'did:plc:p',
      name: 'Test',
      description: null,
      capabilities: ['eta_query'],
      lat: '37',
      lng: '-122',
      radiusKm: '5',
      hours: null,
      responsePolicy: { eta_query: 'auto' },
      capabilitySchemas: null,
      trustScore: 0.5,
      score: 0.8,
      scoreBucket,
    })
    const { db } = stubDb([
      mkRow('at://did:plc:a/com.dinakernel.service.profile/self', 900),
      mkRow('at://did:plc:b/com.dinakernel.service.profile/self', 800),
      mkRow('at://did:plc:c/com.dinakernel.service.profile/self', 700), // limit+1
    ])
    const r = await serviceSearch(db, {
      capability: 'eta_query',
      radiusKm: 5,
      limit: 2,
    })
    expect(r.services).toHaveLength(2)
    expect(typeof r.cursor).toBe('string')
    // Decode + check shape — confirms it's an opaque envelope, not the
    // old `{bucket}::{uri}` transparent form.
    const decoded = JSON.parse(Buffer.from(r.cursor!, 'base64url').toString('utf8'))
    expect(decoded).toMatchObject({
      v: 1,
      bucket: 800,
      uri: 'at://did:plc:b/com.dinakernel.service.profile/self',
    })
  })
})
