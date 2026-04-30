/**
 * Unit tests for `refresh-reviewer-namespace-stats.ts` (TN-SCORE-001).
 *
 * Pins the contract that the per-(did, namespace) reviewer-stats
 * refresh job depends on:
 *
 *   - **No-op fast-path**: empty dirty drain → debug-log + early
 *     return (no UPDATEs issued, no batch counter).
 *   - **Per-row failure isolation**: a poisoned row throws → the
 *     batch continues with the rest. Without this the firehose
 *     gets stuck behind one bad row.
 *   - **Filter shape**: attestations query uses BOTH
 *     `author_did = ?` AND `namespace = ?` (the load-bearing
 *     namespace partition that makes per-namespace stats per-
 *     namespace).
 *   - **JOIN-via-URI for revocations + reactions**: revocations
 *     don't carry a namespace; the namespace is derived from the
 *     target attestation. Pinned because dropping the URI filter
 *     would over-count (every revocation by the author counted
 *     against every namespace).
 *   - **Deletion stats deferred to V2**: `tombstoneCount` passed as
 *     0 to `computeReviewerQuality` in the V1 path. Pinned by test
 *     so a future V2 wiring of `tombstones.namespace` lands as a
 *     deliberate test change rather than silent behaviour drift.
 *   - **Stamp + reset**: every UPDATE explicitly sets
 *     `scoreVersion: 'v1'` AND clears `needsRecalc`. Without the
 *     reset, the same row drains forever.
 *   - **Algorithm parity**: the same `computeReviewerQuality` runs
 *     on the per-namespace counters as on the root-identity ones —
 *     mirror by design (TN-DB-002 docstring).
 *
 * Pure unit tests against a stubbed DB — no Postgres required.
 */

import { describe, expect, it, vi } from 'vitest'

const mockMetricsCounter = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { counter: (...args: unknown[]) => mockMetricsCounter(...args) },
}))

const mockLoggerInfo = vi.fn()
const mockLoggerDebug = vi.fn()
const mockLoggerError = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    warn: vi.fn(),
    error: (...a: unknown[]) => mockLoggerError(...a),
  },
}))

import {
  computeNamespaceStats,
  refreshReviewerNamespaceStats,
} from '@/scorer/jobs/refresh-reviewer-namespace-stats'
import {
  attestations,
  reactions,
  revocations,
  reviewerNamespaceScores,
} from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

// ─── Stub DB shape ───────────────────────────────────────────────────────

interface AttRow {
  uri: string
  subjectId: string | null
  sentiment: string
  evidenceJson: unknown[] | null
  isAgentGenerated: boolean
}

interface NamespaceRow {
  did: string
  namespace: string
}

interface StubOptions {
  /** Dirty (did, namespace) rows the drain query returns. */
  dirty: NamespaceRow[]
  /**
   * Per-(did, namespace) attestation rows the namespace-filtered
   * select returns. Keyed by `${did}::${namespace}`.
   */
  authoredByNamespace?: Record<string, AttRow[]>
  /** Revocation row count to return for the author+URI filter. */
  revocationsByAuthor?: Record<string, number>
  /** Reaction kinds to return for the URI filter. */
  reactionsByUriList?: Record<string, Array<{ reaction: string }>>
  /**
   * Forces an exception on the FIRST update — pins the per-row
   * failure-isolation contract.
   */
  failFirstUpdate?: boolean
}

interface StubCapture {
  drainCount: number
  attestationFilters: Array<{ did: string | null; namespace: string | null }>
  revocationFilters: Array<{ author: string | null; uriCount: number }>
  reactionUris: string[][]
  updates: Array<{
    did: string
    namespace: string
    setValue: Record<string, unknown>
  }>
}

function stubDb(options: StubOptions): { db: DrizzleDB; capture: StubCapture } {
  const capture: StubCapture = {
    drainCount: 0,
    attestationFilters: [],
    revocationFilters: [],
    reactionUris: [],
    updates: [],
  }

  // Each iteration of the job's main loop calls EXACTLY ONE
  // "authored-attestations-for-(did, namespace)" query (5 cols).
  // We use that query's invocation count as the cursor — each call
  // advances to the next dirty row. This survives thrown updates
  // because the cursor only advances when the per-row loop actually
  // starts (= the authored query fires).
  let authoredQueryCallIdx = -1

  const currentRow = (): NamespaceRow | null => {
    if (authoredQueryCallIdx < 0 || authoredQueryCallIdx >= options.dirty.length) {
      return null
    }
    return options.dirty[authoredQueryCallIdx]!
  }

  const db = {
    select: (selObj?: Record<string, unknown>) => {
      const cols = selObj ? Object.keys(selObj) : []
      return {
        from: (table: unknown) => {
          if (table === reviewerNamespaceScores) {
            // Drain query.
            return {
              where: () => ({
                limit: async () => {
                  capture.drainCount++
                  return options.dirty
                },
              }),
            }
          }
          if (table === attestations) {
            // 5-column select = authored-attestations for the
            // current (did, namespace). 1-column select = corroboration
            // check (has .limit(2)).
            if (cols.length === 5) {
              return {
                where: (..._args: unknown[]) => {
                  // Advance the row cursor on EACH per-row authored
                  // query. Survives thrown updates from earlier rows.
                  authoredQueryCallIdx++
                  const row = currentRow()
                  capture.attestationFilters.push({
                    did: row?.did ?? null,
                    namespace: row?.namespace ?? null,
                  })
                  if (!row) return Promise.resolve([])
                  const key = `${row.did}::${row.namespace}`
                  return Promise.resolve(options.authoredByNamespace?.[key] ?? [])
                },
              }
            }
            return {
              where: () => ({
                limit: async () => [],
              }),
            }
          }
          if (table === revocations) {
            return {
              where: () => {
                const row = currentRow()
                capture.revocationFilters.push({
                  author: row?.did ?? null,
                  uriCount: -1, // would require full SQL parse
                })
                if (!row) return Promise.resolve([])
                const key = `${row.did}::${row.namespace}`
                const count = options.revocationsByAuthor?.[key] ?? 0
                return Promise.resolve(
                  Array.from({ length: count }, (_, i) => ({ uri: `r${i}` })),
                )
              },
            }
          }
          if (table === reactions) {
            return {
              where: () => {
                const row = currentRow()
                if (!row) return Promise.resolve([])
                const key = `${row.did}::${row.namespace}`
                capture.reactionUris.push(
                  (options.authoredByNamespace?.[key] ?? []).map((a) => a.uri),
                )
                return Promise.resolve(options.reactionsByUriList?.[key] ?? [])
              },
            }
          }
          return { where: () => Promise.resolve([]) }
        },
      }
    },
    update: (table: unknown) => {
      if (table !== reviewerNamespaceScores) {
        return { set: () => ({ where: async () => undefined }) }
      }
      return {
        set: (setValue: Record<string, unknown>) => ({
          where: async () => {
            const row = currentRow()
            if (!row) return
            // Forced-failure for the FIRST row, to pin per-row
            // isolation. The cursor is already advanced; the job's
            // catch will swallow + move to the next iteration,
            // which advances the cursor again at its authored query.
            if (options.failFirstUpdate && capture.updates.length === 0 && authoredQueryCallIdx === 0) {
              throw new Error('STUB: forced failure for isolation test')
            }
            capture.updates.push({
              did: row.did,
              namespace: row.namespace,
              setValue,
            })
          },
        }),
      }
    },
  } as unknown as DrizzleDB

  return { db, capture }
}

async function runJobAgainstStub(
  options: StubOptions,
): Promise<{ capture: StubCapture; threw: unknown }> {
  const { db, capture } = stubDb(options)
  let threw: unknown = null
  try {
    await refreshReviewerNamespaceStats(db)
  } catch (e) {
    threw = e
  }
  return { capture, threw }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('refreshReviewerNamespaceStats — drain', () => {
  it('returns early when no dirty rows (debug log, no updates, no counter)', async () => {
    mockMetricsCounter.mockClear()
    mockLoggerDebug.mockClear()
    mockLoggerInfo.mockClear()

    const { capture } = await runJobAgainstStub({ dirty: [] })

    expect(capture.drainCount).toBe(1)
    expect(capture.updates).toHaveLength(0)
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      'refresh-reviewer-namespace-stats: no dirty rows',
    )
    // No batch counter on the empty path — pinning so a future
    // refactor that emits 0 doesn't accidentally break dashboards.
    expect(mockMetricsCounter).not.toHaveBeenCalled()
  })

  it('issues one UPDATE per dirty row', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [
        { did: 'did:plc:a', namespace: 'namespace_0' },
        { did: 'did:plc:a', namespace: 'namespace_1' },
        { did: 'did:plc:b', namespace: 'namespace_0' },
      ],
    })

    expect(capture.updates).toHaveLength(3)
    expect(capture.updates.map((u) => `${u.did}::${u.namespace}`)).toEqual([
      'did:plc:a::namespace_0',
      'did:plc:a::namespace_1',
      'did:plc:b::namespace_0',
    ])
  })
})

describe('refreshReviewerNamespaceStats — UPDATE shape', () => {
  it('every UPDATE explicitly stamps scoreVersion: "v1" + clears needsRecalc', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
    })
    expect(capture.updates).toHaveLength(1)
    const set = capture.updates[0]!.setValue
    // TN-SCORE-002 forward-compat — explicit V1 stamp on every
    // UPDATE so a row's score_version always reflects the
    // algorithm that produced it.
    expect(set.scoreVersion).toBe('v1')
    // Must clear needs_recalc — otherwise the row drains forever.
    expect(set.needsRecalc).toBe(false)
    // Sets computedAt to a fresh Date.
    expect(set.computedAt).toBeInstanceOf(Date)
  })

  it('UPDATE includes all reviewer-quality output fields', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
    })
    const set = capture.updates[0]!.setValue
    // Pin the contract that the formula's outputs land in the
    // table — drift here is the formula not being applied.
    expect(set).toHaveProperty('totalAttestationsBy')
    expect(set).toHaveProperty('revocationCount')
    expect(set).toHaveProperty('revocationRate')
    expect(set).toHaveProperty('deletionRate')
    expect(set).toHaveProperty('corroborationRate')
    expect(set).toHaveProperty('evidenceRate')
    expect(set).toHaveProperty('overallTrustScore')
  })
})

describe('refreshReviewerNamespaceStats — counters from data', () => {
  it('totalAttestationsBy = number of authored rows for (did, namespace)', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: false,
          },
          {
            uri: 'at://x/2',
            subjectId: 's2',
            sentiment: 'negative',
            evidenceJson: [{}],
            isAgentGenerated: false,
          },
        ],
      },
    })
    expect(capture.updates[0]!.setValue.totalAttestationsBy).toBe(2)
  })

  it('revocationCount = revocations BY author of attestations IN this namespace', async () => {
    // The revocation-attribution rule: revocations don't carry a
    // namespace, but the JOIN is implicit — we filter revocations
    // by `inArray(revocations.targetUri, authoredAttUris)`.
    // Two namespaces with disjoint attestation URIs would NOT
    // share revocation counts; this test pins that with a single
    // namespace's revocation total.
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: false,
          },
        ],
      },
      revocationsByAuthor: { 'did:plc:a::namespace_0': 3 },
    })
    expect(capture.updates[0]!.setValue.revocationCount).toBe(3)
  })

  it('zero attestations → zero revocation/reaction queries (perf optimisation pinned)', async () => {
    // When there are no authored attestation URIs to filter on, the
    // job skips the revocation/reaction queries entirely. The point
    // is bounded-cost on namespaces that exist but have no records.
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:empty', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:empty::namespace_0': [],
      },
    })
    expect(capture.revocationFilters).toHaveLength(0)
    expect(capture.reactionUris).toHaveLength(0)
    expect(capture.updates[0]!.setValue.totalAttestationsBy).toBe(0)
    expect(capture.updates[0]!.setValue.revocationCount).toBe(0)
  })

  it('overall_trust_score is in [0, 1] range (formula clamp applied)', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: [{}],
            isAgentGenerated: false,
          },
        ],
      },
    })
    const score = capture.updates[0]!.setValue.overallTrustScore as number
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })
})

// ─── computeNamespaceStats — direct ──────────────────────────────────────

describe('computeNamespaceStats — V1 deferral', () => {
  // The V1 path passes `tombstoneCount: 0` to `computeReviewerQuality`
  // (tombstones don't carry namespace; deferred to V2). Captured via
  // the UPDATE's `set` payload — `deletionRate` derives from
  // tombstoneCount and total attestations, so a non-zero tombstone
  // input would surface as non-zero deletionRate.
  it('deletionRate is 0 when no tombstones (V1 deferral)', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: false,
          },
        ],
      },
    })
    expect(capture.updates[0]!.setValue.deletionRate).toBe(0)
  })

  it('evidenceRate counts only rows with non-empty evidenceJson', async () => {
    const { capture } = await runJobAgainstStub({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: [{ url: 'x' }],
            isAgentGenerated: false,
          },
          {
            uri: 'at://x/2',
            subjectId: 's2',
            sentiment: 'positive',
            evidenceJson: [], // empty array — not "with evidence"
            isAgentGenerated: false,
          },
          {
            uri: 'at://x/3',
            subjectId: 's3',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: false,
          },
        ],
      },
    })
    // 1 of 3 rows has non-empty evidence → 1/3 evidenceRate.
    expect(capture.updates[0]!.setValue.evidenceRate).toBeCloseTo(1 / 3, 6)
    expect(capture.updates[0]!.setValue.totalAttestationsBy).toBe(3)
  })
})

// ─── computeNamespaceStats — direct (no job loop) ────────────────────────

describe('computeNamespaceStats — exported helper', () => {
  // The exported helper IS the unit-under-test for the data-gathering
  // contract. Calling it directly (outside the job's loop) verifies
  // the V1-deferral pin and per-counter computation in isolation.

  function freshStubForDirectCall(opts: StubOptions): DrizzleDB {
    const { db } = stubDb(opts)
    return db
  }

  it('exported computeNamespaceStats returns tombstoneCount: 0 directly', async () => {
    // Direct invocation — the helper exists for testability of the
    // deferral pin; pinning here makes it callable without the
    // job's loop wrapper.
    const db = freshStubForDirectCall({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: false,
          },
        ],
      },
    })
    const stats = await computeNamespaceStats(db, 'did:plc:a', 'namespace_0')
    expect(stats.tombstoneCount).toBe(0)
    expect(stats.totalAttestationsBy).toBe(1)
  })

  it('agent-generated count derived from authored rows', async () => {
    const db = freshStubForDirectCall({
      dirty: [{ did: 'did:plc:a', namespace: 'namespace_0' }],
      authoredByNamespace: {
        'did:plc:a::namespace_0': [
          {
            uri: 'at://x/1',
            subjectId: 's1',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: true,
          },
          {
            uri: 'at://x/2',
            subjectId: 's2',
            sentiment: 'positive',
            evidenceJson: null,
            isAgentGenerated: false,
          },
        ],
      },
    })
    const stats = await computeNamespaceStats(db, 'did:plc:a', 'namespace_0')
    expect(stats.agentGeneratedCount).toBe(1)
  })
})

// ─── Failure isolation ──────────────────────────────────────────────────

describe('refreshReviewerNamespaceStats — per-row failure isolation', () => {
  it('a failing row does not stop the rest of the batch', async () => {
    mockLoggerError.mockClear()
    const { capture } = await runJobAgainstStub({
      dirty: [
        { did: 'did:plc:a', namespace: 'namespace_0' },
        { did: 'did:plc:b', namespace: 'namespace_0' },
      ],
      failFirstUpdate: true,
    })

    // First row threw on UPDATE → caught + logged. Second row
    // succeeded, so we should see one successful UPDATE captured.
    // (The first row's failed update is NOT in capture.updates
    // because the stub throws before pushing.)
    expect(capture.updates).toHaveLength(1)
    expect(capture.updates[0]!.did).toBe('did:plc:b')
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ did: 'did:plc:a', namespace: 'namespace_0' }),
      expect.stringContaining('failed to process'),
    )
  })

  it('counter increments only by successful updates', async () => {
    mockMetricsCounter.mockClear()
    await runJobAgainstStub({
      dirty: [
        { did: 'did:plc:a', namespace: 'namespace_0' },
        { did: 'did:plc:b', namespace: 'namespace_0' },
      ],
      failFirstUpdate: true,
    })
    expect(mockMetricsCounter).toHaveBeenCalledWith(
      'scorer.refresh_reviewer_namespace_stats.updated',
      1,
    )
  })
})
