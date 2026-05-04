/**
 * Persona management hook — data layer for Settings → Personas screen.
 *
 * Wraps Core's persona service + orchestrator with a UI-friendly API:
 *   - List all personas with tier, open/locked state, description
 *   - Create a new persona with tier selection
 *   - Unlock/lock personas (delegates to orchestrator)
 *   - Edit persona description
 *
 * Source: ARCHITECTURE.md Task 4.17
 */

import {
  createPersona,
  listPersonas,
  isPersonaOpen,
  setPersonaDescription,
  personaExists,
  resetPersonaState,
  type PersonaTier,
  type PersonaState,
} from '@dina/core';

export interface PersonaUIState {
  name: string;
  tier: PersonaTier;
  tierLabel: string;
  isOpen: boolean;
  description: string;
  canAutoOpen: boolean;
  needsApproval: boolean;
  needsPassphrase: boolean;
}

/** Human-readable tier labels. */
const TIER_LABELS: Record<PersonaTier, string> = {
  default: 'Default (always open)',
  standard: 'Standard (auto-open on boot)',
  sensitive: 'Sensitive (requires approval)',
  locked: 'Locked (requires passphrase)',
};

/** Tier properties. */
const TIER_PROPS: Record<
  PersonaTier,
  { canAutoOpen: boolean; needsApproval: boolean; needsPassphrase: boolean }
> = {
  default: { canAutoOpen: true, needsApproval: false, needsPassphrase: false },
  standard: { canAutoOpen: true, needsApproval: false, needsPassphrase: false },
  sensitive: { canAutoOpen: false, needsApproval: true, needsPassphrase: false },
  locked: { canAutoOpen: false, needsApproval: false, needsPassphrase: true },
};

/**
 * Get all personas with UI-friendly state.
 */
export function getPersonaUIStates(): PersonaUIState[] {
  return listPersonas().map(mapToUI);
}

/**
 * Create a new persona.
 *
 * Returns null on success, or an error message on failure.
 */
export function addPersona(name: string, tier: PersonaTier, description?: string): string | null {
  // Validate name
  const trimmed = name.trim();
  if (!trimmed) return 'Persona name is required';
  if (trimmed.length < 2) return 'Name must be at least 2 characters';
  if (trimmed.length > 30) return 'Name must be at most 30 characters';
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed))
    return 'Name can only contain letters, numbers, hyphens, underscores';

  // Check for duplicates
  if (personaExists(trimmed)) return `Persona "${trimmed}" already exists`;

  try {
    createPersona(trimmed, tier, description);
    return null; // success
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Update a persona's description.
 */
export function updateDescription(name: string, description: string): string | null {
  try {
    setPersonaDescription(name, description);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Get a single persona's UI state. Returns null if not found.
 */
export function getPersonaUI(name: string): PersonaUIState | null {
  const personas = listPersonas();
  const persona = personas.find((p) => p.name === name);
  return persona ? mapToUI(persona) : null;
}

/**
 * Get counts for the status summary.
 */
export function getPersonaCounts(): { total: number; open: number; closed: number } {
  const all = listPersonas();
  const open = all.filter((p) => p.isOpen).length;
  return { total: all.length, open, closed: all.length - open };
}

/**
 * Get available tier options for the create form.
 */
export function getTierOptions(): Array<{
  value: PersonaTier;
  label: string;
  description: string;
}> {
  return [
    { value: 'standard', label: 'Standard', description: 'Opens automatically on boot' },
    { value: 'sensitive', label: 'Sensitive', description: 'Requires your approval to open' },
    { value: 'locked', label: 'Locked', description: 'Requires passphrase to open' },
  ];
}

/**
 * Reset all persona state (for testing).
 */
export function resetPersonas(): void {
  resetPersonaState();
}

/**
 * Format a persona name for display — capitalise + replace
 * underscores with spaces. Internal storage keeps the lowercase
 * `[a-z0-9_]+` form (vault file names, classifier prompt list,
 * registry keys); UI surfaces convert here so users see "Finance"
 * not "finance" and "Trip Planning" not "trip_planning".
 *
 * Single source of truth — every screen that prints a persona name
 * should call this helper. Don't reach for `name.toUpperCase()` /
 * `name[0].toUpperCase()` ad-hoc; underscores would slip through.
 *
 *   formatPersonaDisplayName('general')        → 'General'
 *   formatPersonaDisplayName('trip_planning')  → 'Trip Planning'
 *   formatPersonaDisplayName('')               → ''
 */
export function formatPersonaDisplayName(name: string): string {
  if (!name) return '';
  return name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

/** Map internal PersonaState to UI state. */
function mapToUI(p: PersonaState): PersonaUIState {
  const props = TIER_PROPS[p.tier];
  return {
    name: p.name,
    tier: p.tier,
    tierLabel: TIER_LABELS[p.tier],
    isOpen: p.isOpen,
    description: p.description,
    canAutoOpen: props.canAutoOpen,
    needsApproval: props.needsApproval,
    needsPassphrase: props.needsPassphrase,
  };
}
