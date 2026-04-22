/**
 * Canonical persona and data category names — single source of truth.
 *
 * Both Core, Brain, and App must use these names consistently.
 * The domain classifier in Brain maps to these canonical names.
 */

/** Canonical persona names used across the system. */
export const PERSONA_NAMES = [
  'general',
  'health',
  'financial',
  'professional', // NOT 'work' — Brain classifies to 'professional'
  'social',
  'consumer',
] as const;

export type CanonicalPersona = (typeof PERSONA_NAMES)[number];

/** Canonical data categories for sharing policy. */
export const DATA_CATEGORIES = [
  'general',
  'health',
  'financial',
  'professional',
  'social',
] as const;

export type DataCategory = (typeof DATA_CATEGORIES)[number];

/**
 * Aliases that map to canonical names.
 * 'work' → 'professional' is the most important mapping.
 */
export const PERSONA_ALIASES: Record<string, CanonicalPersona> = {
  work: 'professional',
};

/** Resolve a persona name, applying aliases. */
export function resolvePersonaName(name: string): string {
  const lower = name.toLowerCase();
  return PERSONA_ALIASES[lower] ?? lower;
}
