/**
 * The A2A directory's ingest (design §8.3) against REAL POSTGRES: the rows
 * the first test run proved only with throwaway probes. The spool under a
 * failing write, U+0000, two processors at once, did:web, a dina_signing
 * rotation, a deactivated DID, a first publish checked before PLC names its
 * card key, late replays across a gap, an account known only by a spool
 * row, the 14-day cadence bump, a listing that drops a skill, and a card
 * deleted inside a gap. Real signatures; only the PLC directory is scripted.
 *
 * Run (your own database):
 *   DATABASE_URL=postgresql://dina:dina@localhost:55432/<db> \
 *     npx vitest run tests/integration/lane3_directory_ingest.test.ts
 */

import { sign as nodeSign } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { A2A_CARD_COLLECTION, A2A_SELF_RKEY, signDirectoryEnvelope } from '@dina/a2a'

import { A2A_DRAIN_PASS_MAX, A2A_PROCESS_RETRY_MS, A2ADirectory, type A2ACommitEvent } from '@/ingester/a2a-directory.js'
import { BoundedIngestionQueue, type QueueItem } from '@/ingester/bounded-queue.js'
import { JetstreamConsumer } from '@/ingester/jetstream-consumer.js'
import { A2A_CARD_STALE_AFTER_MS, getCard, searchAgents } from '@/api/xrpc/a2a-directory.js'
import { setBoolFlag } from '@/db/queries/appview-config.js'
import { createPlcDidResolver, type DidResolution, type DidResolver } from '@/shared/a2a/did-resolver.js'
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
let deactivated: Set<string>
let dir: A2ADirectory

const scriptedResolver: DidResolver = async (did): Promise<DidResolution> => {
  if (unreachable.has(did)) return { kind: 'unavailable' }
  if (deactivated.has(did)) return { kind: 'deactivated' }
  const doc = docs.get(did)
  return doc === undefined ? { kind: 'not_found' } : { kind: 'document', document: doc }
}

function directory(over: Partial<ConstructorParameters<typeof A2ADirectory>[0]> = {}): A2ADirectory {
  return new A2ADirectory({
    db: db as never,
    resolveDid: scriptedResolver,
    rejection: { logger: silent as never, metrics: noMetrics as never },
    log: silent,
    retentionUs: DAY * 1000,
    now: () => clock,
    sleep: () => new Promise((r) => setImmediate(r)),
    ...over,
  })
}

/**
 * The real PLC resolver over a scripted PLC directory: 410 for a deactivated
 * DID, 404 for an unknown one, else the document. Each answer is noted as
 * "<status> <url>".
 */
function plcResolver(answered: string[]): DidResolver {
  return createPlcDidResolver({
    plcUrl: 'https://plc.example',
    fetch: (async (url: string | URL) => {
      const did = String(url).slice('https://plc.example/'.length)
      const doc = docs.get(did)
      const response = deactivated.has(did)
        ? new Response('gone', { status: 410 })
        : doc === undefined
          ? new Response('not found', { status: 404 })
          : new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/did+ld+json' } })
      answered.push(`${response.status} ${String(url)}`)
      return response
    }) as typeof fetch,
  })
}

interface Publisher {
  did: string
  keys: Keys
}
function publisher(did = newDid()): Publisher {
  const keys = newKeys()
  docs.set(did, didDocument(did, keys))
  return { did, keys }
}

let timeUs = 1_000
function commit(p: Publisher, rev: number, operation: 'create' | 'update' | 'delete', record?: Record<string, unknown>): A2ACommitEvent {
  timeUs += 1
  const base = { did: p.did, time_us: timeUs, kind: 'commit' as const }
  if (operation === 'delete') {
    return { ...base, commit: { rev: revOf(rev), operation, collection: A2A_CARD_COLLECTION, rkey: 'self' } }
  }
  return { ...base, commit: { rev: revOf(rev), operation, collection: A2A_CARD_COLLECTION, rkey: 'self', record: record ?? {}, cid: newCid() } }
}
const gen = () => dir.currentGapGeneration()
async function put(p: Publisher, rev: number, o: CardOptions = {}, operation: 'create' | 'update' = 'update'): Promise<A2ACommitEvent> {
  const event = commit(p, rev, operation, await cardRecord(p.did, p.keys, o))
  await dir.receive(event, await gen())
  return event
}
const del = async (p: Publisher, rev: number) => dir.receive(commit(p, rev, 'delete'), await gen())
const enable = () => setBoolFlag(db as never, 'a2a_directory_enabled', true)
const disable = () => setBoolFlag(db as never, 'a2a_directory_enabled', false)
const step = () => dir.step()

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows
}
const stateRow = async () => (await q<{ phase: string; gap_generation: number }>(sql`SELECT phase, gap_generation FROM a2a_directory_state WHERE id = 1`))[0]
const cardRow = async (did: string) => (await q<Record<string, unknown>>(sql`SELECT * FROM a2a_cards WHERE did = ${did}`))[0]
const spool = async (did: string) =>
  q<{ id: number; status: string; outcome: string | null; observed_gap_generation: number; repo_rev: string }>(
    sql`SELECT id, status, outcome, observed_gap_generation, repo_rev FROM a2a_event_spool WHERE did = ${did} ORDER BY id`,
  )

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
const listed = async (params: Record<string, unknown> = {}) =>
  (await searchAgents(db as never, { limit: 50, ...params } as never, clock)).agents.map((a) => a.did)
const call = (method: string, params: Record<string, string>) =>
  dispatchXrpc({ routes: XRPC_ROUTES, db, methodId: method, searchParams: new URLSearchParams(params) })

beforeEach(async () => {
  await cleanAllTables(db)
  await db.execute(sql`INSERT INTO a2a_directory_state (id, phase) VALUES (1, 'disabled') ON CONFLICT (id) DO NOTHING`)
  clock = Date.parse('2026-10-03T12:00:00Z')
  docs = new Map()
  unreachable = new Set()
  deactivated = new Set()
  dir = directory()
})
afterAll(async () => {
  await closeTestDb()
})

describe('recording: backpressure over loss', () => {
  // Plan F5
  it('a card event the spool cannot take yet holds the queue’s cursor and is retried until it lands, never dead-lettered', async () => {
    const p = publisher()
    let failing = true
    let failures = 0
    let sawFive!: () => void
    const fiveFailures = new Promise<void>((r) => (sawFive = r))
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async (query: unknown) => {
            if (failing) {
              failures += 1
              throw new Error('connection refused')
            }
            return (target as unknown as { execute: (x: unknown) => Promise<unknown> }).execute(query)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const flakyDir = directory({
      db: flaky as never,
      sleep: async () => {
        if (failures === 5) sawFive()
        await new Promise((r) => setImmediate(r))
      },
    })
    // The consumer's own processing path, with the directory wired in as main.ts wires it.
    const consumer = new JetstreamConsumer(db as never)
    consumer.setA2ADirectory(flakyDir)
    const processEvent = (consumer as unknown as { processEvent: (e: unknown, c?: unknown) => Promise<void> }).processEvent.bind(consumer)
    let deliveries = 0
    let processed!: () => void
    const done = new Promise<void>((r) => (processed = r))
    const queue = new BoundedIngestionQueue(async (item: QueueItem) => {
      deliveries += 1
      await processEvent(item.data, item.context)
      processed()
    })
    const event = commit(p, 1, 'create', await cardRecord(p.did, p.keys))
    expect(queue.push({ data: event, timestampUs: event.time_us, context: { a2aGeneration: 0 } }, { required: true })).toBe(true)
    await fiveFailures
    // More failures than the queue's retry limit (3), yet the event is still held, delivered once.
    expect(queue.getSafeCursor()).toBe(event.time_us)
    expect(deliveries).toBe(1)
    expect(await spool(p.did)).toEqual([])
    failing = false
    await done
    expect(deliveries).toBe(1)
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'pending', observed_gap_generation: 0 })])
    // Processed now, the event no longer holds the cursor.
    await new Promise((r) => setImmediate(r))
    expect(queue.getSafeCursor()).toBeNull()
  })

  // Plan F13
  it('U+0000 in a record never stalls the spool: the row lands holding it, the card is refused, and the next events go on', async () => {
    await enable()
    // A spool write that fails is retried until it lands, so one that can never land stalls the spool.
    // Here a failed write ends the test at once: every write must land the first time.
    dir = directory({ sleep: () => Promise.reject(new Error('a spool write failed and was retried')) })
    const nul = publisher()
    const nulInCard = publisher()
    const next = publisher()
    // U+0000 in a record field outside the card string: JSON text keeps it as the escape \u0000, which jsonb refuses.
    const nulEndpoint = 'https://agent.example/a2a/v1\u0000'
    await put(nul, 1, { tamperRecord: (r) => void (r.endpoint = nulEndpoint) }, 'create')
    const stored = await q<{ status: string; payload: string }>(sql`SELECT status, payload FROM a2a_event_spool WHERE did = ${nul.did}`)
    expect(stored.map((r) => r.status)).toEqual(['pending'])
    expect(stored[0]?.payload).toContain('\\u0000')
    expect((JSON.parse(stored[0]?.payload ?? '{}') as { record: { endpoint: string } }).record.endpoint).toBe(nulEndpoint)
    // U+0000 inside the card string too.
    await put(nulInCard, 1, { name: 'Bus\u000042' }, 'create')
    expect(await spool(nulInCard.did)).toEqual([expect.objectContaining({ status: 'pending' })])
    await put(next, 1, { name: 'After' }, 'create')
    await step()
    expect(await spool(nul.did)).toEqual([expect.objectContaining({ status: 'done', outcome: 'suppressed:sibling_endpoint' })])
    expect(await spool(nulInCard.did)).toEqual([expect.objectContaining({ status: 'done', outcome: 'suppressed:card_nul_character' })])
    expect(await served(nul.did)).toBeNull()
    expect(await served(nulInCard.did)).toBeNull()
    expect(await servedName(next.did)).toBe('After')
    // The same repository's next valid record goes through too.
    await put(nul, 2, { name: 'Bus 42' })
    await step()
    expect(await servedName(nul.did)).toBe('Bus 42')
  })
})

describe('processing', () => {
  // Plan F35
  it('a PLC directory that does not answer: retried at 5 s, 30 s, 2 min, 10 min, then every 30 min, and nothing applied meanwhile', async () => {
    await enable()
    const p = publisher()
    unreachable.add(p.did)
    await put(p, 1, {}, 'create')
    const delays = [5, 30, 120, 600, 1800, 1800]
    for (const [i, delay] of delays.entries()) {
      await step()
      const [row] = await q<{ wait_s: number; attempts: number; outcome: string }>(
        sql`SELECT EXTRACT(EPOCH FROM (not_before - now()))::float8 AS wait_s, attempts, outcome FROM a2a_event_spool WHERE did = ${p.did}`,
      )
      expect(row).toEqual(expect.objectContaining({ attempts: i + 1, outcome: 'retry:did_unavailable' }))
      // Read a moment after it was set, the wait is a little under its delay and never over it.
      const wait = Number(row?.wait_s)
      expect({ delay, wait, within: wait > delay - 2 && wait <= delay }).toEqual({ delay, wait, within: true })
      expect(await cardRow(p.did)).toBeUndefined()
      await db.execute(sql`UPDATE a2a_event_spool SET not_before = NULL WHERE did = ${p.did}`)
    }
    expect(A2A_PROCESS_RETRY_MS).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000])
    unreachable.delete(p.did)
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
  })

  // Plan F37
  it('two processors on one spool (a rolling deploy): both work, each event is checked once, in revision order, and the newest revision wins', async () => {
    // More repositories than one claim takes (25): while one processor holds its rows, the other still finds work.
    const pubs = Array.from({ length: 30 }, () => publisher())
    for (const p of pubs) {
      await put(p, 1, { name: `${p.did} r1` }, 'create')
      await put(p, 2, { name: `${p.did} r2` })
      await put(p, 3, { name: `${p.did} r3` })
    }
    await enable()
    // Each processor records the DIDs it checks. Its first check waits until the other
    // has claimed work too, and every check yields, so the two run side by side.
    const seenA: string[] = []
    const seenB: string[] = []
    let aStarted!: () => void
    let bStarted!: () => void
    const aHasWork = new Promise<void>((r) => (aStarted = r))
    const bHasWork = new Promise<void>((r) => (bStarted = r))
    const recording =
      (seen: string[], started: () => void, otherHasWork: Promise<void>): DidResolver =>
      async (did) => {
        seen.push(did)
        started()
        await otherHasWork
        await new Promise((r) => setImmediate(r))
        return scriptedResolver(did)
      }
    const a = directory({ resolveDid: recording(seenA, aStarted, bHasWork) })
    const b = directory({ resolveDid: recording(seenB, bStarted, aHasWork) })
    await Promise.all([a.step(), b.step()])
    await a.step()
    expect(seenA.length).toBeGreaterThan(0)
    expect(seenB.length).toBeGreaterThan(0)
    // 30 repositories, three revisions each: every event checked once, by one processor or the other.
    expect([...seenA, ...seenB].sort()).toEqual(pubs.flatMap((p) => [p.did, p.did, p.did]).sort())
    for (const p of pubs) {
      const rows = await spool(p.did)
      expect(rows.map((r) => [r.repo_rev, r.status, r.outcome])).toEqual([
        [revOf(1), 'done', 'applied'],
        [revOf(2), 'done', 'applied'],
        [revOf(3), 'done', 'applied'],
      ])
      expect(await cardRow(p.did)).toEqual(expect.objectContaining({ repo_rev: revOf(3) }))
      expect(await servedName(p.did)).toBe(`${p.did} r3`)
    }
  })
})

describe('publishers the directory refuses', () => {
  // Plan F70
  it('a did:web publisher is refused through the real resolver and never served; a did:plc one is', async () => {
    await enable()
    const answered: string[] = []
    dir = directory({ resolveDid: plcResolver(answered) })
    const web = publisher('did:web:agent.example')
    const plc = publisher()
    await put(web, 1, { name: 'Web agent' }, 'create')
    await put(plc, 1, { name: 'PLC agent' }, 'create')
    await step()
    expect(answered).toEqual([`200 https://plc.example/${plc.did}`])
    expect(await cardRow(web.did)).toEqual(
      expect.objectContaining({ unavailable: true, evidence_json: expect.objectContaining({ reason: 'did_unsupported' }) }),
    )
    expect(await served(web.did)).toBeNull()
    expect(await call('com.dinakernel.a2a.getCard', { did: web.did })).toEqual(expect.objectContaining({ status: 404 }))
    expect(await listed()).toEqual([plc.did])
    expect(await servedName(plc.did)).toBe('PLC agent')
  })
})

describe('keys', () => {
  // Plan F87
  it('a rotation of dina_signing alone withholds the card (the envelope no longer verifies); a republish under the new key restores it', async () => {
    await enable()
    const p = publisher()
    await put(p, 1, { name: 'v1' }, 'create')
    await step()
    const rotated = newKeys()
    docs.set(p.did, didDocument(p.did, p.keys, { dinaSigning: rotated.ed.raw }))
    await dir.noteIdentity(p.did)
    await step()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ signature_state: 'invalid', evidence_json: { kind: 'revalidation', reason: 'envelope_signature' } }),
    )
    expect(await served(p.did)).toBeNull()
    expect(await listed()).toEqual([])
    // The card key never changed: only the envelope is re-signed.
    await put({ did: p.did, keys: { ed: rotated.ed, p256: p.keys.p256 } }, 2, { name: 'v2' })
    await step()
    expect(await servedName(p.did)).toBe('v2')
  })

  // Plan F88
  it('a DID the PLC directory has since deactivated (410) is caught by the daily check and withheld, with the reason as evidence', async () => {
    await enable()
    const answered: string[] = []
    dir = directory({ resolveDid: plcResolver(answered) })
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
    deactivated.add(p.did)
    // No identity event reaches AppView: within the day nothing asks PLC again.
    await step()
    expect(answered).toEqual([`200 https://plc.example/${p.did}`])
    expect(await servedName(p.did)).toBe('Bus 42')
    // A day later the periodic check runs, and PLC answers 410.
    clock += DAY + 1
    await step()
    await step()
    expect(answered).toEqual([`200 https://plc.example/${p.did}`, `410 https://plc.example/${p.did}`])
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ signature_state: 'invalid', evidence_json: { kind: 'revalidation', reason: 'did_deactivated' } }),
    )
    expect(await served(p.did)).toBeNull()
    expect(await listed()).toEqual([])
  })

  /** A first publish checked while AppView's view of the DID document has no #a2a_card key yet. */
  async function publishedBeforeTheKey(): Promise<Publisher> {
    const p = { did: newDid(), keys: newKeys() }
    docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
    await put(p, 1, {}, 'create')
    await step()
    expect((await spool(p.did)).map((r) => r.outcome)).toEqual(['suppressed:card_key_missing'])
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ unavailable: true, unavailable_reason: 'newer_invalid', evidence_json: expect.objectContaining({ reason: 'card_key_missing' }) }),
    )
    expect(await served(p.did)).toBeNull()
    return p
  }

  // Plan X-3
  it('a first publish raced by PLC propagation is withheld, checked again on an identity event, and served once the document names the key', async () => {
    await enable()
    const p = await publishedBeforeTheKey()
    // An identity event while the key is still missing: checked again from the cited spool row, still withheld.
    await dir.noteIdentity(p.did)
    await step()
    expect(await served(p.did)).toBeNull()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({ unavailable_reason: 'newer_invalid', evidence_json: expect.objectContaining({ revalidation: { reason: 'card_key_missing' } }) }),
    )
    // The key reaches PLC, and its identity event reaches AppView.
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
    expect(await listed()).toEqual([p.did])
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ unavailable: false, signature_state: 'verified', evidence_json: null }))
  })

  // Dual review CX-6 (design §8.3: a verified card never outlives the key that justified it)
  it('an identity event during a withheld card’s check keeps it withheld: the verdict made against the old document never lands', async () => {
    await enable()
    const p = await publishedBeforeTheKey()
    // The key reaches PLC, and its identity event reaches AppView...
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    // ...but while that check reads the document, the key is taken out again, and that identity event arrives too.
    let raced = false
    dir = directory({
      resolveDid: async (did) => {
        const seen = await scriptedResolver(did)
        if (!raced && did === p.did) {
          raced = true
          docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
          await dir.noteIdentity(p.did)
        }
        return seen
      },
    })
    await step()
    expect(raced).toBe(true)
    // The check passed against the document as it was; the card is still withheld, marked for another check.
    expect(await served(p.did)).toBeNull()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ unavailable_reason: 'newer_invalid', needs_revalidation: true }))
    // The next check reads the document as it is now: still no key, still withheld.
    await step()
    expect(await served(p.did)).toBeNull()
    expect(await cardRow(p.did)).toEqual(
      expect.objectContaining({
        unavailable_reason: 'newer_invalid',
        needs_revalidation: false,
        evidence_json: expect.objectContaining({ revalidation: { reason: 'card_key_missing' } }),
      }),
    )
    // Control: the key back for good, and the card is served.
    docs.set(p.did, didDocument(p.did, p.keys))
    await dir.noteIdentity(p.did)
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
  })

  // Dual review CX-6, the served card's check
  it('an identity event during a served card’s check leaves the mark: the next check withholds the card if the key went', async () => {
    await enable()
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
    const before = (await cardRow(p.did))?.verified_at
    clock += 60_000
    await dir.noteIdentity(p.did)
    let raced = false
    dir = directory({
      resolveDid: async (did) => {
        const seen = await scriptedResolver(did)
        if (!raced && did === p.did) {
          raced = true
          // The rotation that removes the card key lands while the old document is being checked against.
          docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
          await dir.noteIdentity(p.did)
        }
        return seen
      },
    })
    await step()
    expect(raced).toBe(true)
    // Nothing landed from the old document: the mark stands and the last check's time is unchanged.
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ needs_revalidation: true, verified_at: before }))
    await step()
    expect(await served(p.did)).toBeNull()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ signature_state: 'invalid', needs_revalidation: false }))
  })

  // Dual review CX-8 (design §8.3: verified status never outlives its key)
  it('a check that throws keeps its card marked under its lease, the others go on, and it is checked again once the lease ends', async () => {
    await enable()
    const [a, b] = [publisher(), publisher()]
    for (const p of [a, b]) await put(p, 1, {}, 'create')
    await step()
    expect([await servedName(a.did), await servedName(b.did)]).toEqual(['Bus 42', 'Bus 42'])
    // Both card keys leave their documents.
    for (const p of [a, b]) {
      docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
      await dir.noteIdentity(p.did)
    }
    let threw = false
    dir = directory({
      resolveDid: async (did) => {
        if (did === a.did && !threw) {
          threw = true
          throw new Error('resolver fault')
        }
        return scriptedResolver(did)
      },
    })
    await step()
    expect(threw).toBe(true)
    // b's check landed; a's did not, and a is still marked, held by the lease.
    expect(await served(b.did)).toBeNull()
    expect(await cardRow(a.did)).toEqual(expect.objectContaining({ needs_revalidation: true, signature_state: 'verified' }))
    const leased = await q<{ leased: boolean }>(sql`SELECT revalidate_after > now() AS leased FROM a2a_cards WHERE did = ${a.did}`)
    expect(leased).toEqual([{ leased: true }])
    // The lease ends: the next pass checks a against the document as it is.
    await db.execute(sql`UPDATE a2a_cards SET revalidate_after = now() - interval '1 second' WHERE did = ${a.did}`)
    await step()
    expect(await served(a.did)).toBeNull()
    expect(await cardRow(a.did)).toEqual(expect.objectContaining({ needs_revalidation: false, signature_state: 'invalid' }))
  })

  // Dual review CX-8
  it('a pass that dies holding its cards loses none: another takes them once their lease ends', async () => {
    await enable()
    const [a, b] = [publisher(), publisher()]
    for (const p of [a, b]) await put(p, 1, {}, 'create')
    await step()
    for (const p of [a, b]) {
      docs.set(p.did, didDocument(p.did, p.keys, { cardKey: null }))
      await dir.noteIdentity(p.did)
    }
    // A pass that takes both cards and never comes back from its first check (until the test lets it).
    let freed: DidResolution | null = null
    let release: (r: DidResolution) => void = () => undefined
    const stuck = directory({
      resolveDid: (did) =>
        freed !== null
          ? Promise.resolve(did === a.did ? freed : scriptedResolver(did))
          : new Promise<DidResolution>((resolve) => {
              release = (r) => {
                freed = r
                resolve(r)
              }
            }),
    })
    const dying = stuck.step()
    for (let i = 0; i < 100; i += 1) {
      const held = await q<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM a2a_cards WHERE needs_revalidation AND revalidate_after > now()`)
      if (held[0]?.n === 2) break
      await new Promise((r) => setTimeout(r, 10))
    }
    // Still marked: only a verdict clears a mark.
    expect((await q<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM a2a_cards WHERE needs_revalidation`))[0]?.n).toBe(2)
    // The process is gone; its leases end, and another pass checks both.
    await db.execute(sql`UPDATE a2a_cards SET revalidate_after = now() - interval '1 second'`)
    dir = directory()
    await step()
    expect([await served(a.did), await served(b.did)]).toEqual([null, null])
    // The dead pass's late verdict, against the document it read, lands nowhere: its lease is gone.
    release({ kind: 'document', document: didDocument(a.did, a.keys) })
    await dying
    expect([await served(a.did), await served(b.did)]).toEqual([null, null])
    expect(await cardRow(a.did)).toEqual(expect.objectContaining({ needs_revalidation: false, signature_state: 'invalid' }))
  })

  // Plan X-3
  it('the same withheld first publish is served by the daily check when no identity event comes', async () => {
    await enable()
    const p = await publishedBeforeTheKey()
    docs.set(p.did, didDocument(p.did, p.keys))
    // Nothing checks it again within the day.
    await step()
    expect(await served(p.did)).toBeNull()
    clock += DAY + 1
    await step()
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
    expect(await listed()).toEqual([p.did])
  })
})

describe('gap generations: a late replay never proves', () => {
  // Plan F97
  it('a replay of an event processed before the gap, delivered after it, changes nothing and proves nothing', async () => {
    await enable()
    const p = publisher()
    const event = await put(p, 1, {}, 'create')
    await step()
    expect(await servedName(p.did)).toBe('Bus 42')
    await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)
    expect(await served(p.did)).toBeNull()
    await dir.receive(event, await gen())
    await step()
    // The spool row is kept, with the stamp it was first received under.
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'done', outcome: 'applied', observed_gap_generation: 0 })])
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ proved_generation: 0 }))
    expect(await served(p.did)).toBeNull()
  })

  // Plan F97
  it('the same, when the replayed event’s spool row was already pruned', async () => {
    await enable()
    const p = publisher()
    const event = await put(p, 1, {}, 'create')
    await step()
    clock += 31 * DAY
    await step()
    expect(await spool(p.did)).toEqual([])
    await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)
    await dir.receive(event, await gen())
    await step()
    expect((await spool(p.did)).map((r) => r.outcome)).toEqual(['replay'])
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ proved_generation: 0 }))
    expect(await served(p.did)).toBeNull()
  })

  // Plan F97
  it('an event still pending from before the gap keeps its old stamp when redelivered after it: it applies, never proves', async () => {
    const p = publisher()
    const event = await put(p, 1, {}, 'create')
    expect(await spool(p.did)).toEqual([expect.objectContaining({ observed_gap_generation: 0, status: 'pending' })])
    await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)
    expect(await gen()).toBe(1)
    await dir.receive(event, await gen())
    expect(await spool(p.did)).toEqual([expect.objectContaining({ observed_gap_generation: 0 })])
    await enable()
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ presence: 'present', proved_generation: 0 }))
    expect(await served(p.did)).toBeNull()
  })

  // Plan X-2
  it('a card deleted inside a gap never proves again: withheld throughout, also past the staleness window, whatever replays or checks follow', async () => {
    await enable()
    const p = publisher()
    const event = await put(p, 1, {}, 'create')
    await step()
    // The publisher deletes the card while AppView is down past Jetstream's retention: the delete is never seen.
    await dir.markGapIfUnreplayable((clock - 2 * DAY) * 1000)
    expect(await served(p.did)).toBeNull()
    // Its old create replays; an identity event and the daily check run.
    await dir.receive(event, await gen())
    await dir.noteIdentity(p.did)
    await step()
    expect(await served(p.did)).toBeNull()
    for (const days of [1, 15, 30, 31]) {
      clock = Date.parse('2026-10-03T12:00:00Z') + days * DAY
      await step()
      await step()
      expect({ days, served: await served(p.did), listed: await listed() }).toEqual({ days, served: null, listed: [] })
    }
    expect(clock - Date.parse('2026-10-03T12:00:00Z')).toBeGreaterThan(A2A_CARD_STALE_AFTER_MS)
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ proved_generation: 0 }))
    expect(await stateRow()).toEqual(expect.objectContaining({ gap_generation: 1 }))
  })
})

describe('the account gate', () => {
  // Plan F126
  it('a DID known only by a spool row keeps its account status; the card is withheld once processed, and a later commit answers', async () => {
    const p = publisher()
    const first = await put(p, 1, { name: 'v1' }, 'create')
    expect(await cardRow(p.did)).toBeUndefined()
    await dir.noteAccount(p.did, false, first.time_us + 10)
    expect(await q(sql`SELECT active, time_us FROM a2a_account_status WHERE did = ${p.did}`)).toEqual([
      { active: false, time_us: String(first.time_us + 10) },
    ])
    await enable()
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ account_active: false }))
    expect(await served(p.did)).toBeNull()
    timeUs += 100
    await put(p, 2, { name: 'v2' })
    await step()
    expect(await servedName(p.did)).toBe('v2')
  })
})

describe('a stream that never pauses (dual review CX-5)', () => {
  /** A resolver that, each time it is asked, records one more card event from a new publisher: arrivals that never stop. */
  function endlessArrivals(cap: number): { resolver: DidResolver; arrived: () => number } {
    let arrived = 0
    return {
      resolver: async (did) => {
        if (arrived < cap) {
          arrived += 1
          const next = publisher()
          await dir.receive(commit(next, 1, 'create', await cardRecord(next.did, next.keys)), await gen())
        }
        return scriptedResolver(did)
      },
      arrived: () => arrived,
    }
  }
  const counts = async () =>
    (await q<{ status: string; n: number }>(sql`SELECT status, COUNT(*)::int AS n FROM a2a_event_spool GROUP BY status ORDER BY status`)).reduce(
      (acc, r) => ({ ...acc, [r.status]: r.n }),
      {} as Record<string, number>,
    )

  it('a pass processes at most A2A_DRAIN_PASS_MAX events: the history is drained and the directory opens while arrivals continue', async () => {
    // History: three cards recorded while the directory was off.
    const history = [publisher(), publisher(), publisher()]
    for (const p of history) await put(p, 1, {}, 'create')
    const stream = endlessArrivals(A2A_DRAIN_PASS_MAX * 3)
    dir = directory({ resolveDid: stream.resolver })
    await enable()
    await step()
    const after = await counts()
    expect(after.done).toBe(A2A_DRAIN_PASS_MAX)
    expect(after.pending).toBeGreaterThan(0)
    // The history came first, and the directory opened although live events are still waiting.
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'ready' }))
    for (const p of history) expect(await servedName(p.did)).toBe('Bus 42')
  })

  it('turning the flag off while events keep coming stops processing at the next pass', async () => {
    const stream = endlessArrivals(A2A_DRAIN_PASS_MAX * 3)
    dir = directory({ resolveDid: stream.resolver })
    await put(publisher(), 1, {}, 'create')
    await enable()
    await step()
    const done = (await counts()).done
    expect(done).toBe(A2A_DRAIN_PASS_MAX)
    await disable()
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'disabled' }))
    expect((await counts()).done).toBe(done)
  })

  it('a running directory starts the next pass at once when work is left, without waiting its tick', async () => {
    for (let i = 0; i < A2A_DRAIN_PASS_MAX + 50; i += 1) await put(publisher(), 1, {}, 'create')
    await enable()
    const running = directory({ tickMs: 3_600_000 })
    dir = running
    running.start()
    try {
      for (let i = 0; i < 200 && ((await counts()).pending ?? 0) > 0; i += 1) await new Promise((r) => setTimeout(r, 25))
      expect(await counts()).toEqual({ done: A2A_DRAIN_PASS_MAX + 50 })
    } finally {
      await running.stop()
    }
  })
})

describe('the phases', () => {
  // Plan F115
  it('a fresh deployment with no flag row stays off: events record, nothing is processed or served', async () => {
    expect(await q(sql`SELECT key FROM appview_config WHERE key = 'a2a_directory_enabled'`)).toEqual([])
    const p = publisher()
    await put(p, 1, {}, 'create')
    await step()
    expect(await stateRow()).toEqual(expect.objectContaining({ phase: 'disabled' }))
    expect(await spool(p.did)).toEqual([expect.objectContaining({ status: 'pending' })])
    expect((await call('com.dinakernel.a2a.getCard', { did: p.did })).status).toBe(503)
    expect((await call('com.dinakernel.a2a.searchAgents', {})).status).toBe(503)
  })
})

describe('the cadence bump: only the envelope changes', () => {
  // Plan F140
  it('a new commit with a bumped freshness epoch keeps the card hash, moves indexed_at, and turns a stale card fresh', async () => {
    await enable()
    const p = publisher()
    const record = await cardRecord(p.did, p.keys, { freshnessEpoch: 0 })
    await dir.receive(commit(p, 1, 'create', record), await gen())
    await step()
    const before = await cardRow(p.did)
    clock += A2A_CARD_STALE_AFTER_MS
    expect((await getCard(db as never, { did: p.did }, clock)).stale).toBe(true)
    // The publisher's 14-day refresh: the same card bytes, a re-signed envelope.
    const env = record.directory_envelope as { freshness_epoch: number; publisher_epoch: number; publisher_instance: string }
    const bumped = {
      ...record,
      directory_envelope: await signDirectoryEnvelope(
        {
          did: p.did,
          collection: A2A_CARD_COLLECTION,
          rkey: A2A_SELF_RKEY,
          card_hash: cardHashOf(record),
          freshness_epoch: env.freshness_epoch + 1,
          publisher_epoch: env.publisher_epoch,
          publisher_instance: env.publisher_instance,
        },
        (message) => nodeSign(null, message, p.keys.ed.privateKey),
      ),
    }
    await dir.receive(commit(p, 2, 'update', bumped), await gen())
    await step()
    const after = await cardRow(p.did)
    expect(after).toEqual(expect.objectContaining({ card_hash: before?.card_hash, card_json: record.card, freshness_epoch: '1', repo_rev: revOf(2) }))
    expect(new Date(after?.indexed_at as string).getTime()).toBe(clock)
    const card = await getCard(db as never, { did: p.did }, clock)
    expect(card).toEqual(expect.objectContaining({ card: record.card, cardHash: cardHashOf(record), stale: false, indexedAt: new Date(clock).toISOString() }))
  })
})

describe('a listing change that drops a skill', () => {
  // Plan X-1
  it('the dropped skill no longer finds the DID by its exact id, its capability or an alias: an update replaces the skill keys', async () => {
    await enable()
    const p = publisher()
    await put(p, 1, { skills: ['eta_query@line42', 'price_check@shop'] }, 'create')
    await step()
    for (const skill of ['eta_query@line42', 'eta_query', 'bus_eta', 'price_check@shop', 'price_check']) {
      expect({ skill, found: await listed({ skill }) }).toEqual({ skill, found: [p.did] })
    }
    await put(p, 2, { skills: ['price_check@shop'] })
    await step()
    expect(await cardRow(p.did)).toEqual(expect.objectContaining({ skill_ids: ['price_check@shop'], skill_keys: ['price_check'] }))
    for (const skill of ['eta_query@line42', 'eta_query', 'bus_eta', 'transit_eta']) {
      expect({ skill, found: await listed({ skill }) }).toEqual({ skill, found: [] })
    }
    expect(await listed({ q: 'eta_query' })).toEqual([])
    for (const skill of ['price_check@shop', 'price_check', 'price_lookup']) {
      expect({ skill, found: await listed({ skill }) }).toEqual({ skill, found: [p.did] })
    }
  })
})
