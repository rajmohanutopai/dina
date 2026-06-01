import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb } from '@/db/connection.js'
import { assembleCatalogSnapshot, upsertCatalogSnapshot } from '@/db/queries/catalog.js'
import 'dotenv/config'

/**
 * Seed the official service-capability catalog into AppView.
 *
 * The SINGLE bridge from the catalog source (`@dina/protocol`) to AppView's DB.
 * Reads the protocol-emitted JSON (`packages/protocol/dist/catalog.json` —
 * produced by `npm run emit:catalog -w @dina/protocol`, which serializes the
 * one source of truth), hashes it, and UPSERTs the snapshot.
 *
 * Re-runnable any number of times, on any environment (DB via `DATABASE_URL`):
 *   - unchanged content → no-op;
 *   - changed content   → updates the row;
 *   - bumped version    → inserts a new row.
 *
 * Usage (one command, from repo root):
 *   DATABASE_URL=… npm run seed:catalog
 * which chains `emit:catalog` (protocol) then this script.
 */

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  // appview/scripts → repo-root/packages/protocol/dist/catalog.json
  const jsonPath = join(here, '..', '..', 'packages', 'protocol', 'dist', 'catalog.json')

  let content: string
  try {
    content = readFileSync(jsonPath, 'utf8')
  } catch {
    throw new Error(
      `catalog JSON not found at ${jsonPath} — run "npm run emit:catalog -w @dina/protocol" first ` +
        `(or "npm run seed:catalog" from the repo root, which chains it).`,
    )
  }

  const snap = assembleCatalogSnapshot(content, new Date())
  const db = createDb()
  const outcome = await upsertCatalogSnapshot(db, snap)
  // Log metadata only (no payload) — same discipline as the rest of the stack.
  console.log(
    `[seed_catalog] ${outcome}: version=${snap.catalogVersion} hash=${snap.catalogHash.slice(0, 12)}…`,
  )
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('[seed_catalog] FAILED:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
