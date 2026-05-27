/**
 * SEC (P3.13) — `/metrics` bearer-token gate. Disabled unless
 * DINA_METRICS_TOKEN is set AND the request presents it; otherwise the call
 * site returns 404 (no surface enumeration).
 */

import { describe, expect, it, afterEach } from 'vitest'
import { checkMetricsAuth } from '@/web/metrics_auth'

describe('checkMetricsAuth (P3.13 /metrics gate)', () => {
  const orig = process.env.DINA_METRICS_TOKEN
  afterEach(() => {
    if (orig === undefined) delete process.env.DINA_METRICS_TOKEN
    else process.env.DINA_METRICS_TOKEN = orig
  })

  it('DISABLED by default — no token env → false even with a bearer', () => {
    delete process.env.DINA_METRICS_TOKEN
    expect(checkMetricsAuth('Bearer anything')).toBe(false)
    expect(checkMetricsAuth(undefined)).toBe(false)
  })

  it('empty token env → still disabled', () => {
    process.env.DINA_METRICS_TOKEN = ''
    expect(checkMetricsAuth('Bearer ')).toBe(false)
  })

  it('token set + correct Bearer → true', () => {
    process.env.DINA_METRICS_TOKEN = 's3cret-metrics-token'
    expect(checkMetricsAuth('Bearer s3cret-metrics-token')).toBe(true)
  })

  it('token set + wrong / missing bearer → false', () => {
    process.env.DINA_METRICS_TOKEN = 's3cret-metrics-token'
    expect(checkMetricsAuth('Bearer wrong')).toBe(false)
    expect(checkMetricsAuth(undefined)).toBe(false)
    expect(checkMetricsAuth('')).toBe(false)
  })
})
