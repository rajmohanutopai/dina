/**
 * Task 4.74 — legacy persona-tier migration.
 *
 * The current tier model uses four values (`default`, `standard`,
 * `sensitive`, `locked`) — see CLAUDE.md §Persona Access Tiers.
 * Older installs wrote two values — `open` and `restricted` — plus
 * `locked`. This module is a pure function that maps legacy names
 * to canonical ones so `persona_config.ts` (task 4.68) can load old
 * `config.json` files verbatim without the operator editing anything.
 *
 * **Mapping** (matches the Go-side TEST_PLAN entry TST-CORE-TIER-001
 * + TST-CORE-177):
 *
 * | Legacy input                       | Canonical output |
 * |------------------------------------|------------------|
 * | `open` + persona name "personal"   | `default`        |
 * | `open` + persona name "general"    | `default`        |
 * | `open` + any other name            | `standard`       |
 * | `restricted`                       | `sensitive`      |
 * | `locked`                           | `locked`         |
 * | `default` / `standard` / `sensitive` (already canonical) | pass-through |
 *
 * **Why the name-sensitive `open` split**: historically `open`
 * meant "auto-opens on boot, no approval needed". Two classes of
 * persona had that behavior: (1) the singular home bucket (usually
 * named `personal` or `general`), and (2) everyday domains the
 * user explicitly sharded (work, social, consumer). In the new
 * model those diverge: the home bucket stays `default` (truly no
 * gating), but the everyday personas become `standard` (open to
 * the user + Brain, but agents need a session grant). Getting
 * that split right is a security call — a sloppy migration that
 * mapped everything `open`→`default` would silently widen agent
 * access on upgrade. So the migration hard-codes the two home
 * bucket names — every other `open` safely downshifts to
 * `standard`.
 *
 * **Failure mode**: an unknown tier string throws. No silent
 * coercion. Broken config.json fails boot loud (same philosophy
 * as `src/config.ts`'s `ConfigError`).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4i task 4.74.
 */

import type { PersonaTier } from '@dina/core';

/** Legacy tier names the loader accepts for back-compat. */
export type LegacyTier = 'open' | 'restricted';

/** Any tier value that may appear in old `config.json` files. */
export type AnyTier = PersonaTier | LegacyTier;

/**
 * Canonical "home bucket" persona names. An `open` tier attached to
 * one of these becomes `default`; any other `open` becomes `standard`.
 *
 * Intentionally exported so callers that don't go through the loader
 * (e.g. tests, migration tools) can reuse the same list.
 */
export const HOME_BUCKET_NAMES = Object.freeze(['personal', 'general'] as const);

export type HomeBucketName = (typeof HOME_BUCKET_NAMES)[number];

export interface MigrateTierResult {
  /** Canonical tier after migration. */
  tier: PersonaTier;
  /** True when the input required rewriting. Useful for logging + audit. */
  migrated: boolean;
  /** The original input, preserved for the caller's audit trail. */
  original: string;
}

/**
 * Migrate a single (tier, persona-name) pair to canonical tier form.
 *
 * Returns a result struct rather than throwing for known legacy
 * values — the caller usually wants to *log* the migration (so the
 * operator sees what was rewritten on boot) rather than silently
 * coerce. Unknown tier values still throw: corrupt config.json
 * must fail loud.
 *
 * @param tier          raw tier string from disk
 * @param personaName   persona name the tier was attached to — used
 *                      to decide `open → default` vs `open → standard`
 */
export function migrateTier(tier: string, personaName: string): MigrateTierResult {
  if (!personaName) {
    throw new Error('migrateTier: personaName is required');
  }
  const original = tier;

  switch (tier) {
    case 'default':
    case 'standard':
    case 'sensitive':
    case 'locked':
      return { tier, migrated: false, original };

    case 'open':
      return {
        tier: isHomeBucketName(personaName) ? 'default' : 'standard',
        migrated: true,
        original,
      };

    case 'restricted':
      return { tier: 'sensitive', migrated: true, original };

    default:
      throw new Error(
        `migrateTier: unknown tier ${JSON.stringify(tier)} for persona ${JSON.stringify(personaName)}`,
      );
  }
}

/** True when `name` is one of the canonical home-bucket persona names. */
export function isHomeBucketName(name: string): name is HomeBucketName {
  return (HOME_BUCKET_NAMES as readonly string[]).includes(name);
}

/** True when `tier` is a legacy (pre-migration) value. */
export function isLegacyTier(tier: string): tier is LegacyTier {
  return tier === 'open' || tier === 'restricted';
}

/** True when `tier` is a current canonical value. */
export function isCanonicalTier(tier: string): tier is PersonaTier {
  return (
    tier === 'default' || tier === 'standard' || tier === 'sensitive' || tier === 'locked'
  );
}
