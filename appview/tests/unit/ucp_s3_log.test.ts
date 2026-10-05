/**
 * The profile host's off-host log over the S3 API (§3.5): write-once appends,
 * per-label catch-up listings that start after a revision, paging, and
 * refusal of anything in the bucket that is not exactly a record of its name.
 * The bucket is an in-memory S3 behind the injected fetch.
 */
import type { HostLogRecord } from '@dina/ucp'
import { describe, expect, it } from 'vitest'

import { s3HostLog } from '@/ucp/s3_log.js'

const LABEL = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_LABEL = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'

const record = (revision: number, label = LABEL, over: Partial<HostLogRecord> = {}): HostLogRecord => ({
  label,
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  revision,
  epoch: 1,
  instance: '11111111-1111-4111-8111-111111111111',
  op: 'upload',
  envelope_digest: String(revision % 10).repeat(64),
  highest_generation: 0,
  retired_added: [],
  keys_set: {},
  ...over,
})

/** A minimal S3: PUT (with If-None-Match), GET object, ListObjectsV2 with prefix/start-after/paging. */
function fakeS3(pageSize = 1000) {
  const objects = new Map<string, string>()
  const seen: { method: string; authorized: boolean }[] = []
  const fetchFn = (async (input: Request | string | URL) => {
    const req = input as Request
    const url = new URL(req.url)
    seen.push({
      method: req.method,
      authorized: (req.headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256 '),
    })
    const [, bucket, ...rest] = url.pathname.split('/')
    if (bucket !== 'dina-ucp-log') return new Response('', { status: 404 })
    const key = rest.join('/')
    if (req.method === 'PUT') {
      if (req.headers.get('if-none-match') === '*' && objects.has(key)) return new Response('', { status: 412 })
      objects.set(key, await req.text())
      return new Response('', { status: 200 })
    }
    if (key !== '') {
      const body = objects.get(key)
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 })
    }
    const prefix = url.searchParams.get('prefix') ?? ''
    const after = url.searchParams.get('continuation-token') ?? url.searchParams.get('start-after') ?? ''
    const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()
    const page = all.slice(0, pageSize)
    const truncated = all.length > pageSize
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
      page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('') +
      `<IsTruncated>${truncated}</IsTruncated>` +
      (truncated
        ? `<NextContinuationToken>${(page[page.length - 1] as string).replace(/&/g, '&amp;')}</NextContinuationToken>`
        : '') +
      `</ListBucketResult>`
    return new Response(xml, { status: 200 })
  }) as typeof fetch
  return { objects, seen, fetchFn }
}

/** A log over the fake bucket; the clock is frozen unless a test moves it. */
function logOver(s3: ReturnType<typeof fakeS3>, now = () => 1_759_000_000_000) {
  return s3HostLog({
    endpoint: 'https://s3.example-provider.test',
    region: 'eu-central-003',
    bucket: 'dina-ucp-log',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    prefix: 'ucp-host/test',
    fetch: s3.fetchFn,
    now,
  })
}

describe('the off-host log over S3', () => {
  it('appends signed, write-once objects and reads back only a label’s newer records, in order', async () => {
    const s3 = fakeS3()
    const log = logOver(s3)
    for (const r of [record(1), record(2), record(1, OTHER_LABEL), record(3)]) await log.append(r)
    expect(s3.seen.every((r) => r.authorized)).toBe(true)
    expect((await log.after(LABEL, 0)).map((r) => r.revision)).toEqual([1, 2, 3])
    expect((await log.after(LABEL, 2)).map((r) => r.revision)).toEqual([3])
    expect(await log.after(LABEL, 3)).toEqual([])
    expect((await log.after(OTHER_LABEL, 0)).map((r) => r.label)).toEqual([OTHER_LABEL])
  })

  it('keeps records of one revision in write order, even within one millisecond and with a clock going back', async () => {
    const s3 = fakeS3()
    let clock = 1_759_000_000_000
    const log = logOver(s3, () => clock)
    const ops = ['upload', 'pause', 'retire', 'upload', 'pause'] as const
    for (const [i, op] of ops.entries()) {
      if (i === 3) clock -= 5_000 // the clock steps back
      await log.append(record(2, LABEL, { op }))
    }
    expect((await log.after(LABEL, 1)).map((r) => r.op)).toEqual([...ops])
  })

  it('refuses an object or listing larger than its limit without reading it whole', async () => {
    const s3 = fakeS3()
    const log = logOver(s3)
    await log.append(record(1))
    const [name] = [...s3.objects.keys()]
    s3.objects.set(name as string, 'x'.repeat(65 * 1024))
    await expect(log.after(LABEL, 0)).rejects.toThrow('answer too large')
  })

  it('follows a paged listing to the end', async () => {
    const s3 = fakeS3(2)
    const log = logOver(s3)
    for (let i = 1; i <= 7; i++) await log.append(record(i))
    expect((await log.after(LABEL, 0)).map((r) => r.revision)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('a refused write (the name is taken, or the bucket is down) fails the append', async () => {
    for (const status of [412, 503, 403]) {
      const log = s3HostLog({
        endpoint: 'https://s3.example-provider.test',
        region: 'r',
        bucket: 'dina-ucp-log',
        accessKeyId: 'a',
        secretAccessKey: 's',
        prefix: 'p',
        fetch: (async () => new Response('', { status })) as typeof fetch,
      })
      await expect(log.append(record(1))).rejects.toThrow(`append answered ${status}`)
    }
  })

  it('refuses a record that is damaged, or not the label or revision its name says', async () => {
    for (const tamper of [
      (body: string) => body.replace('"op":"upload"', '"op":"delete"'),
      (body: string) => body.replace(`"label":"${LABEL}"`, `"label":"${OTHER_LABEL}"`),
      (body: string) => body.replace('"revision":1', '"revision":5'),
      () => 'not json',
    ]) {
      const s3 = fakeS3()
      const log = logOver(s3)
      await log.append(record(1))
      const [name] = [...s3.objects.keys()]
      s3.objects.set(name as string, tamper(s3.objects.get(name as string) as string))
      await expect(log.after(LABEL, 0)).rejects.toThrow('does not read')
    }
  })

  it('refuses an object under the label whose name is not a log name', async () => {
    const s3 = fakeS3()
    const log = logOver(s3)
    s3.objects.set(`ucp-host/test/${LABEL}/notes.txt`, 'hello')
    await expect(log.after(LABEL, 0)).rejects.toThrow('unexpected object name')
  })

  it('an unreachable bucket fails the catch-up rather than reading as empty', async () => {
    const log = s3HostLog({
      endpoint: 'https://s3.example-provider.test',
      region: 'r',
      bucket: 'dina-ucp-log',
      accessKeyId: 'a',
      secretAccessKey: 's',
      prefix: 'p',
      fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
    })
    await expect(log.after(LABEL, 0)).rejects.toThrow('listing answered 500')
  })

  it('refuses a plain-HTTP endpoint and malformed names at construction', () => {
    const base = { region: 'r', accessKeyId: 'a', secretAccessKey: 's' }
    expect(() => s3HostLog({ ...base, endpoint: 'http://s3.test', bucket: 'b-1', prefix: 'p' })).toThrow('HTTPS')
    expect(() => s3HostLog({ ...base, endpoint: 'https://s3.test', bucket: 'B', prefix: 'p' })).toThrow('bucket')
    for (const prefix of ['../x', 'a//b', '/a', 'a/', 'A']) {
      expect(() => s3HostLog({ ...base, endpoint: 'https://s3.test', bucket: 'b-1', prefix })).toThrow('prefix')
    }
  })
})
