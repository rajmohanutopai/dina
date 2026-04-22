/**
 * Guardian LLM classification — refine silence tier with LLM.
 *
 * When the deterministic classifier produces a low-confidence result,
 * the LLM can override with a higher-confidence classification.
 *
 * The LLM's output is validated via parseSilence and must produce a
 * valid priority (1/2/3) with confidence > the deterministic result.
 * If the LLM fails or returns lower confidence, the deterministic
 * result is kept.
 *
 * Source: ARCHITECTURE.md Task 3.21
 */

import { classifyDeterministic, type ClassificationResult, type PriorityTier } from './silence';
import { parseSilence } from '../llm/output_parser';

/** Confidence threshold — LLM consulted below this. */
const REFINEMENT_THRESHOLD = 0.75;

/** Injectable LLM classifier. Returns raw JSON string for parsing. */
export type SilenceLLMProvider = (event: Record<string, unknown>) => Promise<string>;

let llmProvider: SilenceLLMProvider | null = null;

/** Register an LLM provider for silence classification. */
export function registerSilenceLLM(provider: SilenceLLMProvider): void {
  llmProvider = provider;
}

/** Reset the provider (for testing). */
export function resetSilenceLLM(): void {
  llmProvider = null;
}

/**
 * Classify with LLM refinement.
 *
 * Pipeline:
 * 1. Run deterministic classifier
 * 2. If confidence >= threshold → return deterministic result
 * 3. If LLM available → consult, parse with parseSilence
 * 4. If LLM confidence > deterministic confidence → use LLM result
 * 5. Otherwise → keep deterministic result
 */
export async function classifyWithLLM(
  event: Record<string, unknown>,
): Promise<ClassificationResult> {
  const deterministicResult = classifyDeterministic(event);

  // High confidence → skip LLM
  if (deterministicResult.confidence >= REFINEMENT_THRESHOLD) {
    return deterministicResult;
  }

  // No LLM → return deterministic
  if (!llmProvider) {
    return deterministicResult;
  }

  try {
    const rawOutput = await llmProvider(event);
    const llmResult = parseSilence(rawOutput);

    // LLM must produce higher confidence to override
    if (llmResult.confidence > deterministicResult.confidence) {
      return {
        tier: llmResult.priority,
        reason: llmResult.reason || deterministicResult.reason,
        confidence: llmResult.confidence,
        method: 'llm',
      };
    }

    // LLM confidence not higher → keep deterministic
    return deterministicResult;
  } catch {
    // LLM failure → keep deterministic
    return deterministicResult;
  }
}
