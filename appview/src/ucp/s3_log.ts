/**
 * The profile host's off-host log (§3.5 "Surviving a host restore"), in an
 * S3-compatible bucket at a provider apart from the database backups.
 *
 * One object per applied change, written once (`If-None-Match: *`) and never
 * overwritten or deleted by the host. The bucket itself must be versioned with
 * a retention lock, and the host's key must lack delete rights, so a host
 * compromise cannot rewrite history (operator set-up, docs/DISASTER_RECOVERY_PLAN.md).
 *
 * Object names: `<prefix>/<label>/<revision, 16 digits>-<write order, 16 digits>-<random>.json`,
 * where the write order is this process's clock in µs, made strictly increasing.
 * Within a label they sort by revision and then by when they were written, so
 * `after(label, n)` is one listing that starts after revision n's names.
 *
 * The objects hold the label → DID binding: the bucket is as private as the
 * database and its backups.
 */

import { randomBytes } from 'node:crypto'

import { readHostLogRecord, type HostLogRecord, type UcpHostLog } from '@dina/ucp'
import { AwsClient } from 'aws4fetch'

export interface S3LogOptions {
  /** The S3 endpoint, e.g. `https://s3.eu-central-003.backblazeb2.com`. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Object name prefix (one per environment), e.g. `ucp-host/test`. */
  prefix: string
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}

/** The largest object the host reads back: a record is well under 2 KiB. */
const RECORD_MAX_BYTES = 64 * 1024
/** The largest listing page read: 1000 names of under 120 bytes, plus the XML around them. */
const LIST_MAX_BYTES = 4 * 1024 * 1024
/** Listing pages per catch-up (1000 names each): far beyond any one label's backlog. */
const MAX_LIST_PAGES = 100

const pad16 = (n: number): string => String(n).padStart(16, '0')

/** The five predefined XML entities (S3 escapes them in names and tokens). */
const xmlText = (s: string): string =>
  s.replace(
    /&(lt|gt|quot|apos|amp);/g,
    (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e] as string,
  )

/** The body as text, read no further than `limit` bytes (a larger body is an error, not a buffer). */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('ucp host log: answer too large')
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

export function s3HostLog(options: S3LogOptions): UcpHostLog {
  const endpoint = new URL(options.endpoint)
  if (endpoint.protocol !== 'https:') throw new Error('ucp host log: the bucket must be reached over HTTPS')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error('ucp host log: bad bucket name')
  if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(options.prefix)) throw new Error('ucp host log: bad prefix')
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: 's3',
    region: options.region,
  })
  const timeoutMs = options.timeoutMs ?? 10_000
  const fetchFn = options.fetch ?? fetch
  const now = options.now ?? Date.now
  let lastOrder = 0
  // Path-style: every S3-compatible provider accepts it.
  const base = `${endpoint.origin}/${options.bucket}`

  async function send(url: string, init: RequestInit): Promise<Response> {
    const signed = await client.sign(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    return fetchFn(signed)
  }

  async function readRecord(key: string, label: string, revision: number): Promise<HostLogRecord> {
    const res = await send(`${base}/${key}`, { method: 'GET' })
    if (res.status !== 200) throw new Error(`ucp host log: read answered ${res.status}`)
    const text = await readCapped(res, RECORD_MAX_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const record = readHostLogRecord(parsed)
    // A record must be what its name says: this label, this revision.
    if (record === null || record.label !== label || record.revision !== revision) {
      throw new Error('ucp host log: a record does not read')
    }
    return record
  }

  return {
    async append(record) {
      // µs from the clock, but never equal to or before the last name written,
      // so two records of one revision sort in the order they were written.
      lastOrder = Math.max(now() * 1000, lastOrder + 1)
      const key = `${options.prefix}/${record.label}/${pad16(record.revision)}-${pad16(lastOrder)}-${randomBytes(4).toString('hex')}.json`
      const res = await send(`${base}/${key}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: JSON.stringify(record),
      })
      // Anything but a stored object fails the change: the host answers only after the append.
      if (res.status !== 200) throw new Error(`ucp host log: append answered ${res.status}`)
    },

    async after(label, revision) {
      const folder = `${options.prefix}/${label}/`
      // `~` sorts after `-`, so this skips every name for revisions up to `revision`.
      const startAfter = `${folder}${pad16(revision)}~`
      const names: string[] = []
      let token: string | null = null
      for (let page = 0; ; page++) {
        if (page === MAX_LIST_PAGES) throw new Error('ucp host log: listing too long')
        const q = new URLSearchParams({
          'list-type': '2',
          prefix: folder,
          'start-after': startAfter,
        })
        if (token !== null) q.set('continuation-token', token)
        const res = await send(`${base}?${q.toString()}`, { method: 'GET' })
        if (res.status !== 200) throw new Error(`ucp host log: listing answered ${res.status}`)
        const xml = await readCapped(res, LIST_MAX_BYTES)
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) names.push(xmlText(m[1] as string))
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
        const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
        token = next === undefined ? null : xmlText(next)
        if (token === null) throw new Error('ucp host log: a truncated listing without a token')
      }
      const records: HostLogRecord[] = []
      for (const name of names.sort()) {
        const m = /^(\d{16})-\d{16}-[0-9a-f]{8}\.json$/.exec(name.slice(folder.length))
        if (!name.startsWith(folder) || m === null) throw new Error('ucp host log: an unexpected object name')
        records.push(await readRecord(name, label, Number(m[1])))
      }
      return records
    },
  }
}
