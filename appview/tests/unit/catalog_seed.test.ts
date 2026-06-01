/**
 * Catalog-seed assembly unit tests (SERVICE_CAPABILITY_CATALOG_DESIGN.md §5 / §40).
 *
 * `assembleCatalogSnapshot` is the pure core the re-runnable seed script uses to
 * hash the protocol-emitted catalog + wrap it into the served payload. Tested
 * without a DB (the upsert/read are thin and need Postgres). The idempotency
 * key is the CONTENT hash — stable across re-runs / clocks.
 */

import { describe, expect, it } from 'vitest'

import { assembleCatalogSnapshot } from '../../src/db/queries/catalog.js'

// The protocol emits exactly this shape (serializeCatalogForHash):
// { catalog_version, categories, capabilities, deprecated_capabilities }
const CONTENT = JSON.stringify({
  catalog_version: '2026-06-01',
  categories: [{ id: 'transit', display_name: 'Transit', short_description: 't', sort_order: 1, lifecycle: 'stable' }],
  capabilities: [
    {
      id: 'eta_query',
      aliases: ['bus_eta'],
      category_ids: ['transit'],
      default_category_id: 'transit',
      display_name: 'ETA',
      short_description: 'eta',
      lifecycle: 'stable',
      action_class: 'read',
      privacy_class: 'public',
      default_discoverability: 'public',
      approval_policy_hint: 'none',
      introduced_in: '2026-06-01',
    },
  ],
  deprecated_capabilities: [],
})

describe('assembleCatalogSnapshot', () => {
  it('wraps the content into the served payload (hash + generated_at injected)', () => {
    const at = new Date('2026-06-01T12:00:00.000Z')
    const snap = assembleCatalogSnapshot(CONTENT, at)
    expect(snap.catalogVersion).toBe('2026-06-01')
    expect(snap.catalogHash).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    expect(snap.generatedAt).toBe(at)
    // Payload preserves the content + adds the two volatile fields.
    expect(snap.payload.catalog_version).toBe('2026-06-01')
    expect(snap.payload.catalog_hash).toBe(snap.catalogHash)
    expect(snap.payload.generated_at).toBe(at.toISOString())
    expect((snap.payload.capabilities as unknown[]).length).toBe(1)
  })

  it('is deterministic and content-only (re-runs / different clocks → same hash)', () => {
    const a = assembleCatalogSnapshot(CONTENT, new Date('2026-06-01T00:00:00Z'))
    const b = assembleCatalogSnapshot(CONTENT, new Date('2030-01-01T00:00:00Z'))
    expect(a.catalogHash).toBe(b.catalogHash) // hash excludes generated_at → idempotent
  })

  it('changes the hash when the content changes', () => {
    const a = assembleCatalogSnapshot(CONTENT, new Date(0))
    const changed = CONTENT.replace('2026-06-01', '2026-07-01')
    const b = assembleCatalogSnapshot(changed, new Date(0))
    expect(a.catalogHash).not.toBe(b.catalogHash)
  })

  it('fails closed on malformed content (no versionless snapshot)', () => {
    expect(() => assembleCatalogSnapshot('not json', new Date())).toThrow(/not valid JSON/i)
    expect(() => assembleCatalogSnapshot(JSON.stringify({ categories: [] }), new Date())).toThrow(
      /no catalog_version/i,
    )
    expect(() => assembleCatalogSnapshot(JSON.stringify({ catalog_version: '' }), new Date())).toThrow(
      /no catalog_version/i,
    )
  })
})
