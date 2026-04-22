/**
 * Persona classifier factory — create the right classifier for the LLM provider.
 *
 * Gemini → structured output via response_schema (guaranteed JSON)
 * OpenAI/OpenRouter → JSON mode via response_format
 * Claude → prefilled assistant technique
 * Any → generic classifier (JSON via prompt instructions)
 *
 * Usage:
 *   const provider = getAdapter('gemini'); // your LLM adapter
 *   const classifier = createClassifierForProvider(provider);
 *   registerPersonaSelector(classifier);
 *
 * Source: brain/src/prompts.py PERSONA_CLASSIFY_RESPONSE_SCHEMA
 */

import type { LLMProvider } from '../llm/adapters/provider';
import type { PersonaSelectorProvider } from './persona_selector';
import { createGeminiClassifier, createGenericClassifier } from './gemini_classify';

/**
 * Create the best persona classifier for the given LLM provider.
 *
 * Selects the optimal classification strategy:
 * - Gemini: schema-validated JSON (most reliable)
 * - OpenAI/OpenRouter/Claude: JSON mode (syntax-valid JSON)
 * - Any other: generic prompt-based JSON
 *
 * All classifiers share the same interface (PersonaSelectorProvider)
 * so persona_selector.ts doesn't need to know which strategy is used.
 */
export function createClassifierForProvider(provider: LLMProvider): PersonaSelectorProvider {
  switch (provider.name) {
    case 'gemini':
      // Gemini enforces the full JSON schema via response_schema — most reliable
      return createGeminiClassifier(provider);

    case 'openai':
    case 'openrouter':
    case 'claude':
      // These support JSON mode (response_format / prefilled assistant)
      // but don't enforce a schema — use prompt-based JSON instructions
      return createGenericClassifier(provider);

    default:
      // Unknown provider — use prompt-only JSON instructions
      return createGenericClassifier(provider);
  }
}

/**
 * Auto-configure persona classification from a registered LLM provider.
 *
 * Call this during app startup after the LLM provider is initialized.
 * It creates the optimal classifier and registers it with persona_selector.
 */
export function configureClassification(
  provider: LLMProvider,
  register: (classifier: PersonaSelectorProvider) => void,
): void {
  const classifier = createClassifierForProvider(provider);
  register(classifier);
}
