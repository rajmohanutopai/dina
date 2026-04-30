/**
 * Unit tests for `appview/src/shared/utils/logger.ts` field redaction
 * (TN-OBS-003 / Plan §13.8).
 *
 * Contract:
 *   - Production output is structured JSON (verified by parsing)
 *   - Sensitive paths in `redact.paths` are replaced with [REDACTED]
 *   - Non-sensitive fields (DID, URI, subjectId, error message) are
 *     emitted as-is
 *   - The redacted literal is `[REDACTED]` (distinct from null) so
 *     log readers can tell "had a value, redacted it" from "absent"
 *
 * Strategy: build an isolated pino instance with the SAME redact
 * config as the production logger, but pipe its output to a captured
 * Writable stream. Parse each line as JSON and assert.
 */

import { describe, expect, it } from 'vitest'
import pino from 'pino'

const PRODUCTION_REDACT_CONFIG = {
  paths: [
    '*.password',
    '*.passwd',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.authorization',
    '*.cookie',
    'headers.authorization',
    'headers.cookie',
    '*.privateKey',
    '*.secret',
    '*.apiKey',
    '*.text_value',
  ],
  censor: '[REDACTED]',
}

/** Build a pino logger that writes JSON lines into the provided buffer. */
function makeCapturingLogger(buffer: string[]) {
  return pino(
    { level: 'info', redact: PRODUCTION_REDACT_CONFIG },
    {
      write(chunk: string) {
        buffer.push(chunk)
      },
    } as NodeJS.WritableStream,
  )
}

function lastLog(buffer: string[]): Record<string, unknown> {
  expect(buffer.length).toBeGreaterThan(0)
  return JSON.parse(buffer[buffer.length - 1])
}

describe('logger — TN-OBS-003 structured JSON output', () => {
  it('emits valid JSON per log line', () => {
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info('hello world')
    const parsed = lastLog(buffer)
    expect(parsed.msg).toBe('hello world')
    expect(parsed.level).toBe(30) // pino INFO
  })

  it('preserves non-sensitive fields as-is', () => {
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info(
      {
        did: 'did:plc:alice',
        uri: 'at://did:plc:alice/com.dina.trust.attestation/3kfx',
        subjectId: 'subj-abc',
        method: 'com.dina.trust.search',
        durationMs: 42,
      },
      'request handled',
    )
    const parsed = lastLog(buffer)
    expect(parsed.did).toBe('did:plc:alice')
    expect(parsed.uri).toBe('at://did:plc:alice/com.dina.trust.attestation/3kfx')
    expect(parsed.subjectId).toBe('subj-abc')
    expect(parsed.method).toBe('com.dina.trust.search')
    expect(parsed.durationMs).toBe(42)
  })
})

describe('logger — TN-OBS-003 field redaction', () => {
  it('redacts a top-level *.password match', () => {
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info({ user: { password: 'hunter2' } }, 'login')
    const parsed = lastLog(buffer)
    // Wildcard `*.password` matches user.password
    expect((parsed.user as Record<string, unknown>).password).toBe('[REDACTED]')
  })

  it('redacts *.token / *.accessToken / *.refreshToken', () => {
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info(
      {
        ctx: {
          token: 'eyJhbGciOi...',
          accessToken: 'access-xyz',
          refreshToken: 'refresh-abc',
        },
      },
      'auth',
    )
    const parsed = lastLog(buffer)
    const ctx = parsed.ctx as Record<string, unknown>
    expect(ctx.token).toBe('[REDACTED]')
    expect(ctx.accessToken).toBe('[REDACTED]')
    expect(ctx.refreshToken).toBe('[REDACTED]')
  })

  it('redacts headers.authorization (HTTP header path)', () => {
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info({ headers: { authorization: 'Bearer abc' } }, 'incoming')
    const parsed = lastLog(buffer)
    const headers = parsed.headers as Record<string, unknown>
    expect(headers.authorization).toBe('[REDACTED]')
  })

  it('redacts *.privateKey / *.secret / *.apiKey', () => {
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info(
      {
        creds: { privateKey: 'PEM...', secret: 'shh', apiKey: 'sk-...' },
      },
      'creds loaded',
    )
    const parsed = lastLog(buffer)
    const creds = parsed.creds as Record<string, unknown>
    expect(creds.privateKey).toBe('[REDACTED]')
    expect(creds.secret).toBe('[REDACTED]')
    expect(creds.apiKey).toBe('[REDACTED]')
  })

  it('redacts *.text_value (appview_config future-secret guard)', () => {
    // text_value column may hold webhook URLs / tokens for future flags.
    // Default to redacted; explicit audit logger can opt in if needed.
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info({ row: { key: 'webhook_url', text_value: 'https://x' } }, 'flag')
    const parsed = lastLog(buffer)
    const row = parsed.row as Record<string, unknown>
    expect(row.text_value).toBe('[REDACTED]')
    // The non-sensitive `key` column passes through.
    expect(row.key).toBe('webhook_url')
  })

  it('redacts to the literal [REDACTED] string (not null/undefined)', () => {
    // Distinct from absent — log readers can tell "had a value but
    // redacted it" vs "the field was never set". Crucial for audit
    // logs where "was a token attached?" is itself a signal.
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info({ ctx: { token: 'abc' } }, 'redact-format')
    const parsed = lastLog(buffer)
    const ctx = parsed.ctx as Record<string, unknown>
    expect(ctx.token).toBe('[REDACTED]')
    expect(ctx.token).not.toBeNull()
    expect(ctx.token).not.toBeUndefined()
  })

  it('does NOT redact DID / URI / method / error message fields', () => {
    // CLAUDE.md "PII never in logs" puts the burden on the call site;
    // the redact list is for catastrophic-leak fields. DIDs and
    // AT-URIs are public identifiers and intentional log content for
    // trust-network tracing.
    const buffer: string[] = []
    const log = makeCapturingLogger(buffer)
    log.info(
      {
        did: 'did:plc:alice',
        uri: 'at://did:plc:alice/com.dina.trust.attestation/3kfx',
        method: 'com.dina.trust.search',
        err: { message: 'subject not found' },
      },
      'lookup failed',
    )
    const parsed = lastLog(buffer)
    expect(parsed.did).toBe('did:plc:alice')
    expect(parsed.uri).toBe('at://did:plc:alice/com.dina.trust.attestation/3kfx')
    expect(parsed.method).toBe('com.dina.trust.search')
    expect((parsed.err as Record<string, unknown>).message).toBe(
      'subject not found',
    )
  })
})
