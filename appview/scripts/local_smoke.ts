/**
 * Local smoke driver.
 *
 * Bypasses Jetstream — invokes the registered ingester handlers
 * directly with hand-crafted records, then queries Postgres + the
 * local web server (port 3001) to verify the full pipeline:
 *
 *   handler → DB row → xRPC response.
 *
 * Run with:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5433/dina_trust \
 *     npx tsx scripts/local_smoke.ts
 *
 * The web server (PORT=3001) must already be running.
 */
import { createDb } from '@/db/connection.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { routeHandler } from '@/ingester/handlers/index.js'
import { sql } from 'drizzle-orm'

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3001'

const ALICE = 'did:plc:alice123456789012345678'
const BOB = 'did:plc:bob1234567890123456789012'
const SHOP = 'did:plc:shop123456789012345678901'

async function main() {
  const db = createDb()
  const ctx = { db, logger, metrics }

  console.log('--- 1. clean any prior smoke rows ---')
  await db.execute(sql`DELETE FROM attestations WHERE author_did IN (${ALICE}, ${BOB})`)
  await db.execute(sql`DELETE FROM vouches      WHERE author_did IN (${ALICE}, ${BOB})`)
  await db.execute(sql`DELETE FROM did_profiles WHERE did       IN (${ALICE}, ${BOB}, ${SHOP})`)

  console.log('--- 2. ingest attestation A (alice → shop, positive) ---')
  const attHandler = routeHandler('com.dina.trust.attestation')!
  await attHandler.handleCreate(ctx, {
    uri: `at://${ALICE}/com.dina.trust.attestation/3kabcd1`,
    did: ALICE,
    collection: 'com.dina.trust.attestation',
    rkey: '3kabcd1',
    cid: 'bafyreiabc1',
    record: {
      subject: { type: 'organization', did: SHOP, name: 'Aeron Chairs' },
      category: 'commerce/seller',
      sentiment: 'positive',
      domain: 'commerce',
      confidence: 'high',
      text: 'Excellent service, great chair.',
      tags: ['ergonomic', 'fast-shipping'],
      createdAt: new Date().toISOString(),
    },
    traceId: 'smoke-trace-1',
  })

  console.log('--- 4. ingest attestation B (bob → shop, neutral) ---')
  await attHandler.handleCreate(ctx, {
    uri: `at://${BOB}/com.dina.trust.attestation/3kabcd2`,
    did: BOB,
    collection: 'com.dina.trust.attestation',
    rkey: '3kabcd2',
    cid: 'bafyreiabc2',
    record: {
      subject: { type: 'organization', did: SHOP, name: 'Aeron Chairs' },
      category: 'commerce/seller',
      sentiment: 'neutral',
      text: 'Chair was OK, shipping took a while.',
      createdAt: new Date().toISOString(),
    },
    traceId: 'smoke-trace-2',
  })

  console.log('--- 5. count rows in DB ---')
  const r1 = await db.execute(sql`SELECT COUNT(*)::int AS n FROM attestations WHERE author_did IN (${ALICE}, ${BOB})`)
  const r2 = await db.execute(sql`SELECT COUNT(*)::int AS n FROM trust_edges  WHERE from_did   IN (${ALICE}, ${BOB})`)
  const r3 = await db.execute(sql`SELECT COUNT(*)::int AS n FROM subjects     WHERE did         = ${SHOP}`)
  console.log(' attestations rows:', (r1.rows[0] as any).n)
  console.log(' trust_edges rows :', (r2.rows[0] as any).n, '(expect 0: organization subjects do not create trust edges)')
  console.log(' subjects rows    :', (r3.rows[0] as any).n)

  console.log('--- 6. hit xRPC com.dina.trust.search ---')
  const search = await fetch(`${WEB_URL}/xrpc/com.dina.trust.search?q=Aeron`).then(r => r.json())
  console.log(' search results:', JSON.stringify(search, null, 2))

  console.log('--- 7. hit xRPC com.dina.trust.networkFeed (alice) ---')
  const feed = await fetch(`${WEB_URL}/xrpc/com.dina.trust.networkFeed?viewerDid=${encodeURIComponent(ALICE)}`).then(r => r.json())
  console.log(' feed:', JSON.stringify(feed, null, 2))

  console.log('--- 8. hit xRPC com.dina.trust.getAttestations (subject = shop) ---')
  const att = await fetch(`${WEB_URL}/xrpc/com.dina.trust.getAttestations?subject=${encodeURIComponent(SHOP)}`).then(r => r.json())
  console.log(' attestations response:', JSON.stringify(att, null, 2))

  console.log('--- DONE ---')
  process.exit(0)
}

main().catch(err => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
