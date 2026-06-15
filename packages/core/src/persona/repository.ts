/**
 * Persona SQL repository — durable storage for USER-created personas.
 *
 * Personas were previously in-memory only (`persona/service.ts`'s
 * `personas` Map): a vault the user created via the app vanished on
 * restart because boot only re-seeds the 4 code-defined defaults
 * (`onboarding/default_personas.ts`). This repository persists
 * user-created personas to the identity DB so `hydratePersonas()` can
 * restore them on the next unlock.
 *
 * Builtins are NOT stored here — they stay code-seeded so their
 * classifier descriptions stay in lockstep cross-stack (see
 * default_personas.ts). `is_builtin` is carried for completeness but
 * hydrate skips any builtin rows.
 *
 * **Sync-by-design — exempt from the async-port rule.** This repository
 * is a thin wrapper over the already-exempt synchronous
 * `DatabaseAdapter` (op-sqlite via JSI / better-sqlite3 native — both
 * synchronous, CPU-bound, no I/O wait). Like `ContactRepository`, the
 * service layer enforces SQL-write-before-in-memory-mutation, which
 * requires sync semantics; an async facade would force the in-memory
 * registry to lag the resolved promise or commit before the disk write.
 * Pinned in `__tests__/port_async_gate.test.ts` EXEMPTED list.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { PersonaTier } from '../vault/lifecycle';

/** A persisted persona row. `name` is the primary key (lowercased). */
export interface StoredPersona {
  name: string;
  tier: PersonaTier;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** Code-seeded default (true) vs user-created (false). Hydrate skips true. */
  isBuiltin: boolean;
}

export interface PersonaRepository {
  /** Insert or update a persona row, keyed by `name`. */
  upsert(p: StoredPersona): void;
  /** Delete a persona row by `name`. No-op if absent. */
  remove(name: string): void;
  /** All persisted personas, oldest first. */
  list(): StoredPersona[];
}

/** Singleton repository (null = in-memory only, no persistence). */
let repo: PersonaRepository | null = null;
export function setPersonaRepository(r: PersonaRepository | null): void {
  repo = r;
}
export function getPersonaRepository(): PersonaRepository | null {
  return repo;
}

export class SQLitePersonaRepository implements PersonaRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  upsert(p: StoredPersona): void {
    this.db.execute(
      `INSERT INTO personas (name, tier, description, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         tier = excluded.tier,
         description = excluded.description,
         is_builtin = excluded.is_builtin,
         updated_at = excluded.updated_at`,
      [p.name, p.tier, p.description, p.isBuiltin ? 1 : 0, p.createdAt, p.updatedAt],
    );
  }

  remove(name: string): void {
    this.db.execute('DELETE FROM personas WHERE name = ?', [name]);
  }

  list(): StoredPersona[] {
    const rows = this.db.query('SELECT * FROM personas ORDER BY created_at ASC');
    return rows.map(rowToStoredPersona);
  }
}

function rowToStoredPersona(row: DBRow): StoredPersona {
  return {
    name: String(row.name ?? ''),
    tier: String(row.tier ?? 'standard') as PersonaTier,
    description: String(row.description ?? ''),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    isBuiltin: Number(row.is_builtin ?? 0) === 1,
  };
}
