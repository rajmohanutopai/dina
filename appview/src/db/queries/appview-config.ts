import { eq } from 'drizzle-orm'
import type { DrizzleDB } from '../connection'
import { appviewConfig } from '../schema/appview-config'

/**
 * Typed accessors for `appview_config` (TN-FLAG-001 / Plan §13.6).
 *
 * Every flag has an application-level default — absence of a row means
 * "use the default", not "error". This keeps fresh deployments and
 * test databases from needing a seed step before the ingester / scorer
 * / xRPC layer can boot.
 *
 * **Default cutover stance** (Plan §13.10): V1 ships with the trust
 * feature ON; operators flip OFF with `dina-admin trust disable`
 * (TN-FLAG-002) if they need to roll back a problematic deploy. The
 * default lives in `FLAG_DEFAULTS` so a typo at one call site can't
 * disagree with another.
 *
 * **Concurrency / hot-reload**: callers that poll (the scorer, the
 * ingester) should read on each cycle and cache for that cycle. The
 * xRPC handlers read per-request (cheap — single PK lookup, ~0.1ms);
 * gating reads on a 60s cache would let a `dina-admin trust disable`
 * still serve responses for a full minute, which is the wrong
 * direction for a kill-switch.
 */

export type AppviewFlagKey = keyof typeof FLAG_DEFAULTS

/**
 * Application-level defaults — used when no row exists for the key.
 * Adding a new flag: add an entry here AND seed it in TN-DB-010.
 */
export const FLAG_DEFAULTS = Object.freeze({
  /** Master kill-switch for the `com.dina.trust.*` V1 surface. Plan §13.10 cutover defaults to ON. */
  trust_v1_enabled: true,
} as const)

/**
 * Read a boolean flag. Returns the application default when no row
 * exists OR when the row's `bool_value` is NULL (mis-seeded — log or
 * fall through gracefully rather than crashing).
 */
export async function readBoolFlag(db: DrizzleDB, key: AppviewFlagKey): Promise<boolean> {
  const rows = await db
    .select({ boolValue: appviewConfig.boolValue })
    .from(appviewConfig)
    .where(eq(appviewConfig.key, key))
    .limit(1)
  const row = rows[0]
  if (row === undefined || row.boolValue === null) {
    return FLAG_DEFAULTS[key]
  }
  return row.boolValue
}

/**
 * Operator write path for boolean flags (TN-FLAG-002 / Plan §13.10).
 *
 * Backs `dina-admin trust enable|disable`. UPSERTs the row keyed by
 * `key` so the first call after a fresh deployment creates it and
 * subsequent calls update in place. Idempotent — calling twice with
 * the same value leaves the table in the same state (the second call's
 * `updated_at` advances, useful for the polling layer's change
 * detection).
 *
 * **Closed flag set**: `key` is `AppviewFlagKey`, the keys of
 * `FLAG_DEFAULTS`. A typo in a CLI invocation fails at compile time
 * for in-tree callers and via Zod parsing in the CLI entry. Operators
 * cannot accidentally seed a row for a non-existent flag (the row
 * would never be read by anything, just orphan data).
 *
 * **Description seeded from FLAG_DEFAULTS docstrings is NOT done here**
 * — the consolidated TN-DB-010 migration owns the description field.
 * On UPSERT-create from the CLI path, we set a placeholder description
 * (`'flag set via dina-admin'`) so the NOT NULL constraint passes;
 * operators reviewing `SELECT * FROM appview_config` see the row + can
 * edit the description manually if curating. Updates from the CLI do
 * NOT overwrite an existing description.
 *
 * **Why a separate write path** rather than reusing `readBoolFlag`'s
 * file: keeps reads dependency-free (no UPSERT machinery imported by
 * xRPC handlers / scorer / ingester). CLI-only callers import this
 * function explicitly.
 */
export async function setBoolFlag(
  db: DrizzleDB,
  key: AppviewFlagKey,
  value: boolean,
): Promise<void> {
  // Single timestamp shared across INSERT + UPDATE branches so the
  // wire payload reflects one logical "operator flipped at T" event.
  const now = new Date()
  await db
    .insert(appviewConfig)
    .values({
      key,
      boolValue: value,
      description: 'flag set via dina-admin',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appviewConfig.key,
      set: {
        boolValue: value,
        updatedAt: now,
      },
    })
}
