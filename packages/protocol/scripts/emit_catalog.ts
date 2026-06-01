/**
 * Emit the official capability catalog to `dist/catalog.json` — the single
 * bridge from the protocol source to AppView's seed script (which reads this
 * JSON, hashes it, and upserts the snapshot). See
 * docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md §40.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serializeCatalogForHash } from '../src/services/capability-catalog'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'dist')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'catalog.json')
writeFileSync(out, serializeCatalogForHash())
console.log('wrote', out)
