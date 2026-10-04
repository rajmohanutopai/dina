/**
 * The A2A directory's two methods (design §8.3) against REAL POSTGRES: every
 * gate on searchAgents as on getCard, no search while draining, skill and
 * text together, the parameter refusals, paging with text and ties, and
 * getCard's staleness at its boundary. Real signatures; only the PLC
 * directory is scripted.
 *
 * Run (your own database):
 *   DATABASE_URL=postgresql://dina:dina@localhost:55432/<db> \
 *     npx vitest run tests/integration/lane3_directory_serving.test.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { A2A_CARD_COLLECTION, A2A_DIRECTORY_PAGE_MAX } from '@dina/a2a'

import { A2ADirectory, type A2ACommitEvent } from '@/ingester/a2a-directory.js'
import { A2A_CARD_STALE_AFTER_MS, getCard, searchAgents } from '@/api/xrpc/a2a-directory.js'
import { restoreA2ACard, takedownA2ACard } from '@/admin/peerlens-moderation-cli.js'
import { setBoolFlag } from '@/db/queries/appview-config.js'
import type { DidResolution } from '@/shared/a2a/did-resolver.js'
import { dispatchXrpc } from '@/web/xrpc-dispatch.js'
import { XRPC_ROUTES } from '@/web/xrpc-routes.js'

import { cardRecord, didDocument, newCid, newDid, newKeys, revOf, type CardOptions, type Keys } from '../a2a-fixture.js'
import { cleanAllTables, closeTestDb, getTestDb } from '../test-db.js'

const db = getTestDb()
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
const noMetrics = { incr: () => undefined, gauge: () => undefined, histogram: () => undefined, counter: () => undefined }
const DAY = 24 * 60 * 60 * 1000
const OP = 'did:plc:operatoraaaaaaaaaaaaaaaa'

let clock: number
let docs: Map<string, unknown>
let unreachable: Set<string>
let dir: A2ADirectory

function directory(): A2ADirectory {
  return new A2ADirectory({
    db: db as never,
    resolveDid: async (did): Promise<DidResolution> => {
      if (unreachable.has(did)) return { kind: 'unavailable' }
      const doc = docs.get(did)
      return doc === undefined ? { kind: 'not_found' } : { kind: 'document', document: doc }
    },
    rejection: { logger: silent as never, metrics: noMetrics as never },
    log: silent,
    retentionUs: DAY * 1000,
    now: () => clock,
    sleep: () => new Promise((r) => setImmediate(r)),
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
function commit(p: Publisher, rev: number, operation: 'create' | 'update' | 'delete', record?: Record<string, unknown>): A2ACommitEvent {
  timeUs += 1
  const base = { did: p.did, time_us: timeUs, kind: 'commit' as const }
  if (operation === 'delete') return { ...base, commit: { rev: revOf(rev), operation, collection: A2A_CARD_COLLECTION, rkey: 'self' } }
  return { ...base, commit: { rev: revOf(rev), operation, collection: A2A_CARD_COLLECTION, rkey: 'self', record: record ?? {}, cid: newCid() } }
}
const gen = () => dir.currentGapGeneration()
async function put(p: Publisher, rev: number, o: CardOptions = {}, operation: 'create' | 'update' = 'update'): Promise<A2ACommitEvent> {
  const event = commit(p, rev, operation, await cardRecord(p.did, p.keys, o))
  await dir.receive(event, await gen())
  return event
}
const enable = () => setBoolFlag(db as never, 'a2a_directory_enabled', true)
const step = () => dir.step()

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows
}
async function served(did: string): Promise<string | null> {
  try {
    return (await getCard(db as never, { did }, clock)).card
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}
const call = (method: string, params: Record<string, string>) =>
  dispatchXrpc({ routes: XRPC_ROUTES, db, methodId: method, searchParams: new URLSearchParams(params) })

/** A card listed and processed now, with a trust score and an index time if given. */
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
const names = async (params: Record<string, unknown> = {}) =>
  (await searchAgents(db as never, { limit: A2A_DIRECTORY_PAGE_MAX, ...params } as never, clock)).agents.map((a) => a.displayName)

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

describe('every gate holds on searchAgents as on getCard', () => {
  beforeEach(enable)

  // Plan F107, F117, F118, F119, F127
  it('a deleted, re-keyed, superseded, conflicting, inactive, taken-down, redacted or unproved card is absent from search and not found', async () => {
    const clean = await listed('Clean')
    const deleted = await listed('Deleted')
    const rekeyed = await listed('Rekeyed')
    const superseded = await listed('Superseded')
    const conflicting = await listed('Conflicting')
    const inactive = await listed('Inactive')
    const takenDown = await listed('Taken down')
    const redacted = await listed('Redacted')
    const withheld = [deleted, rekeyed, superseded, conflicting, inactive, takenDown, redacted]
    // Before any gate, every card is searchable and served.
    expect((await names()).sort()).toEqual(['Clean', 'Conflicting', 'Deleted', 'Inactive', 'Redacted', 'Rekeyed', 'Superseded', 'Taken down'])
    for (const p of withheld) expect({ did: p.did, served: (await served(p.did)) !== null }).toEqual({ did: p.did, served: true })

    // One gate for each.
    await dir.receive(commit(deleted, 2, 'delete'), await gen())
    docs.set(rekeyed.did, didDocument(rekeyed.did, newKeys()))
    await dir.noteIdentity(rekeyed.did)
    await put(superseded, 2, { name: 'Superseded', skills: ['teleport'] })
    await put(conflicting, 2, { name: 'Conflicting v2' })
    await step()
    await dir.receive(commit(conflicting, 2, 'delete'), await gen())
    await dir.noteAccount(inactive.did, false, timeUs + 10)
    await takedownA2ACard(db as never, { did: takenDown.did, actorDid: OP, reason: 'spam' })
    await db.execute(sql`INSERT INTO did_redactions (did, reason) VALUES (${redacted.did}, 'gdpr')`)
    await step()

    // Each card's row differs from the clean one only by its own gate.
    const rows = await q<{ did: string }>(sql`
      SELECT did, presence, signature_state, unavailable, unavailable_reason, account_active, proved_generation,
             evidence_json ->> 'kind' AS evidence_kind, evidence_json ->> 'reason' AS evidence_reason
        FROM a2a_cards`)
    const rowOf = (p: Publisher) => {
      const row = rows.find((r) => r.did === p.did)
      if (row === undefined) return undefined
      const { did: _did, ...rest } = row
      return rest
    }
    const cleanRow = {
      presence: 'present',
      signature_state: 'verified',
      unavailable: false,
      unavailable_reason: null,
      account_active: true,
      proved_generation: 0,
      evidence_kind: null,
      evidence_reason: null,
    }
    expect(rowOf(clean)).toEqual(cleanRow)
    expect(rowOf(deleted)).toEqual({ ...cleanRow, presence: 'deleted', signature_state: 'none' })
    expect(rowOf(rekeyed)).toEqual({ ...cleanRow, signature_state: 'invalid', evidence_kind: 'revalidation', evidence_reason: 'card_signature' })
    expect(rowOf(superseded)).toEqual({
      ...cleanRow,
      signature_state: 'invalid',
      unavailable: true,
      unavailable_reason: 'newer_invalid',
      evidence_kind: 'newer_invalid',
      evidence_reason: 'skill_unknown',
    })
    expect(rowOf(conflicting)).toEqual({ ...cleanRow, unavailable: true, unavailable_reason: 'equal_rev_conflict', evidence_kind: 'equal_rev_conflict' })
    expect(rowOf(inactive)).toEqual({ ...cleanRow, account_active: false })
    // The taken-down and redacted rows are clean: only their takedown or redaction withholds them.
    expect(rowOf(takenDown)).toEqual(cleanRow)
    expect(rowOf(redacted)).toEqual(cleanRow)
    expect(await q(sql`SELECT did FROM a2a_card_takedowns`)).toEqual([{ did: takenDown.did }])
    expect(await q(sql`SELECT did FROM did_redactions`)).toEqual([{ did: redacted.did }])

    expect(await names()).toEqual(['Clean'])
    for (const skill of ['eta_query', 'bus_eta']) expect(await names({ skill })).toEqual(['Clean'])
    // Every card's description matches the text; only the clean one is a candidate.
    expect(await names({ q: 'arrival' })).toEqual(['Clean'])
    for (const p of withheld) expect({ did: p.did, card: await served(p.did) }).toEqual({ did: p.did, card: null })
    expect(await served(clean.did)).not.toBeNull()

    // A gap: every card lags until a newer valid event received under the new generation proves it.
    await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)
    expect(await names()).toEqual([])
    expect(await served(clean.did)).toBeNull()
    await put(clean, 2, { name: 'Clean' })
    await step()
    expect(await names()).toEqual(['Clean'])
    // Lifting the takedown does not prove a card the gap left unproved.
    await restoreA2ACard(db as never, { did: takenDown.did, actorDid: OP, reason: 'appeal' })
    expect(await q(sql`SELECT did FROM a2a_card_takedowns`)).toEqual([])
    expect(await names()).toEqual(['Clean'])
    // Control: with the takedown lifted, the gap is all that held it, and a newer valid event proves it.
    await put(takenDown, 2, { name: 'Taken down' })
    await step()
    expect((await names()).sort()).toEqual(['Clean', 'Taken down'])
  })
})

describe('serving waits for the drain', () => {
  // Plan F111
  it('searchAgents refuses while the directory drains, as getCard does, and answers once it is ready', async () => {
    const p = publisher()
    await put(p, 1, {}, 'create')
    unreachable.add(p.did)
    await enable()
    await step()
    expect((await q<{ phase: string }>(sql`SELECT phase FROM a2a_directory_state WHERE id = 1`))[0]?.phase).toBe('draining')
    expect(await call('com.dinakernel.a2a.searchAgents', {})).toEqual({
      status: 503,
      body: { error: 'DirectoryUnavailable', message: 'the agent directory is not open' },
    })
    expect(await call('com.dinakernel.a2a.searchAgents', { skill: 'eta_query', q: 'bus' })).toEqual(expect.objectContaining({ status: 503 }))
    unreachable.delete(p.did)
    await db.execute(sql`UPDATE a2a_event_spool SET not_before = NULL`)
    await step()
    expect(await call('com.dinakernel.a2a.searchAgents', {})).toEqual(expect.objectContaining({ status: 200 }))
  })
})

describe('searchAgents: the parameters', () => {
  beforeEach(enable)

  // Plan F131
  it('skill and text together give the cards that match both', async () => {
    await listed('Bus fast', { description: 'Bus arrivals', skills: ['eta_query'] })
    await listed('Bus shop', { description: 'Bus tickets', skills: ['price_check@shop'] })
    await listed('Train', { description: 'Train arrivals', skills: ['eta_query'] })
    expect(await names({ skill: 'eta_query', q: 'bus' })).toEqual(['Bus fast'])
    expect((await names({ skill: 'eta_query' })).sort()).toEqual(['Bus fast', 'Train'])
    expect((await names({ q: 'bus' })).sort()).toEqual(['Bus fast', 'Bus shop'])
    expect(await names({ skill: 'price_check@shop', q: 'train' })).toEqual([])
  })

  // Plan F134
  it.each([
    ['a cursor that is not base64 JSON', { cursor: 'not a cursor!!' }],
    ['a cursor that decodes to nothing it issued', { cursor: Buffer.from('{"x":1}').toString('base64url') }],
    ['a cursor that is not JSON', { cursor: Buffer.from('garbage').toString('base64url') }],
    ['limit 0', { limit: '0' }],
    ['limit past the page maximum', { limit: String(A2A_DIRECTORY_PAGE_MAX + 1) }],
    ['a negative limit', { limit: '-1' }],
    ['a fractional limit', { limit: '1.5' }],
    ['a limit that is not a number', { limit: 'ten' }],
    ['an empty skill', { skill: '' }],
    ['an empty q', { q: '' }],
  ])('%s is refused with 400', async (_name, params) => {
    await listed('Bus')
    expect(await call('com.dinakernel.a2a.searchAgents', params)).toEqual(
      expect.objectContaining({ status: 400, body: expect.objectContaining({ error: 'InvalidRequest' }) }),
    )
  })

  // Plan F135
  it('pages with text and ties: every matching card once, in the order one page would give', async () => {
    for (let i = 0; i < 7; i++) await listed(`Tied ${i}`, { description: 'bus arrivals', trust: 0.5 })
    await listed('Trusted', { description: 'bus arrivals', trust: 0.9 })
    await listed('More words', { description: 'bus bus arrivals bus', trust: 0.5 })
    await listed('Unrelated', { description: 'bread', trust: 1 })
    const whole = await names({ q: 'bus' })
    expect(whole).toHaveLength(9)
    expect(whole[0]).toBe('Trusted')
    const paged: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await searchAgents(db as never, { q: 'bus', limit: 2, ...(cursor !== undefined ? { cursor } : {}) }, clock)
      paged.push(...page.agents.map((a) => a.displayName))
      cursor = page.cursor ?? undefined
      pages += 1
    } while (cursor !== undefined && pages < 20)
    expect(paged).toEqual(whole)
  })
})

describe('getCard: staleness at its boundary', () => {
  beforeEach(enable)

  // Plan F139
  it('a card indexed exactly 30 days ago is stale; one millisecond younger is fresh', async () => {
    const p = await listed('Bus')
    const indexedAt = clock
    expect((await getCard(db as never, { did: p.did }, indexedAt + A2A_CARD_STALE_AFTER_MS - 1)).stale).toBe(false)
    expect((await getCard(db as never, { did: p.did }, indexedAt + A2A_CARD_STALE_AFTER_MS)).stale).toBe(true)
    expect((await getCard(db as never, { did: p.did }, indexedAt + A2A_CARD_STALE_AFTER_MS + 1)).stale).toBe(true)
    // Staleness only labels the card: getCard still serves it.
    expect((await getCard(db as never, { did: p.did }, indexedAt + 90 * DAY)).card).toBe((await getCard(db as never, { did: p.did }, indexedAt)).card)
  })
})

// Plan F138
it('a DID with no card at all is not found, and a malformed one is refused', async () => {
  await enable()
  await step()
  expect(await call('com.dinakernel.a2a.getCard', { did: newDid() })).toEqual({ status: 404, body: { error: 'NotFound', message: 'no agent card for that DID' } })
  for (const did of ['', 'did:plc:short', 'did:key:z6Mk', `${newDid()}/x`]) {
    expect((await call('com.dinakernel.a2a.getCard', { did })).status).toBe(400)
  }
})
