/**
 * Handle resolver — resolves a `did:plc` to its self-claimed AT
 * Protocol handle by reading the DID document's `alsoKnownAs[0]`.
 *
 * Backs the `backfill-handles` scorer job that populates
 * `did_profiles.handle`. Used elsewhere only by tests; production
 * call sites go through the job, which respects the cache + rate
 * limits.
 *
 * **What we extract**: the first entry of `alsoKnownAs` that parses
 * as `at://<handle>`. The handle is what the user self-claimed in
 * their PLC genesis op; the AppView never assumes uniqueness or
 * authoritativeness — it's a *display* string that the mobile UI
 * shows alongside the raw DID. If a user later changes the handle
 * by rotating their PLC document, the next backfill picks up the
 * new value (we re-resolve on a 30-day cadence, see
 * `backfill-handles.ts`).
 *
 * **What we don't do**:
 *   - Verify the handle is bound on a PDS via `resolveHandle`. That's
 *     the install-time picker's job. Once published in PLC, the AppView
 *     just reads it.
 *   - Negative-cache failures. A PLC fetch failing transiently doesn't
 *     blank an existing handle — we keep the previous value until a
 *     successful resolution arrives.
 */

import { logger } from '@/shared/utils/logger.js'

/**
 * Minimal shape of a `did:plc` document we care about. The full doc
 * is much larger; we mirror just the field this resolver reads. Loose
 * typing on the rest matches the `DIDDocument` shape declared in
 * `shared/utils/did-doc-cache.ts` so a future integration that wants
 * to feed cached docs straight in is type-compatible.
 */
export interface PLCDocumentLike {
  alsoKnownAs?: ReadonlyArray<unknown>
  [key: string]: unknown
}

/**
 * Default PLC directory base URL. The community uses `plc.directory`;
 * test fleets override via `DINA_PLC_DIRECTORY_URL`.
 */
const DEFAULT_PLC_URL = 'https://plc.directory'

/**
 * Per-request timeout in ms. PLC is generally < 100ms; 5s leaves
 * generous headroom for transient slowness without hanging the
 * backfill job.
 */
const DEFAULT_TIMEOUT_MS = 5_000

export interface ResolverConfig {
  /** Override the PLC directory URL. */
  plcURL?: string
  /** Override fetch (test injection). */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout. */
  timeoutMs?: number
}

/**
 * Pull the AT Protocol handle out of a DID document's `alsoKnownAs`.
 * Returns `null` when no handle is published, or when the published
 * value isn't a parseable `at://<handle>` URI.
 *
 * Pure — no I/O. Test it directly with a fixture.
 */
export function extractHandleFromDoc(doc: PLCDocumentLike): string | null {
  const aka = doc.alsoKnownAs
  if (!Array.isArray(aka) || aka.length === 0) return null
  for (const entry of aka) {
    if (typeof entry !== 'string') continue
    const handle = parseAtUri(entry)
    if (handle !== null) return handle
  }
  return null
}

/**
 * Parse an `at://<handle>` URI into the bare handle (no scheme).
 * Returns `null` when the input doesn't match the expected shape or
 * when the handle fails the DNS hostname format check.
 */
function parseAtUri(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('at://')) return null
  const handle = trimmed.slice('at://'.length)
  // Strip an accidental trailing slash (some PLC docs have it).
  const noSlash = handle.endsWith('/') ? handle.slice(0, -1) : handle
  if (!isValidHandleFormat(noSlash)) return null
  return noSlash.toLowerCase()
}

/**
 * Lightweight DNS hostname validation matching the AT Protocol
 * handle rules. We don't need the full strictness of the install-
 * time picker — a stranger's PLC doc can contain an arbitrary string
 * and we just need to reject obvious garbage before persisting.
 */
function isValidHandleFormat(handle: string): boolean {
  if (handle.length === 0) return false
  if (handle.length > 253) return false
  // Must contain at least one dot (a handle is always
  // `<prefix>.<domain>`).
  if (!handle.includes('.')) return false
  // Each label: a-z0-9 + hyphens, no leading/trailing hyphen, ≤ 63 chars.
  const labels = handle.toLowerCase().split('.')
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false
  }
  return true
}

/**
 * Resolve a `did:plc` to its handle by fetching the DID document
 * from the PLC directory. Returns `null` when:
 *   - The DID isn't a `did:plc` (we don't resolve `did:web` here — V2)
 *   - PLC returns 404 (DID was tombstoned)
 *   - The doc has no parseable `alsoKnownAs[0]`
 *
 * Throws on transient errors (network, 5xx, timeout). Callers (the
 * backfill job) should catch + retry on a future tick rather than
 * blanking the existing handle on a flaky network.
 */
export async function resolveHandleFromPLC(
  did: string,
  config: ResolverConfig = {},
): Promise<string | null> {
  if (!did.startsWith('did:plc:')) {
    return null
  }
  const base = (config.plcURL ?? DEFAULT_PLC_URL).replace(/\/$/, '')
  const url = `${base}/${encodeURIComponent(did)}`
  const f = config.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  try {
    const res = await f(url, { signal: controller.signal })
    if (res.status === 404 || res.status === 410) {
      // 404: never registered. 410: tombstoned. In both cases, no
      // handle exists — return null without throwing so the caller
      // can mark the DID processed and not re-poll forever.
      return null
    }
    if (!res.ok) {
      throw new Error(`PLC HTTP ${res.status}`)
    }
    const doc = (await res.json()) as PLCDocumentLike
    return extractHandleFromDoc(doc)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('PLC request timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve handles for many DIDs in parallel. Bounded concurrency
 * (default 10) keeps us from hammering the PLC directory while still
 * making decent forward progress through the backfill queue.
 */
export async function resolveHandlesBatch(
  dids: ReadonlyArray<string>,
  config: ResolverConfig & { concurrency?: number } = {},
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>()
  const concurrency = config.concurrency ?? 10
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= dids.length) return
      const did = dids[idx]
      try {
        const handle = await resolveHandleFromPLC(did, config)
        results.set(did, handle)
      } catch (err) {
        // Soft-fail per DID — record absence so the caller's "I tried
        // these" set is complete, but log so transient PLC issues
        // surface in dashboards.
        logger.warn(
          { did, err: err instanceof Error ? err.message : String(err) },
          'handle_resolver: PLC fetch failed',
        )
        results.set(did, null)
      }
    }
  })
  await Promise.all(workers)
  return results
}
