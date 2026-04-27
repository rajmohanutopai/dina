/**
 * Default-persona seed — the 4 vaults every new install starts with.
 *
 * Mirrors main Dina's `core/cmd/dina-core/main.go:443-450` bootstrap
 * block. Names + tiers + descriptions are byte-identical so the
 * mobile classifier ranks the same way as the Python/Go stack.
 *
 * | Name      | Tier      | Description (used by the LLM classifier)            |
 * | --------- | --------- | --------------------------------------------------- |
 * | general   | default   | Personal facts, preferences, family, relationships… |
 * | work      | standard  | Professional context, meetings, colleagues…        |
 * | health    | sensitive | Medical records, diagnoses, prescriptions…         |
 * | finance   | sensitive | Bank accounts, investments, bills, rent, salary…   |
 *
 * Sensitive-tier vaults stay closed until the user explicitly
 * approves. Without an approval gate on mobile yet, they auto-open at
 * unlock when persona policy allows — the in-process classifier's
 * `availablePersonas` list reads from the registry (open OR closed),
 * so the LLM can route to a sensitive vault even before the user
 * unlocks it; the staging drain then writes through the SQLite
 * vault for that persona (opened during boot in
 * `useUnlock.ts::openPersonaDB`).
 *
 * Descriptions feed the persona classifier. Without them the LLM has
 * only persona NAMES to disambiguate "I take 10mg of lisinopril" →
 * `health` vs `general`. With them the LLM sees `health: "Medical
 * records, diagnoses, prescriptions, …"` and routes correctly. Keep
 * the descriptions in lockstep with main Dina — drift here is a
 * cross-stack classifier divergence.
 */

import {
  createPersona,
  personaExists,
  setPersonaDescription,
} from '@dina/core/src/persona/service';
import type { PersonaTier } from '@dina/core/src/vault/lifecycle';

export interface DefaultPersonaSpec {
  name: string;
  tier: PersonaTier;
  description: string;
}

export const DEFAULT_PERSONAS: readonly DefaultPersonaSpec[] = [
  {
    name: 'general',
    tier: 'default',
    description:
      'Personal facts, preferences, family, relationships, hobbies, recipes, pets, birthdays, daily life, opinions',
  },
  {
    name: 'work',
    tier: 'standard',
    description:
      'Professional context, meetings, colleagues, deadlines, projects, office logistics, career',
  },
  {
    name: 'health',
    tier: 'sensitive',
    description:
      'Medical records, diagnoses, prescriptions, lab results, doctor visits, symptoms, allergies, medications, vital signs',
  },
  {
    name: 'finance',
    tier: 'sensitive',
    description:
      'Bank accounts, investments, bills, rent, salary, tax, loans, insurance, financial planning',
  },
] as const;

/**
 * Idempotent — runs every persona that doesn't already exist.
 * Existing personas are left untouched (no description overwrites)
 * so a user who edited their description in Settings doesn't get it
 * stomped on the next boot.
 *
 * Returns the list of persona names that were freshly created (vs
 * skipped because they already existed).
 */
export function seedDefaultPersonas(): string[] {
  const created: string[] = [];
  for (const spec of DEFAULT_PERSONAS) {
    if (personaExists(spec.name)) continue;
    createPersona(spec.name, spec.tier, spec.description);
    // Defensive: createPersona already accepts a description, but
    // setPersonaDescription is the single source of truth that the
    // Settings UI uses to mutate descriptions. Calling both keeps
    // the path uniform whether seed or user-driven.
    setPersonaDescription(spec.name, spec.description);
    created.push(spec.name);
  }
  return created;
}
