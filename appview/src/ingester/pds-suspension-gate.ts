/**
 * PDS-suspension gate (TN-OPS-003 ingester hookup / Plan §13.10
 * abuse response).
 *
 * Enforces the V1 operator-abuse-response contract: any record
 * authored by a DID whose PDS endpoint matches a host on the
 * `suspended_pds_hosts` list is rejected at the ingester boundary
 * with `reason='pds_suspended'`. The CLI surface (`dina-admin trust
 * suspend-pds <host>`) shipped in TN-OPS-003; this module is the
 * runtime gate that turns the operator's action into ingest-side
 * effect.
 *
 * **Why a separate gate from the namespace-signature gate** (both
 * resolve the author's DID document):
 *   - Different decision shape: this gate reads `service[]` (PDS
 *     endpoint), the namespace gate reads `verificationMethod[]`
 *     (signing keys). Combining them couples two concerns.
 *   - Different cost profile: most authors are NOT on the
 *     suspension list, so a fast-path "list empty? skip resolver"
 *     short-circuits the network round-trip; the namespace gate
 *     can't share that fast path because every namespace-bearing
 *     record needs its own resolution.
 *   - Different reject reason maps to different operator response:
 *     `pds_suspended` is "operator banned this host"; the
 *     namespace gate's `namespace_disabled` is "author's own DID
 *     doc doesn't declare that key". Mobile UX surfaces these
 *     differently.
 *
 * **Order in the dispatcher**: AFTER feature-flag (global kill-
 * switch wins), BEFORE rate-limit (suspended hosts shouldn't
 * consume rate-limit budget either). Same reasoning the
 * feature-flag gate uses — short-circuit ineligible records as
 * early as possible.
 *
 * **Fail-closed on resolver errors**: same posture as the
 * namespace-signature gate. If we can't resolve the DID doc, we
 * can't prove the host is NOT on the suspension list — accepting
 * unknown is the wrong direction for an abuse-response gate.
 * Reject reason in this case is `signature_invalid` (the same
 * reason the namespace gate uses for resolver failures), keeping
 * the closed taxonomy coherent: both gates surface "I couldn't
 * verify your identity" the same way.
 *
 * **Fast path**: `isPdsSuspended` is hit-with-empty-list cheap
 * (PK lookup against an empty table is sub-millisecond). The gate
 * does NOT pre-list-suspended-hosts and short-circuit empty —
 * Postgres' query plan + the PK index make per-event lookups
 * cheap enough that an in-process cache-of-the-list would be a
 * staleness liability (operators expect suspensions to take
 * effect in seconds, not minutes).
 *
 * **Side effects**: zero. Pure function over the inputs (after
 * the fetcher resolves). The dispatcher is responsible for
 * calling the rejection writer + halting the pipeline.
 */

import { logger as defaultLogger } from '@/shared/utils/logger.js'
import { metrics as defaultMetrics } from '@/shared/utils/metrics.js'
import type {
  DidDocCache,
  DIDDocument,
} from '@/shared/utils/did-doc-cache.js'
import { isPdsSuspended } from '@/db/queries/suspended-pds-hosts.js'
import type { DrizzleDB } from '@/db/connection.js'
import type { Logger } from '@/shared/utils/logger.js'
import type { Metrics } from '@/shared/utils/metrics.js'

/**
 * Fetcher signature mirrors the namespace gate — same DI shape so
 * tests can inject a mock without HTTP, and so the production
 * resolver wires the same way.
 */
export type DidDocFetcher = (did: string) => Promise<DIDDocument>

export interface PdsSuspensionGateContext {
  readonly db: DrizzleDB
  readonly didDocCache: DidDocCache
  readonly didResolver: DidDocFetcher
  readonly logger?: Logger
  readonly metrics?: Metrics
}

export type PdsSuspensionGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      // Closed-taxonomy reject reason. `pds_suspended` for the
      // host-on-list path; `signature_invalid` for resolver failure
      // (same fail-closed posture as the namespace gate).
      readonly reason: 'pds_suspended' | 'signature_invalid'
      readonly detail: Record<string, unknown>
    }

/**
 * AT-protocol-shape DID-doc service entry. The DID Core spec is
 * loose about service entry shape; AT-protocol pins
 * `id: '#atproto_pds'`, `type: 'AtprotoPersonalDataServer'`,
 * `serviceEndpoint: <https URL>` — see
 * https://atproto.com/specs/did#did-documents.
 */
interface AtprotoPdsServiceEntry {
  readonly id: string
  readonly type: string
  readonly serviceEndpoint: string
}

function isAtprotoPdsServiceEntry(value: unknown): value is AtprotoPdsServiceEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    typeof v.serviceEndpoint === 'string'
  )
}

/**
 * Extract the AT-protocol PDS host from a resolved DID document.
 * Returns the bare hostname (no scheme, no port unless non-default,
 * no path) — matches the form operators enter in the CLI
 * (`dina-admin trust suspend-pds bsky.social`).
 *
 * AT-protocol pins the service id to `#atproto_pds` (with the
 * leading `#` indicating a DID-relative URL fragment); we accept
 * both `#atproto_pds` and the absolute form `${did}#atproto_pds`.
 *
 * Returns `null` when:
 *   - the doc has no `service` array
 *   - no entry matches the AT-protocol PDS service id
 *   - the matched entry's `serviceEndpoint` is malformed
 *
 * Null is the gate's signal to fail-closed (no PDS endpoint in the
 * DID doc → we can't verify the host isn't suspended).
 */
export function extractPdsHost(doc: DIDDocument): string | null {
  // The DID Core spec allows `service` (singular). The AT Protocol
  // spec uses the same key. Defensive check covers both AT
  // protocol's canonical shape and any legacy variant.
  const services = doc.service ?? doc.services ?? []
  if (!Array.isArray(services)) return null
  for (const entry of services) {
    if (!isAtprotoPdsServiceEntry(entry)) continue
    // Match either fragment form (`#atproto_pds`) or absolute form
    // (`did:plc:...#atproto_pds`). The fragment is the canonical
    // AT-protocol form; the absolute form appears in some legacy
    // PLC docs.
    if (entry.id !== '#atproto_pds' && !entry.id.endsWith('#atproto_pds')) {
      continue
    }
    try {
      const url = new URL(entry.serviceEndpoint)
      // `URL.host` includes port iff non-default — matches what
      // operators paste into the CLI for non-standard ports.
      return url.host || null
    } catch {
      // Malformed URL → null → fail-closed.
      return null
    }
  }
  return null
}

/**
 * Run the PDS-suspension gate.
 *
 *   1. Resolve the author's DID document (cache-first).
 *   2. Extract the AT-protocol PDS host.
 *   3. Look up the host in `suspended_pds_hosts`.
 *   4. Pass | `pds_suspended` | `signature_invalid` (fail-closed).
 */
export async function checkPdsSuspension(
  ctx: PdsSuspensionGateContext,
  authorDid: string,
): Promise<PdsSuspensionGateResult> {
  const log = ctx.logger ?? defaultLogger
  const m = ctx.metrics ?? defaultMetrics

  let doc: DIDDocument
  try {
    doc = await ctx.didDocCache.getOrFetch(authorDid, ctx.didResolver)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(
      { did: authorDid, err: message },
      'pds-suspension-gate: DID doc resolution failed',
    )
    m.incr('ingester.pds_suspension_gate.outcome', { outcome: 'signature_invalid' })
    return {
      ok: false,
      reason: 'signature_invalid',
      detail: { phase: 'did_resolution', did: authorDid, error: message },
    }
  }

  const host = extractPdsHost(doc)
  if (host === null) {
    // No PDS endpoint declared. Fail-closed: we can't verify
    // suspension status. This is rare in practice (every
    // PLC-published Dina identity declares an endpoint at create
    // time) but covers the corner case of a malformed or
    // partially-resolved doc.
    log.warn(
      { did: authorDid },
      'pds-suspension-gate: no AT-protocol PDS endpoint in DID document',
    )
    m.incr('ingester.pds_suspension_gate.outcome', { outcome: 'signature_invalid' })
    return {
      ok: false,
      reason: 'signature_invalid',
      detail: { phase: 'pds_endpoint_missing', did: authorDid },
    }
  }

  const suspended = await isPdsSuspended(ctx.db, host)
  if (suspended) {
    log.info(
      { did: authorDid, host },
      'pds-suspension-gate: rejecting record (host on suspension list)',
    )
    m.incr('ingester.pds_suspension_gate.outcome', { outcome: 'pds_suspended' })
    return {
      ok: false,
      reason: 'pds_suspended',
      detail: { phase: 'host_suspended', did: authorDid, host },
    }
  }

  m.incr('ingester.pds_suspension_gate.outcome', { outcome: 'pass' })
  return { ok: true }
}
