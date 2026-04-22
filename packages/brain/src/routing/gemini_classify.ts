/**
 * Gemini-specific persona classification with structured output.
 *
 * Uses Gemini's `response_schema` parameter to guarantee valid JSON output
 * for persona classification — no free-form parsing needed.
 *
 * Without this schema, Gemini may return malformed JSON, markdown-fenced
 * code blocks, or conversational text instead of the expected structure.
 *
 * Source: brain/src/prompts.py PERSONA_CLASSIFY_RESPONSE_SCHEMA
 */

import { PERSONA_CLASSIFY, PERSONA_CLASSIFY_RESPONSE_SCHEMA } from '../llm/prompts';
import type { LLMProvider, ChatOptions } from '../llm/adapters/provider';
import type { ClassificationInput } from './domain';
import type { PersonaSelectorProvider } from './persona_selector';

/**
 * Create a Gemini-backed persona selector that uses structured output.
 *
 * The returned provider:
 * 1. Builds the classification prompt from the input
 * 2. Calls Gemini with the PERSONA_CLASSIFY_RESPONSE_SCHEMA
 * 3. Parses the guaranteed-valid JSON response
 * 4. Returns persona, confidence, reason (validated)
 *
 * Falls back gracefully to free-form parsing if the schema is not enforced
 * by the underlying provider (e.g., when using OpenAI or Claude instead).
 */
export function createGeminiClassifier(provider: LLMProvider): PersonaSelectorProvider {
  return async (input: ClassificationInput, availablePersonas: string[]) => {
    const personaList = availablePersonas.join(', ');
    const prompt = buildClassificationPrompt(input, personaList);

    const options: ChatOptions = {
      temperature: 0.1, // Low temperature for classification (deterministic)
      maxTokens: 256,
      responseSchema: PERSONA_CLASSIFY_RESPONSE_SCHEMA,
    };

    const response = await provider.chat(
      [
        {
          role: 'system',
          content: `You are classifying an incoming item for Dina. Available personas: ${personaList}. Respond with JSON.`,
        },
        { role: 'user', content: prompt },
      ],
      options,
    );

    return parseClassificationResponse(response.content, availablePersonas);
  };
}

/**
 * Create a generic classifier that works with any provider (no schema enforcement).
 *
 * Uses JSON-mode prompt instructions instead of response_schema.
 */
export function createGenericClassifier(provider: LLMProvider): PersonaSelectorProvider {
  return async (input: ClassificationInput, availablePersonas: string[]) => {
    const personaList = availablePersonas.join(', ');
    const prompt = buildClassificationPrompt(input, personaList);

    const response = await provider.chat(
      [
        {
          role: 'system',
          content: `You are classifying an incoming item for Dina. Available personas: ${personaList}. Respond with ONLY a JSON object: {"persona": "<name>", "confidence": <0.0-1.0>, "reason": "<brief reason>"}`,
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, maxTokens: 256 },
    );

    return parseClassificationResponse(response.content, availablePersonas);
  };
}

/**
 * Build the classification prompt from input fields.
 */
function buildClassificationPrompt(input: ClassificationInput, personaList: string): string {
  return PERSONA_CLASSIFY.replace('{{persona_list}}', personaList)
    .replace('{{type}}', input.type ?? 'unknown')
    .replace('{{source}}', input.source ?? 'unknown')
    .replace('{{sender}}', input.sender ?? 'unknown')
    .replace('{{subject}}', input.subject ?? '')
    .replace('{{body_preview}}', (input.body ?? '').slice(0, 500));
}

/**
 * Parse a classification response (structured or free-form JSON).
 *
 * Validates persona against the available list. Falls back to 'general'
 * with low confidence on parse failure.
 */
export function parseClassificationResponse(
  content: string,
  availablePersonas: string[],
): { persona: string; confidence: number; reason: string } {
  const fallback = { persona: 'general', confidence: 0.3, reason: 'Classification parse failed' };

  if (!content || content.trim().length === 0) return fallback;

  let cleaned = content.trim();
  // Handle markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

  try {
    const parsed = JSON.parse(cleaned);

    const persona = String(parsed.persona ?? 'general')
      .toLowerCase()
      .trim();
    const confidence = Number(parsed.confidence ?? 0.5);
    const reason = String(parsed.reason ?? '');

    // Validate confidence range
    if (isNaN(confidence) || confidence < 0 || confidence > 1.0) {
      return fallback;
    }

    // Validate persona against available list
    const available = new Set(availablePersonas.map((p) => p.toLowerCase()));
    if (!available.has(persona)) {
      return {
        persona: 'general',
        confidence: confidence * 0.5,
        reason: `LLM suggested "${persona}" which is not available`,
      };
    }

    return { persona, confidence, reason };
  } catch {
    return fallback;
  }
}
