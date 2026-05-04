/**
 * Person identity linking — LLM extraction + surface-based resolution.
 *
 * Port of `brain/src/service/person_link_extractor.py` +
 * `brain/src/service/person_resolver.py`. Two concerns, one module:
 *
 *   - **Extraction**: feed a stored note's text through the
 *     `PERSON_IDENTITY_EXTRACTION` prompt; the LLM emits
 *     `{identity_links: [{name, role_phrase, relationship,
 *     confidence, evidence}]}`.
 *   - **Resolution**: given a block of query text + a list of known
 *     people (each with confirmed surfaces), find which people are
 *     mentioned. Longest-surface-first + span-claiming so "Alice
 *     Cooper" doesn't double-count as "Alice". `expandSearchTermsFromText`
 *     returns the set of confirmed surfaces NOT already in the query
 *     (Python's recall-expansion heuristic for synonym-aware search).
 *
 * Source: brain/tests/test_person_linking.py + test_person_resolver.py.
 */

import { scrubPII, rehydratePII } from '../../../core/src/pii/patterns';
import { PERSON_IDENTITY_EXTRACTION } from '../llm/prompts';

export interface PersonLink {
  /** Canonical person name as stated in the text. */
  name: string;
  /** Relationship phrase verbatim ("my daughter", "my colleague"). */
  role_phrase?: string;
  /** Relationship type the LLM picked from the enum
   *  (spouse/child/parent/sibling/friend/colleague/acquaintance/unknown/other). */
  relationship?: string;
  confidence: 'high' | 'medium' | 'low';
  /** Exact source phrase the LLM used to justify the link — 200 char
   *  max per Python's `_parse_response`. */
  evidence?: string;
}

export interface ResolvedPerson {
  personId: string;
  /** Canonical display name (e.g. "Alice Johnson"). */
  name: string;
  /** All confirmed-surface forms for this person (names + aliases +
   *  role phrases), used as synonym expansion material. */
  surfaces: string[];
  /** Linked contact DID when the person record carries one. Empty
   *  string when no DID has been bound yet. Python-parity addition. */
  contactDid?: string;
  /** Relationship hint stamped on the person record (colleague,
   *  friend, etc.). Empty string when unset. Python-parity addition. */
  relationshipHint?: string;
}

/**
 * LLM provider — `(system, prompt) => Promise<string>`. Mirrors the
 * `IdentityLLMCallFn` shape in `pipeline/identity_extraction.ts` and
 * Python's `person_link_extractor.py` two-message pattern: the
 * `PERSON_IDENTITY_EXTRACTION` template rides as the SYSTEM message,
 * the (PII-scrubbed) user text as the USER message. Wire production
 * via `registerPersonLinkProvider(buildLightweightLLMCall(router, 'classify'))`.
 */
export type PersonLinkProvider = (system: string, prompt: string) => Promise<string>;

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
 * Pipeline (Python parity):
 *   1. Empty / no-provider → `[]`.
 *   2. PII-scrub the text — vault content may contain emails / phone
 *      numbers; names pass through (by design).
 *   3. Send `(PERSON_IDENTITY_EXTRACTION, scrubbedText)` as a
 *      two-message conversation.
 *   4. Rehydrate any PII tokens in the response so names / evidence
 *      come back with original values.
 *   5. Parse `{identity_links: [{name, role_phrase, relationship,
 *      confidence, evidence}]}`.
 *
 * Returns `[]` on parse failure (fail-open).
 */
export async function extractPersonLinks(text: string): Promise<PersonLink[]> {
  if (!text || text.trim().length === 0) return [];
  if (!linkProvider) return [];
  const { scrubbed, entities } = scrubPII(text);
  const rawOutput = await linkProvider(PERSON_IDENTITY_EXTRACTION, scrubbed);
  const rehydrated = entities.length > 0 ? rehydratePII(rawOutput, entities) : rawOutput;
  return parseLLMOutput(rehydrated);
}

/**
 * Find a person by a single surface lookup — exact name match OR any
 * of their confirmed surfaces (both case-insensitive).
 */
export function resolvePerson(name: string, knownPeople: ResolvedPerson[]): ResolvedPerson | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const person of knownPeople) {
    if (person.name.toLowerCase() === lower) return person;
    if (person.surfaces.some((s) => s.toLowerCase() === lower)) return person;
  }
  return null;
}

/**
 * Resolve every person mentioned in `text`. Builds regex patterns
 * from each person's (name + surfaces), sorts longest-first, and
 * claims matched spans so "Alice Cooper" wins over "Alice" on
 * overlapping text. Returns at most one `ResolvedPerson` per
 * personId even when the same person appears under multiple
 * surfaces (dedup matches Python's `matched_pids` dict).
 *
 * Empty text / empty people → `[]`.
 */
export function resolveMultiple(text: string, knownPeople: ResolvedPerson[]): ResolvedPerson[] {
  if (!text || knownPeople.length === 0) return [];

  interface Entry {
    surface: string;
    personId: string;
  }
  const entries: Entry[] = [];
  const seenKeys = new Set<string>();
  for (const person of knownPeople) {
    const push = (surface: string): void => {
      const trimmed = surface.trim();
      if (trimmed.length < 2) return;
      const key = `${person.personId} ${trimmed.toLowerCase()}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      entries.push({ surface: trimmed, personId: person.personId });
    };
    push(person.name);
    for (const s of person.surfaces) push(s);
  }
  entries.sort((a, b) => b.surface.length - a.surface.length);

  const byId = new Map<string, ResolvedPerson>();
  const claimed: [number, number][] = [];

  for (const entry of entries) {
    const pattern = new RegExp(`\\b${escapeRegex(entry.surface)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      if (byId.has(entry.personId)) continue;
      const found = knownPeople.find((p) => p.personId === entry.personId);
      if (found) byId.set(entry.personId, found);
    }
  }

  return [...byId.values()];
}

/**
 * Expand a single person's synonym set — name + every confirmed
 * surface, deduped, empty entries dropped. Unchanged from the
 * original TS surface; kept for callers that already resolved the
 * person and just need the synonym list.
 */
export function expandSearchTerms(person: ResolvedPerson): string[] {
  return [...new Set([person.name, ...person.surfaces].filter((s) => s.length > 0))];
}

/**
 * Python-parity recall expansion — given a query and a roster of
 * known people, return the synonyms that are NOT already in the
 * query text. The FTS layer can then OR these in to catch items
 * stored under an alias the user didn't type ("My spouse" → also
 * search "Sarah").
 *
 * Mirrors `person_resolver.py::expand_search_terms`.
 */
export function expandSearchTermsFromText(
  text: string,
  knownPeople: ResolvedPerson[],
): string[] {
  const resolved = resolveMultiple(text, knownPeople);
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const person of resolved) {
    for (const surface of person.surfaces) {
      if (surface && !lower.includes(surface.toLowerCase())) {
        out.push(surface);
      }
    }
  }
  return out;
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

/**
 * Parse LLM JSON output for person links. Accepts the canonical
 * `{identity_links: [{name, role_phrase, relationship, confidence, evidence}]}`
 * envelope emitted by the `PERSON_IDENTITY_EXTRACTION` prompt.
 *
 * Handles markdown code fences. Confidence is coerced to
 * high/medium/low; unknown values → 'low'. Returns `[]` on any
 * parse failure (fail-open: callers proceed with regex-only results).
 */
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
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const rawList = Array.isArray(parsed.identity_links)
      ? (parsed.identity_links as unknown[])
      : [];

    const out: PersonLink[] = [];
    for (const raw of rawList) {
      if (raw === null || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (name === '') continue;
      const rolePhraseRaw = typeof rec.role_phrase === 'string' ? rec.role_phrase : undefined;
      const relationshipRaw =
        typeof rec.relationship === 'string' ? rec.relationship : undefined;
      const evidenceRaw =
        typeof rec.evidence === 'string' ? rec.evidence.slice(0, 200) : undefined;
      const confidenceRaw = String(rec.confidence ?? '').toLowerCase();
      const confidence: PersonLink['confidence'] =
        confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
          ? (confidenceRaw as PersonLink['confidence'])
          : 'low';
      out.push({
        name,
        ...(rolePhraseRaw !== undefined ? { role_phrase: rolePhraseRaw } : {}),
        ...(relationshipRaw !== undefined ? { relationship: relationshipRaw } : {}),
        ...(evidenceRaw !== undefined ? { evidence: evidenceRaw } : {}),
        confidence,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Escape regex metacharacters in a literal string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
