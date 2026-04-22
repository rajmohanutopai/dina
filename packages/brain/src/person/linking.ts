/**
 * Person identity linking — extraction, resolution, deduplication.
 *
 * PersonResolver: surface matching (name, email, alias), synonym expansion, dedup.
 * Parse validation: handle malformed LLM JSON output.
 * extractPersonLinks: LLM-based extraction via injectable provider.
 *
 * Source: brain/tests/test_person_linking.py
 */

export interface PersonLink {
  name: string;
  role?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ResolvedPerson {
  personId: string;
  name: string;
  surfaces: string[];
}

export type PersonLinkProvider = (text: string) => Promise<string>;

/** Injectable LLM provider for person extraction. */
let linkProvider: PersonLinkProvider | null = null;

/** Register an LLM provider for person link extraction. */
export function registerPersonLinkProvider(provider: PersonLinkProvider): void {
  linkProvider = provider;
}

/** Reset the provider (for testing). */
export function resetPersonLinkProvider(): void {
  linkProvider = null;
}

/**
 * Extract person links from text using the registered LLM provider.
 *
 * The provider is expected to return a JSON string with format:
 *   {"links": [{"name": "Alice", "role": "colleague", "confidence": "high"}]}
 *
 * When no provider is registered, returns an empty array.
 * Malformed LLM output is handled gracefully via parseLLMOutput.
 */
export async function extractPersonLinks(text: string): Promise<PersonLink[]> {
  if (!text || text.trim().length === 0) return [];

  if (!linkProvider) return [];

  const rawOutput = await linkProvider(text);
  return parseLLMOutput(rawOutput);
}

/** Resolve a person name against known people (name or surface match). */
export function resolvePerson(name: string, knownPeople: ResolvedPerson[]): ResolvedPerson | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const person of knownPeople) {
    if (person.name.toLowerCase() === lower) return person;
    if (person.surfaces.some((s) => s.toLowerCase() === lower)) return person;
  }
  return null;
}

/** Resolve multiple person references from text. */
export function resolveMultiple(text: string, knownPeople: ResolvedPerson[]): ResolvedPerson[] {
  if (!text) return [];
  const found: ResolvedPerson[] = [];
  const seen = new Set<string>();
  for (const person of knownPeople) {
    for (const term of [person.name, ...person.surfaces]) {
      if (term.length < 2) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(text) && !seen.has(person.personId)) {
        found.push(person);
        seen.add(person.personId);
        break;
      }
    }
  }
  return found;
}

/** Expand search terms from a person's known surfaces. */
export function expandSearchTerms(person: ResolvedPerson): string[] {
  return [...new Set([person.name, ...person.surfaces].filter((s) => s.length > 0))];
}

/** Deduplicate person mentions by personId. */
export function deduplicatePersons(persons: ResolvedPerson[]): ResolvedPerson[] {
  const seen = new Set<string>();
  return persons.filter((p) => {
    if (seen.has(p.personId)) return false;
    seen.add(p.personId);
    return true;
  });
}

/** Parse LLM JSON output for person links (handles malformed JSON). */
export function parseLLMOutput(output: string): PersonLink[] {
  if (!output) return [];
  let cleaned = output.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.links)) return [];
    return parsed.links
      .map((l: Record<string, unknown>) => ({
        name: String(l.name ?? ''),
        role: l.role ? String(l.role) : undefined,
        confidence: (['high', 'medium', 'low'].includes(String(l.confidence))
          ? String(l.confidence)
          : 'low') as PersonLink['confidence'],
      }))
      .filter((l: PersonLink) => l.name.length > 0);
  } catch {
    return [];
  }
}
