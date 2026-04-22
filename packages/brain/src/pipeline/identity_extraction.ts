/**
 * Person identity extraction — extract relationship definitions from vault text.
 *
 * Uses the PERSON_IDENTITY_EXTRACTION prompt to identify statements like
 * "Emma is my daughter" and extract structured identity links.
 *
 * Injectable LLM provider: register via registerIdentityExtractor().
 * Deterministic fallback: regex-based extraction for common patterns.
 *
 * Source: brain/src/prompts.py PROMPT_PERSON_IDENTITY_EXTRACTION
 */

import { PERSON_IDENTITY_EXTRACTION } from '../llm/prompts';
import { scrubPII, rehydratePII } from '../../../core/src/pii/patterns';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type RelationshipType =
  | 'spouse'
  | 'child'
  | 'parent'
  | 'sibling'
  | 'friend'
  | 'colleague'
  | 'acquaintance'
  | 'unknown';

export interface IdentityLink {
  name: string;
  relationship: RelationshipType;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  method: 'deterministic' | 'llm';
}

export interface IdentityExtractionResult {
  links: IdentityLink[];
  method: 'deterministic' | 'llm' | 'combined';
}

// ---------------------------------------------------------------
// Injectable LLM provider
// ---------------------------------------------------------------

export type IdentityLLMCallFn = (system: string, prompt: string) => Promise<string>;

let llmCallFn: IdentityLLMCallFn | null = null;

/** Register an LLM provider for identity extraction. */
export function registerIdentityExtractor(fn: IdentityLLMCallFn): void {
  llmCallFn = fn;
}

/** Reset the LLM provider (for testing). */
export function resetIdentityExtractor(): void {
  llmCallFn = null;
}

// ---------------------------------------------------------------
// Valid relationship types
// ---------------------------------------------------------------

const VALID_RELATIONSHIPS = new Set<RelationshipType>([
  'spouse',
  'child',
  'parent',
  'sibling',
  'friend',
  'colleague',
  'acquaintance',
  'unknown',
]);

// ---------------------------------------------------------------
// Deterministic extraction patterns
// ---------------------------------------------------------------

/**
 * Name pattern: uppercase letter followed by lowercase letters,
 * optionally a second word also starting with uppercase.
 * Must NOT use the `i` flag — uppercase anchoring is essential.
 */
const NAME = '([A-Z][a-z]+(?:\\s[A-Z][a-z]+)?)';

/**
 * Build relationship patterns. Uses `g` flag only (not `i`)
 * so that the name capture requires proper capitalization.
 * Relationship keywords are case-insensitive via alternation (e.g., [Mm]y).
 */
const RELATIONSHIP_PATTERNS: Array<{
  pattern: RegExp;
  relationship: RelationshipType;
  nameGroup: number;
}> = [
  // "X is my daughter/son/wife/husband/etc."
  {
    pattern: new RegExp(`\\b${NAME}\\s+is\\s+[Mm]y\\s+(?:daughter|son|child)\\b`, 'g'),
    relationship: 'child',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b${NAME}\\s+is\\s+[Mm]y\\s+(?:wife|husband|spouse|partner)\\b`, 'g'),
    relationship: 'spouse',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b${NAME}\\s+is\\s+[Mm]y\\s+(?:mother|father|mom|dad|parent)\\b`, 'g'),
    relationship: 'parent',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b${NAME}\\s+is\\s+[Mm]y\\s+(?:brother|sister|sibling)\\b`, 'g'),
    relationship: 'sibling',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b${NAME}\\s+is\\s+[Mm]y\\s+(?:friend|best\\s+friend)\\b`, 'g'),
    relationship: 'friend',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(
      `\\b${NAME}\\s+is\\s+[Mm]y\\s+(?:colleague|coworker|co-worker|boss|manager)\\b`,
      'g',
    ),
    relationship: 'colleague',
    nameGroup: 1,
  },

  // "my daughter/son X"
  {
    pattern: new RegExp(`\\b[Mm]y\\s+(?:daughter|son|child)\\s+${NAME}\\b`, 'g'),
    relationship: 'child',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b[Mm]y\\s+(?:wife|husband|spouse|partner)\\s+${NAME}\\b`, 'g'),
    relationship: 'spouse',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b[Mm]y\\s+(?:mother|father|mom|dad|parent)\\s+${NAME}\\b`, 'g'),
    relationship: 'parent',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b[Mm]y\\s+(?:brother|sister|sibling)\\s+${NAME}\\b`, 'g'),
    relationship: 'sibling',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(`\\b[Mm]y\\s+(?:friend|best\\s+friend)\\s+${NAME}\\b`, 'g'),
    relationship: 'friend',
    nameGroup: 1,
  },
  {
    pattern: new RegExp(
      `\\b[Mm]y\\s+(?:colleague|coworker|co-worker|boss|manager)\\s+${NAME}\\b`,
      'g',
    ),
    relationship: 'colleague',
    nameGroup: 1,
  },
];

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Extract identity links from text.
 *
 * Uses LLM when registered, with deterministic fallback.
 * Both methods may run and results are merged (deduped by name).
 */
export async function extractIdentityLinks(text: string): Promise<IdentityExtractionResult> {
  if (!text || text.trim().length === 0) {
    return { links: [], method: 'deterministic' };
  }

  // Always run deterministic pass (fast, no cost)
  const deterministicLinks = extractDeterministic(text);

  // If LLM is available, run LLM pass for additional/refined links
  if (llmCallFn) {
    try {
      const llmLinks = await extractWithLLM(text);
      const merged = mergeLinks(deterministicLinks, llmLinks);
      return {
        links: merged,
        method: merged.some((l) => l.method === 'llm') ? 'combined' : 'deterministic',
      };
    } catch {
      // LLM failed — return deterministic only
      return { links: deterministicLinks, method: 'deterministic' };
    }
  }

  return { links: deterministicLinks, method: 'deterministic' };
}

/**
 * Deterministic extraction using regex patterns.
 *
 * Fast, high precision, but limited to explicit pattern matches.
 */
export function extractDeterministic(text: string): IdentityLink[] {
  const links: IdentityLink[] = [];
  const seenNames = new Set<string>();

  for (const { pattern, relationship, nameGroup } of RELATIONSHIP_PATTERNS) {
    // Reset regex state for each pattern
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[nameGroup].trim();
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);

      links.push({
        name,
        relationship,
        confidence: 'high',
        evidence: match[0].trim(),
        method: 'deterministic',
      });
    }
  }

  return links;
}

// ---------------------------------------------------------------
// Internal: LLM extraction
// ---------------------------------------------------------------

async function extractWithLLM(text: string): Promise<IdentityLink[]> {
  if (!llmCallFn) return [];

  // PII scrub before sending to cloud LLM — vault text may contain
  // emails, phone numbers, etc. Names are NOT scrubbed (by design).
  const { scrubbed, entities } = scrubPII(text);

  const prompt = PERSON_IDENTITY_EXTRACTION.replace('{{text}}', scrubbed);
  const response = await llmCallFn(
    "You are extracting relationship information from a user's personal notes for Dina, a personal AI assistant.",
    prompt,
  );

  // Rehydrate PII tokens in the response so names/evidence contain original values
  const rehydrated = entities.length > 0 ? rehydratePII(response, entities) : response;
  return parseLLMResponse(rehydrated);
}

/**
 * Parse the LLM response JSON.
 * Handles markdown code fences and malformed output.
 */
export function parseLLMResponse(output: string): IdentityLink[] {
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
    if (!parsed || !Array.isArray(parsed.identity_links)) return [];

    return parsed.identity_links
      .filter((l: Record<string, unknown>) => l && typeof l.name === 'string' && l.name.length > 0)
      .map((l: Record<string, unknown>) => ({
        name: String(l.name),
        relationship: normalizeRelationship(String(l.relationship ?? 'unknown')),
        confidence: normalizeConfidence(String(l.confidence ?? 'low')),
        evidence: String(l.evidence ?? ''),
        method: 'llm' as const,
      }));
  } catch {
    return [];
  }
}

function normalizeRelationship(rel: string): RelationshipType {
  const lower = rel.toLowerCase();
  if (VALID_RELATIONSHIPS.has(lower as RelationshipType)) return lower as RelationshipType;
  // Map common synonyms
  if (['wife', 'husband', 'partner'].includes(lower)) return 'spouse';
  if (['son', 'daughter'].includes(lower)) return 'child';
  if (['mother', 'father', 'mom', 'dad'].includes(lower)) return 'parent';
  if (['brother', 'sister'].includes(lower)) return 'sibling';
  if (['coworker', 'co-worker', 'boss', 'manager'].includes(lower)) return 'colleague';
  return 'unknown';
}

function normalizeConfidence(conf: string): 'high' | 'medium' | 'low' {
  const lower = conf.toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') return lower;
  return 'low';
}

/**
 * Merge deterministic and LLM links, deduplicating by name.
 * Deterministic results take priority (higher confidence, lower cost).
 */
function mergeLinks(deterministic: IdentityLink[], llm: IdentityLink[]): IdentityLink[] {
  const byName = new Map<string, IdentityLink>();

  // Deterministic first (priority)
  for (const link of deterministic) {
    byName.set(link.name.toLowerCase(), link);
  }

  // LLM adds new links only
  for (const link of llm) {
    const key = link.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, link);
    }
  }

  return [...byName.values()];
}
