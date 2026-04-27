/**
 * `PersonResolver` — high-level read-only lookups over the people
 * graph. Thin synchronous facade on top of `PeopleRepository`; lives
 * in `packages/core` so the reminder planner, the D2D ingress
 * speaker-naming, and the vault-facts assembler can all share one
 * resolver without each re-implementing the lookup queries.
 *
 * Why a separate type from the repo:
 *   - The repo is the write-side: extraction, confirm/reject, GC,
 *     merge. Its read methods (`getPerson`, `findByContactDid`) return
 *     raw `Person` rows including suggested+rejected surfaces.
 *   - The resolver is the read-side: it filters to *confirmed*
 *     surfaces, hides rejected people, and answers the three
 *     questions callers actually have:
 *       (1) "I have a DID — who is this person?"   → resolveByDID
 *       (2) "I have a phrase — who could this be?" → resolveBySurface
 *       (3) "Give me every confirmed alias keyed by normalized form."
 *           (used by the reminder planner to substitute "my brother"
 *            with "Sancho") → confirmedSurfacesMap
 *     Plus a tiny `displayName` helper because the reminder planner's
 *     #1 ask is "what name do I use in the user-facing string".
 *
 * Sync-by-design — same rationale as the repository. Callers that
 * already hold a synchronous Identity-DB transaction (the reminder
 * planner) shouldn't have to break their flow on an HTTP round-trip.
 *
 * Behavioural parity with main Dina:
 *   - `resolveBySurface` matches the `resolveConfirmedSurfaces` Go
 *     query — surface confirmed AND owner not rejected. Suggested
 *     people whose alias was manually promoted still resolve.
 *   - `resolveByDID('')` is a no-op. Persons without a bound DID are
 *     never returned by DID lookup.
 */

import { normalizeAlias } from '../contacts/validation';

import type { Person, PersonSurface } from './domain';
import type { PeopleRepository } from './repository';

/**
 * Surface-stripped person record returned by the resolver. We
 * deliberately re-shape `Person.surfaces` to confirmed-only so
 * callers don't accidentally surface a suggested alias to the user.
 */
export interface ResolvedPerson {
  personId: string;
  canonicalName: string;
  contactDid: string;
  relationshipHint: string;
  /** Confirmed surfaces only — name(s), nicknames, role phrases, aliases. */
  surfaces: PersonSurface[];
}

export interface PersonResolver {
  /**
   * Look up the person bound to `did`. Returns `null` for the empty
   * string and for unknown DIDs. The returned record's `surfaces`
   * list contains every confirmed alias.
   */
  resolveByDID(did: string): ResolvedPerson | null;

  /**
   * Look up everyone whose confirmed surface matches `surface`
   * (case-insensitive, whitespace-trimmed via `normalizeAlias`).
   * Multiple confirmed people may share a normalized surface (two
   * "Alex"es), so this returns an array. Empty array on no match.
   */
  resolveBySurface(surface: string): ResolvedPerson[];

  /**
   * Bulk read used by the reminder planner: every confirmed surface
   * keyed by its normalized form. The map values are surface rows so
   * callers can look up the owning `personId`. Mirrors
   * `PeopleRepository.resolveConfirmedSurfaces`.
   */
  confirmedSurfacesMap(): Map<string, PersonSurface[]>;

  /**
   * The user-facing display name to use for `personIdOrDid`. Falls
   * back through:
   *   (1) `canonicalName` when set
   *   (2) the first confirmed `name` surface
   *   (3) the first confirmed `nickname` surface
   *   (4) `null` when nothing usable is recorded
   *
   * Returns `null` when no person is found at all. The reminder
   * planner uses this to render "Sancho is arriving" rather than
   * "did:plc:abc is arriving".
   */
  displayName(personIdOrDid: string): string | null;
}

export class RepositoryPersonResolver implements PersonResolver {
  constructor(private readonly repo: PeopleRepository) {}

  resolveByDID(did: string): ResolvedPerson | null {
    if (did === '') return null;
    const person = this.repo.findByContactDid(did);
    if (person === null) return null;
    return toResolved(person);
  }

  resolveBySurface(surface: string): ResolvedPerson[] {
    const norm = normalizeAlias(surface);
    if (norm === '') return [];
    const map = this.repo.resolveConfirmedSurfaces();
    const surfaces = map.get(norm);
    if (!surfaces || surfaces.length === 0) return [];
    // De-dup by personId — a single person may own multiple confirmed
    // surfaces that normalize to the same form (rare but possible).
    const seen = new Set<string>();
    const out: ResolvedPerson[] = [];
    for (const s of surfaces) {
      if (seen.has(s.personId)) continue;
      seen.add(s.personId);
      const person = this.repo.getPerson(s.personId);
      if (person === null || person.status === 'rejected') continue;
      out.push(toResolved(person));
    }
    return out;
  }

  confirmedSurfacesMap(): Map<string, PersonSurface[]> {
    return this.repo.resolveConfirmedSurfaces();
  }

  displayName(personIdOrDid: string): string | null {
    if (personIdOrDid === '') return null;
    const person =
      personIdOrDid.startsWith('did:')
        ? this.repo.findByContactDid(personIdOrDid)
        : this.repo.getPerson(personIdOrDid);
    if (person === null) return null;
    if (person.canonicalName !== '') return person.canonicalName;
    const confirmed = (person.surfaces ?? []).filter((s) => s.status === 'confirmed');
    const name = confirmed.find((s) => s.surfaceType === 'name');
    if (name !== undefined) return name.surface;
    const nickname = confirmed.find((s) => s.surfaceType === 'nickname');
    if (nickname !== undefined) return nickname.surface;
    return null;
  }
}

function toResolved(person: Person): ResolvedPerson {
  return {
    personId: person.personId,
    canonicalName: person.canonicalName,
    contactDid: person.contactDid,
    relationshipHint: person.relationshipHint,
    surfaces: (person.surfaces ?? []).filter((s) => s.status === 'confirmed'),
  };
}
