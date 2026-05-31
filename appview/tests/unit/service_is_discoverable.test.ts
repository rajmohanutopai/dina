/**
 * Unit tests for `appview/src/api/xrpc/service-is-discoverable.ts`.
 *
 * This endpoint decides whether Core may BYPASS D2D contact-gating for a
 * public-service query (the "egress bypass"). Two security-load-bearing
 * invariants are pinned here:
 *
 *   1. A moderator-TOMBSTONED service must NOT pass the bypass even though
 *      its row still carries isDiscoverable=true — the WHERE clause must
 *      reference `tombstoned_at` (mirrors service-search). Regression: the
 *      handler previously filtered only on operatorDid + isDiscoverable, so
 *      a taken-down service could still authorise egress.
 *   2. Open vocabulary: a namespaced custom capability resolves through
 *      `resolveSearchableCapability`, so a provider-owned custom service can
 *      pass the gate too; an unknown (flat, non-registry) capability cannot.
 */

import { describe, it, expect } from 'vitest'
import { serviceIsDiscoverable } from '@/api/xrpc/service-is-discoverable'
import type { DrizzleDB } from '@/db/connection'

/**
 * Stub matching `db.select({...}).from(...).where(pred)` → Promise<row[]>.
 * Captures the WHERE predicate so we can assert it references tombstoned_at,
 * and returns the given rows so the capability-merge path runs.
 */
function stubDb(rows: Array<{ capabilitiesJson: string[] }>): {
  db: DrizzleDB
  capturedWhere: () => unknown
} {
  let where: unknown
  const whereStep = {
    where: (pred: unknown) => {
      where = pred
      return Promise.resolve(rows)
    },
  }
  const db = {
    select: () => ({
      from: () => ({
        // Redaction join (didRedactions) is chained before `.where`; the stub
        // returns the same where-step so both shapes resolve to `rows`.
        leftJoin: () => whereStep,
        where: whereStep.where,
      }),
    }),
  } as unknown as DrizzleDB
  return { db, capturedWhere: () => where }
}

function whereCols(pred: unknown): string {
  return JSON.stringify(pred, (_k, v) => {
    if (
      v !== null &&
      typeof v === 'object' &&
      'name' in (v as Record<string, unknown>) &&
      typeof (v as { name: unknown }).name === 'string'
    ) {
      return `col:${(v as { name: string }).name}`
    }
    return v
  })
}

describe('serviceIsDiscoverable — egress gate', () => {
  it('WHERE excludes tombstoned rows (references tombstoned_at)', async () => {
    const { db, capturedWhere } = stubDb([{ capabilitiesJson: ['eta_query'] }])
    await serviceIsDiscoverable(db, { did: 'did:plc:bus' })
    expect(whereCols(capturedWhere())).toContain('col:tombstoned_at')
  })

  it('returns isDiscoverable=true + merged capabilities for a live provider', async () => {
    const { db } = stubDb([{ capabilitiesJson: ['eta_query', 'price_check'] }])
    const r = await serviceIsDiscoverable(db, { did: 'did:plc:bus' })
    expect(r.isDiscoverable).toBe(true)
    expect(r.capabilities).toEqual(['eta_query', 'price_check'])
  })

  it('returns isDiscoverable=false when the DID has no (non-tombstoned, discoverable) rows', async () => {
    const { db } = stubDb([])
    const r = await serviceIsDiscoverable(db, { did: 'did:plc:gone' })
    expect(r.isDiscoverable).toBe(false)
  })

  it('WHERE excludes GDPR-redacted operators (references the did_redactions join column)', async () => {
    // P2: a redacted provider must NOT authorise the egress bypass. The
    // `isNull(didRedactions.did)` term references the redactions table's `did`
    // column (distinct from services' `operator_did`).
    const { db, capturedWhere } = stubDb([{ capabilitiesJson: ['eta_query'] }])
    await serviceIsDiscoverable(db, { did: 'did:plc:bus' })
    expect(whereCols(capturedWhere())).toContain('col:did')
  })
})
