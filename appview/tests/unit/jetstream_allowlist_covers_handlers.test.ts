/**
 * The deployed firehose filter must carry every collection we can handle.
 *
 * WHY THIS EXISTS. The Jetstream sidecar subscribes to exactly the NSIDs in
 * `JETSTREAM_WANTED_COLLECTIONS`. A collection with a registered handler but no
 * entry in that list is never delivered, and the only symptom is an empty
 * index — which reads identically to "no supplier has published one yet".
 *
 * That is what happened: the allowlist carried 19 PeerLens collections and
 * none of the three commerce ones, nor `service.profile`, while the handler
 * registry carried all 23. Every commerce handler, every projection, and the
 * whole catalog-search endpoint were unreachable in a Docker deployment. Two
 * thousand green tests said nothing, because they invoke handlers directly and
 * so never cross the sidecar.
 *
 * The check reads the REAL registry (`HANDLED_COLLECTIONS`, derived from the
 * handler map) rather than a list maintained here. A gate with its own copy of
 * the answer is a third place to drift, not a guard against drift.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { HANDLED_COLLECTIONS } from '@/ingester/handlers/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE = resolve(HERE, '../../docker-compose.yml')

/** The NSIDs the sidecar is told to want, read out of the compose file. */
function allowlistedCollections(): string[] {
  const compose = readFileSync(COMPOSE, 'utf8')
  const start = compose.indexOf('JETSTREAM_WANTED_COLLECTIONS')
  expect(start, 'compose must declare JETSTREAM_WANTED_COLLECTIONS').toBeGreaterThan(-1)

  // The block is a YAML folded scalar; it ends at the next key at the same
  // indentation. Reading to `JETSTREAM_PORT` keeps this independent of how the
  // list happens to be wrapped.
  const end = compose.indexOf('JETSTREAM_PORT', start)
  expect(end, 'the collections block must be followed by JETSTREAM_PORT').toBeGreaterThan(start)

  const block = compose.slice(start, end)
  return [...block.matchAll(/com\.dinakernel\.[A-Za-z.]+/g)].map((m) => m[0]).sort()
}

describe('the Jetstream allowlist and the handler registry', () => {
  it('delivers every collection a handler is registered for', () => {
    const allowed = new Set(allowlistedCollections())
    const missing = [...HANDLED_COLLECTIONS].filter((c) => !allowed.has(c)).sort()

    // Named individually: "4 missing" sends the reader hunting, and the whole
    // point of the finding was that nobody knew which ones were absent.
    expect(missing, `handled but never delivered by the sidecar: ${missing.join(', ')}`).toEqual([])
  })

  it('does not ask the relay for records it cannot handle', () => {
    // Not a correctness bug on its own, but it costs firehose bandwidth for
    // records that are dropped on arrival, and it is usually the fingerprint of
    // a handler that was deleted while its subscription stayed behind.
    const handled = new Set(HANDLED_COLLECTIONS)
    const unhandled = allowlistedCollections().filter((c) => !handled.has(c))

    expect(unhandled, `allowlisted with no handler: ${unhandled.join(', ')}`).toEqual([])
  })

  it('actually reads the commerce collections, so this test can fail', () => {
    // A guard whose inputs are empty passes forever. If the compose parse
    // silently returned nothing, both assertions above would still be green,
    // so pin the two facts the parse depends on.
    const allowed = allowlistedCollections()
    expect(allowed.length).toBeGreaterThan(20)
    expect(allowed).toContain('com.dinakernel.commerce.catalog')
    expect(HANDLED_COLLECTIONS).toContain('com.dinakernel.commerce.catalogSnapshot')
  })
})
