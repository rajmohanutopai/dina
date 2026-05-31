import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { encodeCursor, decodeCursor, InvalidCursorError } from '@/util/cursor.js'

describe('opaque cursor helper', () => {
  const TsUriPayload = z.object({
    ts: z.string().datetime(),
    uri: z.string(),
  })

  const BucketUriPayload = z.object({
    bucket: z.number(),
    uri: z.string(),
  })

  it('round-trips a ts/uri payload through encode → decode', () => {
    const payload = {
      ts: '2026-05-23T12:34:56.000Z',
      uri: 'at://did:plc:alice/com.dinakernel.peerlens.attestation/3kxy',
    }
    const encoded = encodeCursor(payload)
    expect(typeof encoded).toBe('string')
    const decoded = decodeCursor(encoded, TsUriPayload)
    expect(decoded).toEqual(payload)
  })

  it('round-trips a bucket/uri payload through encode → decode', () => {
    const payload = { bucket: 800, uri: 'at://did:plc:b/com.dinakernel.service.profile/self' }
    const decoded = decodeCursor(encodeCursor(payload), BucketUriPayload)
    expect(decoded).toEqual(payload)
  })

  it('emits a base64url-encoded JSON envelope', () => {
    const encoded = encodeCursor({ ts: '2026-05-23T00:00:00.000Z', uri: 'at://x' })
    // No `+`, `/`, or `=` characters — base64url is URL-safe by definition.
    expect(encoded).not.toMatch(/[+/=]/)
    const inner = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    expect(inner).toMatchObject({
      v: 1,
      ts: '2026-05-23T00:00:00.000Z',
      uri: 'at://x',
    })
  })

  it('throws InvalidCursorError on non-base64url input', () => {
    expect(() => decodeCursor('!!!not-base64url!!!', TsUriPayload)).toThrow(InvalidCursorError)
  })

  it('throws InvalidCursorError on base64url that isn\'t JSON', () => {
    const garbage = Buffer.from('hello world').toString('base64url')
    expect(() => decodeCursor(garbage, TsUriPayload)).toThrow(InvalidCursorError)
  })

  it('throws InvalidCursorError when the envelope version mismatches', () => {
    const v99 = Buffer.from(
      JSON.stringify({ v: 99, ts: '2026-05-23T00:00:00.000Z', uri: 'at://x' }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(v99, TsUriPayload)).toThrow(InvalidCursorError)
  })

  it('throws InvalidCursorError when the payload fails the Zod schema', () => {
    // Right envelope shape, wrong payload — `ts` isn't an ISO datetime.
    const bad = Buffer.from(
      JSON.stringify({ v: 1, ts: 'not-a-timestamp', uri: 'at://x' }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(bad, TsUriPayload)).toThrow(InvalidCursorError)
  })

  it('throws InvalidCursorError when the payload is missing a required field', () => {
    const missingUri = Buffer.from(
      JSON.stringify({ v: 1, ts: '2026-05-23T00:00:00.000Z' }),
      'utf8',
    ).toString('base64url')
    expect(() => decodeCursor(missingUri, TsUriPayload)).toThrow(InvalidCursorError)
  })

  it('rejects a plaintext `${ISO}::${uri}` string (not a valid envelope)', () => {
    // A naive ISO-prefixed cursor is the most plausible-looking
    // non-opaque input a caller might construct by hand. Confirm
    // the envelope discipline rejects it — only opaque base64url
    // envelopes are accepted.
    const plaintext = '2026-05-23T00:00:00.000Z::at://did:plc:alice/com.dinakernel.peerlens.attestation/3kxy'
    expect(() => decodeCursor(plaintext, TsUriPayload)).toThrow(InvalidCursorError)
  })

  it('InvalidCursorError names itself ZodError so the web layer maps it to 400', () => {
    const err = new InvalidCursorError()
    expect(err.name).toBe('ZodError')
    expect(err.message).toBe('Invalid cursor format')
  })
})
