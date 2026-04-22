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
  type PersonaState,
} from '../../../core/src/persona/service';
import type { PersonaTier } from '../../../core/src/vault/lifecycle';

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
