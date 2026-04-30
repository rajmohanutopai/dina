/**
 * Unit tests for `appview/src/api/middleware/trust-flag-gate.ts`
 * (TN-FLAG-003).
 *
 * Contract:
 *   - `com.dina.trust.*` methods pass when flag = true
 *   - `com.dina.trust.*` methods 503 when flag = false
 *   - `com.dina.service.*` methods always pass (separate namespace,
 *     not gated by trust V1 ramp)
 *   - DB error => 503 (closed-default)
 *   - Methods outside both namespaces (e.g. `app.bsky.foo`) pass
 */

import { describe, expect, it, vi } from 'vitest'
import { gateTrustNamespace } from '@/api/middleware/trust-flag-gate'
import type { DrizzleDB } from '@/db/connection'

interface FlagState {
  value: boolean | null
  throws?: Error
}

/**
 * Minimal DrizzleDB stub matching the shape that `readBoolFlag` uses:
 *   db.select({...}).from(...).where(...).limit(1) → Promise<row[]>
 */
function stubDb(state: FlagState): DrizzleDB {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (state.throws) throw state.throws
            if (state.value === null) return []
            return [{ boolValue: state.value }]
          },
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

describe('gateTrustNamespace — TN-FLAG-003', () => {
  it('trust method with flag=true → ok', async () => {
    const db = stubDb({ value: true })
    const result = await gateTrustNamespace(db, 'com.dina.trust.resolve')
    expect(result.ok).toBe(true)
  })

  it('trust method with no flag row → ok (FLAG_DEFAULTS.trust_v1_enabled = true)', async () => {
    // Fresh deploy / test DB / pre-seed state: the row hasn't been
    // written yet. The reader falls through to FLAG_DEFAULTS, which
    // pins V1's "default ON" cutover stance. This MUST resolve to ok
    // — otherwise every fresh deploy would 503 on every trust call
    // until an operator manually flipped the flag on, which is
    // backwards from the V1 ramp.
    const db = stubDb({ value: null })
    const result = await gateTrustNamespace(db, 'com.dina.trust.resolve')
    expect(result.ok).toBe(true)
  })

  it('trust method with flag=false → 503', async () => {
    // Operator has flipped the kill-switch. Every trust-namespace xRPC
    // call must surface as a 5xx so client backoff kicks in and ops
    // dashboards see the disabled state.
    const db = stubDb({ value: false })
    const result = await gateTrustNamespace(db, 'com.dina.trust.search')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(503)
      expect(result.body.error).toBe('ServiceUnavailable')
      expect(result.body.message).toBe('Trust V1 is currently disabled')
    }
  })

  it('trust method with flag-read error → 503 (closed-default)', async () => {
    // We can't read the flag (transient pg error). Failing open would
    // risk serving data the operator just disabled — safer to 503 and
    // let the client retry once the DB recovers.
    const db = stubDb({ value: true, throws: new Error('connection refused') })
    const result = await gateTrustNamespace(db, 'com.dina.trust.getProfile')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(503)
      expect(result.body.error).toBe('ServiceUnavailable')
      expect(result.body.message).toBe('Trust V1 status unavailable')
    }
  })

  it('service method passes regardless of flag value (false)', async () => {
    // Service registry is a separate surface. Trust V1 disable must
    // NOT affect provider discovery / capability schemas — those
    // are independent and operators rely on them during incident
    // response.
    const db = stubDb({ value: false })
    const result = await gateTrustNamespace(db, 'com.dina.service.search')
    expect(result.ok).toBe(true)
  })

  it('service method passes when flag read errors out', async () => {
    // Service path must NOT even read the flag — it's not gated. A
    // DB error on the flag table should not block service traffic.
    const db = stubDb({ value: true, throws: new Error('connection refused') })
    const result = await gateTrustNamespace(db, 'com.dina.service.isDiscoverable')
    expect(result.ok).toBe(true)
  })

  it('unknown / non-dina namespace methods pass through (not gated here)', async () => {
    // The gate's contract is "trust V1 kill-switch" — out-of-namespace
    // methods are someone else's concern (the dispatcher's 400-Unknown
    // method, or whatever sits next in the chain).
    const db = stubDb({ value: false })
    const result = await gateTrustNamespace(db, 'app.bsky.feed.getTimeline')
    expect(result.ok).toBe(true)
  })

  it('does NOT call the DB for non-trust methods', async () => {
    // Performance + correctness: service traffic must not pay a flag
    // read on every request. Verifies the prefix check short-circuits
    // before any DB access.
    const select = vi.fn()
    const db = { select } as unknown as DrizzleDB
    const result = await gateTrustNamespace(db, 'com.dina.service.search')
    expect(result.ok).toBe(true)
    expect(select).not.toHaveBeenCalled()
  })

  it('exact prefix match — `com.dina.trustNotReally` is NOT gated', async () => {
    // Defense against a future method whose name happens to share a
    // prefix substring. The gate matches `com.dina.trust.` (with the
    // trailing dot), not `com.dina.trust` — so a hypothetical
    // `com.dina.trustNotReally.foo` won't be misclassified.
    const db = stubDb({ value: false })
    const result = await gateTrustNamespace(db, 'com.dina.trustNotReally.foo')
    expect(result.ok).toBe(true)
  })

  describe('error message contract — mutual distinctness', () => {
    // Operators grep dina logs for these exact strings to triage
    // incidents: "is the kill-switch flipped, or is pg flapping?"
    // The two 503 branches MUST emit distinct messages, neither one
    // a substring of the other. A future copy edit like
    //   "Trust V1 disabled — DB unavailable"
    // would silently match both `/disabled/i` and `/unavailable/i`
    // regexes — pinning the exact strings + a substring-disjointness
    // check closes that bug class.

    async function fetchDisabled(): Promise<{ status: number; message: string }> {
      const result = await gateTrustNamespace(
        stubDb({ value: false }),
        'com.dina.trust.search',
      )
      if (result.ok) throw new Error('expected denied')
      return { status: result.status, message: result.body.message }
    }

    async function fetchDbError(): Promise<{ status: number; message: string }> {
      const result = await gateTrustNamespace(
        stubDb({ value: true, throws: new Error('boom') }),
        'com.dina.trust.search',
      )
      if (result.ok) throw new Error('expected denied')
      return { status: result.status, message: result.body.message }
    }

    it('both branches return 503 (operator dashboards aggregate by status)', async () => {
      const disabled = await fetchDisabled()
      const dbError = await fetchDbError()
      expect(disabled.status).toBe(503)
      expect(dbError.status).toBe(503)
    })

    it('messages are exactly the documented strings', async () => {
      const disabled = await fetchDisabled()
      const dbError = await fetchDbError()
      expect(disabled.message).toBe('Trust V1 is currently disabled')
      expect(dbError.message).toBe('Trust V1 status unavailable')
    })

    it('messages are not equal to each other', async () => {
      const disabled = await fetchDisabled()
      const dbError = await fetchDbError()
      expect(disabled.message).not.toBe(dbError.message)
    })

    it('neither message is a substring of the other (substring-disjoint)', async () => {
      // The bug we're guarding against: "Trust V1 disabled — DB
      // unavailable" would pass both /disabled/i and /unavailable/i
      // matchers and make the two states indistinguishable.
      // Substring-disjointness is the strongest grep-friendly invariant.
      const disabled = await fetchDisabled()
      const dbError = await fetchDbError()
      expect(disabled.message.includes(dbError.message)).toBe(false)
      expect(dbError.message.includes(disabled.message)).toBe(false)
    })

    it('discriminating tokens appear in exactly one branch', async () => {
      // `disabled` belongs to the kill-switch branch; `unavailable`
      // belongs to the DB-error branch. Neither token may leak
      // across — that would re-introduce the regex-ambiguity bug.
      const disabled = await fetchDisabled()
      const dbError = await fetchDbError()
      expect(disabled.message).toMatch(/disabled/i)
      expect(disabled.message).not.toMatch(/unavailable/i)
      expect(dbError.message).toMatch(/unavailable/i)
      expect(dbError.message).not.toMatch(/disabled/i)
    })
  })
})
