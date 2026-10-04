/**
 * The publisher's DID document, for the directory's checks (design §8.3).
 *
 * `did:plc` only, through the PLC directory this AppView is configured
 * with. A `did:web` document lives on a host the publisher names, and
 * reaching such a host safely needs a resolve-then-connect fetcher (§6.6:
 * the resolved address checked, the socket pinned to it); AppView has none
 * yet, so a `did:web` publisher's card is refused, fail-closed.
 *
 * The rules §6.6 sets for every outbound connection, applied to the one
 * this makes: HTTPS (plain HTTP only outside production, for a local PLC),
 * no redirects, a response size cap, a deadline, and a bound on how many
 * lookups run at once. No cache: a card is checked against the document as
 * it is now, so a rotated key is never judged by its predecessor.
 */

/** What resolving a publisher's DID gave. */
export type DidResolution =
  | { kind: 'document'; document: unknown }
  /** The directory has never heard of it (404). */
  | { kind: 'not_found' }
  /** Tombstoned (410). */
  | { kind: 'deactivated' }
  /** Not a `did:plc` (see above). */
  | { kind: 'unsupported' }
  /** No answer worth judging by: try again later. */
  | { kind: 'unavailable' }

export type DidResolver = (did: string) => Promise<DidResolution>

export interface PlcResolverOptions {
  plcUrl: string
  /** Plain HTTP allowed (development and test only). */
  allowInsecure?: boolean
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxBytes?: number
  maxConcurrent?: number
}

const DID_PLC_RE = /^did:plc:[a-z2-7]{24}$/
const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i

/** A DID document is small: 64 KiB is many times a real one. */
export const DID_DOCUMENT_MAX_BYTES = 64 * 1024

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

export function createPlcDidResolver(options: PlcResolverOptions): DidResolver {
  const base = new URL(options.plcUrl)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && options.allowInsecure === true)) {
    throw new Error('a2a: the PLC directory must be reached over HTTPS')
  }
  const fetchFn = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxBytes = options.maxBytes ?? DID_DOCUMENT_MAX_BYTES
  const maxConcurrent = options.maxConcurrent ?? 4
  let running = 0
  const waiting: (() => void)[] = []
  const acquire = async (): Promise<void> => {
    if (running < maxConcurrent) {
      running += 1
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  const release = (): void => {
    const next = waiting.shift()
    if (next !== undefined) next()
    else running -= 1
  }

  return async (did) => {
    if (!DID_PLC_RE.test(did)) return { kind: 'unsupported' }
    const url = new URL(`/${did}`, base)
    await acquire()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/did+ld+json, application/json' },
      })
      if (response.status === 404) return { kind: 'not_found' }
      if (response.status === 410) return { kind: 'deactivated' }
      if (response.status !== 200) return { kind: 'unavailable' }
      if (!JSON_MEDIA.test(response.headers.get('content-type') ?? '')) return { kind: 'unavailable' }
      const text = await readCapped(response, maxBytes)
      if (text === null) return { kind: 'unavailable' }
      return { kind: 'document', document: JSON.parse(text) as unknown }
    } catch {
      // A refused redirect, a timeout, a reset, a body that is not UTF-8 JSON.
      return { kind: 'unavailable' }
    } finally {
      clearTimeout(timer)
      release()
    }
  }
}
