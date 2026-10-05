/**
 * Reading a merchant's public UCP profile for the merchant index
 * (docs/UCP_IMPLEMENTATION_PLAN.md §3.15, §3.3): through the vetted socket
 * (`@dina/net-socket-node`: one resolution, special-use addresses refused,
 * the connection pinned to the vetted address, TLS checked, no redirects,
 * byte and time caps), after the URL check every Dina fetch makes
 * (`checkOutboundUrl`: https, no credentials, no literal IP, no fragment).
 * The deadline is held here too: a socket that overruns it is a failure.
 *
 * What is read is a document, its ETag, and how long it may be kept; what a
 * profile means is @dina/ucp's (`readProfileDocument`, `discoverMerchant`).
 */

import { checkOutboundUrl } from '@dina/a2a'
import { UCP_FETCH_LIMITS, narrowHeaders, type PolicySocket } from '@dina/net-policy'

export type ProfileFetch =
  | { kind: 'document'; bytes: Uint8Array; etag: string | null; maxAgeMs: number | null }
  | { kind: 'not_modified'; maxAgeMs: number | null }
  | { kind: 'failed'; reason: 'unreachable' | 'not_found' | 'too_large'; detail?: string }

/** `max-age` from Cache-Control, in ms; 0 for `no-store` or `no-cache`; null when it says neither. */
export function maxAgeOf(cacheControl: string | undefined): number | null {
  if (cacheControl === undefined) return null
  let maxAge: number | null = null
  for (const part of cacheControl.toLowerCase().split(',')) {
    const [key, value] = part.trim().split('=')
    if (key === 'no-store' || key === 'no-cache') return 0
    if (key === 'max-age' && value !== undefined && /^\d{1,10}$/.test(value.trim())) maxAge = Number(value.trim()) * 1000
  }
  return maxAge
}

/** A reader of profile documents over `socket`. */
export function profileFetcher(socket: PolicySocket): (url: string, ifNoneMatch?: string) => Promise<ProfileFetch> {
  return async (url, ifNoneMatch) => {
    const check = checkOutboundUrl(url)
    if (!check.ok) return { kind: 'failed', reason: 'unreachable', detail: check.reason }
    const limits = UCP_FETCH_LIMITS.profile
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), limits.timeoutMs)
    })
    let result: Awaited<ReturnType<PolicySocket>> | 'deadline'
    try {
      result = await Promise.race([
        socket({
          method: 'GET',
          url: check.url.href,
          headers: { accept: 'application/json' },
          accept: 'json',
          minTls: 'TLSv1.2',
          readAuthErrorBodies: false,
          ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
          ...limits,
        }).catch((): Awaited<ReturnType<PolicySocket>> => ({ ok: false, error: 'io_error', sent: true })),
        deadline,
      ])
    } finally {
      clearTimeout(timer)
    }
    if (result === 'deadline') return { kind: 'failed', reason: 'unreachable', detail: 'timeout' }
    if (!result.ok)
      return result.error === 'too_large'
        ? { kind: 'failed', reason: 'too_large' }
        : { kind: 'failed', reason: 'unreachable', detail: result.error }
    const headers = narrowHeaders(result.rawHeaders)
    // A 304 freshens the stored read for as long as its Cache-Control says (RFC 9111 §4.3.4).
    if (result.status === 304 && ifNoneMatch !== undefined)
      return { kind: 'not_modified', maxAgeMs: maxAgeOf(headers['cache-control']) }
    if (result.status === 404) return { kind: 'failed', reason: 'not_found' }
    if (result.status !== 200) return { kind: 'failed', reason: 'unreachable', detail: String(result.status) }
    return {
      kind: 'document',
      bytes: result.bodyBytes,
      etag: headers.etag ?? null,
      maxAgeMs: maxAgeOf(headers['cache-control']),
    }
  }
}
