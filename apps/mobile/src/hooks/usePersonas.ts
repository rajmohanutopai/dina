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
  openPersona,
  setPersonaDescription,
  personaExists,
  resetPersonaState,
  type PersonaTier,
  type PersonaState,
} from '@dina/core';

import { isPersistenceReady, openPersonaDB } from '../storage/init';

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
export async function addPersona(
  name: string,
  tier: PersonaTier,
  description?: string,
): Promise<string | null> {
  // Validate name. Mirror Core's PERSONA_NAME_REGEX exactly — letters,
  // numbers, underscores (NO hyphens; Core lowercases + rejects '-'), so
  // the UI can't promise a name Core then throws on.
  const trimmed = name.trim();
  if (!trimmed) return 'Persona name is required';
  if (trimmed.length < 2) return 'Name must be at least 2 characters';
  if (trimmed.length > 30) return 'Name must be at most 30 characters';
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed))
    return 'Name can only contain letters, numbers, and underscores';

  // Check for duplicates
  if (personaExists(trimmed)) return `Persona "${trimmed}" already exists`;

  // A durable create AND a usable vault both require the full storage layer
  // (persona repo + vault DB). If it isn't ready, fail cleanly rather than
  // land a memory-only persona that vanishes on restart.
  if (!isPersistenceReady()) {
    return 'Storage is still starting up — please try again in a moment';
  }

  try {
    // persist:true → durable registry row so the vault survives a restart
    // (hydratePersonas restores it on the next unlock).
    createPersona(trimmed, tier, description, { persist: true });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  // Make the new vault usable IMMEDIATELY for the owner. Wire its SQLCipher
  // vault DB FIRST and only mark the persona open + report success once the DB
  // is ready — otherwise the UI would show an "open" vault that silently can't
  // receive writes. The persona row is already durable, so a failure here is
  // recoverable: the next unlock's open-loop reopens it.
  const normalized = trimmed.toLowerCase();
  try {
    await openPersonaDB(normalized); // wire the writable SQLCipher vault DB
  } catch (err) {
    console.warn(`[personas] vault DB open failed for "${normalized}":`, err);
    return 'Could not open the new vault right now — it was saved; reopen the app to use it';
  }
  // approved=true → the in-app owner bypasses the tier gate. Marked open only
  // after the DB is wired, so an open vault is always a writable vault.
  openPersona(normalized, true);
  return null;
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
