#!/usr/bin/env npx tsx
/**
 * `dina-admin trust suspend-pds` CLI (TN-OPS-003 / Plan §13.10
 * abuse response).
 *
 * Operator tool for managing the `suspended_pds_hosts` table — the
 * V1 manual abuse-response posture. Sibling pattern to
 * `trust-flag-cli.ts` (TN-FLAG-002): lives in `appview/`, opens a
 * fresh DB connection per invocation, exits 0 on success, 1 on
 * argument or DB error, 2 on "not found" for `unsuspend`
 * (distinguishable from successful no-op without log parsing).
 *
 * **Usage**:
 *   npx tsx src/admin/trust-suspend-pds-cli.ts add <host> <reason>
 *   npx tsx src/admin/trust-suspend-pds-cli.ts remove <host>
 *   npx tsx src/admin/trust-suspend-pds-cli.ts list
 *
 * **Argument shape**: positional. `add` requires host + reason
 * (free-form, e.g. `'sybil-cluster-2026-04-29'`); `remove` requires
 * just the host; `list` takes no args. Reasons with embedded spaces
 * must be quoted on the shell side. The CLI does NOT add a
 * `--by <id>` flag in V1 — `suspended_by` is populated from
 * `process.env.USER` automatically; operators in non-interactive
 * environments (CI / cron) get whatever value the env supplies, and
 * a manual edit via SQL can correct any oddities.
 *
 * **Connection lifecycle**: opens a fresh `createDb()` per
 * invocation, runs the operation, closes via `await db.$client.end()`.
 * One-shot tool — no long-lived process holding the pool open.
 *
 * **Exit codes**:
 *   - 0: success (add succeeded, remove found and deleted, list
 *     printed without error)
 *   - 1: argument parse error OR DB error
 *   - 2: `remove` ran but the host wasn't in the list (distinguishes
 *     "I undid a real suspension" vs "host wasn't suspended; this
 *     was a no-op"; same exit-code convention as
 *     `trust-enrich-cli.ts` for the not-found case).
 */

import 'dotenv/config'
import { createDb } from '@/db/connection.js'
import {
  isPdsSuspended,
  listSuspendedPdsHosts,
  suspendPdsHost,
  unsuspendPdsHost,
} from '@/db/queries/suspended-pds-hosts.js'
import { logger } from '@/shared/utils/logger.js'

type Command = 'add' | 'remove' | 'list'

const VALID_COMMANDS: ReadonlySet<Command> = new Set(['add', 'remove', 'list'])

interface ParsedAdd {
  command: 'add'
  host: string
  reason: string
}
interface ParsedRemove {
  command: 'remove'
  host: string
}
interface ParsedList {
  command: 'list'
}
type ParsedArgs = ParsedAdd | ParsedRemove | ParsedList

/**
 * Parse CLI argv into a typed command object. Throws on any shape
 * that doesn't exactly match one of the three command signatures —
 * the CLI deliberately rejects extra args rather than silently
 * ignoring them, so a typo like `add example.com sybil --by alice`
 * fails loudly (a future `--by` flag wouldn't be silently dropped
 * by an old CLI).
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args.
  const cmd = argv[2]
  if (cmd === undefined) {
    throw new Error(
      'Missing command. Usage: dina-admin trust suspend-pds add|remove|list <args>',
    )
  }
  if (!VALID_COMMANDS.has(cmd as Command)) {
    throw new Error(`Unknown command "${cmd}". Valid: add, remove, list`)
  }

  if (cmd === 'list') {
    if (argv.length > 3) {
      throw new Error(
        `Unexpected extra argument(s) to list: ${argv.slice(3).join(' ')}`,
      )
    }
    return { command: 'list' }
  }

  if (cmd === 'remove') {
    const host = argv[3]
    if (host === undefined || host.length === 0) {
      throw new Error('Missing host. Usage: remove <host>')
    }
    if (argv.length > 4) {
      throw new Error(
        `Unexpected extra argument(s) to remove: ${argv.slice(4).join(' ')}`,
      )
    }
    return { command: 'remove', host }
  }

  // cmd === 'add'
  const host = argv[3]
  const reason = argv[4]
  if (host === undefined || host.length === 0) {
    throw new Error('Missing host. Usage: add <host> <reason>')
  }
  if (reason === undefined || reason.length === 0) {
    throw new Error('Missing reason. Usage: add <host> <reason>')
  }
  if (argv.length > 5) {
    throw new Error(
      `Unexpected extra argument(s) to add: ${argv.slice(5).join(' ')}`,
    )
  }
  return { command: 'add', host, reason }
}

/**
 * Pure run function — separated from `main` so unit tests can drive
 * it without spawning a subprocess. Returns the operation outcome
 * for the caller (or test) to assert on.
 *
 * Throws on DB errors (caller decides how to surface).
 */
export async function runSuspendPdsCommand(
  db: Parameters<typeof suspendPdsHost>[0],
  args: ParsedArgs,
  suspendedBy?: string,
): Promise<
  | { command: 'add'; host: string; reason: string; wasAlreadySuspended: boolean }
  | { command: 'remove'; host: string; removed: boolean }
  | {
      command: 'list'
      hosts: Array<{
        host: string
        reason: string
        suspendedAt: Date
        suspendedBy: string | null
      }>
    }
> {
  if (args.command === 'add') {
    const wasAlreadySuspended = await isPdsSuspended(db, args.host)
    await suspendPdsHost(db, args.host, args.reason, suspendedBy)
    return {
      command: 'add',
      host: args.host,
      reason: args.reason,
      wasAlreadySuspended,
    }
  }
  if (args.command === 'remove') {
    const result = await unsuspendPdsHost(db, args.host)
    return { command: 'remove', host: args.host, removed: result.removed }
  }
  // command === 'list'
  const hosts = await listSuspendedPdsHosts(db)
  return { command: 'list', hosts }
}

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv)
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Invalid CLI invocation')
    process.exit(1)
  }

  const db = createDb()
  // process.env.USER captures the OS-level identity for audit. Empty
  // / unset → null suspended_by (the SQL default).
  const suspendedBy = process.env.USER || undefined

  try {
    const result = await runSuspendPdsCommand(db, parsed, suspendedBy)
    if (result.command === 'remove' && !result.removed) {
      // Exit 2: distinguishable not-found semantics.
      logger.warn({ host: result.host }, 'Host was not in the suspended list — no-op')
      process.exit(2)
    }
    logger.info(result, `trust suspend-pds ${parsed.command} complete`)
  } catch (err) {
    logger.error({ err, command: parsed.command }, 'trust suspend-pds command failed')
    process.exit(1)
  } finally {
    await db.$client.end().catch(() => undefined)
  }
}

// Guard: only run main() when this file is invoked directly, not
// when imported (so tests can import `runSuspendPdsCommand` /
// `parseArgs` without triggering the full pipeline).
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main()
}

export { parseArgs }
export type { ParsedArgs, Command }
