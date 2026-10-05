/**
 * The profile host's Postgres store (`ucp_profile_labels`, §3.5).
 *
 * Each change runs in one transaction that first takes a per-label advisory
 * lock, so two changes for one label run one after the other even when the
 * label has no row yet (a first claim has nothing for `FOR UPDATE` to lock).
 * A stored row that does not read back as a LabelState throws: the label then
 * answers 5xx rather than being taken for unbound.
 */

import { readLabelState, type LabelState, type UcpHostStore } from '@dina/ucp'
import { eq, sql } from 'drizzle-orm'

import type { DrizzleDB } from '@/db/connection.js'
import { ucpProfileLabels } from '@/db/schema/ucp.js'

type Executor = Pick<DrizzleDB, 'select'>

async function readRow(db: Executor, label: string): Promise<LabelState | null> {
  const [row] = await db
    .select({ stateJson: ucpProfileLabels.stateJson })
    .from(ucpProfileLabels)
    .where(eq(ucpProfileLabels.label, label))
    .limit(1)
  if (row === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.stateJson)
  } catch {
    parsed = null
  }
  const state = readLabelState(parsed)
  if (state === null) throw new Error('ucp host: a stored label state does not read')
  return state
}

export function postgresHostStore(db: DrizzleDB): UcpHostStore {
  return {
    async transact(label, fn) {
      return db.transaction(async (tx) => {
        // The lock key is namespaced so it cannot meet another feature's advisory lock.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ucp-host:${label}`}, 0))`)
        const current = await readRow(tx, label)
        const { write, result } = await fn(current)
        if (write !== null) {
          const values = {
            did: write.did,
            revision: write.revision,
            stateJson: JSON.stringify(write),
            updatedAt: new Date(),
          }
          await tx
            .insert(ucpProfileLabels)
            .values({ label, ...values })
            .onConflictDoUpdate({ target: ucpProfileLabels.label, set: values })
        }
        return result
      })
    },
    get(label) {
      return readRow(db, label)
    },
  }
}
