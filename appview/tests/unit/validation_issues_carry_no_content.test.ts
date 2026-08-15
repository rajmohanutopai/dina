/**
 * A rejected record's diagnostics must not carry the publisher's bytes.
 *
 * §22 and the repository's PII invariant: log metadata, never content. This is
 * sharper for AppView than for Core, because AppView's input is a PUBLIC
 * FIREHOSE — the "publisher" is any stranger, and a rejection is exactly the
 * path a hostile record takes.
 *
 * WHY IT NEEDED A TEST OF ITS OWN. `validateRecord` already redacted its own
 * log line to `{code, path}`, which looked like the whole fix. It was not:
 * the function still RETURNED Zod's raw error, the ingester put that object
 * into the rejection `detail`, and `recordRejection` both persists `detail`
 * and spreads it into a warn log. The leak had simply moved one caller
 * downstream, where the redaction was no longer looking.
 *
 * A `ZodError` is not a safe diagnostic for untrusted input:
 *   - `invalid_literal` / `invalid_enum_value` carry `received` — the actual value
 *   - `unrecognized_keys` carries `keys` — publisher-chosen key names
 *   - `message` interpolates both
 *
 * So the assertion is about the RETURNED value, not about one call site. If a
 * future change hands anything richer back, this fails wherever that value
 * eventually gets written.
 */

import { describe, expect, it, vi } from 'vitest'

import { validateRecord } from '@/ingester/record-validator.js'
import { logger } from '@/shared/utils/logger.js'

/** Distinctive enough that a substring search cannot match it by accident. */
const SENTINEL = 'sk-live-SENTINEL-51d0c2e7-do-not-log'

describe('validation diagnostics carry structure, never content', () => {
  it('does not return the publisher’s value for a rejected field', () => {
    const result = validateRecord('com.dinakernel.peerlens.attestation', {
      // Wrong type where a string is required: the classic `invalid_type`,
      // and the shape most likely to quote what it received.
      subject: SENTINEL,
      category: SENTINEL,
      sentiment: SENTINEL,
      createdAt: SENTINEL,
    })

    expect(result.success).toBe(false)
    expect(result.errors, 'a rejection must still say what was wrong').toBeDefined()
    expect(result.errors?.length).toBeGreaterThan(0)

    const serialized = JSON.stringify(result.errors)
    expect(serialized).not.toContain(SENTINEL)
  })

  it('does not return the rejected value of an ENUM field', () => {
    // A DIFFERENT leak shape from the one above, and the worst of them:
    // `invalid_enum_value` sets `received` to the publisher's literal string
    // and repeats it inside `message`. Verified against zod directly — an
    // enum mismatch yields
    //   {received: '<their value>', code: 'invalid_enum_value', …}
    //
    // This replaces an earlier case that aimed at `unrecognized_keys`. No
    // schema in this validator uses `.strict()`, so that issue is never
    // produced and the case passed on unrelated missing-field errors — green
    // without testing its own subject, which is the defect class this whole
    // review round keeps turning up.
    const result = validateRecord('com.dinakernel.peerlens.attestation', {
      subject: { type: 'product', name: 'a chair' },
      category: 'commerce/product',
      sentiment: SENTINEL,
      createdAt: '2026-08-11T00:00:00.000Z',
    })

    expect(result.success).toBe(false)
    const issues = result.errors ?? []
    expect(issues.some((i) => i.path === 'sentiment')).toBe(true)
    expect(JSON.stringify(issues)).not.toContain(SENTINEL)
  })

  it('does not WRITE the publisher’s value to the log', () => {
    // The returned value and the log line are two separate exits, and this
    // module has now leaked through each of them at different times.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    try {
      validateRecord('com.dinakernel.peerlens.attestation', {
        subject: SENTINEL,
        category: SENTINEL,
        sentiment: SENTINEL,
        createdAt: SENTINEL,
      })
      expect(warn).toHaveBeenCalled()
      const written = JSON.stringify(warn.mock.calls)
      expect(written).not.toContain(SENTINEL)
    } finally {
      warn.mockRestore()
    }
  })

  it('still says enough to diagnose the rejection', () => {
    // The privacy rule must not be satisfied by returning nothing — that would
    // pass every assertion above and leave an operator unable to act. Structure
    // is what survives redaction, so structure has to actually be there.
    const result = validateRecord('com.dinakernel.peerlens.attestation', {
      subject: 123,
      category: 'commerce/product',
      sentiment: 'positive',
      createdAt: '2026-08-11T00:00:00.000Z',
    })

    expect(result.success).toBe(false)
    const issues = result.errors ?? []
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(typeof issue.code).toBe('string')
      expect(issue.code.length).toBeGreaterThan(0)
      expect(typeof issue.path).toBe('string')
    }
    expect(issues.some((i) => i.path === 'subject')).toBe(true)
  })
})
