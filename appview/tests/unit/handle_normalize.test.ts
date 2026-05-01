/**
 * Tests for the `normalizeHandle` wire-side mapping helper.
 *
 * `did_profiles.handle` uses an internal `''` sentinel for "tried to
 * resolve, no handle published" so the backfill job doesn't re-poll.
 * Wire surfaces should never expose that — it must map to `null`.
 */

import { describe, expect, it } from 'vitest'
import { normalizeHandle } from '@/util/handle_normalize.js'

describe('normalizeHandle', () => {
  it('passes a real handle through unchanged', () => {
    expect(normalizeHandle('alice.pds.dinakernel.com')).toBe(
      'alice.pds.dinakernel.com',
    )
  })

  it('maps null to null', () => {
    expect(normalizeHandle(null)).toBeNull()
  })

  it('maps undefined to null', () => {
    expect(normalizeHandle(undefined)).toBeNull()
  })

  it("maps the '' sentinel to null", () => {
    // The backfill job writes '' to the handle column when it tried
    // to resolve a DID's PLC doc but found no `alsoKnownAs`. That
    // sentinel exists so the WHERE `handle IS NULL` filter doesn't
    // pick the row up again — clients shouldn't have to know about
    // it. `normalizeHandle` is the boundary layer.
    expect(normalizeHandle('')).toBeNull()
  })
})
