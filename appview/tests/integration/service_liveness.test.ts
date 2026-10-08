/**
 * Live listings (docs/REAL_LIFE_FIXES.md §14), against a real Postgres:
 * presence ingest, revision order, account gates, the paused clock, and how
 * search, get-by-uri and coverage rank and gate listings.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

import { cleanAllTables, closeTestDb, createTestHandlerContext, getTestDb } from '../test-db'
import { setBoolFlag } from '@/db/queries/appview-config.js'
import { clearFlagCache } from '@/ingester/feature-flag-cache.js'
import { serviceProfileHandler } from '@/ingester/handlers/service-profile.js'
import { servicePresenceHandler } from '@/ingester/handlers/service-presence.js'
import { noteIngestGap, noteServiceAccount } from '@/ingester/service-liveness-ingest.js'
import { serviceSearch, ServiceSearchParams } from '@/api/xrpc/service-search.js'
import { serviceGetByUri } from '@/api/xrpc/service-get-by-uri.js'
import { searchCapabilities } from '@/api/xrpc/search-capabilities.js'
import { JetstreamConsumer } from '@/ingester/jetstream-consumer.js'
import { reconcileOne } from '@/scorer/jobs/service-reconcile.js'

const db = getTestDb()
const ctx = () => createTestHandlerContext(db)
const HOUR = 3_600_000_000
const NOW = Date.now() * 1000
const PLACE = { latE7: 620_101_396, lngE7: -67_715_709, radiusKm: 20 }
const CID = (n: number) => `bafyrei${'a'.repeat(50)}${String.fromCharCode(97 + n)}`

function profile(name = 'Albert — Harbour bus') {
  return {
    name,
    capabilities: ['eta_query'],
    responsePolicy: { eta_query: 'auto' },
    isDiscoverable: true,
    discoverability: 'public',
    serviceArea: PLACE,
    updatedAt: new Date().toISOString(),
  }
}

async function publish(did: string, opts: { rkey?: string; cid?: number; rev?: string; observedUs?: number; name?: string } = {}) {
  const rkey = opts.rkey ?? 'self'
  await serviceProfileHandler.handleCreate(ctx(), {
    uri: `at://${did}/com.dinakernel.service.profile/${rkey}`,
    did,
    collection: 'com.dinakernel.service.profile',
    rkey,
    cid: CID(opts.cid ?? 0),
    record: profile(opts.name) as never,
    ...(opts.rev !== undefined ? { repoRev: opts.rev } : {}),
    observedUs: opts.observedUs ?? NOW,
  })
}

async function renew(did: string, observedUs: number, listings: { rkey: string; cid: string }[], rev: string, complete = true) {
  await servicePresenceHandler.handleCreate(ctx(), {
    uri: `at://${did}/com.dinakernel.service.presence/self`,
    did,
    collection: 'com.dinakernel.service.presence',
    rkey: 'self',
    cid: CID(9),
    record: { v: 1, n: '0123456789abcdef', listings, complete },
    repoRev: rev,
    observedUs,
  })
}

async function search(extra: Record<string, unknown> = {}) {
  return serviceSearch(db as never, ServiceSearchParams.parse({ capability: 'eta_query', lat: 62.0101396, lng: -6.7715709, radiusKm: 20, ...extra }))
}

beforeEach(async () => {
  await cleanAllTables(db)
  clearFlagCache()
})

afterAll(async () => {
  await closeTestDb()
})

describe('presence ingest', () => {
  it('a renewal credits the operator and stores the listing set', async () => {
    await publish('did:plc:alive')
    await renew('did:plc:alive', NOW, [{ rkey: 'self', cid: CID(0) }], 'rev2')
    const r = await search()
    expect(r.services.map((s) => [s.operatorDid, s.liveness])).toEqual([['did:plc:alive', 'fresh']])
    expect(r.services[0]!.lastSeenAt).not.toBeNull()
  })

  it('an older revision never replaces the set; a newer one always does, inside the credit limit', async () => {
    await publish('did:plc:a', { rkey: 'one', cid: 1 })
    await publish('did:plc:a', { rkey: 'two', cid: 2 })
    await renew('did:plc:a', NOW, [{ rkey: 'one', cid: CID(1) }], 'rev5')
    // Two minutes later (inside the 10-minute credit limit) the set grows.
    await renew('did:plc:a', NOW + 120_000_000, [{ rkey: 'one', cid: CID(1) }, { rkey: 'two', cid: CID(2) }], 'rev6')
    expect((await search()).services).toHaveLength(2)
    // A replayed older presence changes nothing.
    await renew('did:plc:a', NOW, [{ rkey: 'one', cid: CID(1) }], 'rev4')
    expect((await search()).services).toHaveLength(2)
  })

  it('a listing the set does not name, or with another CID, is withheld and queued for reconciliation', async () => {
    await publish('did:plc:b', { rkey: 'one', cid: 1 })
    await publish('did:plc:b', { rkey: 'ghost', cid: 3 })
    await renew('did:plc:b', NOW, [{ rkey: 'one', cid: CID(1) }], 'rev2')
    const r = await search()
    expect(r.services.map((s) => s.uri)).toEqual(['at://did:plc:b/com.dinakernel.service.profile/one'])
    const jobs = await db.execute(sql`SELECT did, reason FROM service_reconcile_jobs`)
    expect(jobs.rows).toEqual([{ did: 'did:plc:b', reason: 'presence_set_mismatch' }])
  })

  it('a presence delete withholds everything for that operator', async () => {
    await publish('did:plc:gone')
    await renew('did:plc:gone', NOW, [{ rkey: 'self', cid: CID(0) }], 'rev2')
    await servicePresenceHandler.handleDelete(ctx(), {
      uri: 'at://did:plc:gone/com.dinakernel.service.presence/self', did: 'did:plc:gone',
      collection: 'com.dinakernel.service.presence', rkey: 'self', repoRev: 'rev3',
    })
    expect((await search()).services).toEqual([])
  })

  it('an over-limit node (incomplete set) renews without gating its listings', async () => {
    await publish('did:plc:big', { rkey: 'l1', cid: 1 })
    await renew('did:plc:big', NOW, [], 'rev2', false)
    expect((await search()).services.map((s) => s.liveness)).toEqual(['fresh'])
  })
})

describe('revision order and deletion markers', () => {
  it('a replayed older create cannot bring back a deleted listing', async () => {
    await publish('did:plc:c', { rev: 'rev2' })
    await serviceProfileHandler.handleDelete(ctx(), {
      uri: 'at://did:plc:c/com.dinakernel.service.profile/self', did: 'did:plc:c',
      collection: 'com.dinakernel.service.profile', rkey: 'self', repoRev: 'rev3',
    })
    await publish('did:plc:c', { rev: 'rev2' })
    const rows = await db.execute(sql`SELECT uri FROM services`)
    expect(rows.rows).toEqual([])
    // A genuinely newer create does come back.
    await publish('did:plc:c', { rev: 'rev4' })
    expect((await db.execute(sql`SELECT uri FROM services`)).rows).toHaveLength(1)
  })

  it('an older revision never overwrites a newer row', async () => {
    await publish('did:plc:d', { rev: 'rev5', name: 'New name' })
    await publish('did:plc:d', { rev: 'rev4', name: 'Old name' })
    const rows = await db.execute(sql`SELECT name FROM services`)
    expect(rows.rows).toEqual([{ name: 'New name' }])
  })
})

describe('accounts', () => {
  it('an inactive account is withheld; a later commit proves it active again', async () => {
    await publish('did:plc:e', { observedUs: NOW - HOUR })
    await noteServiceAccount(db as never, 'did:plc:e', false, 'deactivated', NOW - HOUR / 2)
    expect((await search()).services).toEqual([])
    await publish('did:plc:e', { observedUs: NOW })
    expect((await search()).services).toHaveLength(1)
  })

  it('a deleted account removes its listings and refuses a delayed older create', async () => {
    await publish('did:plc:f', { observedUs: NOW - HOUR })
    await noteServiceAccount(db as never, 'did:plc:f', false, 'deleted', NOW - HOUR / 2)
    expect((await db.execute(sql`SELECT uri FROM services`)).rows).toEqual([])
    await publish('did:plc:f', { observedUs: NOW - HOUR })
    expect((await db.execute(sql`SELECT uri FROM services`)).rows).toEqual([])
  })

  it('a status that arrives before the first commit still applies', async () => {
    await noteServiceAccount(db as never, 'did:plc:g', false, 'takendown', NOW)
    await publish('did:plc:g', { observedUs: NOW - HOUR })
    expect((await search()).services).toEqual([])
  })
})

describe('ranking: live providers first (the stale-Albert case)', () => {
  async function seed() {
    // Four operators, same name, same place, same trust (none): only liveness differs.
    // Each listing was published before its operator's last renewal.
    for (const [did, ageH] of [['did:plc:live', 0], ['did:plc:thirtyh', 30], ['did:plc:fourd', 96], ['did:plc:twentyd', 480]] as const) {
      await publish(did, { observedUs: NOW - (ageH + 1) * HOUR })
      await renew(did, NOW - ageH * HOUR, [{ rkey: 'self', cid: CID(0) }], 'rev2')
    }
  }

  it('fresh before stale before expired; inside a tier, seen in the last 26 h first', async () => {
    await seed()
    const r = await search()
    expect(r.services.map((s) => [s.operatorDid, s.liveness])).toEqual([
      ['did:plc:live', 'fresh'],
      ['did:plc:thirtyh', 'fresh'],
      ['did:plc:fourd', 'stale'],
      ['did:plc:twentyd', 'expired'],
    ])
  })

  it('with hiding on, expired listings are left out of search but still resolve by link', async () => {
    await seed()
    await setBoolFlag(db as never, 'service_presence_hide_expired', true)
    expect((await search()).services.map((s) => s.operatorDid)).not.toContain('did:plc:twentyd')
    const byLink = await serviceGetByUri(db as never, { uri: 'at://did:plc:twentyd/com.dinakernel.service.profile/self' })
    expect(byLink?.liveness).toBe('expired')
  })

  it('an operator that never wrote presence is unknown: ranked with stale, never hidden before a sunset', async () => {
    await publish('did:plc:legacy', { observedUs: NOW - 20 * 24 * HOUR })
    await publish('did:plc:live')
    await renew('did:plc:live', NOW, [{ rkey: 'self', cid: CID(0) }], 'rev2')
    await setBoolFlag(db as never, 'service_presence_hide_expired', true)
    const r = await search()
    expect(r.services.map((s) => [s.operatorDid, s.liveness])).toEqual([
      ['did:plc:live', 'fresh'],
      ['did:plc:legacy', 'unknown'],
    ])
  })

  it('paging is stable: every row once, in order', async () => {
    await seed()
    const first = await search({ limit: 2 })
    const second = await search({ limit: 2, cursor: first.cursor! })
    expect([...first.services, ...second.services].map((s) => s.operatorDid)).toEqual([
      'did:plc:live', 'did:plc:thirtyh', 'did:plc:fourd', 'did:plc:twentyd',
    ])
  })

  it('capability coverage ignores providers search would not serve', async () => {
    await publish('did:plc:h')
    await noteServiceAccount(db as never, 'did:plc:h', false, 'takendown', NOW)
    const r = await searchCapabilities(db as never, { intent: 'when is the bus' } as never)
    expect(r.capabilities.map((c) => c.canonical)).not.toContain('eta_query')
  })
})

describe('the paused clock', () => {
  it('blind time does not age a provider, and lastSeenAt stays the real observation', async () => {
    await publish('did:plc:i', { observedUs: NOW - 101 * HOUR })
    await renew('did:plc:i', NOW - 100 * HOUR, [{ rkey: 'self', cid: CID(0) }], 'rev2')
    // AppView was blind for 60 of those 100 hours: age is 40 h, still fresh.
    await db.execute(sql`INSERT INTO service_blind_intervals (start_us, end_us, reason)
      VALUES (${NOW - 90 * HOUR}, ${NOW - 30 * HOUR}, 'ingest_gap')`)
    const r = await search()
    expect(r.services[0]!.liveness).toBe('fresh')
    expect(Date.parse(r.services[0]!.lastSeenAt!)).toBeLessThanOrEqual((NOW - 99 * HOUR) / 1000)
  })

  it('a provider dead before a gap stays as old as it was', async () => {
    await publish('did:plc:j', { observedUs: NOW - 30 * 24 * HOUR - HOUR })
    await renew('did:plc:j', NOW - 30 * 24 * HOUR, [{ rkey: 'self', cid: CID(0) }], 'rev2')
    await db.execute(sql`INSERT INTO service_blind_intervals (start_us, end_us, reason)
      VALUES (${NOW - 2 * HOUR}, ${NOW}, 'ingest_gap')`)
    expect((await search()).services[0]!.liveness).toBe('expired')
  })

  it('a resume point older than retention records the lost span as blind time', async () => {
    expect(await noteIngestGap(db as never, NOW - 100 * HOUR, 72 * HOUR, NOW)).toBe(true)
    expect(await noteIngestGap(db as never, NOW - 1 * HOUR, 72 * HOUR, NOW)).toBe(false)
    const rows = await db.execute(sql`SELECT reason FROM service_blind_intervals`)
    expect(rows.rows).toEqual([{ reason: 'ingest_gap' }])
  })
})

describe('through the consumer', () => {
  it('with the services switch off, an event is not applied and its DID is queued for reconciliation', async () => {
    await setBoolFlag(db as never, 'service_index_enabled', false)
    const consumer = new JetstreamConsumer(db as never)
    await (consumer as unknown as { processEvent: (e: unknown, c: unknown) => Promise<void> }).processEvent(
      {
        did: 'did:plc:k', time_us: NOW, kind: 'commit',
        commit: { rev: 'rev2', operation: 'create', collection: 'com.dinakernel.service.presence', rkey: 'self', cid: CID(9),
          record: { v: 1, n: '0123456789abcdef', listings: [], complete: true } },
      },
      { receivedUs: NOW },
    )
    expect((await db.execute(sql`SELECT did FROM service_operator_presence`)).rows).toEqual([])
    expect((await db.execute(sql`SELECT did, reason FROM service_reconcile_jobs`)).rows).toEqual([{ did: 'did:plc:k', reason: 'index_off' }])
  })

  it('a future-dated event counts as of its receipt', async () => {
    const consumer = new JetstreamConsumer(db as never)
    await (consumer as unknown as { processEvent: (e: unknown, c: unknown) => Promise<void> }).processEvent(
      {
        did: 'did:plc:l', time_us: NOW + 1000 * HOUR, kind: 'commit',
        commit: { rev: 'rev2', operation: 'create', collection: 'com.dinakernel.service.presence', rkey: 'self', cid: CID(9),
          record: { v: 1, n: '0123456789abcdef', listings: [], complete: true } },
      },
      { receivedUs: NOW },
    )
    const rows = await db.execute(sql`SELECT last_seen_us FROM service_operator_presence`)
    expect(Number((rows.rows[0] as { last_seen_us: string }).last_seen_us)).toBe(NOW)
  })
})

describe('reconciliation (verified repository reads)', () => {
  const job = (did: string) => ({ did, reason: 'presence_set_mismatch', presence_rev_at_queue: null, attempts: 0 })

  function deps(records: Record<string, { rev: string; cid: string; record: unknown } | 'absent'>, presence?: unknown) {
    return {
      resolve: async () => ({ signingKey: 'did:key:zTest', pds: 'https://pds.example' }),
      listRkeys: async () => Object.keys(records).map((rkey) => ({ rkey, cid: CID(1) })),
      readVerified: async (_p: string, _d: string, _k: string, collection: string, rkey: string) => {
        if (collection === 'com.dinakernel.service.presence') {
          return presence === undefined ? { kind: 'absent' as const, rev: 'rev9' } : { kind: 'present' as const, rev: 'rev9', cid: CID(9), record: presence }
        }
        const r = records[rkey]
        if (r === undefined) return { kind: 'failed' as const, reason: 'no_fixture' }
        return r === 'absent' ? { kind: 'absent' as const, rev: 'rev9' } : { kind: 'present' as const, ...r }
      },
    }
  }

  it('a missed create is fetched and served; a missed delete is removed', async () => {
    await publish('did:plc:m', { rkey: 'old', cid: 2, rev: 'rev1' })
    await renew('did:plc:m', NOW, [{ rkey: 'new', cid: CID(1) }], 'rev3')
    expect((await search()).services).toEqual([]) // 'old' withheld, 'new' not held yet
    const out = await reconcileOne(db as never, deps(
      { new: { rev: 'rev4', cid: CID(1), record: profile() }, old: 'absent' },
      { v: 1, n: '0123456789abcdef', listings: [{ rkey: 'new', cid: CID(1) }], complete: true },
    ) as never, job('did:plc:m'))
    expect(out).toBe('done')
    const r = await search()
    expect(r.services.map((s) => s.uri)).toEqual(['at://did:plc:m/com.dinakernel.service.profile/new'])
  })

  it('an unverifiable read changes nothing and retries later', async () => {
    await publish('did:plc:n', { rkey: 'self', cid: 1, rev: 'rev1' })
    await db.execute(sql`INSERT INTO service_reconcile_jobs (did, reason) VALUES ('did:plc:n', 'rate_limited')`)
    const out = await reconcileOne(db as never, deps({}) as never, job('did:plc:n'))
    expect(out).toBe('failed')
    expect((await db.execute(sql`SELECT uri FROM services`)).rows).toHaveLength(1)
    const rows = await db.execute(sql`SELECT attempts FROM service_reconcile_jobs WHERE did = 'did:plc:n'`)
    expect(rows.rows).toEqual([{ attempts: 1 }])
  })

  it('a reconciled read renews nothing', async () => {
    await publish('did:plc:o', { rkey: 'self', cid: 1, rev: 'rev1', observedUs: NOW - 400 * HOUR })
    await renew('did:plc:o', NOW - 400 * HOUR, [{ rkey: 'self', cid: CID(1) }], 'rev2')
    await reconcileOne(db as never, deps(
      { self: { rev: 'rev4', cid: CID(1), record: profile() } },
      { v: 1, n: '0123456789abcdef', listings: [{ rkey: 'self', cid: CID(1) }], complete: true },
    ) as never, job('did:plc:o'))
    expect((await search()).services[0]!.liveness).toBe('expired')
  })
})

describe('the health guard and clean-up', () => {
  it('a small index never trips the guard', async () => {
    const { servicePresenceHealth } = await import('@/scorer/jobs/service-liveness-jobs.js')
    await db.execute(sql`INSERT INTO service_blind_intervals (start_us, end_us, reason) VALUES (0, ${NOW - 30 * 24 * HOUR}, 'pre_tracking')`)
    for (let i = 0; i < 10; i++) {
      await db.execute(sql`INSERT INTO service_operator_presence (did, last_seen_us, presence_capable, presence_present)
        VALUES (${'did:plc:small' + i}, ${NOW - 40 * HOUR}, true, true)`)
    }
    expect(await servicePresenceHealth(db as never, NOW)).toBe('none')
  })

  async function bigIndex(renewedFraction: number, upstreamDrop: boolean) {
    await db.execute(sql`INSERT INTO service_blind_intervals (start_us, end_us, reason) VALUES (0, ${NOW - 30 * 24 * HOUR}, 'pre_tracking')`)
    for (let i = 0; i < 60; i++) {
      const seen = i < 60 * renewedFraction ? NOW - 2 * HOUR : NOW - 40 * HOUR
      await db.execute(sql`INSERT INTO service_operator_presence (did, last_seen_us, presence_capable, presence_present)
        VALUES (${'did:plc:big' + i}, ${seen}, true, true)`)
    }
    // A steady week of upstream events, then (maybe) a drop in the last 26 h.
    for (let h = 0; h < 8 * 24; h++) {
      const hourUs = Math.floor((NOW - h * HOUR) / HOUR) * HOUR
      const recent = h < 26
      await db.execute(sql`INSERT INTO ingest_hourly_events (hour_start_us, events) VALUES (${hourUs}, ${recent && upstreamDrop ? 10 : 1000})
        ON CONFLICT (hour_start_us) DO NOTHING`)
    }
  }

  it('renewals stopping alone, with other events flowing, opens nothing', async () => {
    const { servicePresenceHealth } = await import('@/scorer/jobs/service-liveness-jobs.js')
    await bigIndex(0.2, false)
    expect(await servicePresenceHealth(db as never, NOW)).toBe('none')
  })

  it('renewals and upstream events both dropping open blind time, which closes on recovery', async () => {
    const { servicePresenceHealth } = await import('@/scorer/jobs/service-liveness-jobs.js')
    await bigIndex(0.2, true)
    expect(await servicePresenceHealth(db as never, NOW)).toBe('opened')
    await db.execute(sql`UPDATE service_operator_presence SET last_seen_us = ${NOW}`)
    expect(await servicePresenceHealth(db as never, NOW + HOUR)).toBe('closed')
  })

  it('a drop lasting 72 h is capped, raises the alarm, and does not reopen until it clears', async () => {
    const { servicePresenceHealth } = await import('@/scorer/jobs/service-liveness-jobs.js')
    await bigIndex(0.2, true)
    expect(await servicePresenceHealth(db as never, NOW)).toBe('opened')
    expect(await servicePresenceHealth(db as never, NOW + 50 * HOUR)).toBe('capped')
    expect(await servicePresenceHealth(db as never, NOW + 51 * HOUR)).toBe('none')
  })

  it('clean-up removes old deletion markers and statuses of DIDs AppView holds nothing for', async () => {
    const { serviceLivenessGc } = await import('@/scorer/jobs/service-liveness-jobs.js')
    await db.execute(sql`INSERT INTO service_deletions (uri, did, deleted_rev, at) VALUES ('at://x/y/z', 'did:plc:x', 'rev1', now() - interval '31 days')`)
    await db.execute(sql`INSERT INTO service_account_status (did, active, status, time_us, updated_at) VALUES ('did:plc:nobody', false, 'takendown', 1, now() - interval '3 days')`)
    await publish('did:plc:kept')
    await db.execute(sql`INSERT INTO service_account_status (did, active, status, time_us, updated_at) VALUES ('did:plc:kept', false, 'takendown', 1, now() - interval '3 days')`)
    await serviceLivenessGc(db as never, NOW)
    expect((await db.execute(sql`SELECT uri FROM service_deletions`)).rows).toEqual([])
    expect((await db.execute(sql`SELECT did FROM service_account_status`)).rows).toEqual([{ did: 'did:plc:kept' }])
  })
})
