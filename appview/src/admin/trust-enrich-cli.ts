#!/usr/bin/env npx tsx
/**
 * `dina-admin trust enrich` CLI (TN-ENRICH-007 / Plan §3.6.4).
 *
 * One-shot operator tool wrapping the `subject-enrich-recompute`
 * scorer job (TN-ENRICH-006) so admins can trigger re-enrichment
 * outside the weekly cadence:
 *
 *   - Force a heuristic-map update to propagate immediately rather
 *     than waiting up to seven days for the next Sunday tick.
 *   - Re-enrich a single subject by id (debug a curation issue).
 *   - Re-enrich all stale subjects on demand (post-deploy backfill).
 *
 * **Two sub-commands**:
 *   - `enrich batch`         — runs `subjectEnrichRecompute` (same
 *                              code path as the weekly cron).
 *   - `enrich one <subjectId>` — runs `enrichSingleSubject(id)`.
 *
 * **Why a separate CLI from `trust-flag-cli.ts`**: each CLI owns one
 * concern. Mixing flag-flips and enrich would make the parser more
 * complex and the failure surface less obvious. The `dina-admin
 * trust …` umbrella in TN-FLAG-002's docstring is descriptive (the
 * shell user types `dina-admin trust enrich …`), not a code-side
 * dispatcher — npm scripts route each sub-command to its own file.
 *
 * **Usage**:
 *   npm run admin:enrich -- batch
 *   npm run admin:enrich -- one sub_xxx
 *
 * **Exit code**: 0 on success, 1 on argument or DB error. The batch
 * mode logs the `{updated, errors, total}` summary; the single-
 * subject mode logs `{updated: true}` or `{updated: false, reason:
 * 'not_found'}`.
 *
 * **Connection lifecycle**: opens a fresh `createDb()` per
 * invocation, closes via `db.$client.end()` in `finally`. CLI is
 * one-shot.
 */

import 'dotenv/config'
import { createDb, type DrizzleDB } from '@/db/connection.js'
import {
  subjectEnrichRecompute,
  enrichSingleSubject,
} from '@/scorer/jobs/subject-enrich-recompute.js'
import { logger } from '@/shared/utils/logger.js'

type ParsedArgs =
  | { mode: 'batch' }
  | { mode: 'one'; subjectId: string }

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args.
  const cmd = argv[2]
  if (cmd === undefined) {
    throw new Error(
      'Missing sub-command. Usage: dina-admin trust enrich batch|one <subjectId>',
    )
  }
  if (cmd === 'batch') {
    if (argv.length > 3) {
      throw new Error(
        `Unexpected extra argument(s) for "batch": ${argv.slice(3).join(' ')}`,
      )
    }
    return { mode: 'batch' }
  }
  if (cmd === 'one') {
    const subjectId = argv[3]
    if (!subjectId) {
      throw new Error(
        'Missing subjectId. Usage: dina-admin trust enrich one <subjectId>',
      )
    }
    if (argv.length > 4) {
      throw new Error(
        `Unexpected extra argument(s) after subjectId: ${argv.slice(4).join(' ')}`,
      )
    }
    return { mode: 'one', subjectId }
  }
  throw new Error(
    `Unknown sub-command "${cmd}". Valid: batch, one <subjectId>`,
  )
}

/**
 * Pure run function — separated from `main` so unit tests can drive
 * it without spawning a subprocess. Returns either `{ mode: 'batch'
 * }` (no return value from the job — output is via logs/metrics) or
 * the single-subject result `{updated, reason?}`.
 */
export async function runEnrichCommand(
  db: DrizzleDB,
  args: ParsedArgs,
): Promise<{ mode: 'batch' } | { mode: 'one'; updated: boolean; reason?: 'not_found' }> {
  if (args.mode === 'batch') {
    await subjectEnrichRecompute(db)
    return { mode: 'batch' }
  }
  const result = await enrichSingleSubject(db, args.subjectId)
  return { mode: 'one', ...result }
}

async function main(): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv)
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Invalid CLI invocation')
    process.exit(1)
  }

  const db = createDb()
  try {
    const result = await runEnrichCommand(db, args)
    logger.info(result, 'trust-enrich complete')
    // Single-subject "not found" is a non-fatal but non-success
    // outcome — surface it via exit code 2 so shell wrappers can
    // distinguish it from successful updates without parsing logs.
    if (result.mode === 'one' && result.updated === false) {
      process.exit(2)
    }
  } catch (err) {
    logger.error({ err, args }, 'trust-enrich command failed')
    process.exit(1)
  } finally {
    await db.$client.end().catch(() => undefined)
  }
}

// Guard: only run main() when this file is invoked directly, not
// when imported (so tests can import `parseArgs` / `runEnrichCommand`
// without triggering the full pipeline).
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main()
}
