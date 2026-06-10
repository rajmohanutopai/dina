/**
 * Relations-tab membership rule.
 *
 * The People screen has two sub-tabs with different meanings:
 *   - Contacts:  the DID directory — anyone/anything you can reach over
 *                D2D, including SERVICE PROVIDERS (a bus depot, a clinic).
 *   - Relations: the personal people graph — humans your vault knows
 *                something relational about.
 *
 * Bug (user-reported 2026-06-10): adding a service provider as a contact
 * (for a known_only grant) created a person row, and the Relations list
 * rendered every person — so "Bus Depot 42" sat between the user's
 * daughter and a friend. Being a contact is NOT being a relation.
 *
 * Rule: a DID-bound person appears under Relations only when there is
 * RELATIONAL EVIDENCE beyond the contact entry itself —
 *   - a relationship hint ("daughter", "doctor"), or
 *   - any vault-extracted surface beyond plain names (role phrases,
 *     nicknames, aliases — the things extraction writes when your life
 *     actually references the person).
 * Persons with no DID at all (pure vault extraction, e.g. "Mia") always
 * qualify — they only exist BECAUSE the vault mentioned them.
 *
 * Self-healing: the moment the vault starts referencing a contact
 * ("Sancho is coming tomorrow" → surfaces/hints), they graduate into
 * Relations automatically. No person/organization modeling needed yet.
 */

import type { Person } from '@dina/core';

export function isRelation(person: Person): boolean {
  if (person.contactDid === '') return true; // vault-born person
  if (person.relationshipHint !== '') return true;
  const surfaces = person.surfaces ?? [];
  return surfaces.some((s) => s.surfaceType !== 'name');
}

/** Filter for the Relations sub-tab list. */
export function relationsOnly(people: readonly Person[]): Person[] {
  return people.filter(isRelation);
}
