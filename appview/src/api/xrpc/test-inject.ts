/**
 * `com.dina.test.injectAttestation` and `com.dina.test.deleteAttestation`
 * — TEST-MODE-ONLY admin endpoints.
 *
 * These bypass the normal Jetstream/PDS pipeline and run the ingester
 * handlers directly against the database. Used by the mobile-side
 * publish runner during development to round-trip a "create review"
 * end-to-end without standing up real PDS auth.
 *
 * **Production gate** — both endpoints 404 unless `DINA_TEST_INJECT=1`
 * is set on the AppView web container. This makes accidental enabling
 * loud (the env var has to be explicitly set in deploy).
 *
 * **Auth gate** — when test-mode is enabled, the request must carry
 * `Authorization: Bearer <DINA_TEST_INJECT_TOKEN>`. The token is the
 * second env var the operator sets at deploy time. Empty token = the
 * endpoint stays 404 even with the mode flag (defense in depth — a
 * misconfigured deploy that sets the mode but forgets the token does
 * not silently expose write access).
 *
 * Both endpoints take POST bodies (not query params), matching the
 * AT-Protocol convention for write methods.
 */

import { z } from 'zod'
import type { DrizzleDB } from '@/db/connection.js'
import { logger } from '@/shared/utils/logger.js'
import { metrics } from '@/shared/utils/metrics.js'
import { attestationHandler } from '@/ingester/handlers/attestation.js'
import { revocationHandler } from '@/ingester/handlers/revocation.js'

const SubjectRefSchema = z.object({
  type: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim', 'place']),
  did: z.string().optional(),
  uri: z.string().optional(),
  name: z.string().optional(),
  identifier: z.string().optional(),
})

export const InjectAttestationBody = z.object({
  authorDid: z.string().regex(/^did:[a-z]+:/, 'must be a DID'),
  rkey: z.string().min(1).max(256),
  cid: z.string().min(1).max(256),
  record: z.object({
    subject: SubjectRefSchema,
    category: z.string().min(1).max(256),
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    confidence: z.enum(['certain', 'high', 'moderate', 'speculative']).optional(),
    text: z.string().max(10_000).optional(),
    domain: z.string().max(253).optional(),
    tags: z.array(z.string()).optional(),
    createdAt: z.string().datetime(),
  }),
})

export type InjectAttestationBodyType = z.infer<typeof InjectAttestationBody>

export const DeleteAttestationBody = z.object({
  authorDid: z.string().regex(/^did:[a-z]+:/, 'must be a DID'),
  uri: z.string().regex(/^at:\/\//, 'must be an at:// URI'),
})

export type DeleteAttestationBodyType = z.infer<typeof DeleteAttestationBody>

export interface InjectAttestationResult {
  uri: string
  cid: string
}

/**
 * Run the attestation handler against the supplied record. Returns the
 * AT-URI of the resulting row (deterministic from `authorDid` + `rkey`)
 * so the caller can poll `attestationStatus` for indexed/scored.
 */
export async function injectAttestation(
  db: DrizzleDB,
  body: InjectAttestationBodyType,
): Promise<InjectAttestationResult> {
  const uri = `at://${body.authorDid}/com.dina.trust.attestation/${body.rkey}`
  await attestationHandler.handleCreate(
    { db, logger, metrics },
    {
      uri,
      did: body.authorDid,
      collection: 'com.dina.trust.attestation',
      rkey: body.rkey,
      cid: body.cid,
      record: body.record as unknown as Record<string, unknown>,
      traceId: `inject-${Date.now()}`,
    },
  )
  return { uri, cid: body.cid }
}

/**
 * Run the revocation handler — emits a `com.dina.trust.revocation`
 * record and the existing handler chain marks the original
 * attestation as revoked. Mirrors the production flow: a delete via
 * the trust network is a SOFT delete (revocation), not a tombstone.
 */
export async function deleteAttestation(
  db: DrizzleDB,
  body: DeleteAttestationBodyType,
): Promise<{ revocationUri: string }> {
  // Use a deterministic rkey so re-running for the same target is a
  // no-op rather than creating a flock of duplicate revocations.
  const targetRkey = body.uri.split('/').pop() ?? 'unknown'
  const rkey = `rev-${targetRkey}`
  const revUri = `at://${body.authorDid}/com.dina.trust.revocation/${rkey}`
  await revocationHandler.handleCreate(
    { db, logger, metrics },
    {
      uri: revUri,
      did: body.authorDid,
      collection: 'com.dina.trust.revocation',
      rkey,
      cid: `bafyrev${Date.now().toString(36)}`,
      record: {
        targetUri: body.uri,
        reason: 'mobile_delete',
        createdAt: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
      traceId: `inject-rev-${Date.now()}`,
    },
  )
  return { revocationUri: revUri }
}

// ─── Auth gate ────────────────────────────────────────────────────────────

/**
 * Returns null if the test-mode auth gate passes; an error tuple
 * otherwise. The 404 response shape matches the way the rest of the
 * server hides disabled endpoints (instead of 401/403, which would
 * leak the existence of the endpoint to a probe).
 */
export function checkTestInjectAuth(
  authHeader: string | undefined,
): { status: number; body: unknown } | null {
  const enabled = process.env.DINA_TEST_INJECT === '1'
  const expected = process.env.DINA_TEST_INJECT_TOKEN
  if (!enabled || !expected || expected.length === 0) {
    return { status: 404, body: { error: 'NotFound' } }
  }
  const provided = (authHeader ?? '').replace(/^Bearer\s+/, '')
  if (provided !== expected) {
    // Same 404 — an attacker scanning the network shouldn't learn the
    // endpoint exists from a 401 response.
    return { status: 404, body: { error: 'NotFound' } }
  }
  return null
}
