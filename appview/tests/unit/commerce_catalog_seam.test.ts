/**
 * THE SEAM BETWEEN THE PUBLISHER AND THIS INDEXER (§10.2).
 *
 * A supplier's Home Node writes catalog records into its own repo; this
 * service reads them off the firehose. Neither half imports the other, so for
 * a long time each spelled the collection names and record shapes for itself —
 * and they disagreed. The publisher wrote its pointer to
 * `com.dinakernel.commerce.catalogPointer`; every name here was
 * `com.dinakernel.commerce.catalog`. Every pointer ever published routed to no
 * handler. The publisher also wrote the snapshot's own fields flat, where the
 * `record.snapshot` this side reads found nothing, and omitted the pages
 * entirely.
 *
 * NOTHING FAILED. The publisher's tests asserted against the publisher's
 * constants; this side's tests fed its handlers fixtures hand-written to match
 * this side's schemas. Both were self-consistent and the wire between them was
 * broken.
 *
 * So these tests build records with `@dina/commerce-protocol`'s OWN builders —
 * the ones the publisher now calls — and check this service accepts them. The
 * point is that no literal in this file describes the wire format; the shared
 * package does, and both sides are measured against it.
 */

import { readFileSync } from 'node:fs'

import { describe, it, expect } from 'vitest'
import {
  CATALOG_POINTER_NSID,
  CATALOG_SNAPSHOT_NSID,
  catalogPointerRecord,
  catalogSnapshotRecord,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@dina/commerce-protocol'

import { HANDLED_COLLECTIONS, routeHandler } from '@/ingester/handlers/index.js'
import { validateRecord } from '@/ingester/record-validator.js'

const SUPPLIER = 'did:plc:chairmaker99'
const CATALOG_ID = 'chairmaker-main'
const DIGEST = 'a'.repeat(64)

function pointer(): CatalogPointer {
  return {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG_ID,
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: '2026-08-09T09:00:00.000Z',
    snapshot_rkey: DIGEST,
    snapshot_digest: DIGEST,
  }
}

function snapshot(): CatalogSnapshot {
  return {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG_ID,
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: '2026-08-09T09:00:00.000Z',
    page_digests: ['b'.repeat(64)],
    item_count: 1,
    payload_root: 'c'.repeat(64),
    snapshot_digest: DIGEST,
  }
}

function pages(): CatalogSnapshotPage[] {
  return [
    {
      catalog_id: CATALOG_ID,
      snapshot_sequence: 1,
      page_index: 0,
      items: [{ sku: 'oak-chair' }],
      page_digest: 'b'.repeat(64),
    },
  ]
}

describe('the collections this service indexes', () => {
  it('routes the protocol’s catalog collections to a handler', () => {
    // Named from the shared package. When the publisher's collection was not
    // among these, its records reached nothing — and no test said so, because
    // no test asked this question with the publisher's own name.
    for (const nsid of [CATALOG_POINTER_NSID, CATALOG_SNAPSHOT_NSID]) {
      expect(HANDLED_COLLECTIONS).toContain(nsid)
      expect(routeHandler(nsid)).not.toBeNull()
    }
  })
})

describe('the deployed jetstream sidecar allowlist', () => {
  // YAML CANNOT IMPORT A CONSTANT, so this is the only way that file can be
  // held to the same name as the code. `JETSTREAM_WANTED_COLLECTIONS` decides
  // what the sidecar forwards at all: a collection missing there never reaches
  // the ingester, no matter how correctly the handler map is keyed. It is the
  // third independent spelling of these names, and the first two disagreeing
  // is what started this.
  const compose = readFileSync(
    new URL('../../docker-compose.yml', import.meta.url),
    'utf8',
  )
  const wanted = compose
    .split('JETSTREAM_WANTED_COLLECTIONS: >-')[1]
    ?.split('JETSTREAM_PORT')[0] ?? ''

  it('forwards both catalog collections', () => {
    expect(wanted).toContain(CATALOG_POINTER_NSID)
    expect(wanted).toContain(CATALOG_SNAPSHOT_NSID)
  })

  it('forwards every collection the ingester handles', () => {
    // Otherwise a handler is registered for records that never arrive — which
    // looks exactly like a quiet supplier.
    for (const nsid of HANDLED_COLLECTIONS) {
      expect(wanted).toContain(nsid)
    }
  })
})

describe('records built the way the publisher builds them', () => {
  it('accepts a pointer record', () => {
    const result = validateRecord(CATALOG_POINTER_NSID, catalogPointerRecord(pointer()))
    expect(result.success).toBe(true)
  })

  it('accepts a snapshot record carrying its pages', () => {
    const result = validateRecord(
      CATALOG_SNAPSHOT_NSID,
      catalogSnapshotRecord(snapshot(), pages()),
    )
    expect(result.success).toBe(true)
  })

  it('REFUSES a snapshot flattened the way the publisher used to write it', () => {
    // The exact record that shipped: the snapshot's fields spread flat, no
    // pages. This is the assertion whose absence let the defect live.
    const flattened = { ...snapshot(), $type: CATALOG_SNAPSHOT_NSID }
    expect(validateRecord(CATALOG_SNAPSHOT_NSID, flattened).success).toBe(false)
  })
})
