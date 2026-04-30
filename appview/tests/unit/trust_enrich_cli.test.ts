/**
 * Unit tests for `appview/src/admin/trust-enrich-cli.ts`
 * (TN-ENRICH-007 / Plan §3.6.4).
 *
 * Coverage strategy:
 *   - `parseArgs` is a pure function — exhaustive positive +
 *     negative path tests.
 *   - `runEnrichCommand` is the testable core: drive it with a
 *     fake DB stub + vi-mocked job functions to assert which
 *     mode invoked which job + the return shape.
 *   - The actual `main()` (process.argv parsing, `db.end()`, exit
 *     codes) isn't unit-tested — Node entry-point glue.
 */

import { describe, expect, it, vi } from 'vitest'

const mockSubjectEnrichRecompute = vi.fn()
const mockEnrichSingleSubject = vi.fn()
vi.mock('@/scorer/jobs/subject-enrich-recompute.js', () => ({
  subjectEnrichRecompute: (...a: unknown[]) =>
    mockSubjectEnrichRecompute(...a),
  enrichSingleSubject: (...a: unknown[]) => mockEnrichSingleSubject(...a),
}))

vi.mock('@/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { parseArgs, runEnrichCommand } from '@/admin/trust-enrich-cli'
import type { DrizzleDB } from '@/db/connection'

const stubDb = {} as unknown as DrizzleDB

// ── parseArgs ──────────────────────────────────────────────

describe('parseArgs — TN-ENRICH-007 CLI', () => {
  it('accepts "batch" with no extra args', () => {
    expect(parseArgs(['node', 'cli.ts', 'batch'])).toEqual({ mode: 'batch' })
  })

  it('accepts "one <subjectId>"', () => {
    expect(parseArgs(['node', 'cli.ts', 'one', 'sub_abc'])).toEqual({
      mode: 'one',
      subjectId: 'sub_abc',
    })
  })

  it('rejects missing sub-command', () => {
    expect(() => parseArgs(['node', 'cli.ts'])).toThrow(/Missing sub-command/)
  })

  it('rejects unknown sub-command (typo guard)', () => {
    expect(() => parseArgs(['node', 'cli.ts', 'enrich-all'])).toThrow(
      /Unknown sub-command "enrich-all"/,
    )
    expect(() => parseArgs(['node', 'cli.ts', ''])).toThrow(
      /Unknown sub-command/,
    )
  })

  it('rejects extra positional args after "batch"', () => {
    expect(() => parseArgs(['node', 'cli.ts', 'batch', 'extra'])).toThrow(
      /Unexpected extra argument/,
    )
  })

  it('rejects "one" without a subjectId', () => {
    expect(() => parseArgs(['node', 'cli.ts', 'one'])).toThrow(
      /Missing subjectId/,
    )
  })

  it('rejects extra positional args after "one <subjectId>"', () => {
    expect(() =>
      parseArgs(['node', 'cli.ts', 'one', 'sub_a', 'extra']),
    ).toThrow(/Unexpected extra argument/)
  })
})

// ── runEnrichCommand ───────────────────────────────────────

describe('runEnrichCommand — TN-ENRICH-007 behaviour', () => {
  it('batch mode calls subjectEnrichRecompute, NOT enrichSingleSubject', async () => {
    mockSubjectEnrichRecompute.mockClear()
    mockEnrichSingleSubject.mockClear()
    mockSubjectEnrichRecompute.mockResolvedValue(undefined)
    const result = await runEnrichCommand(stubDb, { mode: 'batch' })
    expect(result).toEqual({ mode: 'batch' })
    expect(mockSubjectEnrichRecompute).toHaveBeenCalledTimes(1)
    expect(mockEnrichSingleSubject).not.toHaveBeenCalled()
  })

  it('one mode calls enrichSingleSubject with the subjectId, NOT batch', async () => {
    mockSubjectEnrichRecompute.mockClear()
    mockEnrichSingleSubject.mockClear()
    mockEnrichSingleSubject.mockResolvedValue({ updated: true })
    const result = await runEnrichCommand(stubDb, {
      mode: 'one',
      subjectId: 'sub_xyz',
    })
    expect(result).toEqual({ mode: 'one', updated: true })
    expect(mockEnrichSingleSubject).toHaveBeenCalledWith(stubDb, 'sub_xyz')
    expect(mockSubjectEnrichRecompute).not.toHaveBeenCalled()
  })

  it('one mode forwards "not_found" reason verbatim', async () => {
    // The CLI must not transform or hide the not_found reason —
    // the main() layer uses it to set exit code 2 (distinguishable
    // from "updated successfully" exit 0).
    mockEnrichSingleSubject.mockClear()
    mockEnrichSingleSubject.mockResolvedValue({
      updated: false,
      reason: 'not_found',
    })
    const result = await runEnrichCommand(stubDb, {
      mode: 'one',
      subjectId: 'sub_missing',
    })
    expect(result).toEqual({
      mode: 'one',
      updated: false,
      reason: 'not_found',
    })
  })

  it('batch mode propagates job errors (caller decides exit code)', async () => {
    // Pure run function should not swallow errors — main() owns
    // the error → exit 1 mapping. Pinned because a future refactor
    // that moved error logging into runEnrichCommand could swallow
    // failures and exit 0.
    mockSubjectEnrichRecompute.mockClear()
    mockSubjectEnrichRecompute.mockRejectedValue(new Error('synthetic'))
    await expect(runEnrichCommand(stubDb, { mode: 'batch' })).rejects.toThrow(
      'synthetic',
    )
  })

  it('one mode propagates job errors verbatim (caller decides exit code)', async () => {
    mockEnrichSingleSubject.mockClear()
    mockEnrichSingleSubject.mockRejectedValue(new Error('synthetic'))
    await expect(
      runEnrichCommand(stubDb, { mode: 'one', subjectId: 'sub_x' }),
    ).rejects.toThrow('synthetic')
  })
})
