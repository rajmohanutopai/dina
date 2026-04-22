/**
 * Contact domain validation — relationship types, data responsibility,
 * alias rules, and reserved pronouns.
 *
 * Ported from Go: core/internal/domain/contact.go
 */

/** Valid contact relationship types — 8 values from Go. */
export const VALID_RELATIONSHIPS = new Set([
  'spouse',
  'child',
  'parent',
  'sibling',
  'friend',
  'colleague',
  'acquaintance',
  'unknown',
]);

/**
 * Valid data responsibility values — 4 values from Go.
 * "self" is intentionally excluded — it is a pipeline-only bucket
 * for subject attribution, not storable on contacts.
 */
export const VALID_DATA_RESPONSIBILITY = new Set(['household', 'care', 'financial', 'external']);

/**
 * Reserved aliases — pronouns that cannot be used as contact aliases.
 * These would break the subject attributor's pronoun carry-forward logic.
 *
 * Source: Go domain/contact.go ReservedAliases (16 entries)
 */
export const RESERVED_ALIASES = new Set([
  'he',
  'she',
  'they',
  'him',
  'her',
  'them',
  'his',
  'hers',
  'their',
  'theirs',
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
]);

/**
 * Derive the default data responsibility from a relationship type.
 *
 * - spouse, child → "household" (their sensitive data treated as user's own)
 * - all others → "external"
 *
 * Source: Go domain/contact.go DefaultResponsibility()
 */
export function defaultResponsibility(relationship: string): string {
  if (relationship === 'spouse' || relationship === 'child') {
    return 'household';
  }
  return 'external';
}

/**
 * Normalize an alias for comparison: trim + lowercase.
 */
export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

/**
 * Validate an alias string.
 *
 * Returns null if valid, or an error message describing the problem.
 *
 * Rules (from Go domain/contact.go ValidateAlias):
 * 1. Cannot be empty after normalization
 * 2. Must be at least 2 characters
 * 3. Cannot be a reserved pronoun
 */
export function validateAlias(alias: string): string | null {
  const normalized = normalizeAlias(alias);

  if (normalized.length === 0) {
    return 'alias cannot be empty';
  }
  if (normalized.length < 2) {
    return 'alias must be at least 2 characters';
  }
  if (RESERVED_ALIASES.has(normalized)) {
    return `alias "${normalized}" is a reserved pronoun`;
  }
  return null;
}

/**
 * Validate a relationship value.
 * Returns null if valid, or an error message.
 */
export function validateRelationship(relationship: string): string | null {
  if (!VALID_RELATIONSHIPS.has(relationship)) {
    return `invalid relationship: "${relationship}". Valid: ${[...VALID_RELATIONSHIPS].join(', ')}`;
  }
  return null;
}

/**
 * Validate a data responsibility value.
 * Returns null if valid, or an error message.
 */
export function validateDataResponsibility(responsibility: string): string | null {
  if (!VALID_DATA_RESPONSIBILITY.has(responsibility)) {
    return `invalid data_responsibility: "${responsibility}". Valid: ${[...VALID_DATA_RESPONSIBILITY].join(', ')}`;
  }
  return null;
}
