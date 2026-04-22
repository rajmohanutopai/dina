/**
 * Persona selector — LLM-assisted persona routing for uncertain classifications.
 *
 * When the keyword-based domain classifier returns low confidence (< threshold),
 * the persona selector uses an LLM to determine the correct persona.
 *
 * Key invariant: Brain NEVER invents persona names. The LLM can only select
 * from the list of existing personas. Any unknown name is rejected and
 * falls back to "general".
 *
 * Source: ARCHITECTURE.md Task 3.11
 */

import { classifyDomain, type ClassificationInput, type ClassificationResult } from './domain';
import { findSensitiveHits, hasWorkSignal } from './sensitive_signals';
import { personaExists, listPersonas } from '../../../core/src/persona/service';
import { resolveAlias } from '../persona/registry';
import {
  getContact,
  resolveByName,
  type DataResponsibility,
} from '../../../core/src/contacts/directory';

import { PERSONA_SELECTOR_THRESHOLD } from '../constants';
/** Confidence threshold — below this, LLM is consulted. */
const LLM_THRESHOLD = PERSONA_SELECTOR_THRESHOLD;

/** Injectable LLM persona selection provider. */
export type PersonaSelectorProvider = (
  input: ClassificationInput,
  availablePersonas: string[],
) => Promise<{ persona: string; confidence: number; reason: string }>;

let selectorProvider: PersonaSelectorProvider | null = null;

/** Register an LLM persona selection provider. */
export function registerPersonaSelector(provider: PersonaSelectorProvider): void {
  selectorProvider = provider;
}

/** Reset the provider (for testing). */
export function resetPersonaSelector(): void {
  selectorProvider = null;
}

/** Set the confidence threshold for LLM consultation. */
let threshold = LLM_THRESHOLD;

export function setLLMThreshold(value: number): void {
  threshold = Math.max(0, Math.min(1, value));
}

export function getLLMThreshold(): number {
  return threshold;
}

/** Reset threshold to default (for testing). */
export function resetThreshold(): void {
  threshold = LLM_THRESHOLD;
}

/**
 * Select the best persona for an item.
 *
 * Pipeline:
 * 1. Run keyword-based domain classifier
 * 2. If confidence >= threshold → use keyword result
 * 3. If confidence < threshold AND LLM provider available → consult LLM
 * 4. Validate LLM's answer against existing personas
 * 5. Fall back to "general" if LLM suggests unknown persona
 */
export async function selectPersona(input: ClassificationInput): Promise<ClassificationResult> {
  // 1. Keyword-based classification
  const keywordResult = classifyDomain(input);

  // 2. High confidence → use directly
  if (keywordResult.confidence >= threshold) {
    return keywordResult;
  }

  // 3. Low confidence + no LLM → use keyword result as-is
  if (!selectorProvider) {
    return keywordResult;
  }

  // 4. Consult LLM
  const availablePersonas = listPersonas().map((p) => p.name);
  if (availablePersonas.length === 0) {
    return keywordResult; // no personas registered
  }

  try {
    const llmResult = await selectorProvider(input, availablePersonas);

    // 5. Validate: Brain never invents persona names
    const resolved = validatePersonaName(llmResult.persona);
    if (!resolved) {
      // LLM suggested unknown persona → fall back to general
      return {
        persona: 'general',
        confidence: keywordResult.confidence,
        matchedKeywords: keywordResult.matchedKeywords,
        method: 'fallback',
      };
    }

    return {
      persona: resolved,
      confidence: llmResult.confidence,
      matchedKeywords: [],
      method: 'keyword', // reported as keyword since we don't have 'llm' in the type
    };
  } catch {
    // LLM failure → use keyword result
    return keywordResult;
  }
}

/**
 * Validate a persona name against existing personas.
 *
 * Checks: exact name match, alias resolution.
 * Returns the canonical persona name, or null if not found.
 */
export function validatePersonaName(name: string): string | null {
  if (!name || name.trim().length === 0) return null;

  const normalized = name.trim().toLowerCase();

  // Direct persona match
  if (personaExists(normalized)) {
    return normalized;
  }

  // Try alias resolution
  const resolved = resolveAlias(normalized);
  if (resolved && personaExists(resolved)) {
    return resolved;
  }

  return null;
}

// ---------------------------------------------------------------
// Relationship-aware routing (data_responsibility overrides)
//
// When a sender or mentioned contact has a data_responsibility set,
// use it to override or add secondary routing:
//   household (spouse/child) → health items → health persona
//   care → health items → health persona (caretaker)
//   financial → financial items → financial persona
//   external → no override (route as normal)
//
// Source: brain/src/service/persona_selector.py — relationship-aware routing
// ---------------------------------------------------------------

/**
 * Map from data_responsibility to persona override rules.
 *
 * When a contact has this responsibility AND the item content matches
 * the domain, the item is routed to the override persona.
 */
const RESPONSIBILITY_PERSONA_MAP: Record<DataResponsibility, Record<string, string>> = {
  household: {
    health: 'health', // "my daughter's blood pressure" → health
    financial: 'financial', // "family budget" → financial
  },
  care: {
    health: 'health', // "my mother's medication" → health (caretaker)
  },
  financial: {
    financial: 'financial', // "colleague owes money" → financial
  },
  external: {}, // no overrides for external contacts
};

/**
 * Apply data_responsibility override to a classification.
 *
 * Looks up the sender's contact record and checks if their
 * data_responsibility suggests a different routing for the detected domain.
 *
 * Only the SENDER's responsibility overrides routing, not mentioned contacts.
 * Mentioned names are tracked as metadata, not routing drivers.
 *
 * Returns the overridden persona name, or null if no override applies.
 */
export function applyResponsibilityOverride(
  senderDID: string | undefined,
  detectedDomain: string,
): string | null {
  if (!senderDID) return null;

  const contact = getContact(senderDID);
  if (!contact) return null;

  const overrides = RESPONSIBILITY_PERSONA_MAP[contact.dataResponsibility];
  return overrides?.[detectedDomain] ?? null;
}

/**
 * Extract mentioned person names from text (quick regex pass).
 * Used to check if a classification mentions known contacts
 * whose data_responsibility should influence routing.
 */
export function extractMentionedNames(text: string): string[] {
  // Match capitalized words that could be names (2+ chars, not at sentence start)
  const names: string[] = [];
  const pattern = /(?:^|\.\s+)?\b([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    // Only include if it resolves to a known contact
    if (resolveByName(name)) {
      names.push(name);
    }
  }
  return [...new Set(names)];
}

// ---------------------------------------------------------------
// Secondary persona expansion
//
// Ported from Python persona_selector.py — items that span multiple
// domains get secondary personas. "My daughter has diabetes and my
// colleague owes taxes" → primary: health, secondary: financial.
//
// Uses sensitive_signals.ts for span-based domain detection.
// ---------------------------------------------------------------

/** A secondary persona detected via sensitive signal analysis. */
export interface SecondaryPersona {
  persona: string;
  signal: string;
  strength: 'strong' | 'weak';
}

/** Classification result with primary + secondary personas. */
export interface ClassificationWithSecondaries extends ClassificationResult {
  secondaryPersonas: SecondaryPersona[];
}

/**
 * Sensitivity ordering for secondary persona sorting.
 * Higher number = more sensitive = appears first.
 * Matches Python's sensitivity hierarchy.
 */
const SENSITIVITY_ORDER: Record<string, number> = {
  health: 4,
  financial: 3,
  legal: 2,
  professional: 1,
};

/**
 * Map from sensitive signal domain names to persona names.
 * Signal domains (from sensitive_signals.ts) may differ from persona names.
 */
const SIGNAL_TO_PERSONA: Record<string, string> = {
  health: 'health',
  financial: 'financial',
  legal: 'legal',
  work: 'professional',
};

/**
 * Select primary persona + detect secondary personas for multi-domain items.
 *
 * Pipeline:
 * 1. Run selectPersona() for primary classification
 * 2. Run sensitive signal detection on item text
 * 3. Map signal domains to persona names
 * 4. Exclude primary from secondaries
 * 5. Validate each secondary against existing personas
 * 6. Sort by sensitivity (health > financial > legal > professional)
 *
 * This enables items that span multiple domains to be routed to
 * multiple persona vaults (e.g., "medical bill" → health + financial).
 */
export async function selectPersonaWithSecondaries(
  input: ClassificationInput,
): Promise<ClassificationWithSecondaries> {
  // 1. Primary classification
  const primary = await selectPersona(input);

  // 2. Build text from input for signal detection
  const text = [input.subject || '', input.body || ''].join(' ');

  if (!text.trim()) {
    return { ...primary, secondaryPersonas: [] };
  }

  // 2b. Apply data_responsibility override on primary persona (sender only)
  const override = applyResponsibilityOverride(input.sender, primary.persona);
  if (override && override !== primary.persona) {
    const resolved = validatePersonaName(override);
    if (resolved) {
      primary.persona = resolved;
      primary.method = 'keyword'; // responsibility-based override
    }
  }

  // 3. Detect sensitive signals
  const hits = findSensitiveHits(text);
  const detectedDomains = new Set<string>();

  for (const hit of hits) {
    detectedDomains.add(hit.domain);
  }

  // Also check work signals (not covered by findSensitiveHits)
  if (hasWorkSignal(text)) {
    detectedDomains.add('work');
  }

  // 4. Map to persona names, exclude primary, validate
  const secondaries: SecondaryPersona[] = [];

  for (const domain of detectedDomains) {
    const personaName = SIGNAL_TO_PERSONA[domain] ?? domain;

    // Skip if same as primary
    if (personaName === primary.persona) continue;

    // Validate against existing personas
    const resolved = validatePersonaName(personaName);
    if (!resolved) continue;

    // Find the strongest signal for this domain
    const domainHits = hits.filter((h) => h.domain === domain);
    const bestStrength = domainHits.some((h) => h.strength === 'strong') ? 'strong' : 'weak';
    const bestKeyword = domainHits.find((h) => h.strength === bestStrength)?.keyword ?? domain;

    secondaries.push({
      persona: resolved,
      signal: bestKeyword,
      strength: bestStrength,
    });
  }

  // 5. Sort by sensitivity (most sensitive first)
  secondaries.sort((a, b) => {
    const aOrder = SENSITIVITY_ORDER[a.persona] ?? 0;
    const bOrder = SENSITIVITY_ORDER[b.persona] ?? 0;
    return bOrder - aOrder;
  });

  return { ...primary, secondaryPersonas: secondaries };
}
