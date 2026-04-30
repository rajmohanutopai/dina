#!/usr/bin/env npx tsx
/**
 * `dina-admin trust enable|disable` CLI (TN-FLAG-002 / Plan §13.10).
 *
 * One-shot operator tool: flips the master `trust_v1_enabled` kill-
 * switch in `appview_config`. The ingester / scorer / xRPC layers
 * pick up the new value on their next read (≤ 60s for cached
 * readers, immediate for per-request readers — see
 * `appview-config.ts` docstring on the cache stance).
 *
 * **Why a TS CLI in `appview/` rather than extending the Python
 * `admin-cli/`**: AppView is the only owner of the `appview_config`
 * Postgres table; the existing `admin-cli/` connects to Go Core's
 * SQLCipher vault, not AppView. A single-purpose TS tool that
 * imports `setBoolFlag` directly is the cleanest path — same
 * auth / connection / migration story as the rest of AppView, no
 * cross-language schema drift.
 *
 * **Usage**:
 *   npx tsx src/admin/trust-flag-cli.ts enable
 *   npx tsx src/admin/trust-flag-cli.ts disable
 *   npx tsx src/admin/trust-flag-cli.ts status
 *
 * Exit code: 0 on success, 1 on argument or DB error. Logs the
 * before / after state so operators see the actual effect of the
 * flip (no silent no-op if the flag was already in the target
 * state — visible idempotency is the right answer for kill-switch
 * tooling).
 *
 * **Argument shape**: positional `<command>` only. No flags. Adding
 * `dina-admin trust set-param <key> <value>` (TN-FLAG-002 sibling
 * for `trust_v1_params`) is a separate sub-command in a future
 * iteration; this file owns only the boolean kill-switch.
 *
 * **Connection lifecycle**: opens a fresh `createDb()` per
 * invocation, runs the operation, closes via `await db.end()`. CLI
 * is one-shot — there's no long-lived process holding the pool open
 * after the operation lands.
 */

import 'dotenv/config'
import { createDb } from '@/db/connection.js'
import {
  readBoolFlag,
  setBoolFlag,
  type AppviewFlagKey,
} from '@/db/queries/appview-config.js'
import { logger } from '@/shared/utils/logger.js'

const FLAG_KEY: AppviewFlagKey = 'trust_v1_enabled'

type Command = 'enable' | 'disable' | 'status'

const VALID_COMMANDS: ReadonlySet<Command> = new Set([
  'enable',
  'disable',
  'status',
])

function parseCommand(argv: readonly string[]): Command {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args.
  const cmd = argv[2]
  if (cmd === undefined) {
    throw new Error(
      'Missing command. Usage: dina-admin trust enable|disable|status',
    )
  }
  if (!VALID_COMMANDS.has(cmd as Command)) {
    throw new Error(
      `Unknown command "${cmd}". Valid: enable, disable, status`,
    )
  }
  if (argv.length > 3) {
    throw new Error(
      `Unexpected extra argument(s): ${argv.slice(3).join(' ')}`,
    )
  }
  return cmd as Command
}

/**
 * Pure run function — separated from `main` so unit tests can drive
 * it without spawning a subprocess. Returns the before/after state
 * for the caller (or test) to assert on.
 *
 * Throws on argument errors (parse) or DB errors (caller decides
 * how to surface).
 */
export async function runTrustFlagCommand(
  db: Parameters<typeof setBoolFlag>[0],
  command: Command,
): Promise<{ before: boolean; after: boolean; flag: AppviewFlagKey }> {
  const before = await readBoolFlag(db, FLAG_KEY)

  if (command === 'status') {
    return { before, after: before, flag: FLAG_KEY }
  }

  const target = command === 'enable'
  await setBoolFlag(db, FLAG_KEY, target)
  const after = await readBoolFlag(db, FLAG_KEY)
  return { before, after, flag: FLAG_KEY }
}

async function main(): Promise<void> {
  let command: Command
  try {
    command = parseCommand(process.argv)
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Invalid CLI invocation')
    process.exit(1)
  }

  const db = createDb()
  try {
    const result = await runTrustFlagCommand(db, command)
    logger.info(result, `trust-flag ${command} complete`)
  } catch (err) {
    logger.error({ err, command }, 'trust-flag command failed')
    process.exit(1)
  } finally {
    // Drizzle exposes the underlying `pg.Pool` as `db.$client` so the
    // CLI can release the connection cleanly. Failures here aren't
    // surfaced — the process is exiting in any case, and a leaked
    // socket gets reaped on natural process exit.
    await db.$client.end().catch(() => undefined)
  }
}

// Guard: only run main() when this file is invoked directly, not
// when imported (so tests can import `runTrustFlagCommand` /
// `parseCommand` without triggering the full pipeline).
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main()
}

export { parseCommand, FLAG_KEY }
