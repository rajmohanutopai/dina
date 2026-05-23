#!/usr/bin/env npx tsx
/**
 * `dina-admin moderation` CLI.
 *
 * Operator tool for the launch-day moderation surface:
 *
 *   - `subject tombstone <id> --actor DID --reason "..."`
 *   - `subject untombstone <id> --actor DID --reason "..."`
 *   - `attestation takedown <at://uri> --actor DID --reason "..."`
 *   - `attestation restore <at://uri> --actor DID --reason "..."`
 *   - `audit-log [--actor DID] [--target ID] [--action verb] [--limit N]`
 *
 * **Why a CLI, not an xRPC endpoint** — admin actions on the public
 * AppView need auth (operator allow-list / bearer / OAuth), per-action
 * rate limits, and a careful permission model. None of that exists
 * for launch. SSH + container-exec access IS the auth gate today:
 * if you can `docker compose exec appview-web`, you're an operator.
 * When the v0.1 cycle designs the auth properly, the xRPC layer
 * reuses `recordAdminAction` from `@/db/queries/admin-audit-log.ts`.
 *
 * **Audit log + mutation are transactional** — every state-changing
 * command wraps both writes in `db.transaction()`. A crash between
 * the audit insert and the target-table UPDATE rolls both back, so
 * the audit log can never claim a mutation that didn't land.
 *
 * **Every state-changing command requires `--reason`** — including
 * undo commands (untombstone, restore). Knowing WHY a moderation
 * action was reversed matters as much as why it was applied.
 *
 * **Usage from the deploy host:**
 *
 *   ssh dina-test-infra "cd /opt/dina-test-infra/deploy && \\
 *     COMPOSE_PROJECT_NAME=dina-infra-test docker compose -f \\
 *     docker-compose.infra.yml exec appview-web \\
 *     node dist/src/admin/peerlens-moderation-cli.js \\
 *     subject tombstone sub_abc123 \\
 *     --actor did:plc:operator1 --reason 'spam'"
 *
 * Exit code: 0 on success, 1 on argument or DB error.
 */

import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { createDb, type DrizzleDB } from '@/db/connection.js'
import { attestations } from '@/db/schema/attestations.js'
import { services } from '@/db/schema/services.js'
import { subjects } from '@/db/schema/subjects.js'
import {
  ADMIN_ACTIONS,
  queryAuditLog,
  recordAdminAction,
  type AdminAction,
  type AuditLogEntry,
} from '@/db/queries/admin-audit-log.js'
import { logger } from '@/shared/utils/logger.js'

// ─────────────────────────────────────────────────────────────────────────
// Argument parsing — no commander/yargs dep (matches sibling CLI style).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sentinel for `--help`. Returned from `parseArgs` rather than
 * `process.exit`-ing inside the parser so the help path stays
 * testable + the parser stays pure.
 */
export const HELP_SENTINEL = '__help__'

export interface ParsedArgs {
  command: string
  subcommand?: string
  positional: string[]
  flags: Record<string, string>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args.
  const args = argv.slice(2)
  if (args.length === 0) {
    throw new Error('Missing command. See `--help` for usage.')
  }

  if (args[0] === '--help' || args[0] === '-h') {
    return { command: HELP_SENTINEL, positional: [], flags: {} }
  }

  const command = args[0]
  let cursor = 1

  // Two-word commands: `subject tombstone`, `attestation takedown`, etc.
  // Single-word: `audit-log`.
  let subcommand: string | undefined
  if (command === 'subject' || command === 'attestation' || command === 'service') {
    if (cursor >= args.length) {
      throw new Error(`Missing subcommand for "${command}".`)
    }
    subcommand = args[cursor]
    cursor++
  }

  const positional: string[] = []
  const flags: Record<string, string> = {}

  while (cursor < args.length) {
    const tok = args[cursor]
    if (tok.startsWith('--')) {
      const key = tok.slice(2)
      const next = args[cursor + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Flag --${key} missing value.`)
      }
      flags[key] = next
      cursor += 2
    } else {
      positional.push(tok)
      cursor++
    }
  }

  return { command, subcommand, positional, flags }
}

export function helpText(): string {
  return `
dina-admin peerlens-moderation -- operator CLI for AppView moderation.

USAGE
  subject tombstone <subject_id>     --actor <DID> --reason <"text">
  subject untombstone <subject_id>   --actor <DID> --reason <"text">
  attestation takedown <at://uri>    --actor <DID> --reason <"text">
  attestation restore <at://uri>     --actor <DID> --reason <"text">
  service tombstone <at://uri>       --actor <DID> --reason <"text">
  service untombstone <at://uri>     --actor <DID> --reason <"text">
  audit-log                          [--actor <DID>] [--target <id>] [--action <verb>] [--limit <N>]

FLAGS
  --actor   Operator DID. Required for all state-changing commands.
            Must match the regex ^did:[a-z]+: (matches the production
            lexicon's gate). Stamped into admin_audit_log.actor_did.
            May be supplied via DINA_ADMIN_ACTOR_DID env var.
  --reason  Free-text reason. Required for EVERY state-changing command,
            including undo verbs (untombstone, restore) -- the audit
            trail should be uniformly rich.
  --target  Filter audit log by target subject_id / attestation URI.
  --action  Filter audit log by action verb. One of:
              ${ADMIN_ACTIONS.join(', ')}
  --limit   Max rows for audit-log (default 50).

EXIT CODES
  0  success
  1  bad arguments or DB error

EXAMPLES
  subject tombstone sub_5a76e31bf... --actor did:plc:op1 --reason "ToS violation"
  subject untombstone sub_5a76e31bf... --actor did:plc:op1 --reason "appeal granted"
  attestation takedown at://did:plc:author/com.dina.peerlens.attestation/abc \\
                      --actor did:plc:op1 --reason "spam"
  audit-log --action tombstone_subject --limit 20
  audit-log --target sub_5a76e31bf...
`.trim() + '\n'
}

// ─────────────────────────────────────────────────────────────────────────
// Flag validation helpers.
// ─────────────────────────────────────────────────────────────────────────

/**
 * DID regex for the operator CLI. Stricter than the production
 * lexicon (`/^did:[a-z]+:/` allows `did:plc:` with no identifier)
 * because admin actions are permanent and audit-trail-bearing — we
 * want to catch typos like `did:plc:` or `did:` before they land
 * in `admin_audit_log` forever.
 *
 * Requires `did:<method>:<at least one identifier char>`.
 */
const DID_REGEX = /^did:[a-z]+:[A-Za-z0-9._%-]+$/

function requireFlag(
  flags: Record<string, string>,
  envFallback: string | undefined,
  name: string,
): string {
  const v = flags[name] ?? envFallback
  if (v === undefined || v.trim().length === 0) {
    throw new Error(`Missing --${name} (or env fallback). See --help.`)
  }
  return v
}

function requireDidFlag(
  flags: Record<string, string>,
  envFallback: string | undefined,
  name: string,
): string {
  const raw = requireFlag(flags, envFallback, name)
  if (!DID_REGEX.test(raw)) {
    throw new Error(
      `--${name} must be a valid DID (matching ${DID_REGEX.source}), got "${raw}"`,
    )
  }
  return raw
}

// ─────────────────────────────────────────────────────────────────────────
// Commands. Each returns a structured result the caller logs. Each
// runs in a transaction so the audit-log row + the target mutation
// either both land or both roll back.
// ─────────────────────────────────────────────────────────────────────────

export interface TombstoneResult {
  subjectId: string
  before: { tombstonedAt: Date | null; tombstoneReason: string | null }
  after: { tombstonedAt: Date | null; tombstoneReason: string | null }
  auditLogId: bigint
}

export async function tombstoneSubject(
  db: DrizzleDB,
  args: { subjectId: string; actorDid: string; reason: string },
): Promise<TombstoneResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        tombstonedAt: subjects.tombstonedAt,
        tombstoneReason: subjects.tombstoneReason,
      })
      .from(subjects)
      .where(eq(subjects.id, args.subjectId))
      .limit(1)
    if (before === undefined) {
      throw new Error(`Subject not found: ${args.subjectId}`)
    }

    const auditLogId = await recordAdminAction(tx, {
      actorDid: args.actorDid,
      action: 'tombstone_subject',
      targetId: args.subjectId,
      reason: args.reason,
      context: {
        before_tombstoned_at: before.tombstonedAt?.toISOString() ?? null,
        before_reason: before.tombstoneReason,
      },
    })

    // Atomic read-back via RETURNING: no race window with concurrent
    // writers, and one fewer round trip than SELECT-after-UPDATE.
    const [after] = await tx
      .update(subjects)
      .set({ tombstonedAt: new Date(), tombstoneReason: args.reason })
      .where(eq(subjects.id, args.subjectId))
      .returning({
        tombstonedAt: subjects.tombstonedAt,
        tombstoneReason: subjects.tombstoneReason,
      })

    return { subjectId: args.subjectId, before, after, auditLogId }
  })
}

export async function untombstoneSubject(
  db: DrizzleDB,
  args: { subjectId: string; actorDid: string; reason: string },
): Promise<TombstoneResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        tombstonedAt: subjects.tombstonedAt,
        tombstoneReason: subjects.tombstoneReason,
      })
      .from(subjects)
      .where(eq(subjects.id, args.subjectId))
      .limit(1)
    if (before === undefined) {
      throw new Error(`Subject not found: ${args.subjectId}`)
    }

    const auditLogId = await recordAdminAction(tx, {
      actorDid: args.actorDid,
      action: 'untombstone_subject',
      targetId: args.subjectId,
      reason: args.reason,
      context: {
        before_tombstoned_at: before.tombstonedAt?.toISOString() ?? null,
        before_reason: before.tombstoneReason,
      },
    })

    const [after] = await tx
      .update(subjects)
      .set({ tombstonedAt: null, tombstoneReason: null })
      .where(eq(subjects.id, args.subjectId))
      .returning({
        tombstonedAt: subjects.tombstonedAt,
        tombstoneReason: subjects.tombstoneReason,
      })

    return { subjectId: args.subjectId, before, after, auditLogId }
  })
}

export interface TakedownResult {
  uri: string
  before: { isTakedown: boolean; reason: string | null }
  after: { isTakedown: boolean; reason: string | null }
  auditLogId: bigint
}

export async function takedownAttestation(
  db: DrizzleDB,
  args: { uri: string; actorDid: string; reason: string },
): Promise<TakedownResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        isTakedown: attestations.isTakedownByModerator,
        reason: attestations.takedownReason,
      })
      .from(attestations)
      .where(eq(attestations.uri, args.uri))
      .limit(1)
    if (before === undefined) {
      throw new Error(`Attestation not found: ${args.uri}`)
    }

    const auditLogId = await recordAdminAction(tx, {
      actorDid: args.actorDid,
      action: 'takedown_attestation',
      targetId: args.uri,
      reason: args.reason,
      context: {
        before_is_takedown: before.isTakedown,
        before_reason: before.reason,
      },
    })

    const [after] = await tx
      .update(attestations)
      .set({
        isTakedownByModerator: true,
        takedownReason: args.reason,
        takedownAt: new Date(),
      })
      .where(eq(attestations.uri, args.uri))
      .returning({
        isTakedown: attestations.isTakedownByModerator,
        reason: attestations.takedownReason,
      })

    return {
      uri: args.uri,
      before: { isTakedown: before.isTakedown, reason: before.reason },
      after: { isTakedown: after.isTakedown, reason: after.reason },
      auditLogId,
    }
  })
}

export interface ServiceTombstoneResult {
  serviceUri: string
  before: { tombstonedAt: Date | null; tombstoneReason: string | null }
  after: { tombstonedAt: Date | null; tombstoneReason: string | null }
  auditLogId: bigint
}

export async function tombstoneService(
  db: DrizzleDB,
  args: { serviceUri: string; actorDid: string; reason: string },
): Promise<ServiceTombstoneResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        tombstonedAt: services.tombstonedAt,
        tombstoneReason: services.tombstoneReason,
      })
      .from(services)
      .where(eq(services.uri, args.serviceUri))
      .limit(1)
    if (before === undefined) {
      throw new Error(`Service profile not found: ${args.serviceUri}`)
    }

    const auditLogId = await recordAdminAction(tx, {
      actorDid: args.actorDid,
      action: 'tombstone_service',
      targetId: args.serviceUri,
      reason: args.reason,
      context: {
        before_tombstoned_at: before.tombstonedAt?.toISOString() ?? null,
        before_reason: before.tombstoneReason,
      },
    })

    const [after] = await tx
      .update(services)
      .set({ tombstonedAt: new Date(), tombstoneReason: args.reason })
      .where(eq(services.uri, args.serviceUri))
      .returning({
        tombstonedAt: services.tombstonedAt,
        tombstoneReason: services.tombstoneReason,
      })

    return { serviceUri: args.serviceUri, before, after, auditLogId }
  })
}

export async function untombstoneService(
  db: DrizzleDB,
  args: { serviceUri: string; actorDid: string; reason: string },
): Promise<ServiceTombstoneResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        tombstonedAt: services.tombstonedAt,
        tombstoneReason: services.tombstoneReason,
      })
      .from(services)
      .where(eq(services.uri, args.serviceUri))
      .limit(1)
    if (before === undefined) {
      throw new Error(`Service profile not found: ${args.serviceUri}`)
    }

    const auditLogId = await recordAdminAction(tx, {
      actorDid: args.actorDid,
      action: 'untombstone_service',
      targetId: args.serviceUri,
      reason: args.reason,
      context: {
        before_tombstoned_at: before.tombstonedAt?.toISOString() ?? null,
        before_reason: before.tombstoneReason,
      },
    })

    const [after] = await tx
      .update(services)
      .set({ tombstonedAt: null, tombstoneReason: null })
      .where(eq(services.uri, args.serviceUri))
      .returning({
        tombstonedAt: services.tombstonedAt,
        tombstoneReason: services.tombstoneReason,
      })

    return { serviceUri: args.serviceUri, before, after, auditLogId }
  })
}

export async function restoreAttestation(
  db: DrizzleDB,
  args: { uri: string; actorDid: string; reason: string },
): Promise<TakedownResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        isTakedown: attestations.isTakedownByModerator,
        reason: attestations.takedownReason,
      })
      .from(attestations)
      .where(eq(attestations.uri, args.uri))
      .limit(1)
    if (before === undefined) {
      throw new Error(`Attestation not found: ${args.uri}`)
    }

    const auditLogId = await recordAdminAction(tx, {
      actorDid: args.actorDid,
      action: 'restore_attestation',
      targetId: args.uri,
      reason: args.reason,
      context: {
        before_is_takedown: before.isTakedown,
        before_reason: before.reason,
      },
    })

    const [after] = await tx
      .update(attestations)
      .set({
        isTakedownByModerator: false,
        takedownReason: null,
        takedownAt: null,
      })
      .where(eq(attestations.uri, args.uri))
      .returning({
        isTakedown: attestations.isTakedownByModerator,
        reason: attestations.takedownReason,
      })

    return {
      uri: args.uri,
      before: { isTakedown: before.isTakedown, reason: before.reason },
      after: { isTakedown: after.isTakedown, reason: after.reason },
      auditLogId,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// CLI dispatcher.
// ─────────────────────────────────────────────────────────────────────────

export async function dispatch(
  db: DrizzleDB,
  parsed: ParsedArgs,
): Promise<unknown> {
  const envActor = process.env.DINA_ADMIN_ACTOR_DID

  if (parsed.command === HELP_SENTINEL) {
    process.stdout.write(helpText())
    return null
  }

  if (parsed.command === 'subject') {
    if (parsed.subcommand === 'tombstone') {
      const subjectId = parsed.positional[0]
      if (subjectId === undefined) {
        throw new Error('Missing subject_id positional argument.')
      }
      const actorDid = requireDidFlag(parsed.flags, envActor, 'actor')
      const reason = requireFlag(parsed.flags, undefined, 'reason')
      return tombstoneSubject(db, { subjectId, actorDid, reason })
    }
    if (parsed.subcommand === 'untombstone') {
      const subjectId = parsed.positional[0]
      if (subjectId === undefined) {
        throw new Error('Missing subject_id positional argument.')
      }
      const actorDid = requireDidFlag(parsed.flags, envActor, 'actor')
      const reason = requireFlag(parsed.flags, undefined, 'reason')
      return untombstoneSubject(db, { subjectId, actorDid, reason })
    }
    throw new Error(
      `Unknown subject subcommand: ${parsed.subcommand}. Valid: tombstone, untombstone`,
    )
  }

  if (parsed.command === 'service') {
    if (parsed.subcommand === 'tombstone') {
      const serviceUri = parsed.positional[0]
      if (serviceUri === undefined) {
        throw new Error('Missing at:// service URI positional argument.')
      }
      if (!serviceUri.startsWith('at://')) {
        throw new Error(`Expected at:// URI, got "${serviceUri}"`)
      }
      const actorDid = requireDidFlag(parsed.flags, envActor, 'actor')
      const reason = requireFlag(parsed.flags, undefined, 'reason')
      return tombstoneService(db, { serviceUri, actorDid, reason })
    }
    if (parsed.subcommand === 'untombstone') {
      const serviceUri = parsed.positional[0]
      if (serviceUri === undefined) {
        throw new Error('Missing at:// service URI positional argument.')
      }
      if (!serviceUri.startsWith('at://')) {
        throw new Error(`Expected at:// URI, got "${serviceUri}"`)
      }
      const actorDid = requireDidFlag(parsed.flags, envActor, 'actor')
      const reason = requireFlag(parsed.flags, undefined, 'reason')
      return untombstoneService(db, { serviceUri, actorDid, reason })
    }
    throw new Error(
      `Unknown service subcommand: ${parsed.subcommand}. Valid: tombstone, untombstone`,
    )
  }

  if (parsed.command === 'attestation') {
    if (parsed.subcommand === 'takedown') {
      const uri = parsed.positional[0]
      if (uri === undefined) {
        throw new Error('Missing at:// URI positional argument.')
      }
      if (!uri.startsWith('at://')) {
        throw new Error(`Expected at:// URI, got "${uri}"`)
      }
      const actorDid = requireDidFlag(parsed.flags, envActor, 'actor')
      const reason = requireFlag(parsed.flags, undefined, 'reason')
      return takedownAttestation(db, { uri, actorDid, reason })
    }
    if (parsed.subcommand === 'restore') {
      const uri = parsed.positional[0]
      if (uri === undefined) {
        throw new Error('Missing at:// URI positional argument.')
      }
      if (!uri.startsWith('at://')) {
        throw new Error(`Expected at:// URI, got "${uri}"`)
      }
      const actorDid = requireDidFlag(parsed.flags, envActor, 'actor')
      const reason = requireFlag(parsed.flags, undefined, 'reason')
      return restoreAttestation(db, { uri, actorDid, reason })
    }
    throw new Error(
      `Unknown attestation subcommand: ${parsed.subcommand}. Valid: takedown, restore`,
    )
  }

  if (parsed.command === 'audit-log') {
    const action = parsed.flags['action']
    if (
      action !== undefined &&
      !ADMIN_ACTIONS.includes(action as AdminAction)
    ) {
      throw new Error(
        `Unknown --action verb: "${action}". Valid: ${ADMIN_ACTIONS.join(', ')}`,
      )
    }
    const limitRaw = parsed.flags['limit']
    const limit =
      limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10)
    return queryAuditLog(db, {
      actor: parsed.flags['actor'],
      target: parsed.flags['target'],
      action: action as AdminAction | undefined,
      limit,
    })
  }

  throw new Error(
    `Unknown command "${parsed.command}". See --help for usage.`,
  )
}

// BigInt isn't JSON-serializable by default; admin_audit_log.id is
// bigint mode. Render as string so the operator can copy-paste.
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv)
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Invalid CLI invocation')
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  }

  // Help path doesn't open a DB connection.
  if (parsed.command === HELP_SENTINEL) {
    process.stdout.write(helpText())
    return
  }

  const db = createDb()
  try {
    const result = await dispatch(db, parsed)
    if (result !== null) {
      process.stdout.write(JSON.stringify(result, bigintReplacer, 2) + '\n')
    }
    logger.info(
      { command: parsed.command, subcommand: parsed.subcommand },
      'moderation command complete',
    )
  } catch (err) {
    logger.error(
      { err, command: parsed.command, subcommand: parsed.subcommand },
      'moderation command failed',
    )
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  } finally {
    await db.$client.end().catch(() => undefined)
  }
}

export { bigintReplacer }

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main()
}
