/**
 * Enrichment pipeline E2E — orchestrates the full enrichment flow.
 *
 * Pipeline:
 *   1. L0 deterministic (headline from metadata)
 *   2. L1 via LLM (paragraph summary via CONTENT_ENRICH prompt)
 *   3. PII scrub before LLM, rehydrate after
 *   4. Embedding generation from L1 text
 *   5. Set enrichment_status = 'ready'
 *
 * Each step is fail-safe: if LLM or embedding fails, the pipeline
 * degrades gracefully (L0-only with status 'l0_complete').
 *
 * Source: brain/src/service/enrichment.py
 */

import { generateL0WithMeta, type L0Input } from './l0_deterministic';
import { EntityVault } from '../pii/entity_vault';
import { generateEmbedding, isEmbeddingAvailable } from '../embedding/generation';
import {
  renderPrompt,
  CONTENT_ENRICH,
  ENRICHMENT_LOW_TRUST_INSTRUCTION,
  PII_PRESERVE_INSTRUCTION,
} from '../llm/prompts';
import { detectSponsored, tagSponsored, type SponsoredResult } from './sponsored';

/** Injectable LLM call function for L1 generation. */
export type LLMCallFn = (system: string, prompt: string) => Promise<string>;

let llmCallFn: LLMCallFn | null = null;

/** Register the LLM call function (for production/testing). */
export function registerEnrichmentLLM(fn: LLMCallFn): void {
  llmCallFn = fn;
}

/** Reset (for testing). */
export function resetEnrichmentPipeline(): void {
  llmCallFn = null;
}

export interface EnrichmentResult {
  content_l0: string;
  content_l1: string;
  embedding?: Float32Array;
  enrichment_status: 'l0_complete' | 'ready' | 'failed';
  enrichment_version: { prompt_v: string; embed_model: string | null; timestamp: number };
  confidence: 'high' | 'medium' | 'low';
  /** Whether this item was detected as sponsored/promotional content. */
  isSponsored: boolean;
}

/**
 * Run the full enrichment pipeline on a vault item.
 *
 * Steps:
 *   1. L0 deterministic headline
 *   2. L1 via LLM (if available) with PII scrub/rehydrate
 *   3. Embedding from L1 (if provider available)
 *   4. Set status to 'ready' or 'l0_complete'
 *
 * Graceful degradation: if LLM or embedding fails, returns L0-only.
 */
export async function enrichItem(
  input: L0Input & {
    body?: string;
    sender_trust?: string;
  },
): Promise<EnrichmentResult> {
  // Step 0: Sponsored content detection
  const sponsored = detectSponsored({
    source: input.source,
    sender: input.sender,
    sender_trust: input.sender_trust,
    subject: input.summary,
    body: input.body,
  });

  // Step 1: L0 deterministic
  const l0Result = generateL0WithMeta(input);

  // Tag L0 headline with [Sponsored] if detected
  const l0Text = sponsored.isSponsored ? tagSponsored(l0Result.text) : l0Result.text;

  const result: EnrichmentResult = {
    content_l0: l0Text,
    content_l1: '',
    enrichment_status: 'l0_complete',
    enrichment_version: l0Result.enrichment_version,
    confidence: l0Result.confidence,
    isSponsored: sponsored.isSponsored,
  };

  // Step 2: L1 via LLM (if available)
  if (llmCallFn) {
    try {
      const bodyText = input.body ?? '';
      const bodyForLLM = bodyText.slice(0, 4000); // Cap at 4000 chars (matching Python)

      // PII scrub before sending to cloud LLM
      const vault = new EntityVault();
      const scrubbedBody = vault.scrub(bodyForLLM);
      const scrubbedSummary = vault.scrub(input.summary ?? '');

      // Build the enrichment prompt
      let prompt = renderPrompt(CONTENT_ENRICH, {
        type: input.type || 'note',
        sender: input.sender || '',
        subject: scrubbedSummary,
        body: scrubbedBody,
      });

      // Prepend PII preserve instruction if we scrubbed anything
      if (vault.entries().length > 0) {
        prompt = PII_PRESERVE_INSTRUCTION + '\n\n' + prompt;
      }

      // Append low-trust instruction for unverified sources
      const trust = input.sender_trust ?? '';
      if (trust === 'unknown' || trust === 'marketing') {
        prompt = prompt + '\n\n' + ENRICHMENT_LOW_TRUST_INSTRUCTION;
      }

      // Call LLM
      const llmResponse = await llmCallFn('You are Dina, a personal AI assistant.', prompt);

      // Parse JSON response
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const rawL0 = typeof parsed.l0 === 'string' ? parsed.l0 : '';
        const rawL1 = typeof parsed.l1 === 'string' ? parsed.l1 : '';

        // Rehydrate PII tokens back to original values
        result.content_l0 = vault.rehydrate(rawL0) || l0Result.text;
        result.content_l1 = vault.rehydrate(rawL1);
        result.enrichment_version.prompt_v = 'llm-v1';
      }
    } catch {
      // LLM failed — keep L0-only (graceful degradation)
    }
  }

  // Step 3: Embedding from L1 (or L0 if L1 unavailable)
  if (isEmbeddingAvailable()) {
    try {
      const textForEmbedding = (result.content_l1 || result.content_l0).slice(0, 2000);
      const embeddingResult = await generateEmbedding(textForEmbedding);
      result.embedding = embeddingResult.vector;
      result.enrichment_version.embed_model = embeddingResult.model;
    } catch {
      // Embedding failed — continue without it
    }
  }

  // Step 4: Set final status
  if (result.content_l1 && result.embedding) {
    result.enrichment_status = 'ready';
  } else if (result.content_l1) {
    result.enrichment_status = 'l0_complete'; // has L1 but no embedding
  }
  // else stays 'l0_complete' (L0 only)

  return result;
}
