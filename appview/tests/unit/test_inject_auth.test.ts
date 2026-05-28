/**
 * SEC (P3.14 + P3.11) — test-inject xRPC bearer-token gate.
 *
 * The endpoint is double-locked: it must be explicitly enabled via
 * `DINA_TEST_INJECT=1` AND a token must be set; a mismatched / bare /
 * missing Authorization header gets a 404 (NOT 401/403) so a network
 * probe can't enumerate the endpoint's existence. P3.11 added the
 * strict `Bearer ` scheme requirement — a bare token is now rejected.
 *
 * Parity with `metrics_auth.test.ts`. Pre-existing integration tests
 * exercise the route end-to-end against Postgres; this test pins the
 * auth function in isolation so the gate logic can't drift.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { checkTestInjectAuth } from '@/api/xrpc/test-inject'

const NOT_FOUND = { status: 404, body: { error: 'NotFound' } }

describe('checkTestInjectAuth (P3.14 test-inject gate, P3.11 strict Bearer)', () => {
  const origEnabled = process.env.DINA_TEST_INJECT
  const origToken = process.env.DINA_TEST_INJECT_TOKEN
  afterEach(() => {
    if (origEnabled === undefined) delete process.env.DINA_TEST_INJECT
    else process.env.DINA_TEST_INJECT = origEnabled
    if (origToken === undefined) delete process.env.DINA_TEST_INJECT_TOKEN
    else process.env.DINA_TEST_INJECT_TOKEN = origToken
  })

  it('DISABLED by default — DINA_TEST_INJECT unset → 404 even with a correct bearer', () => {
    delete process.env.DINA_TEST_INJECT
    process.env.DINA_TEST_INJECT_TOKEN = 'inject-s3cret'
    expect(checkTestInjectAuth('Bearer inject-s3cret')).toEqual(NOT_FOUND)
  })

  it('enabled but no token env → 404', () => {
    process.env.DINA_TEST_INJECT = '1'
    delete process.env.DINA_TEST_INJECT_TOKEN
    expect(checkTestInjectAuth('Bearer anything')).toEqual(NOT_FOUND)
  })

  it('enabled + empty token → 404', () => {
    process.env.DINA_TEST_INJECT = '1'
    process.env.DINA_TEST_INJECT_TOKEN = ''
    expect(checkTestInjectAuth('Bearer ')).toEqual(NOT_FOUND)
  })

  it('enabled + token + correct Bearer → null (pass)', () => {
    process.env.DINA_TEST_INJECT = '1'
    process.env.DINA_TEST_INJECT_TOKEN = 'inject-s3cret'
    expect(checkTestInjectAuth('Bearer inject-s3cret')).toBeNull()
  })

  it('enabled + token + wrong Bearer → 404 (no surface enumeration)', () => {
    process.env.DINA_TEST_INJECT = '1'
    process.env.DINA_TEST_INJECT_TOKEN = 'inject-s3cret'
    expect(checkTestInjectAuth('Bearer wrong')).toEqual(NOT_FOUND)
  })

  it('enabled + token + missing Authorization header → 404', () => {
    process.env.DINA_TEST_INJECT = '1'
    process.env.DINA_TEST_INJECT_TOKEN = 'inject-s3cret'
    expect(checkTestInjectAuth(undefined)).toEqual(NOT_FOUND)
    expect(checkTestInjectAuth('')).toEqual(NOT_FOUND)
  })

  // P3.11 — bare token without the `Bearer ` scheme is now rejected.
  // (Previously: a whole-header equality check accepted it.)
  it('enabled + token + BARE token (no Bearer prefix) → 404 (P3.11 strict Bearer)', () => {
    process.env.DINA_TEST_INJECT = '1'
    process.env.DINA_TEST_INJECT_TOKEN = 'inject-s3cret'
    expect(checkTestInjectAuth('inject-s3cret')).toEqual(NOT_FOUND)
  })

  // Adjacent schemes that share a prefix substring must NOT match —
  // the check is `startsWith('Bearer ')` with the trailing space.
  it('enabled + token + non-Bearer scheme → 404', () => {
    process.env.DINA_TEST_INJECT = '1'
    process.env.DINA_TEST_INJECT_TOKEN = 'inject-s3cret'
    expect(checkTestInjectAuth('Basic inject-s3cret')).toEqual(NOT_FOUND)
    expect(checkTestInjectAuth('Bearerinject-s3cret')).toEqual(NOT_FOUND)
  })
})
