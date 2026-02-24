import { createHash } from 'crypto'
import { sql, eq } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import type { SubjectRef } from '@/shared/types/lexicon-types.js'
import { subjects } from '@/db/schema/index.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'

/**
 * 3-tier subject identity resolution (Fix 2 + Fix 10):
 *
 * Tier 1: Global identifiers (DID, URI, external ID) — deterministic, author-independent
 * Tier 2: Author-scoped name-based subjects — deterministic per (type, name, author)
 * Tier 3: Canonical chain resolution — follows merge pointers to canonical subject
 */

function generateDeterministicId(
  ref: SubjectRef,
  authorDid: string,
): { id: string; isAuthorScoped: boolean } {
  const hash = createHash('sha256')

  // Tier 1: Global identifiers — same subject regardless of who references it
  if (ref.did) {
    hash.update(`did:${ref.did}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: false }
  }
  if (ref.uri) {
    hash.update(`uri:${ref.uri}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: false }
  }
  if (ref.identifier) {
    hash.update(`id:${ref.identifier}`)
    return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: false }
  }

  // Tier 2: Author-scoped name-based — same author + type + name always resolves the same
  hash.update(`name:${ref.type}:${ref.name?.toLowerCase().trim()}:${authorDid}`)
  return { id: `sub_${hash.digest('hex').slice(0, 32)}`, isAuthorScoped: true }
}

export { generateDeterministicId }

/**
 * Resolve an existing subject or create a new one.
 * Returns the canonical subject ID (following merge chains).
 */
export async function resolveOrCreateSubject(
  db: DrizzleDB,
  ref: SubjectRef,
  authorDid: string,
): Promise<string> {
  const { id: deterministicId, isAuthorScoped } = generateDeterministicId(ref, authorDid)

  const identifiers: Record<string, string>[] = []
  if (ref.uri) identifiers.push({ uri: ref.uri })
  if (ref.identifier) identifiers.push({ id: ref.identifier })

  const name = ref.name || ref.uri || ref.did || 'Unknown Subject'

  const result = await db.execute(sql`
    INSERT INTO subjects (
      id, name, subject_type, did, identifiers_json,
      author_scoped_did, created_at, updated_at
    )
    VALUES (
      ${deterministicId},
      ${name},
      ${ref.type},
      ${ref.did ?? null},
      ${JSON.stringify(identifiers)}::jsonb,
      ${isAuthorScoped ? authorDid : null},
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      updated_at = NOW(),
      identifiers_json = subjects.identifiers_json || EXCLUDED.identifiers_json
    RETURNING id, canonical_subject_id
  `)

  const row = (result as any).rows[0]
  const canonicalId = row.canonical_subject_id as string | null

  if (canonicalId) {
    return resolveCanonicalChain(db, canonicalId)
  }

  return row.id as string
}

/**
 * Resolve an existing subject without creating. Returns null if not found.
 * Only works for Tier 1 (global identifier) lookups.
 */
export async function resolveSubject(
  db: DrizzleDB,
  ref: SubjectRef,
): Promise<string | null> {
  if (ref.did || ref.uri || ref.identifier) {
    const hash = createHash('sha256')
    if (ref.did) hash.update(`did:${ref.did}`)
    else if (ref.uri) hash.update(`uri:${ref.uri}`)
    else if (ref.identifier) hash.update(`id:${ref.identifier}`)
    const id = `sub_${hash.digest('hex').slice(0, 32)}`

    const result = await db.select().from(subjects).where(eq(subjects.id, id)).limit(1)
    if (result.length > 0) {
      const canonicalId = result[0].canonicalSubjectId
      return canonicalId ? resolveCanonicalChain(db, canonicalId) : result[0].id
    }
  }
  return null
}

/**
 * Follow canonical_subject_id chain to find the root subject.
 * Guards against cycles and excessive depth.
 */
async function resolveCanonicalChain(
  db: DrizzleDB,
  startId: string,
): Promise<string> {
  const visited = new Set<string>()
  let currentId = startId

  for (let depth = 0; depth < CONSTANTS.MAX_CHAIN_DEPTH; depth++) {
    if (visited.has(currentId)) {
      logger.warn(`[Subjects] Merge cycle detected at ${currentId}`)
      return currentId
    }
    visited.add(currentId)

    const result = await db.execute(sql`
      SELECT canonical_subject_id FROM subjects WHERE id = ${currentId}
    `)

    const nextId = (result as any).rows[0]?.canonical_subject_id as string | null
    if (!nextId) return currentId
    currentId = nextId
  }

  logger.warn(`[Subjects] Merge chain exceeded ${CONSTANTS.MAX_CHAIN_DEPTH} hops from ${startId}`)
  return currentId
}
