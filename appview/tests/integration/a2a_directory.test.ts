/**
 * The A2A directory (Lane 3, design §8.3) against REAL POSTGRES: the spool,
 * the phases, every ordering and gate vector §8.3 lists, key changes, gap
 * generations, and both xRPC methods. Real signatures throughout; only the
 * PLC directory is scripted (`docs`, `unreachable`). Every assertion is a
 * query or a served answer, never a recorded call.
 *
 * Run:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5432/dina_trust \
 *     npx vitest run tests/integration/a2a_directory.test.ts
 */

import { createHash } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { A2A_CARD_COLLECTION, A2A_DIRECTORY_PAGE_MAX, A2A_DIRECTORY_QUERY_MAX_LENGTH, MAX_ID_LENGTH } from '@dina/a2a'

import { A2A_CONFLICT_EVIDENCE_MAX, A2ADirectory, type A2ACommitEvent } from '@/ingester/a2a-directory.js'
import { resolve } from '@/api/xrpc/resolve.js'
import { clearCache } from '@/api/middleware/swr-cache.js'
import { resolveOrCreateSubject } from '@/db/queries/subjects.js'
import { A2A_CARD_STALE_AFTER_MS, A2A_RANKING_VERSION, getCard, searchAgents } from '@/api/xrpc/a2a-directory.js'
import { restoreA2ACard, takedownA2ACard } from '@/admin/peerlens-moderation-cli.js'
import { setBoolFlag } from '@/db/queries/appview-config.js'
import type { DidResolution } from '@/shared/a2a/did-resolver.js'
import { dispatchXrpc } from '@/web/xrpc-dispatch.js'
import { XRPC_ROUTES } from '@/web/xrpc-routes.js'

import { cardHashOf, cardRecord, didDocument, newCid, newDid, newKeys, revOf, type CardOptions, type Keys } from '../a2a-fixture.js'
import { cleanAllTables, closeTestDb, getTestDb } from '../test-db.js'

const db = getTestDb()
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
const noMetrics = { incr: () => undefined, gauge: () => undefined, histogram: () => undefined, counter: () => undefined }
const DAY = 24 * 60 * 60 * 1000

let clock: number
let docs: Map<string, unknown>
let unreachable: Set<string>
let dir: A2ADirectory
/** DID lookups the directory made, by DID. */
const lookups = new Map<string, number>()

function directory(over: Partial<ConstructorParameters<typeof A2ADirectory>[0]> = {}): A2ADirectory {
  return new A2ADirectory({
    db: db as never,
    resolveDid: async (did): Promise<DidResolution> => {
      lookups.set(did, (lookups.get(did) ?? 0) + 1)
      if (unreachable.has(did)) return { kind: 'unavailable' }
      const doc = docs.get(did)
      return doc === undefined ? { kind: 'not_found' } : { kind: 'document', document: doc }
    },
    rejection: { logger: silent as never, metrics: noMetrics as never },
    log: silent,
    retentionUs: DAY * 1000,
    now: () => clock,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    ...over,
  })
}

interface Publisher {
  did: string
  keys: Keys
}
function publisher(): Publisher {
  const did = newDid()
  const keys = newKeys()
  docs.set(did, didDocument(did, keys))
  return { did, keys }
}

let timeUs = 1_000
function commit(p: Publisher, rev: number, operation: 'create' | 'update' | 'delete', record?: Record<string, unknown>, rkey = 'self'): A2ACommitEvent {
  timeUs += 1
  const base = { did: p.did, time_us: timeUs, kind: 'commit' as const }
  if (operation === 'delete') {
    return { ...base, commit: { rev: revOf(rev), operation, collection: A2A_CARD_COLLECTION, rkey } }
  }
  return { ...base, commit: { rev: revOf(rev), operation, collection: A2A_CARD_COLLECTION, rkey, record: record ?? {}, cid: newCid() } }
}
async function put(p: Publisher, rev: number, o: CardOptions = {}, operation: 'create' | 'update' = 'update'): Promise<A2ACommitEvent> {
  const event = commit(p, rev, operation, await cardRecord(p.did, p.keys, o))
  await dir.receive(event, await gen())
  return event
}
const del = async (p: Publisher, rev: number) => dir.receive(commit(p, rev, 'delete'), await gen())
/** The generation an event received now is stamped with (the consumer holds it; here, read fresh). */
const gen = () => dir.currentGapGeneration()

const enable = () => setBoolFlag(db as never, 'a2a_directory_enabled', true)
const disable = () => setBoolFlag(db as never, 'a2a_directory_enabled', false)
const step = () => dir.step()

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows
}
const stateRow = async () =>
  (await q<{ phase: string; gap_generation: number; reconciliation_required: boolean }>(
    sql`SELECT phase, gap_generation, reconciliation_required FROM a2a_directory_state WHERE id = 1`,
  ))[0]
const cardRow = async (did: string) =>
  (await q<Record<string, unknown>>(sql`SELECT * FROM a2a_cards WHERE did = ${did}`))[0]
const spool = async (did: string) =>
  q<{ id: number; status: string; outcome: string | null; observed_gap_generation: number; repo_rev: string; operation: string }>(
    sql`SELECT id, status, outcome, observed_gap_generation, repo_rev, operation FROM a2a_event_spool WHERE did = ${did} ORDER BY id`,
  )

/** The card a DID serves, or null (not found, for any gate). */
async function served(did: string): Promise<string | null> {
  try {
    return (await getCard(db as never, { did }, clock)).card
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}
const servedName = async (did: string) => {
  const card = await served(did)
  return card === null ? null : (JSON.parse(card) as { name: string }).name
}
async function call(method: string, params: Record<string, string>) {
  return dispatchXrpc({ routes: XRPC_ROUTES, db, methodId: method, searchParams: new URLSearchParams(params) })
}

beforeEach(async () => {
  await cleanAllTables(db)
  await db.execute(sql`INSERT INTO a2a_directory_state (id, phase) VALUES (1, 'disabled') ON CONFLICT (id) DO NOTHING`)
  clock = Date.parse('2026-10-03T12:00:00Z')
  docs = new Map()
  unreachable = new Set()
  dir = directory()
})
afterAll(async () => {
  await closeTestDb()
})

describe('recording: before the acknowledgement, whatever the flag', () => {
  it('records while off, stamps the gap generation, processes nothing, and serves nothing', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'pending', observed_gap_generation: 0, operation: 'create' })])
    expect(await cardRow(p.did)).toBeUndefined()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'disabled' }))
    expect(await call('com.dinakernel.a2a.getCard', { did: p.did })).toEqual({
      status: 503,
      body: { error: 'DirectoryUnavailable', message: 'the agent directory is not open' },
    })
    expect((await call('com.dinakernel.a2a.searchAgents', {})).status).toBe(503)
  })

  it('an rkey other than self, or a revision that is not a TID, is refused at receipt and touches nothing', async () => {
    const p = publisher()
    await dir.receive(commit(p, 1, 'create', await cardRecord(p.did, p.keys), 'other'), 0)
    const bad = commit(p, 2, 'create', await cardRecord(p.did, p.keys))
    ;(bad.commit as { rev: string }).rev = 'not-a-tid'
    await dir.receive(bad, 0)
    expect(await spool(p.did)).toEqual([])
    const rejections = await q<{ detail: { phase: string } }>(sql`SELECT detail FROM ingest_rejections WHERE did = ${p.did} ORDER BY id`)
    expect(rejections.map((r) => r.detail.phase)).toEqual(['a2a_rkey_not_self', 'a2a_rev_invalid'])
  })

  it('persist before acknowledge: receive does not resolve until the row is committed', async () => {
    const p = publisher()
    let failing = true
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async (query: unknown) => {
            if (failing) throw new Error('connection refused')
            return (target as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(query)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const flakyDir = directory({ db: flaky as never })
    const event = commit(p, 1, 'create', await cardRecord(p.did, p.keys))
    let done = false
    const receiving = flakyDir.receive(event, 0).then(() => (done = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(done).toBe(false)
    expect(await spool(p.did)).toEqual([])
    failing = false
    await receiving
    expect(await spool(p.did)).toHaveLength(1)
  })

  it('a delivery twice (a reconnect replay) is one row and one transition', async () => {
    const p = publisher()
    const event = await put(p, 1, {}, 'create')
    await dir.receive(event, await gen())
    await enable()
    await step()
    await dir.receive(event, await gen())
    await step()
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'done', outcome: 'applied' })])
    expect(await servedName(p.did)).toBe('Bus 42')
  })
})

describe('the phases: disabled, draining, ready', () => {
  it('a first-ever create while off is served once the flag is on and the drain is done', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await enable()
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'ready' }))
    expect(await servedName(p.did)).toBe('Bus 42')
  })

  // Cold audit C6-9: the wait in the spool never freshens a card
  it('a card recorded while off and opened a month later is stale: indexed when received, not when drained', async () => {
    const old = publisher()
    await put(old, 1, { name: 'Old' }, 'create')
    clock += A2A_CARD_STALE_AFTER_MS + DAY
    const fresh = publisher()
    await put(fresh, 1, { name: 'Fresh' }, 'create')
    await enable()
    await step()
    expect((await getCard(db as never, { did: old.did }, clock)).stale).toBe(true)
    expect((await getCard(db as never, { did: fresh.did }, clock)).stale).toBe(false)
    const page = await searchAgents(db as never, { limit: 20 }, clock)
    expect(page.agents.map((a) => [a.displayName, a.stale])).toEqual([
      ['Fresh', false],
      ['Old', true],
    ])
  })

  it('updates and deletes while off drain in revision order', async () => {
    const a = publisher()
    const b = publisher()
    await put(a, 1, { name: 'A1' }, 'create')
    await put(b, 1, { name: 'B1' }, 'create')
    await put(a, 2, { name: 'A2' })
    await del(b, 2)
    await enable()
    await step()
    expect(await servedName(a.did)).toBe('A2')
    expect(await served(b.did)).toBeNull()
    expect(await cardRow(b.did)).toEqual(expect.objectContaining({ presence: 'deleted', repo_rev: revOf(2) }))
  })

  it('no premature reopening: while drained history waits, serving refuses; a live event meanwhile does not hold it', async () => {
    const a = publisher()
    const b = publisher()
    await put(a, 1, {}, 'create')
    unreachable.add(a.did)
    await enable()
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'draining' }))
    expect((await call('com.dinakernel.a2a.getCard', { did: a.did })).status).toBe(503)
    // A live event past the watermark is processed, and is not what the opening waits for.
    unreachable.add(b.did)
    await put(b, 1, {}, 'create')
    unreachable.delete(a.did)
    await db.execute(sql`UPDATE a2a_event_spool SET not_before = NULL`)
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'ready' }))
    expect(await servedName(a.did)).toBe('Bus 42')
    expect(await spool(b.did)).toEqual([expect.objectContaining({ status: 'pending' })])
  })

  it('a processor that died holding a lease: the row waits for the lease, then is processed', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await db.execute(sql`UPDATE a2a_event_spool SET lease_until = now() + interval '1 hour'`)
    await enable()
    await step()
    expect(await cardRow(p.did)).toBeUndefined()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'draining' }))
    await db.execute(sql`UPDATE a2a_event_spool SET lease_until = now() - interval '1 second'`)
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
  })

  it('a flag it cannot read closes the directory and is remembered; a good read reopens it', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await enable()
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'ready' }))
    let fail = true
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' && fail) {
          return () => {
            throw new Error('flag read failed')
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    await directory({ db: flaky as never }).step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'disabled', reconciliation_required: true }))
    expect((await call('com.dinakernel.a2a.getCard', { did: p.did })).status).toBe(503)
    fail = false
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'ready', reconciliation_required: false }))
  })

  it('turned off while open: closed at once; events keep recording; turned on, they drain', async () => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await enable()
    await step()
    await disable()
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'disabled' }))
    await put(p, 2, { name: 'v2' })
    await step()
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'done' }), expect.objectContaining({ status: 'pending' })])
    await enable()
    await step()
    expect(await servedName(p.did)).toBe('v2')
  })
})

describe('ordering and replay: the revision is the token', () => {
  beforeEach(enable)

  it('processed events are pruned after 30 days; a replay of a pruned one changes nothing', async () => {
    const p = publisher()
    const event = await put(p, 1, { name: 'kept' }, 'create')
    await step()
    clock += 31 * DAY
    await step()
    expect(await spool(p.did)).toEqual([])
    await dir.receive(event, await gen())
    await step()
    expect((await spool(p.did)).map((r) => r.outcome)).toEqual(['replay'])
    expect(await servedName(p.did)).toBe('kept')
  })

  it('conflict evidence names both spool rows, and pruning keeps them while the conflict stands', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    await put(p, 5, { name: 'v5' })
    await step()
    await del(p, 5)
    await step()
    const rows = await spool(p.did)
    const [first, applied, conflicting] = rows
    expect((await cardRow(p.did))?.evidence_json).toEqual(
      expect.objectContaining({
        spool_ids: [Number(applied?.id), Number(conflicting?.id)],
        applied: expect.objectContaining({ operation: 'update', spool_id: Number(applied?.id) }),
        conflicting: [expect.objectContaining({ operation: 'delete', spool_id: Number(conflicting?.id) })],
      }),
    )
    clock += 31 * DAY
    await step()
    expect((await spool(p.did)).map((r) => r.id)).toEqual([applied?.id, conflicting?.id])
    // A newer valid record ends the conflict; then the rows go like any other.
    await put(p, 6, { name: 'v6' })
    await step()
    clock += 31 * DAY
    await step()
    expect((await spool(p.did)).map((r) => r.id)).not.toContain(conflicting?.id)
    expect(first).toBeDefined()
  })

  it('every further event at a conflicting revision joins the evidence, and pruning keeps all of them', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    await put(p, 5, { name: 'v5' })
    await step()
    await del(p, 5)
    await step()
    await put(p, 5, { name: 'another v5' })
    await step()
    const [, applied, firstConflict, secondConflict] = await spool(p.did)
    const evidence = (await cardRow(p.did))?.evidence_json as { spool_ids: number[]; conflicting: { operation: string }[] }
    expect(evidence.spool_ids).toEqual([Number(applied?.id), Number(firstConflict?.id), Number(secondConflict?.id)])
    expect(evidence.conflicting.map((c) => c.operation)).toEqual(['delete', 'update'])
    clock += 31 * DAY
    await step()
    expect((await spool(p.did)).map((r) => r.id)).toEqual([applied?.id, firstConflict?.id, secondConflict?.id])
  })

  it('the evidence of one conflict is bounded: past the cap a further event adds nothing, and its row is pruned', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    await put(p, 5, { name: 'v5' })
    await step()
    for (let i = 0; i <= A2A_CONFLICT_EVIDENCE_MAX; i += 1) {
      await put(p, 5, { name: `conflict ${i}` })
      await step()
    }
    const evidence = (await cardRow(p.did))?.evidence_json as { spool_ids: number[]; conflicting: unknown[] }
    expect(evidence.conflicting).toHaveLength(A2A_CONFLICT_EVIDENCE_MAX)
    expect(evidence.spool_ids).toHaveLength(A2A_CONFLICT_EVIDENCE_MAX + 1)
    const last = (await spool(p.did)).at(-1)
    expect(evidence.spool_ids).not.toContain(Number(last?.id))
    clock += 31 * DAY
    await step()
    const left = (await spool(p.did)).map((r) => Number(r.id))
    expect(left).toEqual(evidence.spool_ids)
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ unavailable: true, unavailable_reason: 'equal_rev_conflict' }))
  })

  it('a recheck adds its verdict to a standing conflict’s evidence, never replaces it, and takes it off when the card verifies again', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    await put(p, 5, { name: 'v5' })
    await step()
    await del(p, 5)
    await step()
    const [, applied, conflicting] = await spool(p.did)
    const conflict = (await cardRow(p.did))?.evidence_json
    // The key rotates: the recheck fails, and says so beside the conflict.
    docs.set(p.did, didDocument(p.did, newKeys()))
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({
        unavailable: true,
        signature_state: 'invalid',
        evidence_json: { ...(conflict as object), revalidation: { reason: 'card_signature' } },
      }),
    )
    clock += 31 * DAY
    await step()
    expect((await spool(p.did)).map((r) => r.id)).toEqual(expect.arrayContaining([applied?.id, conflicting?.id]))
    // The key comes back: the card verifies, the verdict goes, the conflict stands.
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ unavailable: true, signature_state: 'verified', evidence_json: conflict }),
    )
    expect(await served(p.did)).toBeNull()
  })

  it('newer-invalid evidence names its spool row as a number, and pruning keeps it while the card is withheld', async () => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    await put(p, 2, { skills: ['teleport'] })
    await step()
    const [, invalid] = await spool(p.did)
    expect((await cardRow(p.did))?.evidence_json).toEqual(expect.objectContaining({ spool_ids: [Number(invalid?.id)] }))
    clock += 31 * DAY
    await step()
    expect((await spool(p.did)).map((r) => r.id)).toEqual([invalid?.id])
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ unavailable: true }))
  })

  it('a delayed old update is stale', async () => {
    const p = publisher()
    await put(p, 2, { name: 'new' }, 'create')
    await step()
    await put(p, 1, { name: 'old' })
    await step()
    expect(await servedName(p.did)).toBe('new')
    expect((await spool(p.did)).map((r) => r.outcome)).toEqual(['applied', 'stale'])
  })

  it.each([
    ['update then delete, live', false, ['update', 'delete'] as const],
    ['delete then update, live', false, ['delete', 'update'] as const],
    ['update then delete, spooled', true, ['update', 'delete'] as const],
    ['delete then update, spooled', true, ['delete', 'update'] as const],
  ])('an equal-revision conflict (%s): unavailable, both events kept; a newer valid record clears it', async (_name, spooled, order) => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    if (spooled) await disable()
    for (const op of order) {
      if (op === 'delete') await del(p, 5)
      else await put(p, 5, { name: 'v5' })
      if (!spooled) await step()
    }
    if (spooled) {
      await enable()
      await step()
    }
    const row = await cardRow(p.did)
    expect(row).toEqual(expect.objectContaining({ unavailable: true, unavailable_reason: 'equal_rev_conflict', repo_rev: revOf(5) }))
    expect(row?.evidence_json).toEqual(
      expect.objectContaining({ kind: 'equal_rev_conflict', applied: expect.objectContaining({ operation: order[0] }) }),
    )
    expect(await served(p.did)).toBeNull()
    await put(p, 6, { name: 'v6' })
    await step()
    expect(await servedName(p.did)).toBe('v6')
  })

  it('a delete carries no CID; a create older than it never brings the card back', async () => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    await del(p, 3)
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ presence: 'deleted', cid: null, card_json: null }))
    // Tombstone resurrection: a delayed older update.
    await put(p, 2, { name: 'v2' })
    await step()
    expect(await served(p.did)).toBeNull()
  })

  it('delete racing create: the delete lands first, the older create after it is stale', async () => {
    const p = publisher()
    await del(p, 2)
    await step()
    await put(p, 1, {}, 'create')
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ presence: 'deleted', repo_rev: revOf(2) }))
    expect(await served(p.did)).toBeNull()
  })

  it('valid → invalid → valid: a newer invalid record withholds the older card, with evidence', async () => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    await put(p, 2, { name: 'v2', skills: ['teleport'] })
    await step()
    expect(await served(p.did)).toBeNull()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({
        unavailable: true,
        unavailable_reason: 'newer_invalid',
        evidence_json: expect.objectContaining({ kind: 'newer_invalid', reason: 'skill_unknown' }),
      }),
    )
    await put(p, 3, { name: 'v3' })
    await step()
    expect(await servedName(p.did)).toBe('v3')
  })

  it('a replayed old invalid record never withholds a newer valid one', async () => {
    const p = publisher()
    await put(p, 3, { name: 'v3' }, 'create')
    await step()
    await put(p, 2, { skills: ['teleport'] })
    await step()
    expect(await servedName(p.did)).toBe('v3')
  })

  it('a DID the directory does not know, or a document that stops resolving, is an invalid record', async () => {
    const p = publisher()
    docs.delete(p.did)
    await put(p, 1, {}, 'create')
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ unavailable: true, evidence_json: expect.objectContaining({ reason: 'did_not_found' }) }),
    )
  })

  it('the PLC directory not answering is no verdict: the event waits and is processed later', async () => {
    const p = publisher()
    unreachable.add(p.did)
    await put(p, 1, {}, 'create')
    await step()
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'pending', outcome: 'retry:did_unavailable' })])
    unreachable.delete(p.did)
    await db.execute(sql`UPDATE a2a_event_spool SET not_before = NULL`)
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
  })
})

describe('the gates, each stored apart', () => {
  beforeEach(enable)
  const OP = 'did:plc:operatoraaaaaaaaaaaaaaaa'

  it('an owner re-put during a takedown changes the card but never lifts the takedown', async () => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    await takedownA2ACard(db as never, { did: p.did, actorDid: OP, reason: 'spam' })
    expect(await served(p.did)).toBeNull()
    await put(p, 2, { name: 'v2' })
    await step()
    expect(await served(p.did)).toBeNull()
    await restoreA2ACard(db as never, { did: p.did, actorDid: OP, reason: 'appeal' })
    expect(await servedName(p.did)).toBe('v2')
    const audit = await q<{ action: string }>(sql`SELECT action FROM admin_audit_log WHERE target_id = ${p.did} ORDER BY id`)
    expect(audit.map((a) => a.action)).toEqual(['takedown_a2a_card', 'restore_a2a_card'])
  })

  it('a restore never brings back a card the owner deleted; a takedown can come before any card', async () => {
    const p = publisher()
    await takedownA2ACard(db as never, { did: p.did, actorDid: OP, reason: 'known abuser' })
    await put(p, 1, {}, 'create')
    await step()
    expect(await served(p.did)).toBeNull()
    await del(p, 2)
    await step()
    await restoreA2ACard(db as never, { did: p.did, actorDid: OP, reason: 'appeal' })
    expect(await served(p.did)).toBeNull()
    await put(p, 3, { name: 'back' })
    await step()
    expect(await servedName(p.did)).toBe('back')
    await expect(restoreA2ACard(db as never, { did: p.did, actorDid: OP, reason: 'again' })).rejects.toThrow(/No takedown/)
  })

  it('a redacted DID is withheld; lifting the redaction serves it again', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    await db.execute(sql`INSERT INTO did_redactions (did, reason) VALUES (${p.did}, 'gdpr')`)
    expect(await served(p.did)).toBeNull()
    expect((await searchAgents(db as never, { limit: 20 }, clock)).agents).toEqual([])
    await db.execute(sql`DELETE FROM did_redactions WHERE did = ${p.did}`)
    expect(await served(p.did)).not.toBeNull()
  })

  it('an inactive account is withheld; active again, it is back; an event out of order changes nothing', async () => {
    const p = publisher()
    const ev = await put(p, 1, {}, 'create')
    await step()
    await dir.noteAccount(p.did, false, ev.time_us + 10)
    expect(await served(p.did)).toBeNull()
    await dir.noteAccount(p.did, true, ev.time_us + 20)
    expect(await served(p.did)).not.toBeNull()
    await dir.noteAccount(p.did, false, ev.time_us + 15)
    expect(await served(p.did)).not.toBeNull()
  })

  it('an account deactivated while the directory was off is withheld once its card is processed', async () => {
    const p = publisher()
    await disable()
    const ev = await put(p, 1, {}, 'create')
    await dir.noteAccount(p.did, false, ev.time_us + 10)
    await enable()
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ account_active: false }))
    expect(await served(p.did)).toBeNull()
  })

  it('a reactivation lost in a gap is answered by the next commit; a DID the directory never saw records nothing', async () => {
    const p = publisher()
    const ev = await put(p, 1, {}, 'create')
    await step()
    await dir.noteAccount(p.did, false, ev.time_us + 10)
    expect(await served(p.did)).toBeNull()
    // The reactivation is lost; the account commits again later, so it was active then.
    timeUs += 100
    await put(p, 2, { name: 'back' })
    await step()
    expect(await servedName(p.did)).toBe('back')
    const stranger = newDid()
    await dir.noteAccount(stranger, false, ev.time_us)
    expect(await q(sql`SELECT 1 FROM a2a_account_status WHERE did = ${stranger}`)).toEqual([])
  })

  it('getCard serves the published bytes: their sha256 is the card hash, and nothing is added to them', async () => {
    const p = publisher()
    const event = await put(p, 1, {}, 'create')
    await step()
    const answer = await getCard(db as never, { did: p.did }, clock)
    const record = (event.commit as { record: Record<string, unknown> }).record
    expect(answer.card).toBe(record.card)
    expect(createHash('sha256').update(answer.card, 'utf8').digest('hex')).toBe(answer.cardHash)
    expect(answer.cardHash).toBe(cardHashOf(record))
    expect(answer).toEqual(expect.objectContaining({ signatureState: 'verified', stale: false, trust: expect.objectContaining({ score: 0 }) }))
    expect(await call('com.dinakernel.a2a.getCard', { did: newDid() })).toEqual({
      status: 404,
      body: { error: 'NotFound', message: 'no agent card for that DID' },
    })
    expect((await call('com.dinakernel.a2a.getCard', { did: 'not-a-did' })).status).toBe(400)
  })
})

describe('keys: a card never outlives the key that justified it', () => {
  beforeEach(enable)

  // Cold audit C5-8
  it('an unsigned card, its signatures empty or gone, is never served; the same card signed is', async () => {
    const empty = publisher()
    const gone = publisher()
    const signed = publisher()
    await put(empty, 1, { name: 'Empty', tamper: (c) => (c.signatures = []) }, 'create')
    await put(gone, 1, { name: 'Gone', tamper: (c) => delete c.signatures }, 'create')
    await put(signed, 1, { name: 'Signed' }, 'create')
    await step()
    for (const p of [empty, gone]) {
      expect(await served(p.did)).toBeNull()
      expect(await cardRow(p.did)).toEqual(
        expect.objectContaining({ unavailable: true, evidence_json: expect.objectContaining({ reason: 'card_signature' }) }),
      )
    }
    expect(await servedName(signed.did)).toBe('Signed')
    expect((await call('com.dinakernel.a2a.searchAgents', {})).body).toEqual(
      expect.objectContaining({ agents: [expect.objectContaining({ did: signed.did })] }),
    )
  })

  it('a first card checked before AppView’s view of the document names #a2a_card is served once the identity event arrives', async () => {
    const p = publisher()
    docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
    await put(p, 1, { name: 'First' }, 'create')
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ unavailable: true, evidence_json: expect.objectContaining({ kind: 'newer_invalid', reason: 'card_key_missing' }) }),
    )
    expect(await served(p.did)).toBeNull()
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    await step()
    expect(await servedName(p.did)).toBe('First')
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ unavailable: false, evidence_json: null, signature_state: 'verified' }))
  })

  // Cold audit C6-9
  it('a record withheld for a month, then served, is stale: its indexed time is when it was received', async () => {
    const p = publisher()
    docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
    await put(p, 1, { name: 'Late key' }, 'create')
    await step()
    expect(await served(p.did)).toBeNull()
    clock += A2A_CARD_STALE_AFTER_MS + DAY
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    await step()
    expect(await servedName(p.did)).toBe('Late key')
    expect((await getCard(db as never, { did: p.did }, clock)).stale).toBe(true)
  })

  it('a missed identity event is caught by the daily check: the withheld record is served once the document names its key', async () => {
    const p = publisher()
    docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
    await put(p, 1, { name: 'Late key' }, 'create')
    await step()
    docs.set(p.did, didDocument(p.did, p.keys)) // no identity event reaches the directory
    await step()
    expect(await served(p.did)).toBeNull()
    clock += DAY + 1
    await step()
    await step()
    expect(await servedName(p.did)).toBe('Late key')
  })

  it('a withheld record whose key never appears stays withheld; each check adds its reason and keeps the cited event', async () => {
    const p = publisher()
    docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
    await put(p, 1, { name: 'Never' }, 'create')
    await step()
    const [cited] = await spool(p.did)
    // Two days on, an identity event: the check fails again, and that check is the one the next waits a day from.
    clock += 2 * DAY
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({
        unavailable: true,
        evidence_json: expect.objectContaining({
          reason: 'card_key_missing',
          spool_ids: [Number(cited?.id)],
          revalidation: { reason: 'card_key_missing' },
        }),
      }),
    )
    // A failed check counts as a check: the record waits a day, not an hour, before the next.
    const before = lookups.get(p.did) ?? 0
    clock += 2 * 60 * 60 * 1000
    await step()
    await step()
    expect(lookups.get(p.did) ?? 0).toBe(before)
    clock += 31 * DAY
    await step()
    await step()
    expect(lookups.get(p.did) ?? 0).toBe(before + 1)
    expect(await served(p.did)).toBeNull()
    expect((await spool(p.did)).map((r) => r.id)).toEqual([cited?.id])
  })

  it('a card that failed a check after its key left comes back by the daily check once the key returns, without an identity event', async () => {
    const p = publisher()
    await put(p, 1, { name: 'Back' }, 'create')
    await step()
    clock += 2 * DAY
    docs.set(p.did, didDocument(p.did, newKeys()))
    await dir.noteIdentity(p.did)
    await step()
    expect(await served(p.did)).toBeNull()
    // The failed check is a check: nothing more for a day, though the last pass was two days ago.
    const before = lookups.get(p.did) ?? 0
    clock += 2 * 60 * 60 * 1000
    await step()
    await step()
    expect(lookups.get(p.did) ?? 0).toBe(before)
    docs.set(p.did, didDocument(p.did, p.keys)) // the old key returns; no identity event
    clock += DAY + 1
    await step()
    await step()
    expect(await servedName(p.did)).toBe('Back')
  })

  it('a card that verifies again after a failed recheck is served, with no verdict left on it', async () => {
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    docs.set(p.did, didDocument(p.did, newKeys()))
    await dir.noteIdentity(p.did)
    await step()
    expect(await served(p.did)).toBeNull()
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ signature_state: 'verified', evidence_json: null }))
    expect(await servedName(p.did)).toBe('v1')
  })

  it('rotation before republish: the identity event withholds the card; the republish under the new key restores it', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    const rotated = newKeys()
    docs.set(p.did, didDocument(p.did, rotated))
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ signature_state: 'invalid', evidence_json: expect.objectContaining({ kind: 'revalidation' }) }),
    )
    expect(await served(p.did)).toBeNull()
    await put({ did: p.did, keys: rotated }, 2, { name: 'rotated' })
    await step()
    expect(await servedName(p.did)).toBe('rotated')
  })

  it.each([
    ['an update', true],
    ['a first create (no row yet)', false],
  ])('a key rotated while %s is being checked: the check runs again against the new document', async (_name, existing) => {
    const p = publisher()
    if (existing) {
      await put(p, 1, { name: 'v1' }, 'create')
      await step()
    }
    // The record is signed with the old key; while its document is fetched, the
    // key rotates and the identity event lands.
    const rotated = newKeys()
    let rotatedOnce = false
    dir = directory({
      resolveDid: async (did) => {
        const doc = docs.get(did)
        if (!rotatedOnce && did === p.did) {
          rotatedOnce = true
          docs.set(p.did, didDocument(p.did, rotated))
          await dir.noteIdentity(p.did)
        }
        return doc === undefined ? { kind: 'not_found' } : { kind: 'document', document: doc }
      },
    })
    await put(p, 2, { name: 'v2' }, existing ? 'update' : 'create')
    await step()
    expect(rotatedOnce).toBe(true)
    expect(await served(p.did)).toBeNull()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ unavailable: true, evidence_json: expect.objectContaining({ reason: 'card_signature' }) }),
    )
  })

  // (An account event in that window waits for the commit instead: the per-DID lock test below.)
  it('an identity event landing after the check but before a first create commits is settled after commit', async () => {
    const p = publisher()
    const rotated = newKeys()
    let fired = false
    // Run the event inside the window: the create's transaction is done but not yet committed.
    const windowed = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            (target as unknown as { transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction(async (tx) => {
              const out = await fn(tx)
              if (!fired) {
                fired = true
                docs.set(p.did, didDocument(p.did, rotated))
                await dir.noteIdentity(p.did)
              }
              return out
            })
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    dir = directory({ db: windowed as never })
    await put(p, 1, {}, 'create')
    await step()
    expect(fired).toBe(true)
    // Marked after commit, checked again against the new document, withheld.
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ signature_state: 'invalid' }))
    expect(await served(p.did)).toBeNull()
  })

  it('an account event waits for a card write of the same DID to commit (one per-DID lock), then sees the row', async () => {
    const p = publisher()
    let accountDone = false
    let resolvedWhileOpen: boolean | null = null
    let pending: Promise<void> | null = null
    const holding = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            (target as unknown as { transaction: (f: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).transaction(async (tx) => {
              const out = await fn(tx)
              if (pending === null && out === true) {
                // The card write holds the lock; the account event must wait for it.
                pending = dir.noteAccount(p.did, false, timeUs + 50).then(() => {
                  accountDone = true
                })
                await new Promise((r) => setTimeout(r, 150))
                resolvedWhileOpen = accountDone
              }
              return out
            })
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    dir = directory({ db: holding as never })
    await put(p, 1, {}, 'create')
    await step()
    expect(resolvedWhileOpen).toBe(false)
    await pending
    expect(accountDone).toBe(true)
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ account_active: false }))
  })

  it('a missed identity event: a day later the periodic check catches the rotation', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    docs.set(p.did, didDocument(p.did, newKeys()))
    await step()
    expect(await served(p.did)).not.toBeNull()
    clock += DAY + 1
    await step()
    await step()
    expect(await served(p.did)).toBeNull()
  })

  // Cold audit C4-7: a key may have rotated, so the card waits, withheld, for a verdict
  it('the PLC directory down after an identity event: the card is withheld until a check lands, then served again', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    unreachable.add(p.did)
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ signature_state: 'verified', needs_revalidation: true, identity_check_pending: true }),
    )
    expect(await served(p.did)).toBeNull()
    // Still down at the retry, still withheld: no number of tries serves a card no check has passed.
    const retryDue = () => db.execute(sql`UPDATE a2a_cards SET revalidate_after = now() - interval '1 second' WHERE did = ${p.did}`)
    await retryDue()
    await step()
    expect(await served(p.did)).toBeNull()
    // The directory answers, the same key: the verdict lands and the card is served.
    unreachable.delete(p.did)
    await retryDue()
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ needs_revalidation: false, identity_check_pending: false }))
    expect(await served(p.did)).not.toBeNull()
  })

  it('the routine daily recheck does not withhold: a card awaiting it stays served while the PLC directory is down', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    unreachable.add(p.did)
    clock += 2 * DAY
    // One pass marks the card for its daily check; the next tries it, and the PLC directory does not answer.
    await step()
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ needs_revalidation: true, identity_check_pending: false }))
    expect(await served(p.did)).not.toBeNull()
  })
})

describe('gap generations: presence must be proved again', () => {
  beforeEach(enable)

  it('a cold start over an existing index withholds every card until a newer valid event; a deleted one never returns', async () => {
    const live = publisher()
    const gone = publisher()
    await put(live, 1, {}, 'create')
    await put(gone, 1, {}, 'create')
    await step()
    expect(await dir.markGapIfUnreplayable(0)).toEqual({ gapped: true, generation: 1 })
    expect(await stateRow()).toEqual(expect.objectContaining({ gap_generation: 1 }))
    expect(await served(live.did)).toBeNull()
    await put(live, 2, { name: 'proved' })
    await step()
    expect(await servedName(live.did)).toBe('proved')
    expect(await served(gone.did)).toBeNull()
  })

  it('an outage longer than Jetstream keeps events (less a clock margin) is a gap; a shorter one is not', async () => {
    const MIN = 60_000
    expect((await dir.markGapIfUnreplayable((clock - DAY + 11 * MIN) * 1000)).gapped).toBe(false)
    expect(await dir.markGapIfUnreplayable((clock - DAY + 9 * MIN) * 1000)).toEqual({ gapped: true, generation: 1 })
    expect(await stateRow()).toEqual(expect.objectContaining({ gap_generation: 1 }))
  })

  it('no cursor over a directory that holds anything is a gap, even only a spool (the directory off); over an empty one it is not', async () => {
    expect((await dir.markGapIfUnreplayable(0)).gapped).toBe(false)
    const p = publisher()
    await disable()
    await put(p, 1, {}, 'create')
    expect(await dir.markGapIfUnreplayable(0)).toEqual({ gapped: true, generation: 1 })
    await enable()
    await step()
    // Received before the gap: applied, never proving.
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ presence: 'present', proved_generation: 0 }))
    expect(await served(p.did)).toBeNull()
  })

  it('a quiet day is no gap: the resume point is the later of the cursor and the last time the consumer was live', async () => {
    const dayOldCursor = (clock - 2 * DAY) * 1000
    await dir.noteLive((clock - 60_000) * 1000)
    expect((await dir.markGapIfUnreplayable(dayOldCursor)).gapped).toBe(false)
    // Live notes only move forward.
    await dir.noteLive((clock - 3 * DAY) * 1000)
    expect((await dir.markGapIfUnreplayable(dayOldCursor)).gapped).toBe(false)
    // Down for longer than the retention since it was last live: a gap.
    clock += DAY
    expect(await dir.markGapIfUnreplayable(dayOldCursor)).toEqual({ gapped: true, generation: 1 })
  })

  it('an event received before a gap but recorded after it keeps its receipt stamp: it applies, never proves', async () => {
    // §8.3's "concurrent gap-marking vs live ingestion": the consumer stamped
    // the event as it came off the socket; the gap moved while it was queued.
    const p = publisher()
    const stamp = await gen()
    expect((await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)).gapped).toBe(true)
    await dir.receive(commit(p, 1, 'create', await cardRecord(p.did, p.keys)), stamp)
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ presence: 'present', proved_generation: 0 }))
    expect(await served(p.did)).toBeNull()
  })

  it('an event received before the gap and processed after applies, proves nothing; only one received after proves', async () => {
    const early = publisher()
    const late = publisher()
    await disable()
    await put(early, 1, { name: 'pre-gap' }, 'create')
    await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)
    await put(late, 1, { name: 'post-gap' }, 'create')
    expect((await spool(early.did)).map((r) => r.observed_gap_generation)).toEqual([0])
    expect((await spool(late.did)).map((r) => r.observed_gap_generation)).toEqual([1])
    await enable()
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'ready', gap_generation: 1 }))
    // Both applied; only the one received under the current generation is proved.
    expect(await cardRow(early.did)).toEqual(expect.objectContaining({ presence: 'present', proved_generation: 0 }))
    expect(await served(early.did)).toBeNull()
    expect(await servedName(late.did)).toBe('post-gap')
    await put(early, 2, { name: 'proved now' })
    await step()
    expect(await servedName(early.did)).toBe('proved now')
  })
})

describe('searchAgents: relevance filters, trust orders', () => {
  beforeEach(enable)

  async function listed(name: string, o: CardOptions & { trust?: number; indexedAt?: number } = {}): Promise<Publisher> {
    const p = publisher()
    const saved = clock
    if (o.indexedAt !== undefined) clock = o.indexedAt
    await put(p, 1, { name, ...o }, 'create')
    await step()
    clock = saved
    if (o.trust !== undefined) {
      await db.execute(sql`INSERT INTO did_profiles (did, overall_trust_score, computed_at) VALUES (${p.did}, ${o.trust}, now())`)
    }
    return p
  }
  const names = async (params: Record<string, unknown>) =>
    (await searchAgents(db as never, { limit: 20, ...params } as never, clock)).agents.map((a) => a.displayName)

  it('a keyword-stuffed zero-trust card ranks below a relevant trusted one', async () => {
    await listed('Bus bus bus arrivals bus', { description: 'bus bus bus bus bus bus bus', trust: 0 })
    await listed('City transit', { description: 'Bus arrival times', trust: 0.9 })
    await listed('Bakery', { description: 'Bread', trust: 1 })
    expect(await names({ q: 'bus' })).toEqual(['City transit', 'Bus bus bus arrivals bus'])
  })

  it('skill: an exact id, a capability (every rkey of it), or an alias; unknown finds none; malformed is refused', async () => {
    await listed('Shop', { skills: ['price_check@shop'] })
    await listed('Other shop', { skills: ['price_check@other'] })
    await listed('Bus', { skills: ['eta_query'] })
    expect(await names({ skill: 'price_check@shop' })).toEqual(['Shop'])
    expect((await names({ skill: 'price_check' })).sort()).toEqual(['Other shop', 'Shop'])
    expect(await names({ skill: 'bus_eta' })).toEqual(['Bus'])
    expect(await names({ skill: 'teleport' })).toEqual([])
    expect(await call('com.dinakernel.a2a.searchAgents', { skill: 'price_check@' })).toEqual(
      expect.objectContaining({ status: 400, body: expect.objectContaining({ error: 'InvalidRequest' }) }),
    )
  })

  it('stale cards sink below every fresh one; stale means indexed 30 days ago or more, by AppView’s clock', async () => {
    await listed('Old but trusted', { trust: 1, indexedAt: clock - A2A_CARD_STALE_AFTER_MS })
    await listed('Just fresh', { trust: 0.1, indexedAt: clock - A2A_CARD_STALE_AFTER_MS + 1 })
    const page = await searchAgents(db as never, { limit: 20 }, clock)
    expect(page.agents.map((a) => [a.displayName, a.stale])).toEqual([
      ['Just fresh', false],
      ['Old but trusted', true],
    ])
    // One millisecond on, the second is stale too.
    const later = await searchAgents(db as never, { limit: 20 }, clock + 1)
    expect(later.agents.map((a) => a.stale)).toEqual([true, true])
  })

  it('pages with a versioned cursor: every card once, in order; a cursor from another ordering is refused', async () => {
    for (let i = 0; i < 5; i++) await listed(`Agent ${i}`, { trust: i % 2 === 0 ? 0.5 : 0.7 })
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await searchAgents(db as never, { limit: 2, ...(cursor !== undefined ? { cursor } : {}) }, clock)
      seen.push(...page.agents.map((a) => a.displayName))
      cursor = page.cursor ?? undefined
      expect(page.rankingVersion).toBe(A2A_RANKING_VERSION)
    } while (cursor !== undefined)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect(seen.slice(0, 2).sort()).toEqual(['Agent 1', 'Agent 3'])
    const foreign = Buffer.from(JSON.stringify({ v: 1, rv: 'other', s: 0, t: 0, r: 0, d: newDid() })).toString('base64url')
    expect((await call('com.dinakernel.a2a.searchAgents', { cursor: foreign })).status).toBe(400)
  })

  it('takes any skill id a card may carry, and holds q and limit to the shared contract', async () => {
    await listed('Bus')
    const search = async (params: Record<string, string>) => (await call('com.dinakernel.a2a.searchAgents', params)).status
    expect(await search({ skill: `eta_query@${'r'.repeat(MAX_ID_LENGTH - 'eta_query@'.length)}` })).toBe(200)
    expect(await search({ skill: 's'.repeat(MAX_ID_LENGTH + 1) })).toBe(400)
    expect(await search({ q: 'q'.repeat(A2A_DIRECTORY_QUERY_MAX_LENGTH) })).toBe(200)
    expect(await search({ q: 'q'.repeat(A2A_DIRECTORY_QUERY_MAX_LENGTH + 1) })).toBe(400)
    expect(await search({ limit: String(A2A_DIRECTORY_PAGE_MAX) })).toBe(200)
    expect(await search({ limit: String(A2A_DIRECTORY_PAGE_MAX + 1) })).toBe(400)
  })

  it('the band is resolve’s band for the same DID: scores, flags and a moderator’s tombstone all count', async () => {
    const flagged = await listed('Flagged', { trust: 0.9 })
    const subjectId = await resolveOrCreateSubject(db as never, { type: 'did', did: flagged.did }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
    await db.execute(sql`
      INSERT INTO flags (uri, author_did, cid, subject_id, subject_ref_raw, flag_type, severity, is_active, record_created_at)
      VALUES ('at://did:plc:authoraaaaaaaaaaaaaaaaaa/com.dinakernel.peerlens.flag/1', 'did:plc:authoraaaaaaaaaaaaaaaaaa',
              'bafyflag', ${subjectId}, ${JSON.stringify({ type: 'did', did: flagged.did })}::jsonb, 'scam', 'critical', true, now())`)
    const resolved = async (did: string) => {
      clearCache()
      const r = await resolve(db as never, { subject: JSON.stringify({ type: 'did', did }) })
      return { recommendation: r.recommendation, trustLevel: r.trustLevel, confidence: r.confidence }
    }
    const directoryView = async (did: string) => {
      const t = (await getCard(db as never, { did }, clock)).trust
      return { recommendation: t.recommendation, trustLevel: t.trustLevel, confidence: t.confidence }
    }
    const expected = await resolved(flagged.did)
    expect(await directoryView(flagged.did)).toEqual(expected)
    expect((await searchAgents(db as never, { limit: 20 }, clock)).agents.find((a) => a.did === flagged.did)?.recommendation).toBe(
      expected.recommendation,
    )
    // A moderator removes the DID as a subject: both say avoid, at trust level none.
    await db.execute(sql`UPDATE subjects SET tombstoned_at = now() WHERE id = ${subjectId}`)
    expect(await resolved(flagged.did)).toEqual({ recommendation: 'avoid', trustLevel: 'none', confidence: 0 })
    expect(await directoryView(flagged.did)).toEqual({ recommendation: 'avoid', trustLevel: 'none', confidence: 0 })
  })

  // Cold audit C3-11: resolve gives a tombstoned subject no trust, and the directory orders by what it reports
  describe('a DID a moderator tombstoned has no trust: it orders, pages and reports as 0', () => {
    const order = async (params: Record<string, unknown> = {}) =>
      (await searchAgents(db as never, { limit: 20, ...params } as never, clock)).agents.map((a) => [a.did, a.trustScore])

    it('its own subject tombstoned: below an honest card with little trust, in every view', async () => {
      const removed = await listed('Removed', { trust: 0.9 })
      const honest = await listed('Honest', { trust: 0.1 })
      const subjectId = await resolveOrCreateSubject(db as never, { type: 'did', did: removed.did }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      // Control: before the tombstone, the profile score orders.
      expect(await order()).toEqual([
        [removed.did, expect.closeTo(0.9, 5)],
        [honest.did, expect.closeTo(0.1, 5)],
      ])
      await db.execute(sql`UPDATE subjects SET tombstoned_at = now() WHERE id = ${subjectId}`)
      expect(await order()).toEqual([
        [honest.did, expect.closeTo(0.1, 5)],
        [removed.did, 0],
      ])
      expect((await getCard(db as never, { did: removed.did }, clock)).trust).toEqual({ score: 0, recommendation: 'avoid', trustLevel: 'none', confidence: 0 })
      // Page by page, the cursor carries the same order.
      const first = await searchAgents(db as never, { limit: 1 }, clock)
      expect(first.agents.map((a) => a.did)).toEqual([honest.did])
      const second = await searchAgents(db as never, { limit: 1, cursor: first.cursor ?? undefined }, clock)
      expect([second.agents.map((a) => [a.did, a.trustScore]), second.cursor]).toEqual([[[removed.did, 0]], null])
    })

    it('the subject it was merged into tombstoned: resolve follows the merge, and so does the directory', async () => {
      const merged = await listed('Merged', { trust: 0.9 })
      const honest = await listed('Honest', { trust: 0.1 })
      const own = await resolveOrCreateSubject(db as never, { type: 'did', did: merged.did }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      const root = await resolveOrCreateSubject(db as never, { type: 'organization', name: 'Merged Holdings' }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      await db.execute(sql`UPDATE subjects SET canonical_subject_id = ${root} WHERE id = ${own}`)
      await db.execute(sql`UPDATE subjects SET tombstoned_at = now() WHERE id = ${root}`)
      clearCache()
      expect((await resolve(db as never, { subject: JSON.stringify({ type: 'did', did: merged.did }) })).trustLevel).toBe('none')
      expect(await order()).toEqual([
        [honest.did, expect.closeTo(0.1, 5)],
        [merged.did, 0],
      ])
    })

    it('a tombstone on its own subject, merged since into a live one, does not count: resolve reads the live root', async () => {
      const kept = await listed('Kept', { trust: 0.9 })
      const own = await resolveOrCreateSubject(db as never, { type: 'did', did: kept.did }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      const root = await resolveOrCreateSubject(db as never, { type: 'organization', name: 'Kept Holdings' }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      await db.execute(sql`UPDATE subjects SET canonical_subject_id = ${root}, tombstoned_at = now() WHERE id = ${own}`)
      clearCache()
      expect((await resolve(db as never, { subject: JSON.stringify({ type: 'did', did: kept.did }) })).trustLevel).not.toBe('none')
      expect(await order()).toEqual([[kept.did, expect.closeTo(0.9, 5)]])
      expect((await getCard(db as never, { did: kept.did }, clock)).trust.score).toBeCloseTo(0.9, 5)
    })

    it('control: a tombstone on a subject merged into this DID’s leaves this DID’s trust alone', async () => {
      const kept = await listed('Kept', { trust: 0.9 })
      const own = await resolveOrCreateSubject(db as never, { type: 'did', did: kept.did }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      const leaf = await resolveOrCreateSubject(db as never, { type: 'organization', name: 'Old name' }, 'did:plc:authoraaaaaaaaaaaaaaaaaa')
      await db.execute(sql`UPDATE subjects SET canonical_subject_id = ${own} WHERE id = ${leaf}`)
      await db.execute(sql`UPDATE subjects SET tombstoned_at = now() WHERE id = ${leaf}`)
      expect(await order()).toEqual([[kept.did, expect.closeTo(0.9, 5)]])
    })
  })

  it('each result is index facts only: the trust band beside, the card hash, never a changed card', async () => {
    const p = await listed('Trusted', { trust: 0.9, skills: ['eta_query', 'price_check@shop'] })
    const [agent] = (await searchAgents(db as never, { limit: 20 }, clock)).agents
    expect(agent).toEqual({
      did: p.did,
      displayName: 'Trusted',
      endpoint: 'https://agent.example/a2a/v1',
      skills: ['eta_query', 'price_check@shop'],
      trustScore: expect.closeTo(0.9, 5),
      recommendation: expect.stringMatching(/^(proceed|caution|verify|avoid)$/),
      indexedAt: new Date(clock).toISOString(),
      stale: false,
      cardHash: (await cardRow(p.did))?.card_hash,
    })
  })
})
