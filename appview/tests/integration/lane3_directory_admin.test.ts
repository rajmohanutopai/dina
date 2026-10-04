/**
 * The A2A directory's operator surface and its tables (design §8.3, §9;
 * notes M5 step 3) against REAL POSTGRES: the moderation command as an
 * operator types it, and the migrations that build the directory.
 *
 * Run (your own database, migrated with drizzle-kit):
 *   DATABASE_URL=postgresql://dina:dina@localhost:55432/<db> \
 *     npx vitest run tests/integration/lane3_directory_admin.test.ts
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dispatch, parseArgs } from '@/admin/peerlens-moderation-cli.js'
import { a2aAccountStatus, a2aCards, a2aCardTakedowns, a2aDirectoryState, a2aEventSpool } from '@/db/schema/index.js'

import { newDid } from '../a2a-fixture.js'
import { cleanAllTables, closeTestDb, getTestDb } from '../test-db.js'

const db = getTestDb()
const OP = 'did:plc:operatoraaaaaaaaaaaaaaaa'

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows
}
const cli = (...args: string[]) => dispatch(db as never, parseArgs(['node', 'peerlens-moderation', ...args]))
const takedowns = (did: string) => q<{ reason: string }>(sql`SELECT reason FROM a2a_card_takedowns WHERE did = ${did}`)
const audit = (did: string) => q<{ action: string; actor_did: string; reason: string }>(
  sql`SELECT action, actor_did, reason FROM admin_audit_log WHERE target_id = ${did} ORDER BY id`,
)

let savedActor: string | undefined
beforeEach(async () => {
  await cleanAllTables(db)
  savedActor = process.env.DINA_ADMIN_ACTOR_DID
  delete process.env.DINA_ADMIN_ACTOR_DID
})
afterEach(() => {
  if (savedActor === undefined) delete process.env.DINA_ADMIN_ACTOR_DID
  else process.env.DINA_ADMIN_ACTOR_DID = savedActor
})
afterAll(async () => {
  await closeTestDb()
})

describe('dina-admin peerlens-moderation a2a-card', () => {
  // Plan F142
  it('takedown and restore, typed as an operator types them, write the gate and the audit trail', async () => {
    const did = newDid()
    await cli('a2a-card', 'takedown', did, '--actor', OP, '--reason', 'spam')
    expect(await takedowns(did)).toEqual([{ reason: 'spam' }])
    await cli('a2a-card', 'restore', did, '--actor', OP, '--reason', 'appeal upheld')
    expect(await takedowns(did)).toEqual([])
    expect(await audit(did)).toEqual([
      { action: 'takedown_a2a_card', actor_did: OP, reason: 'spam' },
      { action: 'restore_a2a_card', actor_did: OP, reason: 'appeal upheld' },
    ])
  })

  // Plan F142
  it.each([
    ['a target that is not a DID', ['a2a-card', 'takedown', 'at://not-a-did', '--actor', OP, '--reason', 'spam'], /Expected a DID/],
    ['no reason', ['a2a-card', 'takedown', '__DID__', '--actor', OP], /Missing --reason/],
    ['a blank reason', ['a2a-card', 'takedown', '__DID__', '--actor', OP, '--reason', '  '], /Missing --reason/],
    ['no actor', ['a2a-card', 'takedown', '__DID__', '--reason', 'spam'], /Missing --actor/],
    ['an actor that is not a DID', ['a2a-card', 'takedown', '__DID__', '--actor', 'mallory', '--reason', 'spam'], /--actor must be a valid DID/],
    ['two targets', ['a2a-card', 'takedown', '__DID__', newDid(), '--actor', OP, '--reason', 'spam'], /extra positional/],
    ['an unknown subcommand', ['a2a-card', 'delete', '__DID__', '--actor', OP, '--reason', 'spam'], /Unknown a2a-card subcommand: delete/],
  ])('%s is refused, and nothing is written', async (_name, args, error) => {
    const did = newDid()
    await expect(cli(...args.map((a) => (a === '__DID__' ? did : a)))).rejects.toThrow(error)
    expect(await takedowns(did)).toEqual([])
    expect(await q(sql`SELECT 1 FROM admin_audit_log`)).toEqual([])
  })

  // Plan F142
  it('a missing subcommand is refused before anything runs', () => {
    expect(() => parseArgs(['node', 'peerlens-moderation', 'a2a-card'])).toThrow(/Missing subcommand/)
  })
})

describe('migrations', () => {
  const DRIZZLE = join(__dirname, '..', '..', 'drizzle')
  const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string; when: number }[]
  }

  // Plan F149
  it('every forward migration file is in the journal, and every journal entry was applied', async () => {
    const files = readdirSync(DRIZZLE)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .map((f) => f.slice(0, -'.sql'.length))
      .sort()
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files)
    expect(journal.entries.map((e) => e.tag)).toEqual(expect.arrayContaining(['0024_imported_review_source', '0025_a2a_directory']))
    // drizzle-kit records each applied entry under its journal time.
    const applied = new Set(
      (await q<{ created_at: string }>(sql`SELECT created_at FROM drizzle.__drizzle_migrations`)).map((r) => Number(r.created_at)),
    )
    for (const e of journal.entries) expect({ tag: e.tag, applied: applied.has(e.when) }).toEqual({ tag: e.tag, applied: true })
    expect(await q(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'attestations' AND column_name = 'source_feed'`)).toEqual([
      { column_name: 'source_feed' },
    ])
  })

  // Plan F150
  it.each([
    ['a2a_cards', a2aCards],
    ['a2a_account_status', a2aAccountStatus],
    ['a2a_card_takedowns', a2aCardTakedowns],
    ['a2a_event_spool', a2aEventSpool],
    ['a2a_directory_state', a2aDirectoryState],
  ] as [string, PgTable][])('the Drizzle model of %s equals the table the SQL built: columns, types, nullability', async (name, table) => {
    const config = getTableConfig(table)
    expect(config.name).toBe(name)
    const model = config.columns
      .map((c) => ({ column: c.name, type: c.getSQLType().replace(/^bigserial$/, 'bigint'), notNull: c.notNull }))
      .sort((a, b) => a.column.localeCompare(b.column))
    const built = (
      await q<{ column: string; type: string; not_null: boolean }>(sql`
        SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
          FROM pg_attribute a
         WHERE a.attrelid = ${name}::regclass AND a.attnum > 0 AND NOT a.attisdropped`)
    )
      .map((r) => ({ column: r.column, type: r.type, notNull: r.not_null }))
      .sort((a, b) => a.column.localeCompare(b.column))
    expect(model).toEqual(built)
  })
})
