/**
 * Persona registry — loads from Core, caches, resolves aliases.
 *
 * Brain never invents persona names — it queries Core at startup and
 * caches. Aliases (e.g., "financial" → "finance", "medical" → "health")
 * resolved during classification.
 *
 * Source: brain/tests/test_persona_registry.py
 */

export interface PersonaInfo {
  name: string;
  tier: string;
  locked: boolean;
}

// ---------------------------------------------------------------
// Canonical personas and alias table
// ---------------------------------------------------------------

/** Known canonical persona names (from the server). */
const CANONICAL_PERSONAS = new Set([
  'identity',
  'general',
  'personal',
  'health',
  'financial',
  'social',
  'consumer',
  'professional',
  'citizen',
  'backup',
  'archive',
  'sync',
  'trust',
]);

/**
 * Alias table — maps common alternative names to canonical persona names.
 * Brain never invents personas; it only resolves known aliases.
 */
const ALIAS_TABLE: Record<string, string> = {
  // Financial
  finance: 'financial',
  money: 'financial',
  banking: 'financial',
  // Health
  medical: 'health',
  healthcare: 'health',
  wellness: 'health',
  // Professional
  work: 'professional',
  career: 'professional',
  business: 'professional',
  // Social
  friends: 'social',
  family: 'social',
  // Personal
  private: 'personal',
  diary: 'personal',
  // Consumer
  shopping: 'consumer',
  purchases: 'consumer',
  // General
  default: 'general',
  misc: 'general',
};

// ---------------------------------------------------------------
// In-memory cache (populated from Core API)
// ---------------------------------------------------------------

let cachedPersonas: PersonaInfo[] = [];

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Normalize a persona ID: strip leading '/', lowercase, trim whitespace.
 */
export function normalize(personaId: string): string {
  let normalized = personaId.trim().toLowerCase();
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

/**
 * Resolve an alias to the canonical persona name.
 *
 * Resolution order:
 * 1. Exact match in canonical set → return as-is
 * 2. Match in alias table → return the canonical target
 * 3. No match → return null (Brain never invents personas)
 */
export function resolveAlias(alias: string): string | null {
  const normalized = normalize(alias);

  // Already canonical
  if (CANONICAL_PERSONAS.has(normalized)) {
    return normalized;
  }

  // Check alias table
  const canonical = ALIAS_TABLE[normalized];
  if (canonical) {
    return canonical;
  }

  // Unknown — Brain never invents
  return null;
}

/**
 * Load persona list from Core API.
 * In production, this calls `GET /v1/personas` on Core.
 * For now, returns the cached list (populated by setCachedPersonas or refreshCache).
 */
export async function loadFromCore(): Promise<PersonaInfo[]> {
  // TODO: Phase 3.2 — actual HTTP call to Core
  // For now, return cached list
  return cachedPersonas;
}

/**
 * Refresh cache from Core. Returns cached list on failure.
 */
export async function refreshCache(): Promise<PersonaInfo[]> {
  try {
    const fresh = await loadFromCore();
    if (fresh.length > 0) {
      cachedPersonas = fresh;
    }
    return cachedPersonas;
  } catch {
    // Resilient: return stale cache on failure
    return cachedPersonas;
  }
}

/**
 * Set the cached persona list (for testing or initial population).
 */
export function setCachedPersonas(personas: PersonaInfo[]): void {
  cachedPersonas = personas;
}

/**
 * Get the current cached persona list.
 */
export function getCachedPersonas(): PersonaInfo[] {
  return cachedPersonas;
}

/**
 * Clear the cache (for testing).
 */
export function clearCache(): void {
  cachedPersonas = [];
}
