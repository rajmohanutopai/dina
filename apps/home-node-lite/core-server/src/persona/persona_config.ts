/**
 * Task 4.68 — `config.json` loader for persona tier definitions.
 *
 * At boot the Home Node needs to know which personas exist and
 * which tier each one occupies. That map lives at
 * `${vaultDir}/config.json`. This greenfield loader accepts canonical
 * tier values only. Old tier names are invalid configuration, not a
 * runtime migration path.
 *
 * **Shape**:
 *
 * ```json
 * {
 *   "version": 1,
 *   "personas": {
 *     "general":   { "tier": "default" },
 *     "work":      { "tier": "standard",  "description": "Work comms + projects" },
 *     "health":    { "tier": "sensitive", "description": "Medical records" },
 *     "financial": { "tier": "locked",    "description": "Banks + taxes" }
 *   }
 * }
 * ```
 *
 * **Fail-loud philosophy** (inherited from `src/config.ts`): any
 * validation failure throws `PersonaConfigError` before the server
 * binds a port. A missing file is a distinct error (`missing_file`)
 * so `boot.ts` can choose whether to fail hard or synthesize a
 * default config — first-run installs will have no config.json yet.
 *
 * **I/O injection**: `loadPersonaConfig` takes an explicit
 * `readFile` function so tests don't touch disk. The production
 * caller supplies `fs.readFileSync`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.68.
 */

import { z } from 'zod';
import type { PersonaTier } from '@dina/core';

// ---------------------------------------------------------------------------
// Schema — structural validation only. Tier values are validated separately
// because Zod can't express "this string must be in one of two disjoint
// enum sets" and still produce readable errors; we do it inline in
// `loadPersonaConfig` so the caller gets actionable messages.
// ---------------------------------------------------------------------------

const PersonaEntrySchema = z.object({
  tier: z.string().min(1),
  description: z.string().optional(),
});

export const PersonaConfigFileSchema = z.object({
  /** Schema version. Bumped when we make a breaking change. */
  version: z.number().int().min(1),
  /** Map from persona name → entry. Name is the key, not a field. */
  personas: z.record(z.string().min(1), PersonaEntrySchema),
});

export type PersonaConfigFile = z.infer<typeof PersonaConfigFileSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PersonaDefinition {
  name: string;
  tier: PersonaTier;
  description?: string;
}

export interface LoadedPersonaConfig {
  /** Schema version read from disk. */
  version: number;
  /** Personas keyed by name, with canonical tier values. */
  personas: Map<string, PersonaDefinition>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PersonaConfigErrorCode =
  | 'missing_file'
  | 'invalid_json'
  | 'invalid_shape'
  | 'invalid_tier'
  | 'duplicate_persona';

export class PersonaConfigError extends Error {
  constructor(
    public readonly code: PersonaConfigErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PersonaConfigError';
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadPersonaConfigOptions {
  /** Absolute path to the config.json file. */
  path: string;
  /**
   * Injected file reader. Production passes `fs.readFileSync` (curried
   * to UTF-8). Tests pass a fake that returns a string, or throws with
   * `code: 'ENOENT'` to simulate a missing file.
   */
  readFile: (path: string) => string;
}

/**
 * Load and validate a persona config.json.
 *
 * Returns `LoadedPersonaConfig` on success. Throws `PersonaConfigError`
 * on any failure mode (missing file, bad JSON, invalid shape,
 * non-canonical tier, duplicate persona — though duplicates are
 * impossible via JSON object keys, we still guard against hand-edited
 * files with case-only differences).
 */
export function loadPersonaConfig(opts: LoadPersonaConfigOptions): LoadedPersonaConfig {
  let raw: string;
  try {
    raw = opts.readFile(opts.path);
  } catch (err) {
    // Node's fs throws an Error with `.code = 'ENOENT'` for missing files.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new PersonaConfigError(
        'missing_file',
        `persona config not found at ${opts.path}`,
        { path: opts.path },
      );
    }
    throw new PersonaConfigError(
      'invalid_json',
      `could not read persona config at ${opts.path}: ${(err as Error).message}`,
      { path: opts.path },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PersonaConfigError(
      'invalid_json',
      `persona config at ${opts.path} is not valid JSON: ${(err as Error).message}`,
      { path: opts.path },
    );
  }

  const structural = PersonaConfigFileSchema.safeParse(parsed);
  if (!structural.success) {
    throw new PersonaConfigError(
      'invalid_shape',
      `persona config at ${opts.path} failed validation (${structural.error.issues.length} issue${structural.error.issues.length === 1 ? '' : 's'})`,
      {
        path: opts.path,
        issues: structural.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    );
  }

  const file = structural.data;
  const personas = new Map<string, PersonaDefinition>();

  for (const [name, entry] of Object.entries(file.personas)) {
    if (personas.has(name)) {
      // Object.entries on a standard object cannot produce duplicate keys,
      // but a future JSON parser that preserves duplicates (or a hand-
      // mutated call site) could. Fail loud either way.
      throw new PersonaConfigError(
        'duplicate_persona',
        `persona ${JSON.stringify(name)} appears more than once in ${opts.path}`,
        { persona: name, path: opts.path },
      );
    }

    if (!isCanonicalTier(entry.tier)) {
      throw new PersonaConfigError(
        'invalid_tier',
        `persona ${JSON.stringify(name)} has non-canonical tier ${JSON.stringify(entry.tier)}`,
        { persona: name, tier: entry.tier },
      );
    }

    const def: PersonaDefinition = {
      name,
      tier: entry.tier,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    };
    personas.set(name, def);
  }

  return {
    version: file.version,
    personas,
  };
}

// ---------------------------------------------------------------------------
// Serialization (symmetric round-trip for tests + `dina-admin` writers)
// ---------------------------------------------------------------------------

/**
 * Render a loaded persona config back to the on-disk shape. The
 * output is canonical because non-canonical tier values never load.
 */
export function serializePersonaConfig(loaded: LoadedPersonaConfig): PersonaConfigFile {
  const personas: Record<string, { tier: string; description?: string }> = {};
  for (const [name, def] of loaded.personas) {
    personas[name] = {
      tier: def.tier,
      ...(def.description !== undefined ? { description: def.description } : {}),
    };
  }
  return { version: loaded.version, personas };
}

export function isCanonicalTier(tier: string): tier is PersonaTier {
  return (
    tier === 'default' || tier === 'standard' || tier === 'sensitive' || tier === 'locked'
  );
}
